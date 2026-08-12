import { afterAll, beforeEach, describe, expect, test } from "vitest";
import prisma from "../db.server";
import { recordEvents } from "./event.server";
import {
  WIDGET_TOTAL,
  getDashboardMetrics,
  getFunnel,
  getTopProducts,
  getTotals,
  percentChange,
  rollupDay,
  rollupRange,
} from "./analytics.server";
import { addDays, startOfUtcDay } from "../lib/dates";

const DOMAIN = "vitest-rollup.myshopify.com";
const DAY = new Date("2026-08-10T00:00:00Z");
let shopId;

/** Events on DAY unless told otherwise. */
const at = (hour, event) => ({
  ...event,
  createdAt: new Date(`2026-08-10T${String(hour).padStart(2, "0")}:00:00Z`),
});

beforeEach(async () => {
  await prisma.shop.deleteMany({ where: { domain: DOMAIN } });
  const shop = await prisma.shop.create({ data: { domain: DOMAIN } });
  shopId = shop.id;
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { domain: DOMAIN } });
});

async function seedDay() {
  await recordEvents(shopId, [
    at(9, { type: "served", sourceProductId: "1", placement: "pdp", clientId: "s1" }),
    at(9, { type: "served", sourceProductId: "1", placement: "pdp", clientId: "s2" }),
    at(9, { type: "impression", sourceProductId: "1", recoProductId: "10", placement: "pdp", clientId: "i1" }),
    at(9, { type: "impression", sourceProductId: "1", recoProductId: "10", placement: "pdp", clientId: "i2" }),
    at(9, { type: "impression", sourceProductId: "1", recoProductId: "20", placement: "pdp", clientId: "i3" }),
    at(10, { type: "click", sourceProductId: "1", recoProductId: "10", placement: "pdp", clientId: "c1" }),
    at(10, { type: "add_to_cart", sourceProductId: "1", recoProductId: "10", placement: "pdp", clientId: "a1" }),
    at(11, { type: "purchase", sourceProductId: "1", recoProductId: "10", placement: "pdp", revenue: "40.00", clientId: "p1" }),
  ]);
}

describe("rollupDay", () => {
  test("aggregates raw events into daily rows", async () => {
    await seedDay();
    await rollupDay(shopId, DAY);

    const totals = await getTotals(shopId, DAY, DAY);
    expect(totals).toMatchObject({
      served: 2,
      impressions: 3,
      clicks: 1,
      addToCarts: 1,
      purchases: 1,
      revenue: 40,
    });
  });

  // A serve describes the widget, not any single recommendation, so it has no
  // product to be filed under.
  test("books serves against the widget sentinel", async () => {
    await seedDay();
    await rollupDay(shopId, DAY);

    const widget = await prisma.analyticsDaily.findFirst({
      where: { shopId, productId: WIDGET_TOTAL },
    });
    expect(widget.served).toBe(2);
    expect(widget.impressions).toBe(0);

    const product = await prisma.analyticsDaily.findFirst({
      where: { shopId, productId: "10" },
    });
    expect(product.served).toBe(0);
    expect(product.impressions).toBe(2);
  });

  // The rollup clears the day first, so a re-run has to land on the same
  // numbers rather than doubling them.
  test("is idempotent", async () => {
    await seedDay();
    await rollupDay(shopId, DAY);
    await rollupDay(shopId, DAY);

    expect((await getTotals(shopId, DAY, DAY)).impressions).toBe(3);
  });

  test("picks up events added after a first run", async () => {
    await seedDay();
    await rollupDay(shopId, DAY);

    await recordEvents(shopId, [
      at(12, { type: "click", sourceProductId: "1", recoProductId: "20", placement: "pdp", clientId: "c2" }),
    ]);
    await rollupDay(shopId, DAY);

    expect((await getTotals(shopId, DAY, DAY)).clicks).toBe(2);
  });

  test("leaves neighbouring days alone", async () => {
    await seedDay();
    await recordEvents(shopId, [
      {
        type: "click",
        sourceProductId: "1",
        recoProductId: "10",
        placement: "pdp",
        clientId: "other-day",
        createdAt: new Date("2026-08-11T09:00:00Z"),
      },
    ]);

    await rollupDay(shopId, DAY);
    await rollupDay(shopId, new Date("2026-08-11T00:00:00Z"));

    expect((await getTotals(shopId, DAY, DAY)).clicks).toBe(1);
    expect(
      (await getTotals(shopId, new Date("2026-08-11Z"), new Date("2026-08-11Z"))).clicks,
    ).toBe(1);
  });

  test("writes nothing for a day with no events", async () => {
    await rollupDay(shopId, DAY);
    expect(await prisma.analyticsDaily.count({ where: { shopId } })).toBe(0);
  });

  test("keeps placements apart", async () => {
    await recordEvents(shopId, [
      at(9, { type: "served", sourceProductId: "1", placement: "pdp", clientId: "sa" }),
      at(9, { type: "served", sourceProductId: "1", placement: "checkout", clientId: "sb" }),
    ]);
    await rollupDay(shopId, DAY);

    expect((await getTotals(shopId, DAY, DAY, { placement: "pdp" })).served).toBe(1);
    expect((await getTotals(shopId, DAY, DAY, { placement: "checkout" })).served).toBe(1);
  });
});

