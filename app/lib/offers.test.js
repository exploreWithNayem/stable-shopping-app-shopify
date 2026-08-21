import { afterAll, beforeEach, describe, expect, test } from "vitest";
import prisma from "../db.server";
import { saveOffer } from "../models/offer.server";
import { getOverride, upsertOverride } from "../models/override.server";
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

describe("an offer never outlives its storefront footprint", () => {
  /*
   * The bug: "I deleted the offer but it is still showing." Takedown worked from the
   * offer's *current* targets, so a merchant who edited the product list, or switched
   * the trigger, left rows and metafields behind that nothing could find afterwards —
   * and those pages kept rendering with no way in the admin to stop them.
   *
   * `Override.offerId` records who wrote each row, so a takedown can find everything
   * regardless of what the offer says now.
   */
  const named = (overrides = {}) => ({
    name: "Offer",
    placement: "PRODUCT_PAGE",
    offerType: "cross_sell",
    title: "You may also like",
    triggerMode: "products",
    targets: [product(1), product(2)],
    items: [product(10)],
    ...overrides,
  });

  test("publishing records which offer wrote each row", async () => {
    const offer = await saveOffer(shopId, named());
    await publishOffer({ admin: stubAdmin(), shopId, offer });

    const row = await getOverride({ shopId, productId: "1", placement: "pdp" });
    expect(row.offerId).toBe(offer.id);
  });

  test("unpublishing removes rows the offer no longer targets", async () => {
    const offer = await saveOffer(shopId, named());
    await publishOffer({ admin: stubAdmin(), shopId, offer });

    // The merchant drops product 2 from the list and saves — but does not republish.
    const narrowed = await saveOffer(shopId, named({ id: offer.id, targets: [product(1)] }));

    const admin = stubAdmin();
    const result = await unpublishOffer({ admin, shopId, offer: narrowed });

    // Both rows go, including the one the offer had stopped naming.
    expect(result.removed).toBe(2);
    expect(await getOverride({ shopId, productId: "1", placement: "pdp" })).toBeNull();
    expect(await getOverride({ shopId, productId: "2", placement: "pdp" })).toBeNull();

    const deletes = JSON.stringify(
      admin.calls.filter((call) => call.query.includes("metafieldsDelete")),
    );
    expect(deletes).toContain("/Product/1");
    expect(deletes).toContain("/Product/2");
  });

  test("taking one offer down leaves another offer's row alone", async () => {
    /*
     * Ownership transfers on write: if a second offer publishes onto the same
     * product, the row is that offer's now.
     */
    const first = await saveOffer(shopId, named({ name: "First", targets: [product(1)] }));
    await publishOffer({ admin: stubAdmin(), shopId, offer: first });

    const second = await saveOffer(shopId, named({ name: "Second", targets: [product(1)] }));
    await publishOffer({ admin: stubAdmin(), shopId, offer: second });

    const admin = stubAdmin();
    const result = await unpublishOffer({ admin, shopId, offer: first });

    // The row belongs to the second offer now, so the first one's takedown leaves it
    // — row *and* metafield. Taking one offer down must not take another's list with
    // it, and nothing was removed on the first offer's behalf.
    expect(await getOverride({ shopId, productId: "1", placement: "pdp" })).toBeTruthy();
    expect(result.removed).toBe(0);
    expect(admin.calls.some((call) => call.query.includes("metafieldsDelete"))).toBe(false);
  });

  test("switching back to specific products takes the offer out of the shop list", async () => {
    /*
     * The bug behind "the app embed is on and the UI shows even though there is no
     * offer": an offer published as **all products** and later switched to specific
     * products took the per-product path on republish, nothing rebuilt the shop list,
     * and the offer stayed in it — rendering on *every* product page while the admin
     * showed a two-product offer.
     */
    const broad = await saveOffer(shopId, named({ triggerMode: "all", targets: [] }));
    await publishOffer({ admin: stubAdmin(), shopId, offer: broad });

    const narrowed = await saveOffer(
      shopId,
      named({ id: broad.id, triggerMode: "products", targets: [product(1)] }),
    );

    const admin = stubAdmin();
    await publishOffer({ admin, shopId, offer: narrowed });

    // The shop list is rewritten from what is published and shop-scope — which is now
    // nothing, so it goes out empty.
    const write = admin.calls.find(
      (call) =>
        call.query.includes("metafieldsSet") &&
        call.variables.metafields?.[0]?.key === "reco_offers",
    );
    expect(write).toBeTruthy();
    expect(JSON.parse(write.variables.metafields[0].value).offers).toEqual([]);
  });

  test("taking a per-product offer down also rewrites the shop list", async () => {
    // Same hole, other direction: unpublish used to skip the rebuild for a
    // products-mode offer, so one that had been shop-scope stayed live everywhere.
    const offer = await saveOffer(shopId, named({ targets: [product(1)] }));
    await publishOffer({ admin: stubAdmin(), shopId, offer });

    const admin = stubAdmin();
    await unpublishOffer({ admin, shopId, offer });

    expect(
      admin.calls.some(
        (call) =>
          call.query.includes("metafieldsSet") &&
          call.variables.metafields?.[0]?.key === "reco_offers",
      ),
    ).toBe(true);
  });

  test("switching a trigger cleans up by ownership, not by the caller's memory", async () => {
    // No `previousTargets` passed at all: the rows are the authority.
    const offer = await saveOffer(shopId, named({ targets: [product(1)] }));
    await publishOffer({ admin: stubAdmin(), shopId, offer });

    const broadened = await saveOffer(
      shopId,
      named({ id: offer.id, triggerMode: "all", targets: [] }),
    );

    const result = await publishOffer({ admin: stubAdmin(), shopId, offer: broadened });

    expect(result.removed).toBe(1);
    expect(await getOverride({ shopId, productId: "1", placement: "pdp" })).toBeNull();
  });

  test("an unowned row loses to the takedown, but another offer's does not", async () => {
    // Unowned is indistinguishable from a legacy row this offer wrote, and leaving
    // those behind is exactly the bug being fixed.
    const offer = await saveOffer(shopId, named({ targets: [product(1)] }));
    await publishOffer({ admin: stubAdmin(), shopId, offer });

    // The recommendations page saves without an offer id.
    await upsertOverride({
      shopId,
      productId: "1",
      productTitle: "Product 1",
      productHandle: "p1",
      items: [product(99)],
    });

    const result = await unpublishOffer({ admin: stubAdmin(), shopId, offer });

    /*
     * Taken down. An unowned row is indistinguishable from one this offer wrote
     * before `offerId` existed, and leaving those behind is the bug being fixed — so
     * unowned loses to the takedown. Only a row owned by a *different* offer is
     * spared.
     */
    expect(await getOverride({ shopId, productId: "1", placement: "pdp" })).toBeNull();
    expect(result.removed).toBe(1);
  });
});

