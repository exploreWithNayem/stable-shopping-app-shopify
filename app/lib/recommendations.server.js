import { getActiveOverride } from "../models/override.server";
import { getStoredStorefrontToken, storefrontGraphql } from "./storefront.server";

/**
 * The recommendation engine: a manual override if the merchant saved one for
 * this product, otherwise Shopify's own recommendations.
 *
 * Both paths return the same normalised product shape so callers — the app
 * proxy, the checkout extension and the admin preview — never branch on source.
 *
 * Note the PDP does not depend on this module for the common case: Liquid
 * renders overrides straight from the $app:reco_overrides metafield and falls
 * back to the storefront Ajax API in the browser. This is the server-side path,
 * used where there is no theme to do that (checkout, admin).
 */

export const INTENTS = ["related", "complementary"];
export const DEFAULT_LIMIT = 4;

/** The Storefront API returns at most 10 recommendations for a product. */
export const MAX_LIMIT = 10;

const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 500;

/**
 * Shopify's recommendations only change as the shop's order history does, so a
 * short TTL absorbs repeat PDP traffic without going stale in any way a
 * merchant would notice. Overrides are never cached — a save must show up at
 * once.
 */
const cache = new Map();

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;

  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }

  // Re-insert so Map iteration order stays least-recently-used first.
  cache.delete(key);
  cache.set(key, entry);
  return entry.value;
}

function cacheSet(key, value) {
  cache.delete(key);
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });

  while (cache.size > CACHE_MAX_ENTRIES) {
    cache.delete(cache.keys().next().value);
  }
}

export function clearRecommendationCache() {
  cache.clear();
}

const PRODUCT_FIELDS = `#graphql
  fragment RecommendedProduct on Product {
    id
    handle
    title
    onlineStoreUrl
    availableForSale
    featuredImage {
      url
      altText
    }
    priceRange {
      minVariantPrice {
        amount
        currencyCode
      }
    }
    compareAtPriceRange {
      minVariantPrice {
        amount
        currencyCode
      }
    }
  }`;

const RECOMMENDATIONS_QUERY = `#graphql
  ${PRODUCT_FIELDS}
  query ProductRecommendations($productId: ID!, $intent: ProductRecommendationIntent!) {
    productRecommendations(productId: $productId, intent: $intent) {
      ...RecommendedProduct
    }
  }`;

const PRODUCTS_BY_ID_QUERY = `#graphql
  ${PRODUCT_FIELDS}
  query ProductsByIds($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product {
        ...RecommendedProduct
      }
    }
  }`;

/** Accepts a numeric id or a GID and always returns a GID. */
export function toProductGid(id) {
  const value = String(id ?? "");
  if (!value) return null;
  return value.startsWith("gid://") ? value : `gid://shopify/Product/${value}`;
}

export function fromProductGid(gid) {
  return String(gid ?? "").split("/").pop() || null;
}

/** One product shape for every caller, from either source. */
export function normalizeProduct(node) {
  if (!node?.id) return null;

  const price = Number(node.priceRange?.minVariantPrice?.amount ?? 0);
  const compareAt = Number(
    node.compareAtPriceRange?.minVariantPrice?.amount ?? 0,
  );

  return {
    id: fromProductGid(node.id),
    gid: node.id,
    handle: node.handle ?? null,
    title: node.title ?? "",
    image: node.featuredImage?.url ?? null,
    imageAlt: node.featuredImage?.altText ?? node.title ?? "",
    price,
    // Shopify reports 0 or the selling price when there is no sale; only a
    // genuinely higher value should render as a strike-through.
    compareAtPrice: compareAt > price ? compareAt : null,
    currencyCode: node.priceRange?.minVariantPrice?.currencyCode ?? null,
    available: node.availableForSale ?? false,
    url: node.onlineStoreUrl ?? (node.handle ? `/products/${node.handle}` : null),
  };
}