describe("rollupRange", () => {
  // Raw events are pruned on a retention schedule, but daily rows are kept.
  // Rebuilding a day whose events are gone would replace real history with
  // zeroes, so those days must be refused.
  test("refuses days older than the retention window", async () => {
    const today = startOfUtcDay(new Date("2026-08-12Z"));
    const old = addDays(today, -40);

    // Pretend the old day was rolled up back when its events still existed.
    await prisma.analyticsDaily.create({
      data: {
        shopId,
        date: old,
        productId: WIDGET_TOTAL,
        placement: "pdp",
        served: 500,
      },
    });

    const { rolled, skipped } = await rollupRange(shopId, {
      from: old,
      to: today,
      maxAgeDays: 30,
    });

    expect(skipped.length).toBeGreaterThan(0);
    expect(rolled).toHaveLength(31); // today plus the 30 allowed days
    expect((await getTotals(shopId, old, old)).served).toBe(500); // untouched
  });

  test("rolls each day in the window", async () => {
    await seedDay();
    const { rolled } = await rollupRange(shopId, {
      from: DAY,
      to: new Date("2026-08-12Z"),
      maxAgeDays: 90,
    });

    expect(rolled).toHaveLength(3);
    expect((await getTotals(shopId, DAY, DAY)).served).toBe(2);
  });
});

describe("getDashboardMetrics", () => {
  test("compares against the preceding period of equal length", async () => {
    const to = new Date("2026-08-12Z");
    // 3 serves in the current 7 days, 1 in the 7 before it.
    await prisma.analyticsDaily.createMany({
      data: [
        { shopId, date: startOfUtcDay(new Date("2026-08-10Z")), productId: WIDGET_TOTAL, placement: "pdp", served: 3 },
        { shopId, date: startOfUtcDay(new Date("2026-08-01Z")), productId: WIDGET_TOTAL, placement: "pdp", served: 1 },
      ],
    });

    const metrics = await getDashboardMetrics(shopId, { days: 7, to });

    expect(metrics.totals.served).toBe(3);
    expect(metrics.previous.served).toBe(1);
    expect(metrics.deltas.served).toBe(200);
  });

  // A gap in the series would leave the chart guessing where to draw.
  test("returns one point per day, including empty ones", async () => {
    const metrics = await getDashboardMetrics(shopId, {
      days: 7,
      to: new Date("2026-08-12Z"),
    });

    expect(metrics.series).toHaveLength(7);
    expect(metrics.series[0].date).toBe("2026-08-06");
    expect(metrics.series.at(-1).date).toBe("2026-08-12");
    expect(metrics.series.every((point) => point.served === 0)).toBe(true);
  });

  test("derives rates from the totals", async () => {
    await seedDay();
    await rollupDay(shopId, DAY);

    const metrics = await getDashboardMetrics(shopId, {
      days: 7,
      to: new Date("2026-08-12Z"),
    });

    // 1 click / 3 impressions
    expect(metrics.totals.clickThroughRate).toBeCloseTo(33.33, 1);
  });

  test("reports no delta rather than a fake one when there is no history", async () => {
    const metrics = await getDashboardMetrics(shopId, {
      days: 7,
      to: new Date("2026-08-12Z"),
    });
    expect(metrics.deltas.served).toBeNull();
  });
});

describe("percentChange", () => {
  test("is null when there is nothing to compare against", () => {
    expect(percentChange(10, 0)).toBeNull();
  });

  test("handles growth and decline", () => {
    expect(percentChange(150, 100)).toBe(50);
    expect(percentChange(50, 100)).toBe(-50);
  });
});

describe("getFunnel", () => {
  test("steps down from served to purchased", async () => {
    await seedDay();
    await rollupDay(shopId, DAY);

    const funnel = await getFunnel(shopId, { days: 7, to: new Date("2026-08-12Z") });

    expect(funnel.map((step) => step.value)).toEqual([2, 3, 1, 1, 1]);
    expect(funnel[0].rateFromPrevious).toBe(100);
    // Each step is measured against the one before it, not the top.
    expect(funnel[2].rateFromPrevious).toBeCloseTo(33.33, 1);
  });
});

describe("getTopProducts", () => {
  test("excludes the widget sentinel and ranks by impressions", async () => {
    await seedDay();
    await rollupDay(shopId, DAY);

    const top = await getTopProducts(shopId, DAY, DAY);

    expect(top.map((row) => row.productId)).toEqual(["10", "20"]);
    expect(top[0]).toMatchObject({ impressions: 2, clicks: 1, revenue: 40 });
  });
});
