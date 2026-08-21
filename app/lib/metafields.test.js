import { afterAll, beforeEach, describe, expect, test } from "vitest";
import prisma from "../db.server";
import { upsertOverride, markOverrideSynced } from "../models/override.server";
import {
  METAFIELDS_SET_BATCH,
  METAFIELD_KEY,
  METAFIELD_NAMESPACE,
  buildMetafieldValue,
  deleteOverrideMetafield,
  shouldPublishToStorefront,
  syncAllOverrides,
  syncOverrideMetafield,
} from "./metafields.server";

const DOMAIN = "vitest-metafields.myshopify.com";
let shopId;

/** Records mutations and lets a test force userErrors. */
function stubAdmin({ setErrors = [], deleteErrors = [] } = {}) {
  const calls = [];
  return {
    calls,
    setCalls: () => calls.filter((c) => c.query.includes("metafieldsSet")),
    deleteCalls: () => calls.filter((c) => c.query.includes("metafieldsDelete")),
    graphql: async (query, options) => {
      calls.push({ query, variables: options?.variables ?? {} });
      const isSet = query.includes("metafieldsSet");
      return {
        json: async () => ({
          data: isSet
            ? { metafieldsSet: { metafields: [{ id: "gid://mf/1" }], userErrors: setErrors } }
            : { metafieldsDelete: { deletedMetafields: [], userErrors: deleteErrors } },
        }),
      };
    },
  };
}

const override = (overrides = {}) => ({
  id: "row-1",
  productId: "55",
  placement: "pdp",
  enabled: true,
  items: [
    { id: "1", handle: "one" },
    { id: "2", handle: "two" },
  ],
  ...overrides,
});

beforeEach(async () => {
  await prisma.shop.deleteMany({ where: { domain: DOMAIN } });
  const shop = await prisma.shop.create({ data: { domain: DOMAIN } });
  shopId = shop.id;
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { domain: DOMAIN } });
});

describe("shouldPublishToStorefront", () => {
  test("publishes an enabled pdp or both override", () => {
    expect(shouldPublishToStorefront(override({ placement: "pdp" }))).toBe(true);
    expect(shouldPublishToStorefront(override({ placement: "both" }))).toBe(true);
  });

  // The metafield is read by the PDP block only. Publishing a checkout-only
  // override would put it on the product page, where it was never meant to be.
  test("does not publish a checkout-only override", () => {
    expect(shouldPublishToStorefront(override({ placement: "checkout" }))).toBe(false);
  });

  test("does not publish a disabled or empty override", () => {
    expect(shouldPublishToStorefront(override({ enabled: false }))).toBe(false);
    expect(shouldPublishToStorefront(override({ items: [] }))).toBe(false);
    expect(shouldPublishToStorefront(null)).toBe(false);
  });
});

