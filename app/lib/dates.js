/**
 * Date helpers. Everything the app stores is UTC — the billing month is anchored
 * to Shop.billingCycleStart rather than the calendar month, so never assume the
 * 1st. Billing-window maths lives in app/models/usage.server.js (Phase 2).
 */

/** UTC midnight for the day `date` falls in. */
export function startOfUtcDay(date = new Date()) {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/** `date` shifted by `days`, without mutating the input. */
export function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

/** `date` shifted by `months`, clamping to the last valid day (Jan 31 -> Feb 28). */
export function addMonths(date, months) {
  const d = new Date(date);
  const targetDay = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDayOfTarget = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
  ).getUTCDate();
  d.setUTCDate(Math.min(targetDay, lastDayOfTarget));
  return d;
}

/** Inclusive list of UTC midnights between `from` and `to`. */
export function eachUtcDay(from, to) {
  const days = [];
  let cursor = startOfUtcDay(from);
  const end = startOfUtcDay(to);
  while (cursor <= end) {
    days.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return days;
}
