import { authenticate } from "../shopify.server";
import { getShopByDomain } from "../models/shop.server";
import { deleteEventsForOrders } from "../models/event.server";

/**
 * GDPR: erase what this app holds about one customer. Mandatory.
 *
 * The app stores no customer identifiers (see webhooks.customers.data_request),
 * with one exception: a `purchase` event carries the `orderId` it was attributed
 * from, and an order leads back to a person. Shopify names the affected orders
 * in `orders_to_redact`, so those rows are the redaction.
 *
 * Aggregate revenue already in AnalyticsDaily is not customer-linked and is
 * kept — a total across a day identifies nobody.
 */
export const action = async ({ request }) => {
  const { shop, payload, topic } = await authenticate.webhook(request);

  const shopRecord = await getShopByDomain(shop);
  // Uninstalled and already purged, or never installed. Nothing to erase.
  if (!shopRecord) return new Response();

  const orderIds = Array.isArray(payload?.orders_to_redact)
    ? payload.orders_to_redact
    : [];

  const { count } = await deleteEventsForOrders(shopRecord.id, orderIds);

  console.log(
    `[easy-reco] ${topic} for ${shop}: redacted ${count} event(s) across ${orderIds.length} order(s)`,
  );

  return new Response();
};
