import prisma from "../db.server";
import { addMonths, startOfUtcDay } from "../lib/dates";
import { getPlan, isUnlimited, planQuota } from "../lib/plans";

/**
 * Quota windows: storage primitives first, then the billing-month service built
 * on top of them (getBillingWindow / getCurrentPeriod / getQuotaStatus /
 * canServe / recordServed).
 */

export function findPeriod(shopId, periodStart) {
  return prisma.usagePeriod.findUnique({
    where: { shopId_periodStart: { shopId, periodStart } },
  });
}

/** Most recent window, used to detect rollover. */
export function getLatestPeriod(shopId) {
  return prisma.usagePeriod.findFirst({
    where: { shopId },
    orderBy: { periodStart: "desc" },
  });
}

/**
 * Find-or-create in one call. Concurrent proxy requests can race here, so the
 * unique violation on (shopId, periodStart) is caught and re-read rather than
 * surfaced.
 */
export async function ensurePeriod({
  shopId,
  periodStart,
  periodEnd,
  quota,
  planAtStart,
}) {
  const existing = await findPeriod(shopId, periodStart);
  if (existing) return existing;

  try {
    return await prisma.usagePeriod.create({
      data: { shopId, periodStart, periodEnd, quota, planAtStart },
    });
  } catch (error) {
    if (error?.code === "P2002") return findPeriod(shopId, periodStart);
    throw error;
  }
}

/** Atomic increment — never read-modify-write, the proxy is concurrent. */
export function incrementServed({ shopId, periodStart, by = 1 }) {
  return prisma.usagePeriod.update({
    where: { shopId_periodStart: { shopId, periodStart } },
    data: { servedCount: { increment: by } },
  });
}

/**
 * Re-snapshot the limit on the live window after a plan change, so an upgrade
 * takes effect immediately instead of at the next rollover.
 */
export function updatePeriodQuota({ shopId, periodStart, quota, plan }) {
  return prisma.usagePeriod.update({
    where: { shopId_periodStart: { shopId, periodStart } },
    data: { quota, planAtStart: plan },
  });
}

export function listPeriods(shopId, { take = 12 } = {}) {
  return prisma.usagePeriod.findMany({
    where: { shopId },
    orderBy: { periodStart: "desc" },
    take,
  });
}

// ---------------------------------------------------------------------------
// Billing window service
// ---------------------------------------------------------------------------

/** Usage at or above this share of the quota shows a warning in the admin. */
export const NEAR_LIMIT_THRESHOLD = 0.8;

/**
 * The quota window `now` falls in, anchored to the shop's billing cycle rather
 * than the calendar month.
 *
 * Every window is measured as `anchor + n months`, never by stepping forward
 * from the previous window. That matters because addMonths clamps short months:
 * stepping would move a Jan 31 anchor to Feb 28 and then permanently bill on
 * the 28th, whereas anchoring gives Jan 31 -> Feb 28 -> Mar 31.
 *
 * Pure and synchronous — this is the piece worth testing directly.
 */
export function getBillingWindow(shop, now = new Date()) {
  const anchor = startOfUtcDay(
    shop?.billingCycleStart ?? shop?.installedAt ?? now,
  );

  // Backdated install or clock skew: the first window starts at the anchor.
  if (anchor > now) {
    return { periodStart: anchor, periodEnd: addMonths(anchor, 1) };
  }

  let elapsed =
    (now.getUTCFullYear() - anchor.getUTCFullYear()) * 12 +
    (now.getUTCMonth() - anchor.getUTCMonth());

  // The calendar-month difference overshoots when `now` is earlier in the month
  // than the anchor day (anchor Jan 31, now Feb 27 -> still the first window).
  if (addMonths(anchor, elapsed) > now) elapsed -= 1;
  if (elapsed < 0) elapsed = 0;

  return {
    periodStart: addMonths(anchor, elapsed),
    periodEnd: addMonths(anchor, elapsed + 1),
  };
}

/**
 * The live UsagePeriod row, created on first use.
 *
 * Rollover needs no job: once `now` passes periodEnd the window maths returns
 * the next periodStart and a fresh row is created. Past periods are never
 * mutated, so they stay as history.
 *
 * The row is also reconciled against the shop's current plan, so an upgrade
 * raises the limit immediately and a missed app_subscriptions/update webhook
 * self-heals. Note the flip side: downgrading mid-window applies the smaller
 * limit right away and can put a shop over quota.
 */
export async function getCurrentPeriodForShop(shop, now = new Date()) {
  const { periodStart, periodEnd } = getBillingWindow(shop, now);
  const quota = planQuota(shop.plan);

  const period = await ensurePeriod({
    shopId: shop.id,
    periodStart,
    periodEnd,
    quota,
    planAtStart: shop.plan,
  });

  if (period.quota !== quota || period.planAtStart !== shop.plan) {
    return updatePeriodQuota({
      shopId: shop.id,
      periodStart,
      quota,
      plan: shop.plan,
    });
  }

  return period;
}

export async function getCurrentPeriod(shopId, now = new Date()) {
  const shop = await prisma.shop.findUniqueOrThrow({ where: { id: shopId } });
  return getCurrentPeriodForShop(shop, now);
}

/**
 * Everything the admin needs to render the quota meter.
 *
 * `remaining` is null (not Infinity) on unlimited plans so the object survives
 * JSON serialisation through a loader.
 */
export async function getQuotaStatusForShop(shop, now = new Date()) {
  const period = await getCurrentPeriodForShop(shop, now);
  const plan = getPlan(shop.plan);
  const unlimited = isUnlimited(period.quota);
  const used = period.servedCount;

  const percentUsed =
    unlimited || period.quota <= 0
      ? 0
      : Math.min(100, Math.round((used / period.quota) * 100));

  return {
    plan: plan.key,
    planName: plan.name,
    used,
    limit: unlimited ? null : period.quota,
    unlimited,
    remaining: unlimited ? null : Math.max(0, period.quota - used),
    percentUsed,
    isOver: !unlimited && used >= period.quota,
    isNearLimit:
      !unlimited && used >= period.quota * NEAR_LIMIT_THRESHOLD,
    periodStart: period.periodStart,
    resetsAt: period.periodEnd,
  };
}

export async function getQuotaStatus(shopId, now = new Date()) {
  const shop = await prisma.shop.findUniqueOrThrow({ where: { id: shopId } });
  return getQuotaStatusForShop(shop, now);
}

/** Gate for the storefront proxy. Unlimited plans always pass. */
export async function canServe(shopId, now = new Date()) {
  const status = await getQuotaStatus(shopId, now);
  return !status.isOver;
}

/**
 * Count `by` recommendations against the live window, creating it if needed.
 * Returns the updated period.
 */
export async function recordServed(shopId, by = 1, now = new Date()) {
  const shop = await prisma.shop.findUniqueOrThrow({ where: { id: shopId } });
  const period = await getCurrentPeriodForShop(shop, now);
  return incrementServed({ shopId, periodStart: period.periodStart, by });
}
