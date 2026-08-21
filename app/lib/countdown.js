/**
 * The offer countdown, in the one place both sides can read.
 *
 * Client-safe on purpose. The offer builder renders these in a component — the
 * default wording, the bounds on the length, the ticking clock in the preview —
 * and `app/models/offer.server.js` validates against the same values. Importing
 * them from the model instead broke `npm run build` outright: a route component
 * that touches a `.server` module drags it into the client bundle, which is the
 * one thing neither lint nor the tests can see.
 *
 * `formatDuration` is mirrored by a copy in `extensions/theme-extension/assets/
 * reco.js`, which cannot import from here — the storefront runtime is a plain
 * asset with no bundler. A test pins the two together.
 */

/**
 * How a countdown ends.
 *
 * `fixed` is a per-visitor duration: the clock starts when a shopper first sees
 * the offer, and when it runs out the offer hides for 24 hours before starting
 * over — urgency that works on a product page most people visit once. `date` is
 * one absolute deadline for everybody, after which the offer is simply over.
 */
export const COUNTDOWN_MODES = ["fixed", "date"];

/** An hour, which is what the reference design defaults to. */
export const DEFAULT_COUNTDOWN_MINUTES = 60;

/**
 * Where the live clock goes in the merchant's own sentence. A token rather than a
 * fixed prefix, so "Hurry up! Offer expires in 09:12" and "09:12 left on this
 * offer" are both writable.
 */
export const COUNTDOWN_TOKEN = "{{timer}}";

export const DEFAULT_COUNTDOWN_TITLE = `Hurry up! Offer expires in ${COUNTDOWN_TOKEN}`;

/**
 * Minutes are clamped rather than validated: the field is a number input, and a
 * merchant who types 0 or 100000 means "very short" or "very long", not "reject my
 * save". One minute is the shortest countdown that can be read; a week is past the
 * point where a per-visitor timer says anything.
 */
export const MIN_COUNTDOWN_MINUTES = 1;
export const MAX_COUNTDOWN_MINUTES = 10080;

export function clampCountdownMinutes(value) {
  /*
   * An empty field is "nothing given", not zero. `Number("")` is 0 and finite, so
   * without this a merchant who cleared the box mid-edit and saved got a
   * one-minute countdown — the clamp doing exactly what it was told.
   */
  if (value === null || value === undefined || String(value).trim() === "") {
    return DEFAULT_COUNTDOWN_MINUTES;
  }

  const minutes = Math.round(Number(value));
  if (!Number.isFinite(minutes)) return DEFAULT_COUNTDOWN_MINUTES;
  return Math.min(Math.max(minutes, MIN_COUNTDOWN_MINUTES), MAX_COUNTDOWN_MINUTES);
}

/**
 * The clock, at whatever scale the remaining time needs: `mm:ss`, then `h:mm:ss`
 * past an hour, then `5d 10:37:21` past a day.
 *
 * The days step exists because a week-long countdown read **130:37:21** — an hours
 * counter that has run past anything a shopper can parse. Hours are padded once a
 * day is shown, so the tail stays a fixed width as it counts down.
 *
 * `dayUnit` is a parameter rather than a constant because the storefront copy of
 * this function takes the letter from the shop's locale file; the admin preview is
 * English and uses the default.
 */
export function formatDuration(ms, { dayUnit = "d" } = {}) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const pad = (part) => String(part).padStart(2, "0");

  const days = Math.floor(total / 86400);
  const hours = Math.floor(total / 3600) % 24;
  const minutes = Math.floor(total / 60) % 60;
  const seconds = total % 60;

  if (days > 0) return `${days}${dayUnit} ${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  return `${pad(minutes)}:${pad(seconds)}`;
}

/* ------------------------------------------------------- the deadline pickers */

/** When a date is picked but no time — "that day", not "that morning". */
export const DEFAULT_END_TIME = "23:30";

export const HOUR_OPTIONS = Array.from({ length: 12 }, (_, index) => index + 1);
export const MINUTE_OPTIONS = Array.from({ length: 60 }, (_, index) => index);
export const MERIDIEMS = ["AM", "PM"];

export const pad2 = (value) => String(value).padStart(2, "0");

/** The two halves of the default, so a fallback here cannot drift from it. */
const [FALLBACK_HOUR, FALLBACK_MINUTE] = DEFAULT_END_TIME.split(":").map(Number);

/**
 * `Number("")` is 0 and finite — the second time that has bitten this file (see
 * `clampCountdownMinutes`). Blank means "nothing given", and for a clock face
 * nothing given must fall back to the default deadline, not to midnight.
 */
const blank = (value) => value === undefined || value === null || String(value).trim() === "";

/**
 * A stored 24-hour "HH:mm" as the three things a clock face shows.
 *
 * Out-of-range input is clamped rather than rejected: the value comes from a URL
 * or a hand-edited row as often as from the picker, and a deadline of 25:99 should
 * read as late in the day, not blow up the editor.
 */
export function readTime(value) {
  const [rawHour, rawMinute] = String(value ?? "").split(":");
  const hour = blank(rawHour) ? NaN : Number(rawHour);
  const minute = blank(rawMinute) ? NaN : Number(rawMinute);

  const hour24 = Number.isFinite(hour) ? Math.min(Math.max(hour, 0), 23) : FALLBACK_HOUR;

  return {
    // 0 and 12 are both "12" on a clock face.
    hour12: hour24 % 12 === 0 ? 12 : hour24 % 12,
    minute: Number.isFinite(minute)
      ? Math.min(Math.max(minute, 0), 59)
      : FALLBACK_MINUTE,
    meridiem: hour24 >= 12 ? "PM" : "AM",
  };
}

/** …and back, to the "HH:mm" half of the stored local string. */
export function writeTime({ hour12, minute, meridiem }) {
  const hour24 = (hour12 % 12) + (meridiem === "PM" ? 12 : 0);
  return `${pad2(hour24)}:${pad2(minute)}`;
}

/** "6:04 PM" — the pill's own label, since it has to say what is chosen. */
export function formatClockTime(value) {
  const { hour12, minute, meridiem } = readTime(value);
  return `${hour12}:${pad2(minute)} ${meridiem}`;
}

/**
 * "Aug 22, 2026" — the date pill's label. An unset date prompts instead of showing
 * an empty button.
 *
 * Parsed at local noon on purpose: `new Date("2026-08-22")` is UTC midnight, which
 * is the day *before* in any negative offset — the classic off-by-one that makes a
 * merchant's deadline read a day early.
 */
export function formatDayLabel(value, { empty = "Choose a date" } = {}) {
  if (!value) return empty;

  const date = new Date(`${value}T12:00`);
  if (Number.isNaN(date.getTime())) return empty;

  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

/**
 * Split a merchant's sentence around the clock.
 *
 * No token means the clock goes *after* their sentence rather than nowhere — the
 * only reading that still renders a timer, and the same one reco.js takes.
 */
export function splitCountdownTitle(title) {
  const sentence = String(title ?? "");
  const at = sentence.indexOf(COUNTDOWN_TOKEN);

  if (at < 0) return { lead: sentence ? `${sentence} ` : "", trail: "" };
  return { lead: sentence.slice(0, at), trail: sentence.slice(at + COUNTDOWN_TOKEN.length) };
}
