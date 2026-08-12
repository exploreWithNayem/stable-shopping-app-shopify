/**
 * Turns an orders/create payload into purchase events.
 *
 * Pure and synchronous so the mapping can be tested against real webhook
 * shapes without a database or a live store.
 */

export const SOURCE_PROPERTY = "_reco_src";
export const CLICK_PROPERTY = "_reco_cid";
export const ORIGIN_PROPERTY = "_reco_source";

const VALID_SOURCES = ["shopify", "override"];

/**
 * Line item properties arrive as [{ name, value }] on webhook payloads, but as
 * a plain object elsewhere in the API. Both are accepted.
 */
export function readLineProperties(lineItem) {
  const raw = lineItem?.properties;
  if (!raw) return {};

  if (Array.isArray(raw)) {
    return raw.reduce((accumulator, entry) => {
      if (entry?.name) accumulator[entry.name] = entry.value;
      return accumulator;
    }, {});
  }

  return typeof raw === "object" ? raw : {};
}

/**
 * One purchase event per attributed line.
 *
 * Revenue is price × quantity, and the app's own tagging is the only signal
 * used — a line with no `_reco_src` was not sold by a recommendation and is
 * left out rather than guessed at.
 */
export function purchaseEventsFromOrder(order) {
  const orderId = order?.admin_graphql_api_id ?? (order?.id ? String(order.id) : null);
  const lineItems = order?.line_items ?? [];
  const createdAt = order?.created_at ? new Date(order.created_at) : undefined;

  const events = [];

  for (const line of lineItems) {
    const properties = readLineProperties(line);
    const sourceProductId = properties[SOURCE_PROPERTY];
    if (!sourceProductId) continue;

    const quantity = Number(line.quantity ?? 1) || 1;
    const unitPrice = Number(line.price ?? 0) || 0;
    const origin = properties[ORIGIN_PROPERTY];

    events.push({
      type: "purchase",
      sourceProductId: String(sourceProductId),
      recoProductId: line.product_id ? String(line.product_id) : null,
      // The theme block is the only thing tagging lines today. Checkout adds
      // go through applyCartLinesChange (Phase 12) and will need their own
      // placement carried here.
      placement: "pdp",
      source: VALID_SOURCES.includes(origin) ? origin : "shopify",
      orderId,
      revenue: (unitPrice * quantity).toFixed(2),
      // Stable across redeliveries: Shopify guarantees at-least-once, so the
      // key has to come from the order rather than be generated here.
      clientId: `order:${orderId}:line:${line.id}`,
      ...(createdAt && !Number.isNaN(createdAt.getTime()) ? { createdAt } : {}),
    });
  }

  return events;
}
