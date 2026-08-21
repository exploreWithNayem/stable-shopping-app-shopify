/**
 * Admin GraphQL product reads for the recommendations pages.
 *
 * The catalog lives in Shopify, so the list page pages through it with cursors
 * rather than mirroring products locally.
 */

export const PAGE_SIZE = 25;

/** Subset of ProductSortKeys this app offers, mapped from URL values. */
export const SORT_KEYS = {
  title: { sortKey: "TITLE", reverse: false, label: "Title A–Z" },
  title_desc: { sortKey: "TITLE", reverse: true, label: "Title Z–A" },
  updated: { sortKey: "UPDATED_AT", reverse: true, label: "Recently updated" },
};

export const DEFAULT_SORT = "title";

const PRODUCT_FIELDS = `#graphql
  fragment AdminProduct on Product {
    id
    title
    handle
    status
    totalInventory
    featuredMedia {
      preview {
        image {
          url
          altText
        }
      }
    }
    priceRangeV2 {
      minVariantPrice {
        amount
        currencyCode
      }
    }
  }`;

const PRODUCT_LIST_QUERY = `#graphql
  ${PRODUCT_FIELDS}
  query AdminProductList(
    $first: Int
    $last: Int
    $after: String
    $before: String
    $query: String
    $sortKey: ProductSortKeys!
    $reverse: Boolean!
  ) {
    products(
      first: $first
      last: $last
      after: $after
      before: $before
      query: $query
      sortKey: $sortKey
      reverse: $reverse
    ) {
      pageInfo {
        hasNextPage
        hasPreviousPage
        startCursor
        endCursor
      }
      nodes {
        ...AdminProduct
      }
    }
  }`;

const PRODUCTS_BY_ID_QUERY = `#graphql
  ${PRODUCT_FIELDS}
  query AdminProductsByIds($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product {
        ...AdminProduct
      }
    }
  }`;

const PRODUCT_QUERY = `#graphql
  ${PRODUCT_FIELDS}
  query AdminProduct($id: ID!) {
    product(id: $id) {
      ...AdminProduct
    }
  }`;

export function toProductGid(id) {
  const value = String(id ?? "");
  if (!value) return null;
  return value.startsWith("gid://") ? value : `gid://shopify/Product/${value}`;
}

/**
 * Strip the characters that mean something to Shopify's search grammar.
 *
 * The list query is built by interpolation (`title:*<term>*`), so a quote, a
 * bracket or a bare field name in the search box changes the query instead of
 * being searched for — `12"` errors, and `x OR status:draft` quietly widens the
 * result set. Merchant-scoped and read-only, so this is hygiene rather than a
 * hole, but a search for a product called `12" Skateboard` should return it.
 */
export function sanitizeSearchTerm(value) {
  return String(value ?? "")
    .replace(/[\\"'()*:]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeAdminProduct(node) {
  if (!node?.id) return null;

  const image = node.featuredMedia?.preview?.image ?? null;
  /*
   * The cheapest variant, which is what a storefront card shows as "from" price.
   * Kept as the raw amount plus its currency rather than a formatted string: the
   * offer preview formats it with Intl, and a pre-formatted string would have to
   * be re-parsed to do anything else with it.
   */
  const price = node.priceRangeV2?.minVariantPrice ?? null;

  return {
    id: node.id.split("/").pop(),
    gid: node.id,
    title: node.title ?? "",
    handle: node.handle ?? "",
    status: node.status ?? "ACTIVE",
    totalInventory: node.totalInventory ?? 0,
    image: image?.url ?? null,
    imageAlt: image?.altText ?? node.title ?? "",
    price: price ? Number(price.amount) : null,
    currencyCode: price?.currencyCode ?? null,
  };
}

/**
 * One page of the catalog.
 *
 * Pass `before` to page backwards — Shopify requires `last` instead of `first`
 * in that direction, so the two are mutually exclusive.
 */
export async function listProducts(
  admin,
  { search = "", sort = DEFAULT_SORT, after = null, before = null, pageSize = PAGE_SIZE } = {},
) {
  const { sortKey, reverse } = SORT_KEYS[sort] ?? SORT_KEYS[DEFAULT_SORT];
  const paging = before
    ? { last: pageSize, before, first: null, after: null }
    : { first: pageSize, after, last: null, before: null };

  const term = sanitizeSearchTerm(search);

  const response = await admin.graphql(PRODUCT_LIST_QUERY, {
    variables: {
      ...paging,
      // Shopify's search syntax; an empty string means "everything".
      query: term ? `title:*${term}*` : null,
      sortKey,
      reverse,
    },
  });

  const body = await response.json();
  const connection = body?.data?.products;

  return {
    products: (connection?.nodes ?? []).map(normalizeAdminProduct).filter(Boolean),
    pageInfo: connection?.pageInfo ?? {
      hasNextPage: false,
      hasPreviousPage: false,
      startCursor: null,
      endCursor: null,
    },
  };
}

/** Hydrate a known set of ids, preserving the order they were asked for. */
export async function getProductsByIds(admin, ids) {
  const gids = (ids ?? []).map(toProductGid).filter(Boolean);
  if (gids.length === 0) return [];

  const response = await admin.graphql(PRODUCTS_BY_ID_QUERY, {
    variables: { ids: gids },
  });
  const body = await response.json();

  const byGid = new Map();
  for (const node of body?.data?.nodes ?? []) {
    const product = normalizeAdminProduct(node);
    if (product) byGid.set(product.gid, product);
  }

  return gids.map((gid) => byGid.get(gid)).filter(Boolean);
}

export async function getProduct(admin, id) {
  const response = await admin.graphql(PRODUCT_QUERY, {
    variables: { id: toProductGid(id) },
  });
  const body = await response.json();
  return normalizeAdminProduct(body?.data?.product);
}
