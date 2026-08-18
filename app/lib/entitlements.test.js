import { describe, expect, test } from "vitest";
import {
  analyticsRetentionDays,
  canAddOverride,
  canExportCsv,
  canUseCheckout,
  overrideLimit,
  remainingOverrides,
} from "./entitlements";
import { UNLIMITED } from "./plans";

describe("feature gates", () => {
  test("checkout needs a paid plan", () => {
    expect(canUseCheckout("free")).toBe(false);
    expect(canUseCheckout("standard")).toBe(true);
    expect(canUseCheckout("enterprise")).toBe(true);
  });

  // An unknown plan must not accidentally unlock paid features.
  test("an unknown plan is treated as free", () => {
    expect(canUseCheckout("bogus")).toBe(false);
    expect(overrideLimit("bogus")).toBe(10);
    expect(overrideLimit(undefined)).toBe(10);
    expect(analyticsRetentionDays("bogus")).toBe(7);
  });

  test("retention grows with the plan", () => {
    expect(analyticsRetentionDays("free")).toBe(7);
    expect(analyticsRetentionDays("standard")).toBe(90);
    expect(analyticsRetentionDays("enterprise")).toBe(365);
  });
});

describe("override allowance", () => {
  test("free gets 10 products, paid plans get no ceiling", () => {
    expect(overrideLimit("free")).toBe(10);
    expect(overrideLimit("standard")).toBe(UNLIMITED);
    expect(overrideLimit("enterprise")).toBe(UNLIMITED);
  });

  test("canAddOverride stops at the limit, not before it", () => {
    expect(canAddOverride("free", 0)).toBe(true);
    expect(canAddOverride("free", 9)).toBe(true);
    expect(canAddOverride("free", 10)).toBe(false);
    // Defensive: a shop that somehow got past the limit stays blocked.
    expect(canAddOverride("free", 11)).toBe(false);
  });

  test("canAddOverride is always true on an unlimited plan", () => {
    expect(canAddOverride("standard", 5000)).toBe(true);
    expect(canAddOverride("enterprise", 5000)).toBe(true);
  });

  test("no argument means nothing used yet", () => {
    expect(canAddOverride("free")).toBe(true);
  });

  // Unlimited is null rather than Infinity so loaders can JSON-encode it.
  test("remainingOverrides is null when unlimited and never negative", () => {
    expect(remainingOverrides("free", 4)).toBe(6);
    expect(remainingOverrides("free", 12)).toBe(0);
    expect(remainingOverrides("standard", 4)).toBeNull();
  });
});

describe("canExportCsv", () => {
  test("is a paid feature", () => {
    expect(canExportCsv("free")).toBe(false);
    expect(canExportCsv("standard")).toBe(true);
    expect(canExportCsv("enterprise")).toBe(true);
  });

  test("treats an unknown plan as Free rather than granting the feature", () => {
    expect(canExportCsv("nonsense")).toBe(false);
    expect(canExportCsv(undefined)).toBe(false);
  });
});
