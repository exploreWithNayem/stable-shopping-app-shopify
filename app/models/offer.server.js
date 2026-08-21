import prisma from "../db.server";
import { OFFER_TYPE_KEYS } from "../lib/offer-labels";
import {
  COUNTDOWN_MODES,
  DEFAULT_COUNTDOWN_TITLE,
  clampCountdownMinutes,
} from "../lib/countdown";

/**
 * Data access for merchant-authored offers.
 *
 * An Offer sits *above* Override rather than replacing it. It holds what a
 * merchant authors — which product pages it appears on, what it recommends, and
 * how it reads — and publishing it writes one Override per target product plus a
 * metafield sync. That reuses the whole Phase 6/8 storefront path unchanged: the
 * theme block has no idea offers exist, it just finds a list in the metafield.
 *
 * The publish/unpublish side effects need an authenticated `admin` client, so
 * they live in app/lib/offers.server.js. Everything here is pure persistence.
 */

/** The only placement with a surface built for it. */
export const PLACEMENTS = ["PRODUCT_PAGE"];

/**
 * The offer types, shared with the UI rather than restated here: the builder's
 * radios and the Home list's "Offer type" column read the same keys, so a fifth
 * type is one edit in app/lib/offer-labels.js.
 */
export const OFFER_TYPES = OFFER_TYPE_KEYS;

export const STATUSES = ["draft", "published"];

export const ANCHOR_POSITIONS = ["before", "after"];


/**
 * Same ceiling as Override.MAX_OVERRIDE_ITEMS, and for the same reason: Liquid
 * resolves the published list with all_products[handle], which is capped at 20
 * lookups per page.
 */
export const MAX_ITEMS = 12;

/**
 * Targets are capped too, but far higher — each one is a separate Override row
 * and a separate metafield write, so a merchant pointing an offer at their whole
 * catalogue would be a very long publish. 50 keeps a publish inside one request.
 */
export const MAX_TARGETS = 50;

