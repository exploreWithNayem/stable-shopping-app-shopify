/**
 * Plan definitions — the single source of truth for pricing and quota limits.
 *
 * `quota` is recommendations served per billing month, where one recommendation
 * is one widget render that returned at least one product (see CLAUDE.md §3.3).
 * Impressions, clicks and add-to-carts are analytics, not billable units.
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
    features: [
      "PDP recommendations widget",
      "Shopify's built-in recommendations",
      "7 days of analytics",
    ],
  },
  standard: {
    key: "standard",
    name: "Standard",
    price: 29,
    quota: 1000,
    features: [
      "Everything in Free",
      "Custom recommendation overrides",
      "Checkout recommendations",
      "90 days of analytics",
      "CSV export",
    ],
  },
  enterprise: {
    key: "enterprise",
    name: "Enterprise",
    price: 59,
    quota: UNLIMITED,
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

export function isUnlimited(quota) {
  return quota === UNLIMITED;
}

export function isPaidPlan(key) {
  return getPlan(key).price > 0;
}
