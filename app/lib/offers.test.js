import { afterAll, beforeEach, describe, expect, test } from "vitest";
import prisma from "../db.server";
import { saveOffer } from "../models/offer.server";
import { getOverride } from "../models/override.server";
import { getOffer } from "../models/offer.server";
import {
  newlyOccupiedTargets,
  publishOffer,
  unpublishOffer,
} from "./offers.server";

/*
 * Publishing is the only part of the offer flow with side effects outside its own
 * table: it writes an Override per target product and syncs each metafield, so
 * the storefront path from Phase 6/8 is reused untouched. These check the
 * projection is right and, more importantly, that one product failing does not
 * take the rest of the publish with it.
 */

const DOMAIN = "vitest-offers-lib.myshopify.com";
let shopId;

const product = (id) => ({ id: String(id), handle: `p${id}`, title: `Product ${id}` });

/** Stand-in for the authenticated admin client, recording metafield calls. */
function stubAdmin({ failFor = [] } = {}) {
  const calls = [];

  return {
    calls,
    graphql: async (query, options) => {
      const variables = options?.variables ?? {};
      calls.push({ query, variables });

      /*
       * The shop id lookup the shop-scope path makes before writing its metafield.
       * Answered first: without it `shopGid()` reads undefined and every
       * shop-scope publish fails for the wrong reason.
       */
      if (query.includes("RecoShopId")) {
        return { json: async () => ({ data: { shop: { id: "gid://shopify/Shop/1" } } }) };
      }

      const owner = JSON.stringify(variables);
      // A bare id means a product; anything containing a slash ("Shop/1") is
      // matched as written, so a test can fail the shop-level write too.
      if (failFor.some((id) => owner.includes(id.includes("/") ? id : `/Product/${id}`))) {
        throw new Error(`metafield write failed for ${owner}`);
      }

      // Shapes for both metafieldsSet and metafieldsDelete.
      return {
        json: async () => ({
          data: {
            metafieldsSet: { metafields: [{ id: "gid://shopify/Metafield/1" }], userErrors: [] },
            metafieldsDelete: { deletedMetafields: [{ key: "reco_overrides" }], userErrors: [] },
          },
        }),
      };
    },
  };
}

const offerFor = (targets, items) =>
  saveOffer(shopId, {
    name: "Offer",
    placement: "PRODUCT_PAGE",
    offerType: "cross_sell",
    title: "You may also like",
    buttonText: "Add",
    targets,
    items,
  });

beforeEach(async () => {
  await prisma.shop.deleteMany({ where: { domain: DOMAIN } });
  const shop = await prisma.shop.create({ data: { domain: DOMAIN } });
  shopId = shop.id;
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { domain: DOMAIN } });
});

