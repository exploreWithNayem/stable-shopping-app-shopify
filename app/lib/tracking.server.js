import prisma from "../db.server";
import { EVENT_TYPES } from "../models/event.server";

/**
 * Request-level concerns for the storefront tracking endpoints: batch limits,
 * flood protection, and the rule that decides what counts as one billable
 * recommendation.
 *
 * Per-event shaping lives in app/models/event.server.js.
 */

/** A beacon carrying more than this is truncated, not rejected. */
export const MAX_EVENTS_PER_BATCH = 10;

/**
 * One recommendation = one widget render that returned products, counted once
 * per session/product/placement within this window (CLAUDE.md §3.3). Without
 * it, a shopper refreshing a product page would burn a free plan in an evening.
 */
export const SERVE_DEDUPE_WINDOW_MS = 30 * 60 * 1000;

/**
 * Per-shop ceiling on tracking requests. Deliberately generous — this is flood
 * protection, not billing.
 *
 * In-memory and therefore per-process: a multi-instance deployment gets this
 * limit per instance. Good enough to stop a runaway loop; move to Redis if the
 * app is ever scaled horizontally.
 */
export const RATE_LIMIT_PER_MINUTE = 600;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_KEYS = 10_000;

const buckets = new Map();

export function checkRateLimit(key, { limit = RATE_LIMIT_PER_MINUTE, now = Date.now() } = {}) {
  if (!key) return false;

  const bucket = buckets.get(key);

  if (!bucket || now - bucket.windowStart >= RATE_LIMIT_WINDOW_MS) {
    // Cheap guard against unbounded growth from a spray of unknown shops.
    if (buckets.size > RATE_LIMIT_MAX_KEYS) buckets.clear();
    buckets.set(key, { windowStart: now, count: 1 });
    return true;
  }

  if (bucket.count >= limit) return false;

  bucket.count += 1;
  return true;
}

export function resetRateLimits() {
  buckets.clear();
}

/**
 * Pull a usable event list out of an untrusted beacon body.
 *
 * Never throws: a malformed payload yields an empty list, because the caller's
 * only sane response to the storefront is 204 either way.
 */
export function parseEventBatch(body) {
  const raw = Array.isArray(body?.events)
    ? body.events
    : Array.isArray(body)
      ? body
      : [];

  const valid = raw.filter(
    (event) => event && EVENT_TYPES.includes(event.type) && event.sourceProductId,
  );

  return {
    events: valid.slice(0, MAX_EVENTS_PER_BATCH),
    received: raw.length,
    dropped: raw.length - Math.min(valid.length, MAX_EVENTS_PER_BATCH),
  };
}

/**
 * Has this session already been served this widget recently?
 *
 * Without a sessionId there is nothing to dedupe on, so the serve counts —
 * better to over-count a shopper with cookies disabled than to hand out free
 * recommendations to anyone who omits the field.
 */
/**
 * Which serves in a batch should be counted against the quota.
 *
 * Deduplicates twice: against what is already stored, and within the batch
 * itself. The second matters because a block re-initialising can put two
 * identical serves in one beacon, and neither would find the other in the
 * database yet.
 *
 * Call before writing the events — once they are stored, every serve looks like
 * a duplicate of itself.
 */
export async function selectBillableServes({ shopId, serves, now = new Date() }) {
  const seen = new Set();
  const billable = [];

  for (const serve of serves) {
    const placement = serve.placement ?? "pdp";
    const key = `${serve.sessionId ?? ""}:${serve.sourceProductId}:${placement}`;

    if (serve.sessionId && seen.has(key)) continue;

    const duplicate = await isDuplicateServe({
      shopId,
      sessionId: serve.sessionId,
      sourceProductId: serve.sourceProductId,
      placement,
      now,
    });
    if (duplicate) continue;

    seen.add(key);
    billable.push(serve);
  }

  return billable;
}

export async function isDuplicateServe({
  shopId,
  sessionId,
  sourceProductId,
  placement,
  now = new Date(),
}) {
  if (!sessionId) return false;

  const existing = await prisma.recommendationEvent.findFirst({
    where: {
      shopId,
      type: "served",
      sessionId: String(sessionId),
      sourceProductId: String(sourceProductId),
      placement,
      createdAt: { gte: new Date(now.getTime() - SERVE_DEDUPE_WINDOW_MS) },
    },
    select: { id: true },
  });

  return Boolean(existing);
}
