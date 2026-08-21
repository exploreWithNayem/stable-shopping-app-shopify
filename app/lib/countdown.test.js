import { describe, expect, test } from "vitest";
import {
  DEFAULT_COUNTDOWN_MINUTES,
  MAX_COUNTDOWN_MINUTES,
  clampCountdownMinutes,
  formatClockTime,
  formatDayLabel,
  formatDuration,
  readTime,
  splitCountdownTitle,
  writeTime,
} from "./countdown";

/*
 * The clock the offer editor previews. Its twin lives in reco.js — the storefront
 * runtime is a plain theme asset and cannot import this — so these assertions are
 * deliberately the same strings tests/reco-runtime.test.js expects from the other
 * copy. A drift shows up as one of the two suites failing.
 */
describe("formatDuration", () => {
  test("mm:ss under an hour, h:mm:ss at or above one", () => {
    expect(formatDuration(3599000)).toBe("59:59");
    expect(formatDuration(119000)).toBe("01:59");
    expect(formatDuration(5399000)).toBe("1:29:59");
    expect(formatDuration(3600000)).toBe("1:00:00");
  });

  test("days once there is more than a day, not a runaway hours count", () => {
    /*
     * A week-long countdown rendered "130:37:21" on a live storefront — an hours
     * counter past anything a shopper parses. Hours are padded from here on, so the
     * tail keeps a fixed width while it counts down.
     */
    expect(formatDuration(470241000)).toBe("5d 10:37:21");
    expect(formatDuration(86400000)).toBe("1d 00:00:00");
    // The last second before the days step, and the first one after it.
    expect(formatDuration(86399000)).toBe("23:59:59");
    expect(formatDuration(90061000)).toBe("1d 01:01:01");
  });

  test("the day letter is a parameter, because the storefront translates it", () => {
    // reco.js takes it from the shop's locale file; the admin preview is English.
    expect(formatDuration(86400000, { dayUnit: "j" })).toBe("1j 00:00:00");
  });

  test("never counts past zero", () => {
    // A negative remainder is a deadline already gone; the caller hides the offer,
    // and until it does the clock must not read "-01:23".
    expect(formatDuration(0)).toBe("00:00");
    expect(formatDuration(-5000)).toBe("00:00");
  });
});

describe("splitCountdownTitle", () => {
  test("splits the merchant's sentence around the clock", () => {
    expect(splitCountdownTitle("Hurry up! Offer expires in {{timer}}")).toEqual({
      lead: "Hurry up! Offer expires in ",
      trail: "",
    });
    expect(splitCountdownTitle("{{timer}} left on this offer")).toEqual({
      lead: "",
      trail: " left on this offer",
    });
  });

  test("no token puts the clock after the sentence, not nowhere", () => {
    // The only reading that still renders a timer.
    expect(splitCountdownTitle("Ends soon")).toEqual({ lead: "Ends soon ", trail: "" });
    expect(splitCountdownTitle("")).toEqual({ lead: "", trail: "" });
    expect(splitCountdownTitle(null)).toEqual({ lead: "", trail: "" });
  });
});

describe("clampCountdownMinutes", () => {
  test("clamps rather than rejecting", () => {
    expect(clampCountdownMinutes(0)).toBe(1);
    expect(clampCountdownMinutes(999999)).toBe(MAX_COUNTDOWN_MINUTES);
    expect(clampCountdownMinutes("45")).toBe(45);
  });

  test("an empty field means nothing given, not zero", () => {
    // `Number("")` is 0 and finite, so without the guard a merchant who cleared
    // the box mid-edit saved a one-minute countdown.
    expect(clampCountdownMinutes("")).toBe(DEFAULT_COUNTDOWN_MINUTES);
    expect(clampCountdownMinutes("  ")).toBe(DEFAULT_COUNTDOWN_MINUTES);
    expect(clampCountdownMinutes(null)).toBe(DEFAULT_COUNTDOWN_MINUTES);
    expect(clampCountdownMinutes("soon")).toBe(DEFAULT_COUNTDOWN_MINUTES);
  });
});

/*
 * The deadline pickers. The stored value is one local "YYYY-MM-DDTHH:mm" string and
 * the design shows a calendar and a clock face, so these are the conversions
 * between the two — the pill's label and the picker's highlighted cells both come
 * through here, which is what stops them disagreeing.
 */
describe("readTime / writeTime", () => {
  test("round-trips a 24-hour value through a clock face", () => {
    expect(readTime("18:04")).toEqual({ hour12: 6, minute: 4, meridiem: "PM" });
    expect(writeTime({ hour12: 6, minute: 4, meridiem: "PM" })).toBe("18:04");
  });

  test("midnight and noon are both 12", () => {
    // 0 and 12 are the same face; only the meridiem separates them.
    expect(readTime("00:30")).toEqual({ hour12: 12, minute: 30, meridiem: "AM" });
    expect(readTime("12:00")).toEqual({ hour12: 12, minute: 0, meridiem: "PM" });
    expect(writeTime({ hour12: 12, minute: 30, meridiem: "AM" })).toBe("00:30");
    expect(writeTime({ hour12: 12, minute: 0, meridiem: "PM" })).toBe("12:00");
  });

  test("out-of-range and unusable input is clamped, never thrown", () => {
    // These arrive from a URL or a hand-edited row as often as from the picker.
    expect(readTime("25:99")).toEqual({ hour12: 11, minute: 59, meridiem: "PM" });
    expect(readTime("")).toEqual({ hour12: 11, minute: 30, meridiem: "PM" });
    expect(readTime(null)).toEqual({ hour12: 11, minute: 30, meridiem: "PM" });
  });
});

describe("formatClockTime", () => {
  test("reads as a deadline, not as a stored value", () => {
    expect(formatClockTime("18:04")).toBe("6:04 PM");
    expect(formatClockTime("09:00")).toBe("9:00 AM");
    expect(formatClockTime("00:05")).toBe("12:05 AM");
  });
});

describe("formatDayLabel", () => {
  test("formats the day the merchant picked", () => {
    expect(formatDayLabel("2026-08-22")).toBe("Aug 22, 2026");
  });

  test("does not slip a day in a negative offset", () => {
    /*
     * `new Date("2026-01-01")` is UTC midnight, which is 31 December in any
     * negative offset — so the label is parsed at local noon instead. This test
     * passes in every zone; the bug it guards was only visible west of UTC.
     */
    expect(formatDayLabel("2026-01-01")).toBe("Jan 1, 2026");
  });

  test("prompts rather than rendering an empty pill", () => {
    expect(formatDayLabel("")).toBe("Choose a date");
    expect(formatDayLabel("not a date")).toBe("Choose a date");
    expect(formatDayLabel(null, { empty: "Pick one" })).toBe("Pick one");
  });
});
