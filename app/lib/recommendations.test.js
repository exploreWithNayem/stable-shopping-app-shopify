import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import prisma from "../db.server";
import { upsertOverride } from "../models/override.server";
import {
  MAX_LIMIT,
  clearRecommendationCache,
  fromProductGid,
  getShopifyRecommendations,
  hydrateOverrideItems,
  normalizeProduct,
  resolveRecommendations,
  toOverridePlacement,
  toProductGid,
} from "./recommendations.server";

const DOMAIN = "vitest-reco.myshopify.com";
let shop;

/** Storefront API-shaped node. */
const node = (id, overrides = {}) => ({
  id: `gid://shopify/Product/${id}`,
  handle: `product-${id}`,
  title: `Product ${id}`,
  onlineStoreUrl: `https://${DOMAIN}/products/product-${id}`,
  availableForSale: true,
  featuredImage: { url: `https://cdn/${id}.jpg`, altText: `Alt ${id}` },
  priceRange: { minVariantPrice: { amount: "10.00", currencyCode: "USD" } },
  compareAtPriceRange: { minVariantPrice: { amount: "0.00", currencyCode: "USD" } },
  ...overrides,
});

/** Stub for storefrontGraphql that records calls. */
function stubGraphql(handler) {
  const calls = [];
  const fn = async (domain, token, query, variables) => {
    calls.push({ domain, token, query, variables });
    return handler(variables, query);
  };
  fn.calls = calls;
  return fn;
}

const recommends = (...ids) =>
  stubGraphql(() => ({ productRecommendations: ids.map((id) => node(id)) }));

beforeEach(async () => {
  clearRecommendationCache();
  await prisma.shop.deleteMany({ where: { domain: DOMAIN } });
  shop = await prisma.shop.create({
    data: { domain: DOMAIN, storefrontToken: "shpat_test_token" },
  });
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { domain: DOMAIN } });
});

describe("id helpers", () => {
  test("toProductGid accepts numeric ids and passes GIDs through", () => {
    expect(toProductGid(123)).toBe("gid://shopify/Product/123");
    expect(toProductGid("gid://shopify/Product/123")).toBe(
      "gid://shopify/Product/123",
    );
    expect(toProductGid("")).toBeNull();
  });

  test("fromProductGid extracts the numeric id", () => {
    expect(fromProductGid("gid://shopify/Product/123")).toBe("123");
  });

  test("placements collapse to the two override buckets", () => {
    expect(toOverridePlacement("pdp")).toBe("pdp");
    expect(toOverridePlacement("checkout")).toBe("checkout");
    expect(toOverridePlacement("thank_you")).toBe("checkout");
    expect(toOverridePlacement("order_status")).toBe("checkout");
  });
});

describe("normalizeProduct", () => {
  test("flattens the Storefront shape", () => {
    expect(normalizeProduct(node(7))).toMatchObject({
      id: "7",
      gid: "gid://shopify/Product/7",
      handle: "product-7",
      title: "Product 7",
      image: "https://cdn/7.jpg",
      imageAlt: "Alt 7",
      price: 10,
      currencyCode: "USD",
      available: true,
    });
  });

  // Shopify returns 0 or the selling price when nothing is on sale; rendering
  // that as a strike-through would invent a fake discount.
  test("keeps compareAtPrice only when it is genuinely higher", () => {
    expect(normalizeProduct(node(1)).compareAtPrice).toBeNull();
    expect(
      normalizeProduct(
        node(1, {
          compareAtPriceRange: {
            minVariantPrice: { amount: "10.00", currencyCode: "USD" },
          },
        }),
      ).compareAtPrice,
    ).toBeNull();
    expect(
      normalizeProduct(
        node(1, {
          compareAtPriceRange: {
            minVariantPrice: { amount: "15.00", currencyCode: "USD" },
          },
        }),
      ).compareAtPrice,
    ).toBe(15);
  });

  test("falls back to a handle URL and the title for alt text", () => {
    const product = normalizeProduct(
      node(2, { onlineStoreUrl: null, featuredImage: { url: "u", altText: null } }),
    );
    expect(product.url).toBe("/products/product-2");
    expect(product.imageAlt).toBe("Product 2");
  });

  test("returns null for an unusable node", () => {
    expect(normalizeProduct(null)).toBeNull();
    expect(normalizeProduct({})).toBeNull();
  });
});

