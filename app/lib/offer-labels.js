/**
 * Merchant-facing names for the fields of an offer.
 *
 * Client-safe on purpose: both the offer builder and the Home offer list render
 * these, and Home renders them in the component rather than the loader. The keys
 * are the stored values — `app/models/offer.server.js` imports them so validation
 * and the UI can never disagree about which offer types exist.
 */

/** Stored `offerType` values, in the order the builder offers them. */
export const OFFER_TYPE_KEYS = [
  "cross_sell",
  "volume_discount",
  "frequently_bought_together",
  "product_add_on",
];

export const OFFER_TYPE_LABELS = {
  cross_sell: "Cross-sell",
  volume_discount: "Volume discount",
  frequently_bought_together: "Frequently bought together",
  product_add_on: "Product add-on",
};

/**
 * Where a saved offer renders. Only `PRODUCT_PAGE` can be saved today (the other
 * placement cards do not navigate), so this is a map rather than the picker's
 * card list — those cards carry diagrams and unbuilt-surface copy that a table
 * cell has no use for.
 */
export const OFFER_LOCATION_LABELS = {
  PRODUCT_PAGE: "Product page",
};

/** Fall back to the raw key rather than an empty cell — a blank reads as a bug. */
export function offerTypeLabel(offerType) {
  return OFFER_TYPE_LABELS[offerType] ?? humanize(offerType);
}

export function offerLocationLabel(placement) {
  return OFFER_LOCATION_LABELS[placement] ?? humanize(placement);
}

function humanize(value) {
  const text = String(value ?? "").replace(/[_-]+/g, " ").trim().toLowerCase();
  if (!text) return "—";
  return text.charAt(0).toUpperCase() + text.slice(1);
}
