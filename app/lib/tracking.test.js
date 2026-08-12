import { afterAll, beforeEach, describe, expect, test } from "vitest";
import prisma from "../db.server";
import { recordEvent } from "../models/event.server";
import {
  MAX_EVENTS_PER_BATCH,
  RATE_LIMIT_PER_MINUTE,
  SERVE_DEDUPE_WINDOW_MS,
  checkRateLimit,
  isDuplicateServe,
  parseEventBatch,
  resetRateLimits,
  selectBillableServes,
} from "./tracking.server";

const DOMAIN = "vitest-tracking.myshopify.com";
let shopId;

const click = (overrides = {}) => ({
  type: "click",
  sourceProductId: "1",
  recoProductId: "2",
  ...overrides,
});

beforeEach(async () => {
  resetRateLimits();
  await prisma.shop.deleteMany({ where: { domain: DOMAIN } });
  const shop = await prisma.shop.create({ data: { domain: DOMAIN } });
  shopId = shop.id;
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { domain: DOMAIN } });
});

describe("parseEventBatch", () => {
  test("reads the events array", () => {
    const result = parseEventBatch({ events: [click(), click()] });
    expect(result.events).toHaveLength(2);
  });

  test("accepts a bare array too", () => {
    expect(parseEventBatch([click()]).events).toHaveLength(1);
  });

  // Truncated rather than rejected: 11 events should still record 10.
  test("caps an oversized batch instead of dropping it", () => {
    const many = Array.from({ length: 25 }, () => click());
    const result = parseEventBatch({ events: many });

    expect(result.events).toHaveLength(MAX_EVENTS_PER_BATCH);
    expect(result.received).toBe(25);
    expect(result.dropped).toBe(15);
  });

  test("drops events with an unknown type or no source product", () => {
    const result = parseEventBatch({
      events: [click({ type: "hack" }), click({ sourceProductId: "" }), click()],
    });
    expect(result.events).toHaveLength(1);
  });

  // The endpoint answers 204 regardless, so parsing must never throw.
  test("returns an empty batch for junk", () => {
    for (const junk of [null, undefined, {}, "nope", 42, { events: "no" }]) {
      expect(parseEventBatch(junk).events).toEqual([]);
    }
  });
});

describe("checkRateLimit", () => {
  test("allows traffic up to the limit then refuses", () => {
    for (let i = 0; i < RATE_LIMIT_PER_MINUTE; i += 1) {
      expect(checkRateLimit("shop-a")).toBe(true);
    }
    expect(checkRateLimit("shop-a")).toBe(false);
  });

  test("counts each shop separately", () => {
    for (let i = 0; i < RATE_LIMIT_PER_MINUTE; i += 1) checkRateLimit("shop-a");

    expect(checkRateLimit("shop-a")).toBe(false);
    expect(checkRateLimit("shop-b")).toBe(true);
  });

  test("opens a fresh window after a minute", () => {
    const start = 1_000_000;
    for (let i = 0; i < RATE_LIMIT_PER_MINUTE; i += 1) {
      checkRateLimit("shop-a", { now: start });
    }
    expect(checkRateLimit("shop-a", { now: start })).toBe(false);
    expect(checkRateLimit("shop-a", { now: start + 60_001 })).toBe(true);
  });

  test("refuses a missing key", () => {
    expect(checkRateLimit(null)).toBe(false);
  });
});

describe("isDuplicateServe", () => {
  const serve = (sessionId, extra = {}) =>
    recordEvent(shopId, {
      type: "served",
      sourceProductId: "1",
      placement: "pdp",
      sessionId,
      ...extra,
    });

  test("spots a repeat serve in the same session", async () => {
    await serve("sess-1");

    expect(
      await isDuplicateServe({
        shopId,
        sessionId: "sess-1",
        sourceProductId: "1",
        placement: "pdp",
      }),
    ).toBe(true);
  });

  test("treats a different session, product or placement as new", async () => {
    await serve("sess-1");

    const base = { shopId, sourceProductId: "1", placement: "pdp", sessionId: "sess-1" };
    expect(await isDuplicateServe({ ...base, sessionId: "sess-2" })).toBe(false);
    expect(await isDuplicateServe({ ...base, sourceProductId: "2" })).toBe(false);
    expect(await isDuplicateServe({ ...base, placement: "checkout" })).toBe(false);
  });

  test("expires once the window passes", async () => {
    const longAgo = new Date(Date.now() - SERVE_DEDUPE_WINDOW_MS - 60_000);
    await serve("sess-1", { createdAt: longAgo });

    expect(
      await isDuplicateServe({
        shopId,
        sessionId: "sess-1",
        sourceProductId: "1",
        placement: "pdp",
      }),
    ).toBe(false);
  });

  // Better to over-count a shopper with cookies disabled than to hand out free
  // recommendations to any caller that omits the field.
  test("counts the serve when there is no session id", async () => {
    await serve(null);

    expect(
      await isDuplicateServe({
        shopId,
        sessionId: null,
        sourceProductId: "1",
        placement: "pdp",
      }),
    ).toBe(false);
  });
});

describe("selectBillableServes", () => {
  const served = (overrides = {}) => ({
    type: "served",
    sourceProductId: "1",
    placement: "pdp",
    sessionId: "sess-1",
    ...overrides,
  });

  test("counts a first serve", async () => {
    expect(
      await selectBillableServes({ shopId, serves: [served()] }),
    ).toHaveLength(1);
  });

  // A block that re-initialises can put two identical serves in one beacon.
  // Neither is in the database yet, so only in-batch dedupe catches it.
  test("collapses duplicates inside a single batch", async () => {
    const billable = await selectBillableServes({
      shopId,
      serves: [served(), served(), served()],
    });
    expect(billable).toHaveLength(1);
  });

  test("keeps genuinely different serves in one batch", async () => {
    const billable = await selectBillableServes({
      shopId,
      serves: [
        served(),
        served({ sourceProductId: "2" }),
        served({ sessionId: "sess-2" }),
        served({ placement: "checkout" }),
      ],
    });
    expect(billable).toHaveLength(4);
  });

  test("drops one already stored", async () => {
    await recordEvent(shopId, served());
    expect(await selectBillableServes({ shopId, serves: [served()] })).toHaveLength(0);
  });

  // Without a session there is nothing to dedupe on, so each one counts.
  test("counts every sessionless serve", async () => {
    const billable = await selectBillableServes({
      shopId,
      serves: [served({ sessionId: null }), served({ sessionId: null })],
    });
    expect(billable).toHaveLength(2);
  });
});
