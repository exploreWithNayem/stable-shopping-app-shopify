import { authenticate } from "../shopify.server";
import { getShopByDomain } from "../models/shop.server";
import { isOfferLive } from "../models/offer.server";

/**
 * GET /apps/easy-reco/offer?offerId=…&productId=…
 *
 * "Is this offer still live for this product?"
 *
 * The storefront reads offers out of a metafield — a mirror the app writes (§3.1,
 * §7.8). A mirror can be stale: any write that fails, or any path that forgets to
 * rewrite it, leaves an offer rendering that no longer exists in the admin. From
 * Liquid's side there is no way to tell the difference, because mirror-says-offer
 * *is* offer.
 *
 * So the mirror proposes and the app confirms. The widget renders only when both
 * are true: the app embed is on, and the app says this offer is live.
 *
 * Deliberately narrow. It does **not** resolve products or match triggers — Liquid
 * already did that for free with `product.collections`, and doing it here would mean
 * an Admin API call per page view. All this answers is whether the offer behind what
 * Liquid found still exists, is still published, and still covers this product.
 */

/**
 * `no-store`, like the recommendations endpoint: a cached "live" would outlive the
 * offer it describes, which is the exact failure this endpoint exists to end.
 */
function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

/**
 * Not live, for every failure.
 *
 * The merchant's instruction is "render when there *is* an offer", and an
 * unanswerable question is not a yes. A proxy problem therefore hides the widget
 * rather than showing something that may no longer exist — which is also the safer
 * side for the shopper, who cannot be offered a deal the store has withdrawn.
 */
const NOT_LIVE = { live: false };

export const loader = async ({ request }) => {
  let session;
  try {
    ({ session } = await authenticate.public.appProxy(request));
  } catch {
    return json(NOT_LIVE, 401);
  }

  if (!session?.shop) return json(NOT_LIVE);

  try {
    const url = new URL(request.url);
    const offerId = url.searchParams.get("offerId");
    const productId = url.searchParams.get("productId");

    if (!offerId) return json(NOT_LIVE);

    const shop = await getShopByDomain(session.shop);
    // An uninstalled shop has no live anything.
    if (!shop || shop.uninstalledAt) return json(NOT_LIVE);

    return json({ live: await isOfferLive(shop.id, offerId, productId) });
  } catch (error) {
    console.error("[easy-reco] offer liveness check failed", error);
    return json(NOT_LIVE);
  }
};
