import prisma from "../db.server";
import { addDays, eachUtcDay, startOfUtcDay } from "../lib/dates";

/**
 * Data access for pre-aggregated daily metrics.
 *
 * Every admin analytics read hits this table. The rollup that fills it from raw
 * events, plus the dashboard/funnel queries built on top, land in Phase 9.
 */

export const METRIC_FIELDS = [
  "served",
  "impressions",
  "clicks",
  "addToCarts",
  "purchases",
];

/**
 * Sentinel productId for widget-level metrics.
 *
 * A `served` event describes the whole widget, not any one recommendation, so
 * it has no recommended product to be filed under. Rather than making
 * `productId` nullable — SQLite treats NULLs as distinct in a unique index, so
 * the (shop, date, product, placement) key would stop deduplicating — these
 * rows are booked against "*". Product-level queries filter it out; totals
 * include it, which is what makes `served` add up.
 */
export const WIDGET_TOTAL = "*";

/**
 * Add `metrics` onto one (date, product, placement) bucket.
 *
 * Increment-based rather than set-based so a rollup can run in chunks, but that
 * makes it non-idempotent — re-running the rollup for a day must reset the day
 * first (Phase 9) or the numbers double.
 */
export function incrementDaily({
  shopId,
  date,
  productId,
  placement,
  metrics = {},
  revenue = 0,
}) {
  const day = startOfUtcDay(date);
  const key = {
    shopId_date_productId_placement: {
      shopId,
      date: day,
      productId: String(productId),
      placement,
    },
  };

  const increments = {};
  const seed = {};
  for (const field of METRIC_FIELDS) {
    const value = metrics[field] ?? 0;
    if (value) increments[field] = { increment: value };
    seed[field] = value;
  }

  return prisma.analyticsDaily.upsert({
    where: key,
    update: {
      ...increments,
      ...(revenue ? { revenue: { increment: revenue } } : {}),
    },
    create: {
      shopId,
      date: day,
      productId: String(productId),
      placement,
      ...seed,
      revenue,
    },
  });
}

/** Wipe a day before re-rolling it, so the rollup stays idempotent. */
export function clearDay(shopId, date) {
  return prisma.analyticsDaily.deleteMany({
    where: { shopId, date: startOfUtcDay(date) },
  });
}

export function getDailyRange(shopId, from, to, { placement } = {}) {
  return prisma.analyticsDaily.findMany({
    where: {
      shopId,
      date: { gte: startOfUtcDay(from), lte: startOfUtcDay(to) },
      ...(placement ? { placement } : {}),
    },
    orderBy: { date: "asc" },
  });
}

/** Totals across a range, for the dashboard stat widgets. */
export async function getTotals(shopId, from, to, { placement } = {}) {
  const result = await prisma.analyticsDaily.aggregate({
    where: {
      shopId,
      date: { gte: startOfUtcDay(from), lte: startOfUtcDay(to) },
      ...(placement ? { placement } : {}),
    },
    _sum: {
      served: true,
      impressions: true,
      clicks: true,
      addToCarts: true,
      purchases: true,
      revenue: true,
    },
  });

  return {
    served: result._sum.served ?? 0,
    impressions: result._sum.impressions ?? 0,
    clicks: result._sum.clicks ?? 0,
    addToCarts: result._sum.addToCarts ?? 0,
    purchases: result._sum.purchases ?? 0,
    revenue: Number(result._sum.revenue ?? 0),
  };
}

/**
 * Top recommended products for the dashboard table.
 *
 * Ranked by impressions, not `served`: a serve belongs to the widget as a
 * whole, so it is booked against WIDGET_TOTAL and every real product row has
 * served = 0. Impressions are the per-product analogue of "how often was this
 * shown".
 */
