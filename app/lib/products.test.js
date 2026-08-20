import { describe, expect, test } from "vitest";
import {
  PAGE_SIZE,
  getProductsByIds,
  listProducts,
  normalizeAdminProduct,
  sanitizeSearchTerm,
  toProductGid,
} from "./products.server";

const node = (id, overrides = {}) => ({
  id: `gid://shopify/Product/${id}`,
  title: `Product ${id}`,
  handle: `product-${id}`,
  status: "ACTIVE",
  totalInventory: 5,
  featuredMedia: {
    preview: { image: { url: `https://cdn/${id}.jpg`, altText: `Alt ${id}` } },
  },
  ...overrides,
});

/** Stand-in for the authenticated admin client. */
function stubAdmin(respond) {
  const calls = [];
  return {
    calls,
    graphql: async (query, options) => {
      calls.push({ query, variables: options?.variables ?? {} });
      return { json: async () => ({ data: respond(options?.variables ?? {}) }) };
    },
  };
}

describe("normalizeAdminProduct", () => {
  test("flattens the featuredMedia preview path", () => {
    expect(normalizeAdminProduct(node(9))).toMatchObject({
      id: "9",
      gid: "gid://shopify/Product/9",
      title: "Product 9",
      handle: "product-9",
      status: "ACTIVE",
      image: "https://cdn/9.jpg",
      imageAlt: "Alt 9",
    });
  });

  test("survives a product with no media", () => {
    const product = normalizeAdminProduct(node(9, { featuredMedia: null }));
    expect(product.image).toBeNull();
    expect(product.imageAlt).toBe("Product 9");
  });

  test("returns null for an unusable node", () => {
    expect(normalizeAdminProduct(null)).toBeNull();
    expect(normalizeAdminProduct({})).toBeNull();
  });
});

describe("toProductGid", () => {
  test("accepts numeric ids and passes GIDs through", () => {
    expect(toProductGid(4)).toBe("gid://shopify/Product/4");
    expect(toProductGid("gid://shopify/Product/4")).toBe("gid://shopify/Product/4");
    expect(toProductGid(null)).toBeNull();
  });
});

describe("listProducts", () => {
  const connection = () => ({
    products: {
      pageInfo: { hasNextPage: true, hasPreviousPage: false, startCursor: "s", endCursor: "e" },
      nodes: [node(1), node(2)],
    },
  });

  test("pages forward with first/after", async () => {
    const admin = stubAdmin(connection);
    await listProducts(admin, { after: "cursor-1" });

    expect(admin.calls[0].variables).toMatchObject({
      first: PAGE_SIZE,
      after: "cursor-1",
      last: null,
      before: null,
    });
  });

  // Shopify rejects first+before together, so the direction has to swap.
  test("pages backward with last/before", async () => {
    const admin = stubAdmin(connection);
    await listProducts(admin, { before: "cursor-9" });

    expect(admin.calls[0].variables).toMatchObject({
      last: PAGE_SIZE,
      before: "cursor-9",
      first: null,
      after: null,
    });
  });

  test("wraps the search term in Shopify's title syntax", async () => {
    const admin = stubAdmin(connection);
    await listProducts(admin, { search: "snow" });
    expect(admin.calls[0].variables.query).toBe("title:*snow*");
  });

  /*
   * The query is built by interpolation, so the search box was one `"` away
   * from producing a syntax error and one `OR status:draft` away from silently
   * widening the result set. Merchant-scoped and read-only, so hygiene rather
   * than a hole — but a product called `12" Skateboard` was unsearchable.
   */
  test("strips the characters that mean something to Shopify's search grammar", () => {
    expect(sanitizeSearchTerm('12" board')).toBe("12 board");
    expect(sanitizeSearchTerm("x OR status:draft")).toBe("x OR status draft");
    expect(sanitizeSearchTerm("a*b(c)")).toBe("a b c");
    expect(sanitizeSearchTerm("  spaced   out  ")).toBe("spaced out");
    expect(sanitizeSearchTerm(null)).toBe("");
  });

  test("a search of nothing but punctuation filters nothing", async () => {
    // Sanitising down to an empty string must mean "everything", not `title:**`.
    const admin = stubAdmin(() => ({ products: { nodes: [], pageInfo: {} } }));
    await listProducts(admin, { search: '**' });
    expect(admin.calls[0].variables.query).toBeNull();
  });

  test("sanitises before wrapping in the title syntax", async () => {
    const admin = stubAdmin(() => ({ products: { nodes: [], pageInfo: {} } }));
    await listProducts(admin, { search: 'snow"board' });
    expect(admin.calls[0].variables.query).toBe("title:*snow board*");
  });

  test("sends no query filter when the search is empty", async () => {
    const admin = stubAdmin(connection);
    await listProducts(admin, { search: "" });
    expect(admin.calls[0].variables.query).toBeNull();
  });

  test("maps sort options onto ProductSortKeys", async () => {
    const admin = stubAdmin(connection);
    await listProducts(admin, { sort: "title_desc" });
    expect(admin.calls[0].variables).toMatchObject({ sortKey: "TITLE", reverse: true });

    await listProducts(admin, { sort: "updated" });
    expect(admin.calls[1].variables).toMatchObject({ sortKey: "UPDATED_AT", reverse: true });
  });

  test("falls back to the default sort for an unknown value", async () => {
    const admin = stubAdmin(connection);
    await listProducts(admin, { sort: "bogus" });
    expect(admin.calls[0].variables).toMatchObject({ sortKey: "TITLE", reverse: false });
  });

  test("returns a usable shape when the response is empty", async () => {
    const admin = stubAdmin(() => ({ products: null }));
    const result = await listProducts(admin, {});
    expect(result.products).toEqual([]);
    expect(result.pageInfo.hasNextPage).toBe(false);
  });
});

describe("getProductsByIds", () => {
  test("returns products in the order requested", async () => {
    const admin = stubAdmin(({ ids }) => ({
      nodes: [...ids].reverse().map((gid) => node(gid.split("/").pop())),
    }));

    const products = await getProductsByIds(admin, ["3", "1", "2"]);
    expect(products.map((p) => p.id)).toEqual(["3", "1", "2"]);
  });

  test("drops ids the API cannot resolve", async () => {
    const admin = stubAdmin(() => ({ nodes: [node(1), null] }));
    const products = await getProductsByIds(admin, ["1", "2"]);
    expect(products.map((p) => p.id)).toEqual(["1"]);
  });

  test("skips the request entirely for an empty list", async () => {
    const admin = stubAdmin(() => ({ nodes: [] }));
    expect(await getProductsByIds(admin, [])).toEqual([]);
    expect(admin.calls).toHaveLength(0);
  });
});
