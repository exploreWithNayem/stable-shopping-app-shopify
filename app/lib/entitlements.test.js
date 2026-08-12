import { describe, expect, test } from "vitest";
import {
  analyticsRetentionDays,
  canUseCheckout,
  canUseOverrides,
} from "./entitlements";

describe("feature gates", () => {
  test("overrides and checkout need a paid plan", () => {
    expect(canUseOverrides("free")).toBe(false);
    expect(canUseOverrides("standard")).toBe(true);
    expect(canUseOverrides("enterprise")).toBe(true);

    expect(canUseCheckout("free")).toBe(false);
    expect(canUseCheckout("standard")).toBe(true);
  });

  // An unknown plan must not accidentally unlock paid features.
  test("an unknown plan is treated as free", () => {
    expect(canUseOverrides("bogus")).toBe(false);
    expect(canUseOverrides(undefined)).toBe(false);
    expect(analyticsRetentionDays("bogus")).toBe(7);
  });

  test("retention grows with the plan", () => {
    expect(analyticsRetentionDays("free")).toBe(7);
    expect(analyticsRetentionDays("standard")).toBe(90);
    expect(analyticsRetentionDays("enterprise")).toBe(365);
  });
});