describe("buildMetafieldValue", () => {
  test("writes the versioned shape Liquid expects", () => {
    const value = JSON.parse(
      buildMetafieldValue(
        [{ id: 1, handle: "one", title: "One", position: 0 }],
        { now: new Date("2026-08-12T00:00:00Z") },
      ),
    );

    // No copy without an offer, so this is byte-identical to v1 apart from the
    // version — the theme block's own settings still supply the wording.
    expect(value).toEqual({
      v: 2,
      updatedAt: "2026-08-12T00:00:00.000Z",
      items: [{ id: "1", handle: "one" }],
    });
  });

  test("carries an offer's wording when there is some", () => {
    const value = JSON.parse(
      buildMetafieldValue([{ id: 1, handle: "one" }], {
        now: new Date("2026-08-12T00:00:00Z"),
        presentation: {
          title: "Complete the set",
          badge: "Limited offer",
          buttonText: "Add to cart",
          countdown: true,
        },
      }),
    );

    expect(value.copy).toEqual({
      title: "Complete the set",
      badge: "Limited offer",
      buttonText: "Add to cart",
      countdown: true,
      // A countdown that is on always names its mode; the duration and wording
      // fall back to reco.js's own defaults when the offer said nothing.
      countdownMode: "fixed",
      // Storefront filtering always ships, so reco.js never has to guess. Hiding
      // the trigger product is the historical behaviour and so the default.
      visibility: { hideInCart: false, hideTrigger: true, quantityPicker: false },
    });
  });

  test("a countdown carries its own settings, and only when it is on", () => {
    const withTimer = JSON.parse(
      buildMetafieldValue([{ id: 1 }], {
        presentation: {
          title: "Complete the set",
          countdown: true,
          countdownMode: "date",
          countdownMinutes: 45,
          countdownEndsAt: "2026-09-01T10:30:00.000Z",
          countdownTitle: "Ends in {{timer}}",
        },
      }),
    );

    expect(withTimer.copy).toMatchObject({
      countdown: true,
      countdownMode: "date",
      countdownMinutes: 45,
      // ISO, so Date.parse handles it in every browser.
      countdownEndsAt: "2026-09-01T10:30:00.000Z",
      countdownTitle: "Ends in {{timer}}",
    });

    // Switched off, the settings are payload that can only mislead: reco.js reads
    // `countdown` first and would never look at them.
    const off = JSON.parse(
      buildMetafieldValue([{ id: 1 }], {
        presentation: {
          title: "Complete the set",
          countdown: false,
          countdownMode: "date",
          countdownMinutes: 45,
          countdownTitle: "Ends in {{timer}}",
        },
      }),
    );

    expect(off.copy.countdown).toBe(false);
    expect("countdownMode" in off.copy).toBe(false);
    expect("countdownTitle" in off.copy).toBe(false);
  });

  test("a null duration or blank wording is left out, not written as null", () => {
    // Every key here is read by hand on the other side, and reco.js already has
    // defaults for both.
    const value = JSON.parse(
      buildMetafieldValue([{ id: 1 }], {
        presentation: { countdown: true, countdownMinutes: null, countdownTitle: "  " },
      }),
    );

    expect(value.copy).toEqual({
      title: "",
      badge: "",
      buttonText: "",
      countdown: true,
      countdownMode: "fixed",
      visibility: { hideInCart: false, hideTrigger: true, quantityPicker: false },
    });
  });

  test("omits copy entirely rather than writing an empty object", () => {
    // Liquid checks for nil to decide whether to fall back to block settings, so
    // an empty object here would read as "the offer wants a blank heading".
    const value = JSON.parse(buildMetafieldValue([{ id: 1 }]));
    expect("copy" in value).toBe(false);
  });

  test("carries the offer type, so the embed can lay it out", () => {
    /*
     * The app embed has no theme settings to read (§7.6), so the offer type is the
     * only thing that can tell it whether to render a carousel of rows or a grid.
     */
    const value = JSON.parse(
      buildMetafieldValue([{ id: 1 }], {
        presentation: { type: "cross_sell", title: "You may also like" },
      }),
    );

    expect(value.type).toBe("cross_sell");
  });

  test("no type for a list curated on the recommendations page", () => {
    // It has no offer behind it, so there is no type — and the theme block's own
    // layout setting is the right answer there.
    expect("type" in JSON.parse(buildMetafieldValue([{ id: 1 }]))).toBe(false);
    expect(
      "type" in JSON.parse(buildMetafieldValue([{ id: 1 }], { presentation: { type: "  " } })),
    ).toBe(false);
  });

  test("the sync reads copy off the row, not the caller", async () => {
    /*
     * The Settings re-sync has no offer in hand — it iterates Override rows. If
     * the copy were passed in by the publish path only, a repair would rewrite
     * every metafield without it and silently blank the merchant's wording.
     */
    const admin = stubAdmin();

    await syncOverrideMetafield(admin, {
      productId: "1",
      placement: "pdp",
      enabled: true,
      items: [{ id: "2", handle: "two" }],
      presentation: { title: "From the row", badge: "", buttonText: "Add", countdown: false },
    });

    const sent = JSON.parse(admin.calls[0].variables.metafields[0].value);
    expect(sent.copy.title).toBe("From the row");
  });

  test("keeps ids as strings and tolerates a missing handle", () => {
    const value = JSON.parse(buildMetafieldValue([{ id: 42 }]));
    expect(value.items[0]).toEqual({ id: "42", handle: null });
  });
});

