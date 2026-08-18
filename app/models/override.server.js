import prisma from "../db.server";

/**
 * Data access for manual recommendation overrides.
 *
 * Prisma is the source of truth; the $app:reco_overrides product metafield is a
 * mirror written by app/lib/metafields.server.js (Phase 6). Any write here must
 * be followed by a metafield sync, then markOverrideSynced().
 */

export const PLACEMENTS = ["pdp", "checkout", "both"];

/**
 * Liquid resolves override items with all_products[handle], which is capped at
 * 20 lookups per page. 12 leaves headroom for the rest of the template.
 */
export const MAX_OVERRIDE_ITEMS = 12;

/** Coerce picker output into the stored shape, deduped, ordered and capped. */
export function normalizeItems(items = []) {
  const seen = new Set();
  return items
    .filter((item) => {
      const id = String(item?.id ?? "").trim();
      // Shopify product IDs are positive, so "" and "0" both mean the caller
      // had nothing real. Letting one through writes an item to the metafield
      // that all_products can never resolve.
      if (!id || id === "0" || seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .slice(0, MAX_OVERRIDE_ITEMS)
    .map((item, index) => ({
      id: String(item.id),
      handle: item.handle ?? null,
      title: item.title ?? null,
      position: index,
    }));
}

export function countOverrides(shopId) {
  return prisma.override.count({ where: { shopId } });
}

/**
 * Distinct products carrying an override — the unit the plan limit counts.
 *
 * Not the same as countOverrides(): placement is part of a row's identity, so
 * one product can hold a `pdp` row and a `checkout` row. Charging that as two
 * against the allowance would be wrong.
 */
export async function countOverriddenProducts(shopId) {
  const rows = await prisma.override.groupBy({
    by: ["productId"],
    where: { shopId },
  });
  return rows.length;
}

/** Whether this product already counts against the limit. */
export async function hasOverrideForProduct(shopId, productId) {
  const rows = await prisma.override.count({
    where: { shopId, productId: String(productId) },
  });
  return rows > 0;
}

export function getOverride({ shopId, productId, placement = "pdp" }) {
  return prisma.override.findUnique({
    where: {
      shopId_productId_placement: {
        shopId,
        productId: String(productId),
        placement,
      },
    },
  });
}

/**
 * The enabled override that applies to `placement`, if any.
 *
 * An override saved as "both" covers pdp and checkout, so a lookup has to
 * consider it too. An exact placement match wins over "both".
 */
export async function getActiveOverride({ shopId, productId, placement = "pdp" }) {
  const rows = await prisma.override.findMany({
    where: {
      shopId,
      productId: String(productId),
      enabled: true,
      placement: { in: [placement, "both"] },
    },
  });

  if (rows.length === 0) return null;
  return rows.find((row) => row.placement === placement) ?? rows[0];
}

export function listOverrides({
  shopId,
  search,
  placement,
  enabled,
  take = 25,
  skip = 0,
  orderBy = { updatedAt: "desc" },
}) {
  return prisma.override.findMany({
    where: {
      shopId,
      ...(placement ? { placement } : {}),
      ...(typeof enabled === "boolean" ? { enabled } : {}),
      ...(search ? { productTitle: { contains: search } } : {}),
    },
    orderBy,
    take,
    skip,
  });
}

/**
 * Overrides for a page of products, keyed by productId, so the recommendations
 * list can show Source: Shopify / Custom without an N+1.
 */
export async function getOverridesForProducts(shopId, productIds) {
  const rows = await prisma.override.findMany({
    where: { shopId, productId: { in: productIds.map(String) } },
  });
  return new Map(rows.map((row) => [row.productId, row]));
}

export function upsertOverride({
  shopId,
  productId,
  productTitle,
  productHandle,
  placement = "pdp",
  items,
  enabled = true,
}) {
  const normalized = normalizeItems(items);
  const key = { shopId, productId: String(productId), placement };

  return prisma.override.upsert({
    where: { shopId_productId_placement: key },
    // syncedAt is cleared on every write: the metafield is stale until the
    // sync in Phase 6 succeeds.
    update: {
      productTitle,
      productHandle,
      items: normalized,
      enabled,
      syncedAt: null,
    },
    create: {
      ...key,
      productTitle,
      productHandle,
      items: normalized,
      enabled,
    },
  });
}

export function setOverrideEnabled(id, enabled) {
  return prisma.override.update({
    where: { id },
    data: { enabled, syncedAt: null },
  });
}

export function markOverrideSynced(id) {
  return prisma.override.update({
    where: { id },
    data: { syncedAt: new Date() },
  });
}

/** Rows whose metafield mirror is missing or stale (drift repair, Phase 13). */
export function listUnsyncedOverrides(shopId) {
  return prisma.override.findMany({ where: { shopId, syncedAt: null } });
}

export function deleteOverride({ shopId, productId, placement = "pdp" }) {
  return prisma.override.deleteMany({
    where: { shopId, productId: String(productId), placement },
  });
}

/** Used by the products/delete webhook to drop orphans. */
export function deleteOverridesForProduct(shopId, productId) {
  return prisma.override.deleteMany({
    where: { shopId, productId: String(productId) },
  });
}
