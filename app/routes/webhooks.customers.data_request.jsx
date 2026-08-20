import { authenticate } from "../shopify.server";
import { getShopByDomain } from "../models/shop.server";

/**
 * GDPR: a customer has asked the merchant for the personal data this app holds
 * about them. Mandatory — the App Store rejects an app that does not subscribe.
 *
 * The honest answer here is "none". Nothing this app stores is keyed to a
 * person: RecommendationEvent holds product ids, a placement, an opaque
 * per-tab session id, and — on purchase rows only — an order id. There is no
 * name, email, address or customer id anywhere in the schema, and the app never
 * requests customer scopes.
 *
 * So there is nothing to assemble and hand back. The handler still has to exist
 * and still has to verify the HMAC (authenticate.webhook does that, and throws
 * a 401 if it fails), because Shopify tests that it does.
 *
 * If a future phase ever stores a customer id — a per-shopper recommendation
 * history, say — this is the handler that has to start producing a payload, and
 * `orders_requested` in the body is where to look.
 */
export const action = async ({ request }) => {
  const { shop, payload, topic } = await authenticate.webhook(request);

  const shopRecord = await getShopByDomain(shop);

  console.log(
    `[easy-reco] ${topic} for ${shop}: no personal data held`,
    JSON.stringify({
      known: Boolean(shopRecord),
      customer: payload?.customer?.id ?? null,
      ordersRequested: payload?.orders_requested?.length ?? 0,
    }),
  );

  return new Response();
};