describe("publishOffer", () => {
  test("writes one override per target, carrying the offer's items", async () => {
    const offer = await offerFor([product(1), product(2)], [product(10), product(11)]);
    const result = await publishOffer({ admin: stubAdmin(), shopId, offer });

    expect(result.synced).toBe(2);
    expect(result.failures).toEqual([]);
    expect(result.offer.status).toBe("published");

    for (const id of ["1", "2"]) {
      const override = await getOverride({ shopId, productId: id, placement: "pdp" });
      expect(override, `no override for ${id}`).toBeTruthy();
      expect(override.items.map((item) => item.id)).toEqual(["10", "11"]);
      // Marked synced, so the Settings repair action does not pick it up.
      expect(override.syncedAt).not.toBeNull();
      expect(override.enabled).toBe(true);
    }
  });

  test("a product page offer publishes to the pdp placement", async () => {
    const offer = await offerFor([product(1)], [product(10)]);
    await publishOffer({ admin: stubAdmin(), shopId, offer });

    expect(await getOverride({ shopId, productId: "1", placement: "checkout" })).toBeNull();
    expect(await getOverride({ shopId, productId: "1", placement: "pdp" })).toBeTruthy();
  });

  /*
   * The important one. A metafield write can fail per product — a deleted
   * product, a throttled shop — and one failure must not roll back the rest or
   * leave the merchant guessing which products are live.
   */
  test("one failing product does not take the others down", async () => {
    const offer = await offerFor([product(1), product(2), product(3)], [product(10)]);
    const result = await publishOffer({
      admin: stubAdmin({ failFor: ["2"] }),
      shopId,
      offer,
    });

    expect(result.synced).toBe(2);
    expect(result.total).toBe(3);
    expect(result.failures.map((failure) => failure.productId)).toEqual(["2"]);

    // Still published: some of it is live, and calling it a draft would tell the
    // merchant nothing is showing when something is.
    expect(result.offer.status).toBe("published");
  });

  test("a failed product is left unsynced for the repair action", async () => {
    const offer = await offerFor([product(2)], [product(10)]);
    await publishOffer({ admin: stubAdmin({ failFor: ["2"] }), shopId, offer });

    const override = await getOverride({ shopId, productId: "2", placement: "pdp" });
    // The row is written either way; only the sync failed.
    expect(override).toBeTruthy();
    expect(override.syncedAt).toBeNull();
  });

  test("every product failing leaves the offer a draft", async () => {
    const offer = await offerFor([product(1)], [product(10)]);
    const result = await publishOffer({
      admin: stubAdmin({ failFor: ["1"] }),
      shopId,
      offer,
    });

    expect(result.synced).toBe(0);
    expect(result.offer.status).toBe("draft");
  });

  test("re-publishing drops products the offer no longer targets", async () => {
    /*
     * Editing a live offer republishes it (the editor's save path), so a product
     * the merchant removed has to lose its Override row *and* its metafield.
     * Without that its page keeps rendering the offer while nothing in the admin
     * claims it does — and the merchant has no way left to take it down.
     */
    const first = await saveOffer(shopId, {
      name: "Offer",
      placement: "PRODUCT_PAGE",
      offerType: "cross_sell",
      title: "You may also like",
      targets: [product(1), product(2)],
      items: [product(10)],
    });
    await publishOffer({ admin: stubAdmin(), shopId, offer: first });

    const narrowed = await saveOffer(shopId, {
      id: first.id,
      name: "Offer",
      placement: "PRODUCT_PAGE",
      offerType: "cross_sell",
      title: "You may also like",
      targets: [product(1)],
      items: [product(10)],
    });

    const admin = stubAdmin();
    const result = await publishOffer({
      admin,
      shopId,
      offer: narrowed,
      previousTargets: first.targets,
    });

    expect(result.removed).toBe(1);
    expect(result.synced).toBe(1);
    expect(await getOverride({ shopId, productId: "2", placement: "pdp" })).toBeNull();
    expect(await getOverride({ shopId, productId: "1", placement: "pdp" })).toBeTruthy();

    // The metafield goes too — the theme reads nothing else, so leaving it behind
    // is what keeps the old list rendering.
    const deletes = admin.calls.filter((call) => call.query.includes("metafieldsDelete"));
    expect(JSON.stringify(deletes)).toContain("/Product/2");
    expect(JSON.stringify(deletes)).not.toContain("/Product/1");
  });

  test("a first publish takes nothing away", async () => {
    // No previous targets means nothing to subtract; the parameter is optional so
    // the plain publish path reads the same as it always did.
    const offer = await saveOffer(shopId, {
      name: "Offer",
      placement: "PRODUCT_PAGE",
      offerType: "cross_sell",
      title: "You may also like",
      targets: [product(1)],
      items: [product(10)],
    });

    const admin = stubAdmin();
    const result = await publishOffer({ admin, shopId, offer });

    expect(result.removed).toBe(0);
    expect(admin.calls.some((call) => call.query.includes("metafieldsDelete"))).toBe(false);
  });

  test("re-publishing replaces the list rather than appending", async () => {
    const offer = await offerFor([product(1)], [product(10)]);
    await publishOffer({ admin: stubAdmin(), shopId, offer });

    const edited = await saveOffer(shopId, {
      id: offer.id,
      name: "Offer",
      placement: "PRODUCT_PAGE",
      offerType: "cross_sell",
      title: "You may also like",
      buttonText: "Add",
      targets: [product(1)],
      items: [product(20)],
    });
    await publishOffer({ admin: stubAdmin(), shopId, offer: edited });

    const override = await getOverride({ shopId, productId: "1", placement: "pdp" });
    expect(override.items.map((item) => item.id)).toEqual(["20"]);
  });
});