describe("getShopifyRecommendations", () => {
  test("uppercases the intent for the enum", async () => {
    const graphql = recommends(1);
    await getShopifyRecommendations({ shop, productId: 5, intent: "complementary", graphql });
    expect(graphql.calls[0].variables).toMatchObject({
      productId: "gid://shopify/Product/5",
      intent: "COMPLEMENTARY",
    });
  });

  test("falls back to RELATED for an unknown intent", async () => {
    const graphql = recommends(1);
    await getShopifyRecommendations({ shop, productId: 5, intent: "bogus", graphql });
    expect(graphql.calls[0].variables.intent).toBe("RELATED");
  });

  test("clamps the limit to what the API can return", async () => {
    const graphql = recommends(...Array.from({ length: 10 }, (_, i) => i + 1));
    const items = await getShopifyRecommendations({ shop, productId: 5, limit: 50, graphql });
    expect(items).toHaveLength(MAX_LIMIT);
  });

  test("throws without a storefront token", async () => {
    const tokenless = { ...shop, storefrontToken: null };
    await expect(
      getShopifyRecommendations({ shop: tokenless, productId: 5, graphql: recommends(1) }),
    ).rejects.toThrow(/Storefront access token/);
  });
});

describe("caching", () => {
  test("serves a repeat request without calling the API again", async () => {
    const graphql = recommends(1, 2, 3);
    await getShopifyRecommendations({ shop, productId: 5, graphql });
    await getShopifyRecommendations({ shop, productId: 5, graphql });
    expect(graphql.calls).toHaveLength(1);
  });

  // Cached whole, sliced per request, so a 2-item widget and a 4-item widget
  // on the same product share one fetch.
  test("different limits share one fetch", async () => {
    const graphql = recommends(1, 2, 3, 4);
    const four = await getShopifyRecommendations({ shop, productId: 5, limit: 4, graphql });
    const two = await getShopifyRecommendations({ shop, productId: 5, limit: 2, graphql });

    expect(graphql.calls).toHaveLength(1);
    expect(four).toHaveLength(4);
    expect(two).toHaveLength(2);
  });

  test("keys separately by product and intent", async () => {
    const graphql = recommends(1);
    await getShopifyRecommendations({ shop, productId: 5, intent: "related", graphql });
    await getShopifyRecommendations({ shop, productId: 6, intent: "related", graphql });
    await getShopifyRecommendations({ shop, productId: 5, intent: "complementary", graphql });
    expect(graphql.calls).toHaveLength(3);
  });

  test("refetches once the entry expires", async () => {
    vi.useFakeTimers();
    const graphql = recommends(1);

    await getShopifyRecommendations({ shop, productId: 5, graphql });
    vi.advanceTimersByTime(61_000);
    await getShopifyRecommendations({ shop, productId: 5, graphql });

    expect(graphql.calls).toHaveLength(2);
  });
});

describe("hydrateOverrideItems", () => {
  test("returns products in the saved order", async () => {
    const graphql = stubGraphql(({ ids }) => ({
      // Deliberately answered out of order.
      nodes: [...ids].reverse().map((gid) => node(fromProductGid(gid))),
    }));

    const items = await hydrateOverrideItems({
      shop,
      items: [{ id: "3" }, { id: "1" }, { id: "2" }],
      graphql,
    });

    expect(items.map((i) => i.id)).toEqual(["3", "1", "2"]);
  });

  // A deleted or unpublished product comes back as null; a blank card is worse
  // than a shorter row.
  test("drops items the API cannot resolve", async () => {
    const graphql = stubGraphql(() => ({ nodes: [node(1), null, node(3)] }));
    const items = await hydrateOverrideItems({
      shop,
      items: [{ id: "1" }, { id: "2" }, { id: "3" }],
      graphql,
    });

    expect(items.map((i) => i.id)).toEqual(["1", "3"]);
  });

  test("skips the API entirely for an empty list", async () => {
    const graphql = stubGraphql(() => ({ nodes: [] }));
    expect(await hydrateOverrideItems({ shop, items: [], graphql })).toEqual([]);
    expect(graphql.calls).toHaveLength(0);
  });
});

