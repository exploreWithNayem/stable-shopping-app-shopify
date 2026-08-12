import { describe, expect, test } from "vitest";
import {
  DEFAULT_PLAN,
  PLANS,
  PLAN_KEYS,
  UNLIMITED,
  getPlan,
  isPaidPlan,
  isUnlimited,
  planQuota,
} from "./plans";

describe("plan definitions", () => {
  test("match the published pricing", () => {
    expect(PLANS.free).toMatchObject({ price: 0, quota: 100 });
    expect(PLANS.standard).toMatchObject({ price: 29, quota: 1000 });
    expect(PLANS.enterprise).toMatchObject({ price: 59, quota: UNLIMITED });
  });

  test("every key is self-consistent and listed in display order", () => {
    for (const [key, plan] of Object.entries(PLANS)) {
      expect(plan.key).toBe(key);
      expect(PLAN_KEYS).toContain(key);
    }
    expect(PLAN_KEYS).toHaveLength(Object.keys(PLANS).length);
  });
});

describe("getPlan", () => {
  test("falls back to the default plan for unknown keys", () => {
    expect(getPlan("bogus").key).toBe(DEFAULT_PLAN);
    expect(getPlan(undefined).key).toBe(DEFAULT_PLAN);
    expect(getPlan(null).key).toBe(DEFAULT_PLAN);
  });
});

describe("quota helpers", () => {
  test("planQuota reads through to the definition", () => {
    expect(planQuota("standard")).toBe(1000);
    expect(planQuota("bogus")).toBe(100);
  });

  test("only enterprise is unlimited", () => {
    expect(isUnlimited(planQuota("enterprise"))).toBe(true);
    expect(isUnlimited(planQuota("standard"))).toBe(false);
    expect(isUnlimited(planQuota("free"))).toBe(false);
  });

  test("free is the only unpaid plan", () => {
    expect(isPaidPlan("free")).toBe(false);
    expect(isPaidPlan("standard")).toBe(true);
    expect(isPaidPlan("enterprise")).toBe(true);
  });
});
