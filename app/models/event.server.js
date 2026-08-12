import prisma from "../db.server";

/**
 * Data access for raw tracking events.
 *
 * Append-only. Nothing in the admin reads this table directly — it is rolled up
 * into AnalyticsDaily (Phase 9) and pruned by the retention job.
 */

export const EVENT_TYPES = [
  "served",
  "impression",
  "click",
  "add_to_cart",
  "purchase",
];

export const PLACEMENTS = ["pdp", "checkout", "thank_you", "order_status"];

export const SOURCES = ["shopify", "override"];

/** Shape one inbound beacon payload into a row, or null if it is unusable. */
export function normalizeEvent(shopId, raw) {
  if (!raw || !EVENT_TYPES.includes(raw.type)) return null;
  if (!raw.sourceProductId) return null;

  const placement = PLACEMENTS.includes(raw.placement) ? raw.placement : "pdp";
  const source = SOURCES.includes(raw.source) ? raw.source : "shopify";

  return {
    shopId,
    type: raw.type,
    sourceProductId: String(raw.sourceProductId),
    recoProductId: raw.recoProductId ? String(raw.recoProductId) : null,
    placement,
    source,
    sessionId: raw.sessionId ? String(raw.sessionId) : null,
    clientId: raw.clientId ? String(raw.clientId) : null,
    orderId: raw.orderId ? String(raw.orderId) : null,
    revenue: raw.revenue != null ? String(raw.revenue) : null,
    ...(raw.createdAt ? { createdAt: new Date(raw.createdAt) } : {}),
  };
}

/**
 * Insert a batch, ignoring replays.
 *
 * Rows carrying a clientId go through upsert with an empty update, so a beacon
 * retried by the browser is a no-op. Rows without one (server-side `served`
 * events, webhook-derived purchases) are plain creates. That per-row split is
 * why this is not a single createMany.
 *
 * Returns the number of rows written.
 */
export async function recordEvents(shopId, rawEvents = []) {
  const rows = rawEvents
    .map((raw) => normalizeEvent(shopId, raw))
    .filter(Boolean);

  if (rows.length === 0) return 0;

  const writes = rows.map((row) =>
    row.clientId
      ? prisma.recommendationEvent.upsert({
          where: { clientId: row.clientId },
          create: row,
          update: {},
        })
      : prisma.recommendationEvent.create({ data: row }),
  );

  const results = await prisma.$transaction(writes);
  return results.length;
}

/** Single event convenience wrapper (used by the proxy `served` write). */
export async function recordEvent(shopId, rawEvent) {
  const written = await recordEvents(shopId, [rawEvent]);
  return written > 0;
}

/** Raw events for one UTC day — the input to the daily rollup. */
export function getEventsForRange(shopId, from, to) {
  return prisma.recommendationEvent.findMany({
    where: { shopId, createdAt: { gte: from, lt: to } },
    orderBy: { createdAt: "asc" },
  });
}

export function countEvents(shopId, { type, from, to } = {}) {
  return prisma.recommendationEvent.count({
    where: {
      shopId,
      ...(type ? { type } : {}),
      ...(from || to
        ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } }
        : {}),
    },
  });
}

const METRIC_BY_TYPE = {
  served: "served",
  impression: "impressions",
  click: "clicks",
  add_to_cart: "addToCarts",
  purchase: "purchases",
};

const emptyMetrics = () => ({
  served: 0,
  impressions: 0,
  clicks: 0,
  addToCarts: 0,
  purchases: 0,
});

/**
 * Per-source-product totals, keyed by productId — "how did the widget on this
 * product's page perform".
 *
 * AnalyticsDaily aggregates by *recommended* product, which answers a different
 * question, so this reads raw events. Safe because the call is bounded on three
 * sides: an explicit id list (one page of the table), a date range, and the
 * (shopId, sourceProductId, type) index.
 */
export async function getSourceProductMetrics(shopId, productIds, { from, to } = {}) {
  const ids = [...new Set((productIds ?? []).map(String))];
  const metrics = new Map(ids.map((id) => [id, emptyMetrics()]));
  if (ids.length === 0) return metrics;

  const rows = await prisma.recommendationEvent.groupBy({
    by: ["sourceProductId", "type"],
    where: {
      shopId,
      sourceProductId: { in: ids },
      ...(from || to
        ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } }
        : {}),
    },
    _count: { _all: true },
  });

  for (const row of rows) {
    const bucket = metrics.get(row.sourceProductId);
    const field = METRIC_BY_TYPE[row.type];
    if (bucket && field) bucket[field] = row._count._all;
  }

  return metrics;
}

/** Retention job. Rolled-up data in AnalyticsDaily is kept. */
export function deleteEventsBefore(shopId, cutoff) {
  return prisma.recommendationEvent.deleteMany({
    where: { shopId, createdAt: { lt: cutoff } },
  });
}