describe("resolveRecommendations", () => {
  const saveOverride = (placement, items = [{ id: "11" }, { id: "12" }], extra = {}) =>
    upsertOverride({
      shopId: shop.id,
      productId: 5,
      productTitle: "Source",
      productHandle: "source",
      placement,
      items,
      ...extra,
    });

  test("falls back to Shopify when there is no override", async () => {
    const result = await resolveRecommendations({
      shop,
      productId: 5,
      graphql: recommends(1, 2),
    });

    expect(result.source).toBe("shopify");
    expect(result.items.map((i) => i.id)).toEqual(["1", "2"]);
  });

  test("an override replaces the Shopify list", async () => {
    await saveOverride("pdp");
    const graphql = stubGraphql(({ ids }) =>
      ids
        ? { nodes: ids.map((gid) => node(fromProductGid(gid))) }
        : { productRecommendations: [node(99)] },
    );

    const result = await resolveRecommendations({ shop, productId: 5, graphql });

    expect(result.source).toBe("override");
    expect(result.items.map((i) => i.id)).toEqual(["11", "12"]);
  });

  test("a disabled override is ignored", async () => {
    await saveOverride("pdp", [{ id: "11" }], { enabled: false });
    const result = await resolveRecommendations({
      shop,
      productId: 5,
      graphql: recommends(1),
    });

    expect(result.source).toBe("shopify");
  });

  test("a 'both' override covers checkout surfaces", async () => {
    await saveOverride("both");
    const graphql = stubGraphql(({ ids }) => ({
      nodes: ids.map((gid) => node(fromProductGid(gid))),
    }));

    for (const placement of ["pdp", "checkout", "thank_you", "order_status"]) {
      const result = await resolveRecommendations({ shop, productId: 5, placement, graphql });
      expect(result.source).toBe("override");
    }
  });

  test("an exact placement override wins over 'both'", async () => {
    await saveOverride("both", [{ id: "11" }]);
    await saveOverride("checkout", [{ id: "22" }]);
    const graphql = stubGraphql(({ ids }) => ({
      nodes: ids.map((gid) => node(fromProductGid(gid))),
    }));

    const result = await resolveRecommendations({
      shop,
      productId: 5,
      placement: "checkout",
      graphql,
    });
    expect(result.items.map((i) => i.id)).toEqual(["22"]);
  });

  test("honours the limit", async () => {
    const result = await resolveRecommendations({
      shop,
      productId: 5,
      limit: 2,
      graphql: recommends(1, 2, 3, 4),
    });
    expect(result.items).toHaveLength(2);
  });

  // The storefront must keep rendering even when our Storefront call fails.
  test("degrades instead of throwing when the API fails", async () => {
    const graphql = stubGraphql(() => {
      throw new Error("Storefront API responded 500");
    });

    const result = await resolveRecommendations({ shop, productId: 5, graphql });

    expect(result).toMatchObject({ source: "shopify", items: [], degraded: true });
    expect(result.reason).toMatch(/500/);
  });

  /*
   * An override pointing only at deleted or unpublished products used to return
   * `{ source: "override", items: [] }` — no fallback and no `degraded` flag —
   * so the surface rendered nothing at all. The merchant's intent was
   * "recommend something here", and the list they curated no longer exists to
   * honour.
   */
  test("an override whose products are all gone falls back to Shopify", async () => {
    await saveOverride("pdp", [{ id: "11" }, { id: "12" }]);
    const graphql = stubGraphql(({ ids }) =>
      // nodes(ids:) answers null for anything deleted or unpublished.
      ids ? { nodes: ids.map(() => null) } : { productRecommendations: [node(77)] },
    );

    const result = await resolveRecommendations({ shop, productId: 5, graphql });

    expect(result.source).toBe("shopify");
    expect(result.items.map((i) => i.id)).toEqual(["77"]);
    expect(result.degraded).toBeUndefined();
  });

  test("a partly resolvable override is still the override", async () => {
    // One survivor is a list; falling back would discard the merchant's choice.
    await saveOverride("pdp", [{ id: "11" }, { id: "12" }]);
    const graphql = stubGraphql(({ ids }) =>
      ids
        ? { nodes: [node(fromProductGid(ids[0])), null] }
        : { productRecommendations: [node(77)] },
    );

    const result = await resolveRecommendations({ shop, productId: 5, graphql });

    expect(result.source).toBe("override");
    expect(result.items.map((i) => i.id)).toEqual(["11"]);
  });

  test("degrades when the shop has no storefront token", async () => {
    const result = await resolveRecommendations({
      shop: { ...shop, storefrontToken: null },
      productId: 5,
      graphql: recommends(1),
    });

    expect(result).toMatchObject({ items: [], degraded: true });
  });
});