describe("syncOverrideMetafield", () => {
  test("writes the metafield for a published override", async () => {
    const admin = stubAdmin();
    const result = await syncOverrideMetafield(admin, override());

    expect(result.published).toBe(true);
    expect(admin.setCalls()).toHaveLength(1);
    expect(admin.setCalls()[0].variables.metafields[0]).toMatchObject({
      ownerId: "gid://shopify/Product/55",
      namespace: METAFIELD_NAMESPACE,
      key: METAFIELD_KEY,
      type: "json",
    });
  });

  // Turning an override off has to remove the metafield, otherwise the theme
  // keeps rendering the old list.
  test("deletes the metafield when the override should not be live", async () => {
    const admin = stubAdmin();
    const result = await syncOverrideMetafield(admin, override({ enabled: false }));

    expect(result.published).toBe(false);
    expect(admin.deleteCalls()).toHaveLength(1);
    expect(admin.setCalls()).toHaveLength(0);
  });

  test("throws on userErrors so the caller can warn the merchant", async () => {
    const admin = stubAdmin({ setErrors: [{ message: "Owner not found" }] });
    await expect(syncOverrideMetafield(admin, override())).rejects.toThrow(
      /Owner not found/,
    );
  });
});

describe("deleteOverrideMetafield", () => {
  test("sends the identifier for the product", async () => {
    const admin = stubAdmin();
    await deleteOverrideMetafield(admin, 77);

    expect(admin.deleteCalls()[0].variables.metafields[0]).toEqual({
      ownerId: "gid://shopify/Product/77",
      namespace: METAFIELD_NAMESPACE,
      key: METAFIELD_KEY,
    });
  });

  test("throws on userErrors", async () => {
    const admin = stubAdmin({ deleteErrors: [{ message: "nope" }] });
    await expect(deleteOverrideMetafield(admin, 77)).rejects.toThrow(/nope/);
  });
});

describe("syncAllOverrides", () => {
  const save = (productId, extra = {}) =>
    upsertOverride({
      shopId,
      productId,
      productTitle: `P${productId}`,
      productHandle: `p-${productId}`,
      items: [{ id: "9", handle: "nine" }],
      ...extra,
    });

  test("pushes drifted overrides and marks them synced", async () => {
    const a = await save(1);
    const b = await save(2);
    const admin = stubAdmin();

    const result = await syncAllOverrides({ admin, shopId });

    expect(result).toMatchObject({ total: 2, synced: 2, errors: [] });
    for (const row of [a, b]) {
      const reloaded = await prisma.override.findUnique({ where: { id: row.id } });
      expect(reloaded.syncedAt).toBeInstanceOf(Date);
    }
  });

  test("skips rows already in sync", async () => {
    const row = await save(1);
    await markOverrideSynced(row.id);
    const admin = stubAdmin();

    expect(await syncAllOverrides({ admin, shopId })).toMatchObject({ total: 0 });
    expect(admin.calls).toHaveLength(0);
  });

  test("onlyUnsynced false re-pushes everything", async () => {
    const row = await save(1);
    await markOverrideSynced(row.id);
    const admin = stubAdmin();

    expect(
      await syncAllOverrides({ admin, shopId, onlyUnsynced: false }),
    ).toMatchObject({ total: 1, synced: 1 });
  });

  // metafieldsSet caps at 25 per call, and it is atomic — one oversized request
  // would fail wholesale.
  test("splits large sets into batches of 25", async () => {
    for (let i = 1; i <= 26; i += 1) await save(i);
    const admin = stubAdmin();

    const result = await syncAllOverrides({ admin, shopId });

    expect(admin.setCalls()).toHaveLength(2);
    expect(admin.setCalls()[0].variables.metafields).toHaveLength(METAFIELDS_SET_BATCH);
    expect(admin.setCalls()[1].variables.metafields).toHaveLength(1);
    expect(result.synced).toBe(26);
  });

  test("routes unpublishable rows to delete instead of set", async () => {
    await save(1, { enabled: false });
    await save(2, { placement: "checkout" });
    await save(3);
    const admin = stubAdmin();

    await syncAllOverrides({ admin, shopId });

    expect(admin.setCalls()[0].variables.metafields).toHaveLength(1);
    expect(admin.deleteCalls()[0].variables.metafields).toHaveLength(2);
  });

  // One failing batch must not abandon the rest of the shop's overrides.
  test("reports errors without throwing", async () => {
    await save(1);
    const admin = stubAdmin({ setErrors: [{ message: "rate limited" }] });

    const result = await syncAllOverrides({ admin, shopId });

    expect(result.synced).toBe(0);
    expect(result.errors[0]).toMatch(/rate limited/);

    const row = await prisma.override.findFirst({ where: { shopId } });
    expect(row.syncedAt).toBeNull(); // still flagged as drifted
  });
});
