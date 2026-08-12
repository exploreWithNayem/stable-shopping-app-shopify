import { describe, expect, test } from "vitest";
import { addDays, addMonths, eachUtcDay, startOfUtcDay } from "./dates";

const utc = (s) => new Date(`${s}T00:00:00Z`);
const iso = (d) => d.toISOString().slice(0, 10);

describe("startOfUtcDay", () => {
  test("zeroes the time component", () => {
    expect(startOfUtcDay(new Date("2026-01-31T12:34:56Z")).toISOString()).toBe(
      "2026-01-31T00:00:00.000Z",
    );
  });

  test("does not mutate its input", () => {
    const input = new Date("2026-01-31T12:00:00Z");
    startOfUtcDay(input);
    expect(input.toISOString()).toBe("2026-01-31T12:00:00.000Z");
  });
});

describe("addMonths", () => {
  test("clamps to the last valid day of a short month", () => {
    expect(iso(addMonths(utc("2026-01-31"), 1))).toBe("2026-02-28");
  });

  test("clamps to Feb 29 in a leap year", () => {
    expect(iso(addMonths(utc("2028-01-31"), 1))).toBe("2028-02-29");
  });

  test("restores the anchor day when the target month is long enough", () => {
    expect(iso(addMonths(utc("2026-01-31"), 2))).toBe("2026-03-31");
  });

  test("crosses a year boundary", () => {
    expect(iso(addMonths(utc("2026-11-15"), 3))).toBe("2027-02-15");
  });

  test("goes backwards", () => {
    expect(iso(addMonths(utc("2026-03-31"), -1))).toBe("2026-02-28");
  });
});

describe("addDays", () => {
  test("crosses a month boundary", () => {
    expect(iso(addDays(utc("2026-02-28"), 1))).toBe("2026-03-01");
  });

  test("crosses a leap day", () => {
    expect(iso(addDays(utc("2028-02-28"), 1))).toBe("2028-02-29");
  });
});

describe("eachUtcDay", () => {
  test("is inclusive of both ends", () => {
    expect(eachUtcDay(utc("2026-08-01"), utc("2026-08-04")).map(iso)).toEqual([
      "2026-08-01",
      "2026-08-02",
      "2026-08-03",
      "2026-08-04",
    ]);
  });

  test("returns a single day when from equals to", () => {
    expect(eachUtcDay(utc("2026-08-01"), utc("2026-08-01"))).toHaveLength(1);
  });

  test("returns nothing when the range is inverted", () => {
    expect(eachUtcDay(utc("2026-08-04"), utc("2026-08-01"))).toHaveLength(0);
  });
});