export async function getTopProducts(shopId, from, to, { limit = 10 } = {}) {
  const rows = await prisma.analyticsDaily.groupBy({
    by: ["productId"],
    where: {
      shopId,
      date: { gte: startOfUtcDay(from), lte: startOfUtcDay(to) },
      productId: { not: WIDGET_TOTAL },
    },
    _sum: {
      served: true,
      impressions: true,
      clicks: true,
      addToCarts: true,
      purchases: true,
      revenue: true,
    },
    orderBy: { _sum: { impressions: "desc" } },
    take: limit,
  });

  return rows.map((row) => ({
    productId: row.productId,
    served: row._sum.served ?? 0,
    impressions: row._sum.impressions ?? 0,
    clicks: row._sum.clicks ?? 0,
    addToCarts: row._sum.addToCarts ?? 0,
    purchases: row._sum.purchases ?? 0,
    revenue: Number(row._sum.revenue ?? 0),
  }));
}

// ---------------------------------------------------------------------------
// Rollup
// ---------------------------------------------------------------------------

const PRODUCT_METRIC_BY_TYPE = {
  impression: "impressions",
  click: "clicks",
  add_to_cart: "addToCarts",
  purchase: "purchases",
};

/**
 * Rebuild one UTC day of AnalyticsDaily from raw events.
 *
 * Wipes the day first, so running it twice produces the same numbers rather
 * than doubling them. That also makes it destructive if the raw events are
 * gone: never call it for a day outside the retention window — rollupRange
 * enforces that.
 */
export async function rollupDay(shopId, date) {
  const dayStart = startOfUtcDay(date);
  const dayEnd = addDays(dayStart, 1);
  const window = { gte: dayStart, lt: dayEnd };

  const [productRows, servedRows] = await Promise.all([
    prisma.recommendationEvent.groupBy({
      by: ["recoProductId", "placement", "type"],
      where: {
        shopId,
        createdAt: window,
        type: { in: Object.keys(PRODUCT_METRIC_BY_TYPE) },
        recoProductId: { not: null },
      },
      _count: { _all: true },
      _sum: { revenue: true },
    }),
    prisma.recommendationEvent.groupBy({
      by: ["placement"],
      where: { shopId, createdAt: window, type: "served" },
      _count: { _all: true },
    }),
  ]);

  // Collapse (product, placement, type) rows into one bucket per
  // (product, placement).
  const buckets = new Map();
  const bucketFor = (productId, placement) => {
    const key = `${productId}|${placement}`;
    if (!buckets.has(key)) {
      buckets.set(key, {
        productId,
        placement,
        served: 0,
        impressions: 0,
        clicks: 0,
        addToCarts: 0,
        purchases: 0,
        revenue: 0,
      });
    }
    return buckets.get(key);
  };

  for (const row of productRows) {
    const bucket = bucketFor(row.recoProductId, row.placement);
    bucket[PRODUCT_METRIC_BY_TYPE[row.type]] += row._count._all;
    if (row.type === "purchase") bucket.revenue += Number(row._sum.revenue ?? 0);
  }

  for (const row of servedRows) {
    bucketFor(WIDGET_TOTAL, row.placement).served += row._count._all;
  }

  await clearDay(shopId, dayStart);

  if (buckets.size > 0) {
    await prisma.analyticsDaily.createMany({
      data: [...buckets.values()].map((bucket) => ({
        shopId,
        date: dayStart,
        ...bucket,
      })),
    });
  }

  return { date: dayStart, rows: buckets.size };
}

/**
 * Roll up every day in a range.
 *
 * Days older than `maxAgeDays` are skipped rather than rebuilt: their raw
 * events have been pruned, so rebuilding would replace real history with
 * zeroes. Returns which days were done and which were refused.
 */
export async function rollupRange(
  shopId,
  { from, to = new Date(), maxAgeDays = 90 } = {},
) {
  const today = startOfUtcDay(to);
  const oldestAllowed = addDays(today, -maxAgeDays);
  const start = startOfUtcDay(from ?? addDays(today, -2));

  const rolled = [];
  const skipped = [];

  for (const day of eachUtcDay(start, today)) {
    if (day < oldestAllowed) {
      skipped.push(day);
      continue;
    }
    const result = await rollupDay(shopId, day);
    rolled.push(result);
  }

  return { rolled, skipped };
}

