import prisma from "../db.server";

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

export const OFFER_TYPES = [
  "cross_sell",
  "volume_discount",
  "frequently_bought_together",
  "product_add_on",
];

export const STATUSES = ["draft", "published"];

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

  return errors;
}

const shape = (input) => ({
  name: String(input.name ?? "").trim(),
  placement: input.placement,
  offerType: input.offerType,
  title: String(input.title ?? "").trim(),
  badge: String(input.badge ?? "").trim(),
  buttonText: String(input.buttonText ?? "").trim() || "Add",
  countdown: Boolean(input.countdown),
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
