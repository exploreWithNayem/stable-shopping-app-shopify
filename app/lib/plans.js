/**
 * Plan definitions — the single source of truth for pricing and quota limits.
 *
 * `quota` is recommendations served per billing month, where one recommendation
 * is one widget render that returned at least one product (see CLAUDE.md §3.3).
 * Impressions, clicks and add-to-carts are analytics, not billable units.
 *
 * `overrideLimit` is a different unit entirely: how many products may carry a
 * custom recommendation list at once. Free gets a real allowance rather than
 * nothing, so a merchant can build the feature into their store before paying.
 *
 * Feature gating built on this map lands in Phase 11 (app/lib/entitlements.js).
 */

export const UNLIMITED = -1;

export const DEFAULT_PLAN = "free";

export const PLANS = {
  free: {
    key: "free",
    name: "Free",
    price: 0,
    quota: 100,
    overrideLimit: 10,
    features: [
      "PDP recommendations widget",
      "Shopify's built-in recommendations",
      "Custom recommendations on up to 10 products",
      "7 days of analytics",
    ],
  },
  /*
   * "Checkout recommendations" was listed here before the checkout UI extension
   * existed (Phase 12), so the plan was sold on a feature a merchant could not
   * find. canUseCheckout() in lib/entitlements.js is the gate it will use, and
   * this line goes back the moment the extension ships.
   */
  standard: {
    key: "standard",
    name: "Standard",
    price: 29,
    quota: 1000,
    overrideLimit: UNLIMITED,
    features: [
      "Everything in Free",
      "Custom recommendations on unlimited products",
      "Bought Together bundles",
      "90 days of analytics",
      "CSV export",
    ],
  },
  enterprise: {
    key: "enterprise",
    name: "Enterprise",
    price: 59,
    quota: UNLIMITED,
    overrideLimit: UNLIMITED,
    features: [
      "Everything in Standard",
      "Unlimited recommendations",
      "Full analytics history",
      "Priority support",
    ],
  },
};

/** Display order for the pricing page. */
export const PLAN_KEYS = ["free", "standard", "enterprise"];

/** Unknown or missing plan keys fall back to Free rather than throwing. */
export function getPlan(key) {
  return PLANS[key] ?? PLANS[DEFAULT_PLAN];
}

export function planQuota(key) {
  return getPlan(key).quota;
}

/** How many products may carry a custom recommendation list (-1 = unlimited). */
export function planOverrideLimit(key) {
  return getPlan(key).overrideLimit;
}

export function isUnlimited(quota) {
  return quota === UNLIMITED;
}

export function isPaidPlan(key) {
  return getPlan(key).price > 0;
}
