import { authenticate } from "../shopify.server";
import { getShopByDomain } from "../models/shop.server";
import { recordEvents } from "../models/event.server";
import { purchaseEventsFromOrder } from "../lib/attribution.server";

/**
 * Closes the loop on attribution.
 *
 * reco.js tags every line it adds with `_reco_src` / `_reco_cid`, and those
 * properties travel with the line all the way into the order. Reading them back
 * here is what turns "someone clicked a recommendation" into revenue.
 */
export const action = async ({ request }) => {
  const { shop, payload, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  const shopRecord = await getShopByDomain(shop);
  if (!shopRecord) return new Response();

  const events = purchaseEventsFromOrder(payload);
  // clientId is derived from the order and line ids, so Shopify's at-least-once
  // delivery cannot double-count a sale.
  if (events.length > 0) await recordEvents(shopRecord.id, events);

  return new Response();
};