/** Coerce picker output into the stored shape: deduped, ordered, capped. */
export function normalizeProducts(list = [], max = MAX_ITEMS) {
  const seen = new Set();

  return (Array.isArray(list) ? list : [])
    .filter((entry) => {
      const id = String(entry?.id ?? "").trim();
      // Shopify product ids are positive, so "" and "0" both mean the caller had
      // nothing real. Letting one through writes an item the storefront can
      // never resolve.
      if (!id || id === "0" || seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .slice(0, max)
    .map((entry, index) => ({
      id: String(entry.id),
      handle: entry.handle ?? null,
      title: entry.title ?? null,
      position: index,
    }));
}

/**
 * Everything an offer needs before it can be saved at all.
 *
 * Returns a list of messages rather than throwing: the form shows them together,
 * and a merchant fixing three fields should not have to submit three times.
 */
export function validateOffer(input = {}) {
  const errors = [];

  if (!String(input.name ?? "").trim()) {
    errors.push("Give the offer a name for your own reference.");
  }
  if (!PLACEMENTS.includes(input.placement)) {
    errors.push("Choose a placement that this app supports.");
  }
  if (!OFFER_TYPES.includes(input.offerType)) {
    errors.push("Choose an offer type.");
  }

  return errors;
}

/**
 * What a *published* offer additionally needs.
 *
 * Kept apart from validateOffer so a half-finished offer can still be saved as a
 * draft — a merchant who has picked products but not written a title should not
 * lose the products.
 */
export function validateForPublish(input = {}) {
  const errors = validateOffer(input);

  if (normalizeProducts(input.targets, MAX_TARGETS).length === 0) {
    errors.push("Choose at least one product for this offer to appear on.");
  }
  if (normalizeProducts(input.items).length === 0) {
    errors.push("Choose at least one product for the offer to recommend.");
  }
  if (!String(input.title ?? "").trim()) {
    errors.push("Give the offer a title — shoppers see this above the products.");
  }
  /*
   * A date-mode countdown with no date would render nothing and quietly hide the
   * offer, which is the worst of both. The duration mode needs no such check —
   * minutes are clamped to something usable.
   */
  if (input.countdown && input.countdownMode === "date" && !toDate(input.countdownEndsAt)) {
    errors.push("Pick the date and time the countdown ends, or switch it to a fixed length.");
  }

  return errors;
}

/** A datetime-local value from a form, or null for anything unusable. */
function toDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

const shape = (input) => ({
  name: String(input.name ?? "").trim(),
  placement: input.placement,
  offerType: input.offerType,
  title: String(input.title ?? "").trim(),
  badge: String(input.badge ?? "").trim(),
  buttonText: String(input.buttonText ?? "").trim() || "Add",
  countdown: Boolean(input.countdown),
  countdownMode: COUNTDOWN_MODES.includes(input.countdownMode) ? input.countdownMode : "fixed",
  countdownMinutes: clampCountdownMinutes(input.countdownMinutes),
  countdownEndsAt: toDate(input.countdownEndsAt),
  // Blank falls back to the default sentence rather than storing "", because a
  // countdown with no wording renders a bare clock with nothing explaining it.
  countdownTitle: String(input.countdownTitle ?? "").trim() || DEFAULT_COUNTDOWN_TITLE,
  // Empty means "use reco.js's fallback chain", which is the right default —
  // storing a blank string would look like a selector that matches nothing.
  anchorSelector: String(input.anchorSelector ?? "").trim() || null,
  anchorPosition: ANCHOR_POSITIONS.includes(input.anchorPosition)
    ? input.anchorPosition
    : "after",
  targets: normalizeProducts(input.targets, MAX_TARGETS),
  items: normalizeProducts(input.items),
});

export function getOffer(shopId, id) {
  return prisma.offer.findFirst({ where: { id, shopId } });
}

/**
 * Newest-edited first, with `id` as a tiebreaker.
 *
 * `updatedAt` alone is not a total order: SQLite stores it to the millisecond,
 * and two offers saved in the same tick compared equal, so the list came back in
 * whatever order the query planner chose. The tiebreaker makes paging stable —
 * without it a row can appear on two pages or none.
 */
export function listOffers(shopId, { take = 50 } = {}) {
  return prisma.offer.findMany({
    where: { shopId },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take,
  });
}

export function countOffers(shopId, { status } = {}) {
  return prisma.offer.count({
    where: { shopId, ...(status ? { status } : {}) },
  });
}

/**
 * Create or update, keeping the row's status.
 *
 * Status is never changed here — publishing has storefront side effects and goes
 * through publishOffer() in app/lib/offers.server.js, so a plain save can never
 * make something live by accident.
 *
 * The editor's save path does republish an offer that is *already* live, so an
 * edit reaches the storefront instead of sitting in this row unseen. That is the
 * route's decision, made from the status it reads before calling this; going live
 * in the first place stays a deliberate press of Publish.
 */
export async function saveOffer(shopId, input = {}) {
  const data = shape(input);

  if (input.id) {
    // Scoped to the shop: an id from a form field is not proof of ownership.
    const existing = await getOffer(shopId, input.id);
    if (!existing) return null;

    return prisma.offer.update({ where: { id: existing.id }, data });
  }

  return prisma.offer.create({ data: { ...data, shopId, status: "draft" } });
}

/** Mark an offer live. The Override rows are written by the caller first. */
export function markPublished(id) {
  return prisma.offer.update({
    where: { id },
    data: { status: "published", publishedAt: new Date() },
  });
}

/** Mark an offer not live. The caller removes the Override rows. */
export function markDraft(id) {
  return prisma.offer.update({
    where: { id },
    data: { status: "draft", publishedAt: null },
  });
}

/**
 * Copy an offer as a draft.
 *
 * A duplicate is never born published, whatever the original was: publishing
 * writes Override rows and metafields for every target (§3.1), so a copy that
 * went live on creation would silently overwrite the original's storefront
 * output for the products the two share.
 *
 * The products come along — a duplicate exists to be a variation on something,
 * and re-picking twelve products by hand is the thing being avoided.
 */
export async function duplicateOffer(shopId, id) {
  const existing = await getOffer(shopId, id);
  if (!existing) return null;

  return prisma.offer.create({
    data: {
      shopId,
      name: `${existing.name} copy`.trim(),
      placement: existing.placement,
      offerType: existing.offerType,
      title: existing.title,
      badge: existing.badge,
      buttonText: existing.buttonText,
      countdown: existing.countdown,
      countdownMode: existing.countdownMode,
      countdownMinutes: existing.countdownMinutes,
      countdownEndsAt: existing.countdownEndsAt,
      countdownTitle: existing.countdownTitle,
      anchorSelector: existing.anchorSelector,
      anchorPosition: existing.anchorPosition,
      targets: existing.targets ?? [],
      items: existing.items ?? [],
      status: "draft",
    },
  });
}

export async function deleteOffer(shopId, id) {
  const existing = await getOffer(shopId, id);
  if (!existing) return null;

  await prisma.offer.delete({ where: { id: existing.id } });
  return existing;
}

/**
 * Product ids a published offer occupies, for the plan allowance.
 *
 * Distinct across offers, because two offers targeting the same product still
 * only cost one product against the limit — the same rule Override uses
 * (countOverriddenProducts, §5).
 */
export async function publishedTargetIds(shopId, { excludeOfferId = null } = {}) {
  const offers = await prisma.offer.findMany({
    where: {
      shopId,
      status: "published",
      ...(excludeOfferId ? { id: { not: excludeOfferId } } : {}),
    },
    select: { targets: true },
  });

  const ids = new Set();
  for (const offer of offers) {
    for (const target of offer.targets ?? []) ids.add(String(target.id));
  }
  return ids;
}
