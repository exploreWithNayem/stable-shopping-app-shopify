import { afterAll, beforeEach, describe, expect, test } from "vitest";
import prisma from "../db.server";
import { saveOffer, markPublished } from "../models/offer.server";
import {
  buildShopOffersValue,
  listShopScopeOffers,
  projectOffer,
  syncShopOffers,
} from "./shop-offers.server";

/*
 * Offers whose trigger is "all products" or a collection cannot be mirrored per
 * product — that would be thousands of metafield writes on a real catalogue, and
 * every one would count against the per-product plan allowance. They go into one
 * shop-owned metafield instead, and the trigger is matched on the storefront.
 *
 * What matters here: what ships in that metafield (and what does not), the order it
 * ships in, and that only published shop-scope offers are in it.
 */

const DOMAIN = "vitest-shop-offers.myshopify.com";
let shopId;

const product = (id) => ({ id: String(id), handle: `p${id}`, title: `Product ${id}` });
const collection = (handle) => ({ id: `9${handle.length}`, handle, title: handle });

const offer = (overrides = {}) => ({
  name: "Offer",
  placement: "PRODUCT_PAGE",
  offerType: "cross_sell",
  title: "You may also like",
  buttonText: "Add",
  targets: [],
  items: [product(10)],
  triggerMode: "all",
  ...overrides,
});

/** Records the mutations, and lets a test force a userError. */
function stubAdmin({ failWith = null } = {}) {
  const calls = [];

  return {
    calls,
    graphql: async (query, options) => {
      calls.push({ query, variables: options?.variables ?? {} });

      if (query.includes("RecoShopId")) {
        return { json: async () => ({ data: { shop: { id: "gid://shopify/Shop/1" } } }) };
      }

      return {
        json: async () => ({
          data: {
            metafieldsSet: {
              metafields: failWith ? [] : [{ id: "gid://shopify/Metafield/1" }],
              userErrors: failWith ? [{ field: ["value"], message: failWith }] : [],
            },
          },
        }),
      };
    },
  };
}

beforeEach(async () => {
  await prisma.shop.deleteMany({ where: { domain: DOMAIN } });
  const shop = await prisma.shop.create({ data: { domain: DOMAIN } });
  shopId = shop.id;
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { domain: DOMAIN } });
});

describe("projectOffer", () => {
  test("ships what the storefront matches on, not the row", async () => {
    /*
     * The metafield is public. A merchant's internal offer name, their timestamps
     * and their status are their business; what goes out is what Liquid matches and
     * what reco.js draws.
     */
    const saved = await saveOffer(
      shopId,
      offer({
        name: "Internal name nobody should see",
        triggerMode: "collections",
        triggerCollections: [collection("summer"), collection("sale")],
        excludeProducts: [product(77)],
        excludeCollections: [collection("clearance")],
      }),
    );

    const projected = projectOffer(saved);

    expect(projected.trigger).toEqual({ mode: "collections", collections: ["summer", "sale"] });
    expect(projected.exclude).toEqual({ products: ["77"], collections: ["clearance"] });
    expect(JSON.stringify(projected)).not.toContain("Internal name");
    expect(projected.name).toBeUndefined();
    expect(projected.status).toBeUndefined();
  });

  test("an automated offer carries no items", async () => {
    // Shopify supplies the list in the browser; shipping a stale copy of it would
    // be worse than shipping none.
    const saved = await saveOffer(
      shopId,
      offer({ offerSource: "automated", offerIntent: "complementary", items: [product(10)] }),
    );

    const projected = projectOffer(saved);
    expect(projected.items).toEqual([]);
    expect(projected.source).toEqual({ mode: "automated", intent: "complementary" });
  });

  test("visibility and copy travel with it", async () => {
    const saved = await saveOffer(
      shopId,
      offer({
        badge: "Limited",
        countdown: true,
        hideInCart: true,
        hideTriggerProduct: false,
        showQuantityPicker: true,
      }),
    );

    const projected = projectOffer(saved);
    expect(projected.visibility).toEqual({
      hideInCart: true,
      hideTrigger: false,
      quantityPicker: true,
    });
    expect(projected.copy).toMatchObject({ badge: "Limited", countdown: true });
    expect(projected.copy.countdownMode).toBe("fixed");
  });
});

