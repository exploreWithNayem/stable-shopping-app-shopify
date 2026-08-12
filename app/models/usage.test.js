import { afterAll, beforeEach, describe, expect, test } from "vitest";
import prisma from "../db.server";
import {
  canServe,
  findPeriod,
  getBillingWindow,
  getCurrentPeriod,
  getQuotaStatus,
  listPeriods,
  recordServed,
} from "./usage.server";

const DOMAIN = "vitest-usage.myshopify.com";
const utc = (s) => new Date(`${s}T00:00:00Z`);
const iso = (d) => d.toISOString().slice(0, 10);
const NOW = utc("2026-08-12");

/** Billing window maths is pure — no database needed. */
describe("getBillingWindow", () => {
  const win = (anchor, now) =>
    getBillingWindow({ billingCycleStart: utc(anchor) }, utc(now));

  test("returns the first window before the anchor day comes round", () => {
    const w = win("2026-01-31", "2026-02-15");
    expect([iso(w.periodStart), iso(w.periodEnd)]).toEqual([
      "2026-01-31",
      "2026-02-28",
    ]);
  });

  test("holds the first window until the clamped end date", () => {
    expect(iso(win("2026-01-31", "2026-02-27").periodStart)).toBe("2026-01-31");
    expect(iso(win("2026-01-31", "2026-02-28").periodStart)).toBe("2026-02-28");
  });

  // The regression this guards: stepping month-by-month from the previous
  // window would clamp Jan 31 -> Feb 28 and then bill on the 28th forever.
  test("does not permanently drift to the clamped day", () => {
    const w = win("2026-01-31", "2026-03-30");
    expect([iso(w.periodStart), iso(w.periodEnd)]).toEqual([
      "2026-02-28",
      "2026-03-31",
    ]);
    expect(iso(win("2026-01-31", "2026-03-31").periodStart)).toBe("2026-03-31");
  });

  test("handles the leap day", () => {
    const w = win("2028-01-31", "2028-02-29");
    expect([iso(w.periodStart), iso(w.periodEnd)]).toEqual([
      "2028-02-29",
      "2028-03-31",
    ]);
  });

  test("jumps straight to a window months later", () => {
    const w = win("2026-08-12", "2027-01-05");
    expect([iso(w.periodStart), iso(w.periodEnd)]).toEqual([
      "2026-12-12",
      "2027-01-12",
    ]);
  });

  test("treats the anchor instant as the start of its own window", () => {
    expect(iso(win("2026-08-12", "2026-08-12").periodStart)).toBe("2026-08-12");
  });

  test("never runs negative for a future anchor", () => {
    expect(iso(win("2030-01-01", "2026-08-12").periodStart)).toBe("2030-01-01");
  });

  test("falls back to installedAt when there is no billing anchor", () => {
    const w = getBillingWindow({ installedAt: utc("2026-05-03") }, NOW);
    expect(iso(w.periodStart)).toBe("2026-08-03");
  });
});

describe("quota status", () => {
  let shop;

  beforeEach(async () => {
    await prisma.shop.deleteMany({ where: { domain: DOMAIN } });
    shop = await prisma.shop.create({
      data: { domain: DOMAIN, plan: "free", billingCycleStart: utc("2026-08-01") },
    });
  });

  afterAll(async () => {
    await prisma.shop.deleteMany({ where: { domain: DOMAIN } });
  });

  test("starts empty on the free plan", async () => {
    const status = await getQuotaStatus(shop.id, NOW);
    expect(status).toMatchObject({
      plan: "free",
      used: 0,
      limit: 100,
      remaining: 100,
      percentUsed: 0,
      isOver: false,
      unlimited: false,
    });
    expect(iso(status.resetsAt)).toBe("2026-09-01");
  });

  test("trips the warning at 80% but still serves", async () => {
    await recordServed(shop.id, 79, NOW);
    expect(await getQuotaStatus(shop.id, NOW)).toMatchObject({
      percentUsed: 79,
      isNearLimit: false,
    });

    await recordServed(shop.id, 1, NOW);
    expect(await getQuotaStatus(shop.id, NOW)).toMatchObject({
      isNearLimit: true,
      isOver: false,
    });
    expect(await canServe(shop.id, NOW)).toBe(true);
  });

  test("stops serving once the limit is reached", async () => {
    await recordServed(shop.id, 100, NOW);
    expect(await getQuotaStatus(shop.id, NOW)).toMatchObject({
      isOver: true,
      remaining: 0,
      percentUsed: 100,
    });
    expect(await canServe(shop.id, NOW)).toBe(false);
  });

  test("counts concurrent increments without losing any", async () => {
    await Promise.all(
      Array.from({ length: 25 }, () => recordServed(shop.id, 1, NOW)),
    );
    expect((await getQuotaStatus(shop.id, NOW)).used).toBe(25);
  });
});

