import { getPlan } from "./plans";

/**
 * Plan feature gates.
 *
 * Always enforce these server-side in the loader or action as well as in the
 * UI — hiding a button is a hint, not a control. Phase 11 extends this file as
 * billing lands.
 */

/** Custom recommendations that replace Shopify's list. */
export function canUseOverrides(planKey) {
  return getPlan(planKey).key !== "free";
}

/** The checkout / thank-you / order-status widget. */
export function canUseCheckout(planKey) {
  return getPlan(planKey).key !== "free";
}

/**
 * How long raw events are kept before the retention job prunes them.
 *
 * Distinct from the dashboard window below: rolled-up daily figures outlive the
 * raw events they came from, which is also why a rollup must never be re-run
 * for a day older than this (it would rebuild it as zeroes).
 */
export function rawEventRetentionDays(planKey) {
  switch (getPlan(planKey).key) {
    case "enterprise":
      return 365;
    case "standard":
      return 90;
    default:
      return 30;
  }
}

/** How far back the analytics pages may look. */
export function analyticsRetentionDays(planKey) {
  switch (getPlan(planKey).key) {
    case "enterprise":
      return 365;
    case "standard":
      return 90;
    default:
      return 7;
  }
}