// ---------------------------------------------------------------------------
// Dashboard queries
// ---------------------------------------------------------------------------

function withRates(totals) {
  return {
    ...totals,
    clickThroughRate: rate(totals.clicks, totals.impressions),
    addToCartRate: rate(totals.addToCarts, totals.clicks),
    conversionRate: rate(totals.purchases, totals.addToCarts),
  };
}

function rate(numerator, denominator) {
  if (!denominator) return 0;
  return (numerator / denominator) * 100;
}

/** Percentage change, or null when there is no comparable previous period. */
export function percentChange(current, previous) {
  if (!previous) return null;
  return ((current - previous) / previous) * 100;
}

/**
 * Everything the home dashboard renders: totals, the same totals for the
 * preceding period of equal length, and a daily series for the trend chart.
 */
export async function getDashboardMetrics(shopId, { days = 30, to = new Date() } = {}) {
  const end = startOfUtcDay(to);
  const start = addDays(end, -(days - 1));
  const previousEnd = addDays(start, -1);
  const previousStart = addDays(previousEnd, -(days - 1));

  const [current, previous, daily] = await Promise.all([
    getTotals(shopId, start, end),
    getTotals(shopId, previousStart, previousEnd),
    getDailyRange(shopId, start, end),
  ]);

  // Every day in the range appears, including empty ones, so the chart has no
  // gaps to guess at.
  const byDate = new Map();
  for (const day of eachUtcDay(start, end)) {
    byDate.set(day.toISOString().slice(0, 10), {
      date: day.toISOString().slice(0, 10),
      served: 0,
      impressions: 0,
      clicks: 0,
      addToCarts: 0,
      purchases: 0,
      revenue: 0,
    });
  }
  for (const row of daily) {
    const bucket = byDate.get(row.date.toISOString().slice(0, 10));
    if (!bucket) continue;
    bucket.served += row.served;
    bucket.impressions += row.impressions;
    bucket.clicks += row.clicks;
    bucket.addToCarts += row.addToCarts;
    bucket.purchases += row.purchases;
    bucket.revenue += Number(row.revenue ?? 0);
  }

  return {
    range: {
      days,
      from: start.toISOString(),
      to: end.toISOString(),
    },
    totals: withRates(current),
    previous: withRates(previous),
    deltas: {
      served: percentChange(current.served, previous.served),
      impressions: percentChange(current.impressions, previous.impressions),
      clicks: percentChange(current.clicks, previous.clicks),
      addToCarts: percentChange(current.addToCarts, previous.addToCarts),
      revenue: percentChange(current.revenue, previous.revenue),
    },
    series: [...byDate.values()],
  };
}

/** served → impression → click → add to cart → purchase, with step rates. */
export async function getFunnel(shopId, { days = 30, to = new Date() } = {}) {
  const end = startOfUtcDay(to);
  const totals = await getTotals(shopId, addDays(end, -(days - 1)), end);

  const steps = [
    { key: "served", label: "Recommendations served", value: totals.served },
    { key: "impressions", label: "Seen", value: totals.impressions },
    { key: "clicks", label: "Clicked", value: totals.clicks },
    { key: "addToCarts", label: "Added to cart", value: totals.addToCarts },
    { key: "purchases", label: "Purchased", value: totals.purchases },
  ];

  return steps.map((step, index) => ({
    ...step,
    // Rate against the step before it, not against the top of the funnel.
    rateFromPrevious: index === 0 ? 100 : rate(step.value, steps[index - 1].value),
  }));
}

export function deleteDailyBefore(shopId, cutoff) {
  return prisma.analyticsDaily.deleteMany({
    where: { shopId, date: { lt: startOfUtcDay(cutoff) } },
  });
}