describe("plan changes mid-window", () => {
  let shop;

  beforeEach(async () => {
    await prisma.shop.deleteMany({ where: { domain: DOMAIN } });
    shop = await prisma.shop.create({
      data: { domain: DOMAIN, plan: "free", billingCycleStart: utc("2026-08-01") },
    });
    await recordServed(shop.id, 100, NOW);
  });

  afterAll(async () => {
    await prisma.shop.deleteMany({ where: { domain: DOMAIN } });
  });

  test("an upgrade raises the limit immediately and keeps usage", async () => {
    await prisma.shop.update({
      where: { id: shop.id },
      data: { plan: "standard" },
    });

    expect(await getQuotaStatus(shop.id, NOW)).toMatchObject({
      limit: 1000,
      used: 100,
      isOver: false,
    });

    // Self-heals the stored row too, so a missed webhook can't strand a shop.
    expect(await getCurrentPeriod(shop.id, NOW)).toMatchObject({
      quota: 1000,
      planAtStart: "standard",
    });
  });

  test("unlimited reports null limits and never blocks", async () => {
    await prisma.shop.update({
      where: { id: shop.id },
      data: { plan: "enterprise" },
    });
    await recordServed(shop.id, 500_000, NOW);

    const status = await getQuotaStatus(shop.id, NOW);
    expect(status).toMatchObject({
      unlimited: true,
      limit: null,
      remaining: null,
      percentUsed: 0,
      isOver: false,
      isNearLimit: false,
    });
    // null rather than Infinity so the status survives a loader's JSON round-trip.
    expect(JSON.parse(JSON.stringify(status)).remaining).toBeNull();
    expect(await canServe(shop.id, NOW)).toBe(true);
  });

  test("a downgrade applies at once and can leave a shop over quota", async () => {
    await prisma.shop.update({
      where: { id: shop.id },
      data: { plan: "enterprise" },
    });
    await recordServed(shop.id, 5_000, NOW);
    await prisma.shop.update({ where: { id: shop.id }, data: { plan: "free" } });

    expect(await getQuotaStatus(shop.id, NOW)).toMatchObject({
      limit: 100,
      isOver: true,
    });
  });
});

describe("rollover", () => {
  let shop;

  beforeEach(async () => {
    await prisma.shop.deleteMany({ where: { domain: DOMAIN } });
    shop = await prisma.shop.create({
      data: { domain: DOMAIN, plan: "free", billingCycleStart: utc("2026-08-01") },
    });
    await recordServed(shop.id, 42, NOW);
  });

  afterAll(async () => {
    await prisma.shop.deleteMany({ where: { domain: DOMAIN } });
  });

  test("opens a fresh window without touching the old one", async () => {
    const next = await getCurrentPeriod(shop.id, utc("2026-09-05"));
    expect(iso(next.periodStart)).toBe("2026-09-01");
    expect(next.servedCount).toBe(0);

    const previous = await findPeriod(shop.id, utc("2026-08-01"));
    expect(previous.servedCount).toBe(42);
    expect(await listPeriods(shop.id)).toHaveLength(2);
  });
});