describe("the offer's wording reaches the metafield", () => {
  /*
   * This is the whole point of the v2 shape: the products a published offer
   * recommends always reached the storefront, but its Title, Badge and Button
   * text did not — the theme block rendered its own settings instead.
   */
  test("publishing writes the copy into the metafield payload", async () => {
    const offer = await saveOffer(shopId, {
      name: "Offer",
      placement: "PRODUCT_PAGE",
      offerType: "cross_sell",
      title: "Complete the set",
      badge: "Limited offer",
      buttonText: "Add to cart",
      countdown: true,
      targets: [product(1)],
      items: [product(10)],
    });

    const admin = stubAdmin();
    await publishOffer({ admin, shopId, offer });

    const value = JSON.parse(admin.calls[0].variables.metafields[0].value);
    expect(value.v).toBe(2);
    expect(value.copy).toEqual({
      title: "Complete the set",
      badge: "Limited offer",
      buttonText: "Add to cart",
      // The countdown brings its own settings when it is on — the model defaults
      // to a 60-minute per-visitor timer with the reference wording.
      countdown: true,
      countdownMode: "fixed",
      countdownMinutes: 60,
      countdownTitle: "Hurry up! Offer expires in {{timer}}",
      visibility: { hideInCart: false, hideTrigger: true, quantityPicker: false },
    });
    expect(value.items.map((item) => item.id)).toEqual(["10"]);
  });

  test("the copy is stored on the row, so a re-sync keeps it", async () => {
    // The Settings repair action iterates Override rows and has no offer in
    // hand; if the copy only travelled with the publish call, a repair would
    // blank the merchant's wording.
    const offer = await saveOffer(shopId, {
      name: "Offer",
      placement: "PRODUCT_PAGE",
      offerType: "cross_sell",
      title: "Complete the set",
      buttonText: "Add to cart",
      targets: [product(1)],
      items: [product(10)],
    });
    await publishOffer({ admin: stubAdmin(), shopId, offer });

    const override = await getOverride({ shopId, productId: "1", placement: "pdp" });
    expect(override.presentation).toMatchObject({
      title: "Complete the set",
      buttonText: "Add to cart",
    });
  });

  test("publishing writes the offer type, end to end", async () => {
    /*
     * The type is what makes the injected offer render the way the editor
     * previewed it — a carousel of rows for a cross-sell (§7.6). It has to travel
     * the whole way: publish -> Override.presentation -> metafield. It once went
     * onto the publish call but was dropped by normalizePresentation, so the
     * storefront kept rendering a grid with every test still green.
     */
    const offer = await saveOffer(shopId, {
      name: "Offer",
      placement: "PRODUCT_PAGE",
      offerType: "product_add_on",
      title: "Add a case",
      buttonText: "Add",
      targets: [product(1)],
      items: [product(10)],
    });

    const admin = stubAdmin();
    await publishOffer({ admin, shopId, offer });

    const value = JSON.parse(admin.calls[0].variables.metafields[0].value);
    expect(value.type).toBe("product_add_on");

    // And on the row, so the Settings re-sync writes it again without the offer.
    const override = await getOverride({ shopId, productId: "1", placement: "pdp" });
    expect(override.presentation).toMatchObject({ type: "product_add_on" });
  });

  test("an offer with no wording leaves the block settings in charge", async () => {
    const offer = await saveOffer(shopId, {
      name: "Offer",
      placement: "PRODUCT_PAGE",
      offerType: "cross_sell",
      title: "",
      badge: "",
      buttonText: "",
      targets: [product(1)],
      items: [product(10)],
    });

    const admin = stubAdmin();
    await publishOffer({ admin, shopId, offer });

    // buttonText defaults to "Add" in the model, so that alone is present —
    // what matters is that an empty title never becomes a blank heading.
    const value = JSON.parse(admin.calls[0].variables.metafields[0].value);
    expect(value.copy?.title ?? "").toBe("");
  });
});