function clampLimit(limit) {
  const value = Number(limit) || DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(value)));
}

function normalizeIntent(intent) {
  return INTENTS.includes(intent) ? intent : "related";
}

/**
 * Override placements are pdp | checkout | both, but events and extensions talk
 * about thank_you and order_status too — all of which are checkout surfaces.
 */
export function toOverridePlacement(placement) {
  return placement === "pdp" ? "pdp" : "checkout";
}

/**
 * Shopify's recommendations for a product. Throws if the Storefront call fails
 * so the caller can decide between degrading and surfacing the error.
 */
export async function getShopifyRecommendations({
  shop,
  productId,
  intent = "related",
  limit = DEFAULT_LIMIT,
  graphql = storefrontGraphql,
}) {
  const token = getStoredStorefrontToken(shop);
  if (!token) throw new Error("No Storefront access token for this shop");

  const safeIntent = normalizeIntent(intent);
  const safeLimit = clampLimit(limit);
  const gid = toProductGid(productId);

  const cacheKey = `${shop.domain}:${gid}:${safeIntent}`;
  const cached = cacheGet(cacheKey);
  // Cached under the full result, then sliced, so two limits share one fetch.
  if (cached) return cached.slice(0, safeLimit);

  const data = await graphql(shop.domain, token, RECOMMENDATIONS_QUERY, {
    productId: gid,
    intent: safeIntent.toUpperCase(),
  });

  const items = (data?.productRecommendations ?? [])
    .map(normalizeProduct)
    .filter(Boolean);

  cacheSet(cacheKey, items);
  return items.slice(0, safeLimit);
}

/**
 * Fill in price, image and availability for stored override items, which hold
 * only id/handle/title.
 *
 * Returns them in the merchant's saved order — `nodes` preserves the requested
 * order, but anything unresolvable (deleted or unpublished product) is dropped
 * rather than rendered as a blank card.
 */
export async function hydrateOverrideItems({
  shop,
  items,
  graphql = storefrontGraphql,
}) {
  const token = getStoredStorefrontToken(shop);
  if (!token) throw new Error("No Storefront access token for this shop");

  const ids = items.map((item) => toProductGid(item.id)).filter(Boolean);
  if (ids.length === 0) return [];

  const data = await graphql(shop.domain, token, PRODUCTS_BY_ID_QUERY, { ids });

  const byGid = new Map();
  for (const node of data?.nodes ?? []) {
    const product = normalizeProduct(node);
    if (product) byGid.set(product.gid, product);
  }

  return ids.map((gid) => byGid.get(gid)).filter(Boolean);
}

/**
 * The engine entry point: override first, Shopify second.
 *
 * Never throws on a Storefront failure — the storefront must keep rendering —
 * and instead returns an empty list flagged `degraded`, so the caller can fall
 * back client-side and skip counting it against the quota.
 */
export async function resolveRecommendations({
  shop,
  productId,
  placement = "pdp",
  intent = "related",
  limit = DEFAULT_LIMIT,
  graphql = storefrontGraphql,
}) {
  const safeLimit = clampLimit(limit);

  const override = await getActiveOverride({
    shopId: shop.id,
    productId,
    placement: toOverridePlacement(placement),
  });

  if (override && Array.isArray(override.items) && override.items.length > 0) {
    try {
      const items = await hydrateOverrideItems({
        shop,
        items: override.items,
        graphql,
      });
      return { source: "override", items: items.slice(0, safeLimit) };
    } catch (error) {
      return {
        source: "override",
        items: [],
        degraded: true,
        reason: error.message,
      };
    }
  }

  try {
    const items = await getShopifyRecommendations({
      shop,
      productId,
      intent,
      limit: safeLimit,
      graphql,
    });
    return { source: "shopify", items };
  } catch (error) {
    return {
      source: "shopify",
      items: [],
      degraded: true,
      reason: error.message,
    };
  }
}
