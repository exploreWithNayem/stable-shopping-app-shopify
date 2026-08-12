/** Display formatting shared by the admin pages. */

const numberFormatter = new Intl.NumberFormat("en");

export function formatNumber(value) {
  return numberFormatter.format(value ?? 0);
}

/** Percentage with a single decimal only when it needs one (4% / 4.2%). */
export function formatPercent(value, { digits = 1 } = {}) {
  const number = Number(value ?? 0);
  return `${Number.isInteger(number) ? number : number.toFixed(digits)}%`;
}

export function formatMoney(value, currencyCode = "USD") {
  return new Intl.NumberFormat("en", {
    style: "currency",
    currency: currencyCode || "USD",
  }).format(Number(value ?? 0));
}

/** "12 Sep" — dates arrive from loaders as ISO strings. */
export function formatShortDate(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("en", {
    day: "numeric",
    month: "short",
  }).format(new Date(value));
}

/** Click-through rate as a percentage of impressions. */
export function rate(numerator, denominator) {
  if (!denominator) return 0;
  return (numerator / denominator) * 100;
}