describe("projectOffer on a row with nothing in its Json columns", () => {
  test("empty lists, not null, so Liquid's `contains` has something to read", async () => {
    /*
     * A row written before those columns existed carries null (they are nullable
     * and undefaulted for the reason in the model tests). `contains` against null
     * in Liquid is not an error but it is not a match either — the projection
     * coalesces so the metafield always ships arrays.
     */
    const saved = await saveOffer(shopId, offer());
    await prisma.$executeRawUnsafe(
      `UPDATE "Offer" SET "triggerCollections" = NULL, "excludeProducts" = NULL,
       "excludeCollections" = NULL WHERE id = ?`,
      saved.id,
    );

    const [row] = await prisma.offer.findMany({ where: { id: saved.id } });
    const projected = projectOffer(row);

    expect(projected.trigger.collections).toEqual([]);
    expect(projected.exclude).toEqual({ products: [], collections: [] });
  });
});

describe("listShopScopeOffers", () => {
  test("only published offers, and only shop-scope ones", async () => {
    const live = await saveOffer(shopId, offer({ name: "Live all-products" }));
    await markPublished(live.id);

    // A draft, and a named-products offer: neither belongs in the shop list.
    await saveOffer(shopId, offer({ name: "Draft" }));
    const named = await saveOffer(
      shopId,
      offer({ name: "Named", triggerMode: "products", targets: [product(1)] }),
    );
    await markPublished(named.id);

    const listed = await listShopScopeOffers(shopId);
    expect(listed.map((entry) => entry.name)).toEqual(["Live all-products"]);
  });

  test("oldest published first, so a later broad offer cannot take over", async () => {
    /*
     * The embed renders the **first** match. Newest-first would let one new "All
     * products" offer silently swallow every page a collection offer was covering.
     */
    const first = await saveOffer(shopId, offer({ name: "First" }));
    const second = await saveOffer(shopId, offer({ name: "Second" }));
    for (const row of [first, second]) await markPublished(row.id);

    await prisma.offer.update({
      where: { id: first.id },
      data: { createdAt: new Date("2026-01-01T00:00:00Z") },
    });
    await prisma.offer.update({
      where: { id: second.id },
      data: { createdAt: new Date("2026-06-01T00:00:00Z") },
    });

    expect((await listShopScopeOffers(shopId)).map((entry) => entry.name)).toEqual([
      "First",
      "Second",
    ]);
  });
});

describe("syncShopOffers", () => {
  test("rebuilds the whole list rather than patching it", async () => {
    const live = await saveOffer(shopId, offer());
    await markPublished(live.id);

    const admin = stubAdmin();
    const result = await syncShopOffers({ admin, shopId, now: new Date("2026-08-21T00:00:00Z") });

    expect(result.count).toBe(1);

    const write = admin.calls.find((call) => call.query.includes("metafieldsSet"));
    const [metafield] = write.variables.metafields;

    expect(metafield.ownerId).toBe("gid://shopify/Shop/1");
    expect(metafield.namespace).toBe("$app");
    expect(metafield.key).toBe("reco_offers");
    expect(metafield.type).toBe("json");

    const value = JSON.parse(metafield.value);
    expect(value).toMatchObject({ v: 1, updatedAt: "2026-08-21T00:00:00.000Z" });
    expect(value.offers).toHaveLength(1);
  });

  test("an unpublished offer simply is not in the rebuilt list", async () => {
    // Which is what makes unpublish and delete fall out for free — nothing has to
    // find the offer in the metafield and remove it.
    const live = await saveOffer(shopId, offer());
    await markPublished(live.id);
    await prisma.offer.update({ where: { id: live.id }, data: { status: "draft" } });

    const admin = stubAdmin();
    await syncShopOffers({ admin, shopId });

    const write = admin.calls.find((call) => call.query.includes("metafieldsSet"));
    expect(JSON.parse(write.variables.metafields[0].value).offers).toEqual([]);
  });

  test("a userError throws, so the caller can say it is not live", async () => {
    const live = await saveOffer(shopId, offer());
    await markPublished(live.id);

    await expect(
      syncShopOffers({ admin: stubAdmin({ failWith: "Metafield is invalid" }), shopId }),
    ).rejects.toThrow("Metafield is invalid");
  });
});

describe("buildShopOffersValue", () => {
  test("an empty shop writes an empty list, not nothing", () => {
    // The metafield has to exist and say "no offers", or the last published list
    // would keep rendering.
    const value = JSON.parse(buildShopOffersValue([], { now: new Date("2026-08-21T00:00:00Z") }));
    expect(value).toEqual({ v: 1, updatedAt: "2026-08-21T00:00:00.000Z", offers: [] });
  });
});
