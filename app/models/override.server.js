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

/**
 * Every override row for one product, whatever its placement.
 *
 * The inline editor on the list page needs this: it edits the items and must
 * leave the placement alone, so it has to know which row already exists rather
 * than assuming `pdp` and creating a duplicate beside a `checkout` row.
 */
export function getProductOverrides(shopId, productId) {
  return prisma.override.findMany({
    where: { shopId, productId: String(productId) },
    orderBy: { updatedAt: "desc" },
  });
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

/**
 * Copy projected from an Offer, or null when there is none.
 *
 * Stored on the row rather than looked up at sync time because this row is what
 * gets written to the metafield — the Settings re-sync reads rows, not offers,
 * so anything the metafield needs has to be here or a repair would drop it.
 */
export function normalizePresentation(presentation) {
  if (!presentation) return null;

  const title = String(presentation.title ?? "").trim();
  const badge = String(presentation.badge ?? "").trim();
  const buttonText = String(presentation.buttonText ?? "").trim();
  const countdown = Boolean(presentation.countdown);
  /*
   * The offer type, which is what tells the app embed whether to lay the offer out
   * as a carousel of rows or a grid (§7.6). It is not wording, but it belongs here
   * for the same reason the wording does: this row is what gets written to the
   * metafield, so anything the storefront needs has to survive a Settings re-sync.
   */
  const type = String(presentation.type ?? "").trim();

  /*
   * Countdown settings, kept only when the countdown is actually on — storing the
   * duration of a switched-off timer would put it in the metafield for reco.js to
   * find. Every field is rebuilt by name here, which is exactly how `type` went
   * missing the first time: anything the storefront needs has to be named.
   */
  const timer = countdown
    ? {
        countdownMode: presentation.countdownMode === "date" ? "date" : "fixed",
        countdownMinutes: Number(presentation.countdownMinutes) || null,
        countdownEndsAt: presentation.countdownEndsAt
          ? new Date(presentation.countdownEndsAt).toISOString()
          : null,
        countdownTitle: String(presentation.countdownTitle ?? "").trim(),
      }
    : null;

  /*
   * Storefront filtering. Rebuilt by name like everything else here — the lesson
   * from `type`, which was added to the caller and silently dropped at this line.
   */
  const visibility = {
    hideInCart: Boolean(presentation.hideInCart),
    hideTriggerProduct: presentation.hideTriggerProduct !== false,
    showQuantityPicker: Boolean(presentation.showQuantityPicker),
  };

  const selector = String(presentation.anchor?.selector ?? "").trim();
  const position = presentation.anchor?.position === "before" ? "before" : "after";
  // Only stored when it says something: a bare default is reco.js's job.
  const anchor = selector ? { selector, position } : null;

  // Nothing worth storing: let the theme block's own settings speak.
  if (!title && !badge && !buttonText && !countdown && !anchor && !type) return null;

  return {
    ...(type ? { type } : {}),
    title,
    badge,
    buttonText,
    countdown,
    ...(timer ?? {}),
    ...visibility,
    ...(anchor ? { anchor } : {}),
  };
}

/**
 * `presentation` is deliberately **not** defaulted.
 *
 * Omitting it leaves whatever the row already had; passing it — even as null —
 * replaces it. The recommendations page edits a product's list without knowing
 * anything about offers, and while this defaulted to null that edit silently
 * stripped a published offer's title, badge, button text and anchor out of the
 * metafield, so the storefront lost the offer's wording and layout with no way to
 * tell what had happened. Only the publish path, which does hold the copy, gets
 * to clear it.
 */
export function upsertOverride({
  shopId,
  productId,
  productTitle,
  productHandle,
  placement = "pdp",
  items,
  enabled = true,
  presentation,
  offerId = null,
}) {
  const normalized = normalizeItems(items);
  const copy = normalizePresentation(presentation);
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
      ...(presentation === undefined ? {} : { presentation: copy }),
      /*
       * Ownership transfers on write. If a second offer publishes onto the same
       * product, the row is that offer's — and taking the first one down must not
       * remove it. A write from the recommendations page passes nothing and clears
       * the link, which is correct: the row is the merchant's now, not an offer's.
       */
      offerId,
      syncedAt: null,
    },
    create: {
      ...key,
      productTitle,
      productHandle,
      items: normalized,
      enabled,
      // Nothing to preserve on a first write.
      presentation: copy,
      offerId,
    },
  });
}

/** Every row a given offer wrote, whatever it targets now. */
export function listOverridesForOffer(shopId, offerId) {
  return prisma.override.findMany({ where: { shopId, offerId } });
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