describe("shop-scope offers publish to the shop metafield", () => {
  /*
   * "All products" and a collections trigger cannot write a row per product, so
   * they take the other path entirely: no Override rows, one shop metafield, and
   * the trigger matched on the storefront (app/lib/shop-offers.server.js).
   */
  const shopScope = (overrides = {}) => ({
    name: "Catalogue offer",
    placement: "PRODUCT_PAGE",
    offerType: "cross_sell",
    title: "You may also like",
    triggerMode: "all",
    targets: [],
    items: [product(10)],
    ...overrides,
  });

  test("writes no override rows at all", async () => {
    const offer = await saveOffer(shopId, shopScope());
    const admin = stubAdmin();

    const result = await publishOffer({ admin, shopId, offer });

    expect(result.offer.status).toBe("published");
    expect(result.synced).toBe(1);
    expect(await prisma.override.count({ where: { shopId } })).toBe(0);

    // One shop metafield, not one per product.
    const sets = admin.calls.filter((call) => call.query.includes("metafieldsSet"));
    expect(sets).toHaveLength(1);
    expect(sets[0].variables.metafields[0].key).toBe("reco_offers");
  });

  test("a failed write leaves the offer a draft rather than a false claim", async () => {
    /*
     * Rolled back, unlike the per-product path: there is one write here, so a
     * failure means *nothing* is live — and an offer left marked published would
     * claim to be showing on every product page while showing on none.
     */
    const offer = await saveOffer(shopId, shopScope());
    const result = await publishOffer({
      admin: stubAdmin({ failFor: ["Shop/1"] }),
      shopId,
      offer,
    });

    expect(result.offer.status).toBe("draft");
    expect(result.synced).toBe(0);
    expect(result.failures).toHaveLength(1);
    expect(await getOffer(shopId, offer.id)).toMatchObject({ status: "draft" });
  });

  test("unpublishing drops it from the list and touches no product", async () => {
    const offer = await saveOffer(shopId, shopScope());
    const published = await publishOffer({ admin: stubAdmin(), shopId, offer });

    const admin = stubAdmin();
    const result = await unpublishOffer({ admin, shopId, offer: published.offer });

    expect(result.offer.status).toBe("draft");
    expect(result.removed).toBe(1);
    expect(result.failures).toEqual([]);
    // No metafieldsDelete: nothing was written per product to delete.
    expect(admin.calls.some((call) => call.query.includes("metafieldsDelete"))).toBe(false);
  });

  test("a failed unpublish reports rather than restoring published", async () => {
    // The offer is *meant* to be off. Quietly marking it published again would tell
    // the merchant it is live when they just took it down; a stale metafield is
    // what the Settings re-sync is for.
    const offer = await saveOffer(shopId, shopScope());
    const published = await publishOffer({ admin: stubAdmin(), shopId, offer });

    const result = await unpublishOffer({
      admin: stubAdmin({ failFor: ["Shop/1"] }),
      shopId,
      offer: published.offer,
    });

    expect(result.offer.status).toBe("draft");
    expect(result.failures).toHaveLength(1);
  });
});

describe("unpublishOffer", () => {
  test("removes the override and the metafield for every target", async () => {
    const offer = await offerFor([product(1), product(2)], [product(10)]);
    const published = (await publishOffer({ admin: stubAdmin(), shopId, offer })).offer;

    const admin = stubAdmin();
    const result = await unpublishOffer({ admin, shopId, offer: published });

    expect(result.removed).toBe(2);
    expect(result.offer.status).toBe("draft");
    expect(await getOverride({ shopId, productId: "1", placement: "pdp" })).toBeNull();
    expect(await getOverride({ shopId, productId: "2", placement: "pdp" })).toBeNull();

    // The metafield has to go too: leaving it behind keeps the old list
    // rendering on the product page.
    expect(admin.calls.length).toBe(2);
  });

  test("is idempotent", async () => {
    const offer = await offerFor([product(1)], [product(10)]);
    const published = (await publishOffer({ admin: stubAdmin(), shopId, offer })).offer;

    await unpublishOffer({ admin: stubAdmin(), shopId, offer: published });
    const second = await unpublishOffer({ admin: stubAdmin(), shopId, offer: published });

    expect(second.failures).toEqual([]);
    expect(second.offer.status).toBe("draft");
  });
});

describe("newlyOccupiedTargets", () => {
  test("counts only products nobody has published", () => {
    const offer = { targets: [product(1), product(2), product(3)] };
    expect(
      newlyOccupiedTargets(offer, new Set(["2"])).map((target) => target.id),
    ).toEqual(["1", "3"]);
  });

  test("counts a repeated product once", () => {
    const offer = { targets: [product(1), product(1)] };
    expect(newlyOccupiedTargets(offer, new Set())).toHaveLength(1);
  });

  test("survives an offer with no targets", () => {
    expect(newlyOccupiedTargets({}, new Set())).toEqual([]);
  });
});
