import { afterAll, beforeEach, describe, expect, test } from "vitest";
import prisma from "../db.server";
import {
  WIDGET_TOTAL,
  clearDay,
  deleteDailyBefore,
  getDailyRange,
  getTopProducts,
  getTotals,
  incrementDaily,
} from "./analytics.server";

const DOMAIN = "vitest-analytics.myshopify.com";
const utc = (s) => new Date(`${s}T00:00:00Z`);
const DAY = utc("2026-08-10");
let shopId;

beforeEach(async () => {
  await prisma.shop.deleteMany({ where: { domain: DOMAIN } });
  const shop = await prisma.shop.create({ data: { domain: DOMAIN } });
  shopId = shop.id;
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { domain: DOMAIN } });
});

const bump = (overrides = {}) =>
  incrementDaily({
    shopId,
    date: DAY,
    productId: 55,
    placement: "pdp",
    metrics: { served: 10, clicks: 2 },
    revenue: 100,
    ...overrides,
  });

describe("incrementDaily", () => {
  test("accumulates into one bucket instead of inserting twice", async () => {
    await bump();
    await bump({ metrics: { served: 5, clicks: 1 }, revenue: 50 });

    expect(await getTotals(shopId, DAY, DAY)).toMatchObject({
      served: 15,
      clicks: 3,
      revenue: 150,
    });
    expect(await prisma.analyticsDaily.count({ where: { shopId } })).toBe(1);
  });

  test("normalises the timestamp to UTC midnight", async () => {
    await incrementDaily({
      shopId,
      date: new Date("2026-08-10T23:45:00Z"),
      productId: 55,
      placement: "pdp",
      metrics: { served: 1 },
    });
    await bump({ metrics: { served: 1 }, revenue: 0 });

    const rows = await getDailyRange(shopId, DAY, DAY);
    expect(rows).toHaveLength(1);
    expect(rows[0].served).toBe(2);
  });

  test("separates buckets by placement", async () => {
    await bump({ placement: "pdp" });
    await bump({ placement: "checkout" });

    expect(await prisma.analyticsDaily.count({ where: { shopId } })).toBe(2);
    expect((await getTotals(shopId, DAY, DAY, { placement: "pdp" })).served).toBe(10);
  });

  test("returns revenue as a number, not a Decimal", async () => {
    await bump();
    expect(typeof (await getTotals(shopId, DAY, DAY)).revenue).toBe("number");
  });
});

describe("ranges", () => {
  test("getTotals covers both endpoints and excludes outside days", async () => {
    await bump({ date: utc("2026-08-09"), metrics: { served: 1 } });
    await bump({ date: utc("2026-08-10"), metrics: { served: 2 } });
    await bump({ date: utc("2026-08-11"), metrics: { served: 4 } });
    await bump({ date: utc("2026-08-20"), metrics: { served: 8 } });

    const totals = await getTotals(shopId, utc("2026-08-09"), utc("2026-08-11"));
    expect(totals.served).toBe(7);
  });

  test("getDailyRange comes back in date order", async () => {
    await bump({ date: utc("2026-08-11") });
    await bump({ date: utc("2026-08-09") });

    const rows = await getDailyRange(shopId, utc("2026-08-01"), utc("2026-08-31"));
    expect(rows.map((r) => r.date.toISOString().slice(0, 10))).toEqual([
      "2026-08-09",
      "2026-08-11",
    ]);
  });

  test("empty range totals to zero rather than null", async () => {
    expect(await getTotals(shopId, DAY, DAY)).toMatchObject({
      served: 0,
      revenue: 0,
    });
  });
});

describe("getTopProducts", () => {
  // Ranked by impressions, not served: serves belong to the widget and live
  // under WIDGET_TOTAL, so every product row has served = 0.
  test("ranks by impressions across the range", async () => {
    await bump({ productId: 1, metrics: { impressions: 5 }, revenue: 10 });
    await bump({ productId: 2, metrics: { impressions: 50 }, revenue: 20 });
    await bump({
      productId: 2,
      date: utc("2026-08-11"),
      metrics: { impressions: 1 },
      revenue: 5,
    });

    const top = await getTopProducts(shopId, utc("2026-08-01"), utc("2026-08-31"));
    expect(top.map((p) => p.productId)).toEqual(["2", "1"]);
    expect(top[0]).toMatchObject({ impressions: 51, revenue: 25 });
  });

  test("leaves the widget sentinel out of the product ranking", async () => {
    await bump({ productId: WIDGET_TOTAL, metrics: { served: 99 } });
    await bump({ productId: 1, metrics: { impressions: 5 } });

    const top = await getTopProducts(shopId, DAY, DAY);
    expect(top.map((p) => p.productId)).toEqual(["1"]);
  });

  test("honours the limit", async () => {
    for (const productId of [1, 2, 3]) {
      await bump({ productId, metrics: { impressions: productId } });
    }
    expect(await getTopProducts(shopId, DAY, DAY, { limit: 2 })).toHaveLength(2);
  });
});

describe("maintenance", () => {
  // The rollup increments, so a day has to be wiped before it is re-rolled or
  // the numbers double.
  test("clearDay empties one day and leaves the rest", async () => {
    await bump({ date: utc("2026-08-09") });
    await bump({ date: DAY });

    await clearDay(shopId, DAY);
    expect((await getTotals(shopId, DAY, DAY)).served).toBe(0);
    expect((await getTotals(shopId, utc("2026-08-09"), utc("2026-08-09"))).served).toBe(10);
  });

  test("deleteDailyBefore prunes older days only", async () => {
    await bump({ date: utc("2026-01-05") });
    await bump({ date: DAY });

    await deleteDailyBefore(shopId, utc("2026-06-01"));
    expect(await prisma.analyticsDaily.count({ where: { shopId } })).toBe(1);
  });
});