describe("exclusions", () => {
  test("an excluded product is never published, and is removed on republish", async () => {
    /*
     * A merchant who names ten pages and excludes one means nine. And because the
     * dropped target falls out of the keep set, republishing after adding the
     * exclusion also removes the row and metafield the earlier publish left there —
     * otherwise the page would keep rendering an offer that no longer claims it.
     */
    const first = await saveOffer(shopId, {
      name: "Offer",
      placement: "PRODUCT_PAGE",
      offerType: "cross_sell",
      title: "You may also like",
      triggerMode: "products",
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
      triggerMode: "products",
      targets: [product(1), product(2)],
      excludeProducts: [product(2)],
      items: [product(10)],
    });

    const admin = stubAdmin();
    const result = await publishOffer({
      admin,
      shopId,
      offer: narrowed,
      previousTargets: first.targets,
    });

    expect(result.synced).toBe(1);
    expect(result.removed).toBe(1);
    expect(await getOverride({ shopId, productId: "1", placement: "pdp" })).toBeTruthy();
    expect(await getOverride({ shopId, productId: "2", placement: "pdp" })).toBeNull();
  });

  test("an excluded product costs no allowance slot", () => {
    // Counting one would refuse a publish over a page the offer will not appear on.
    const offer = {
      targets: [product(1), product(2)],
      excludeProducts: [product(2)],
    };

    expect(newlyOccupiedTargets(offer, new Set()).map((entry) => entry.id)).toEqual(["1"]);
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

  test("switching a live offer to all-products cleans up what it published per product", async () => {
    /*
     * The leak this closes: rows and metafields left on the products a
     * "specific products" offer had named keep rendering the *old* list — a
     * product's own metafield wins over the shop list — while still counting against
     * the per-product plan allowance.
     */
    const named = await saveOffer(shopId, {
      name: "Offer",
      placement: "PRODUCT_PAGE",
      offerType: "cross_sell",
      title: "You may also like",
      triggerMode: "products",
      targets: [product(1)],
      items: [product(10)],
    });
    await publishOffer({ admin: stubAdmin(), shopId, offer: named });
    expect(await getOverride({ shopId, productId: "1", placement: "pdp" })).toBeTruthy();

    const broadened = await saveOffer(shopId, {
      id: named.id,
      name: "Offer",
      placement: "PRODUCT_PAGE",
      offerType: "cross_sell",
      title: "You may also like",
      triggerMode: "all",
      targets: [],
      items: [product(10)],
    });

    const admin = stubAdmin();
    const result = await publishOffer({
      admin,
      shopId,
      offer: broadened,
      previousTargets: named.targets,
    });

    expect(result.everyProduct).toBe(true);
    expect(result.removed).toBe(1);
    expect(await getOverride({ shopId, productId: "1", placement: "pdp" })).toBeNull();
    expect(admin.calls.some((call) => call.query.includes("metafieldsDelete"))).toBe(true);
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

    /*
     * Two metafieldsDelete calls — the metafield has to go with the row, or the old
     * list keeps rendering on the product page.
     *
     * Counted by shape rather than by total calls: the takedown also rebuilds the shop
     * offer list (a shop id lookup plus a metafieldsSet), because an offer that was
     * once "all products" is otherwise left in that list forever.
     */
    const deletes = admin.calls.filter((call) => call.query.includes("metafieldsDelete"));
    expect(deletes).toHaveLength(2);
    expect(admin.calls.some((call) => call.query.includes("metafieldsSet"))).toBe(true);
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
