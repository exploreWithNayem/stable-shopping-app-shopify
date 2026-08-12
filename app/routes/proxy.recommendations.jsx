import { authenticate } from "../shopify.server";
import { getShopByDomain } from "../models/shop.server";
import { canServe, recordServed } from "../models/usage.server";
import { recordEvent } from "../models/event.server";
import { isDuplicateServe } from "../lib/tracking.server";
import {
  DEFAULT_LIMIT,
  getShopifyRecommendations,
  resolveRecommendations,
} from "../lib/recommendations.server";

/**
 * GET /apps/easy-reco/recommendations
 *
 * Serves the checkout extension and any theme that prefers to fetch rather than
 * render from the metafield.
 *
 * Two rules govern everything here: never throw at the storefront, and only
 * count a recommendation the merchant actually got value from.
 */

const EMPTY = { source: "shopify", items: [] };

/**
 * No-store rather than a short CDN cache: a cached response would never reach
 * this server, and the `served` count would silently drift below reality.
 */
function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export const loader = async ({ request }) => {
  let session;
  try {
    ({ session } = await authenticate.public.appProxy(request));
  } catch {
    return json(EMPTY, 401);
  }

  if (!session?.shop) return json(EMPTY);

  try {
    const url = new URL(request.url);
    const productId = url.searchParams.get("productId");
    if (!productId) return json(EMPTY, 400);

    const placement = url.searchParams.get("placement") ?? "pdp";
    const intent = url.searchParams.get("intent") ?? "related";
    const sessionId = url.searchParams.get("sessionId");
    const limit = Number(url.searchParams.get("limit")) || DEFAULT_LIMIT;

    const shop = await getShopByDomain(session.shop);
    if (!shop) return json(EMPTY);

    // Over quota: the storefront keeps working on Shopify's own list, but
    // overrides are withheld and nothing is counted or tracked.
    if (!(await canServe(shop.id))) {
      try {
        const items = await getShopifyRecommendations({
          shop,
          productId,
          intent,
          limit,
        });
        return json({ source: "shopify", items, quotaExceeded: true });
      } catch {
        return json({ ...EMPTY, quotaExceeded: true });
      }
    }

    const result = await resolveRecommendations({
      shop,
      productId,
      placement,
      intent,
      limit,
    });

    // An empty or degraded response cost the merchant nothing, so it must not
    // cost them a recommendation either.
    if (result.items.length > 0 && !result.degraded) {
      const duplicate = await isDuplicateServe({
        shopId: shop.id,
        sessionId,
        sourceProductId: productId,
        placement,
      });

      if (!duplicate) {
        await recordServed(shop.id, 1);
        await recordEvent(shop.id, {
          type: "served",
          sourceProductId: productId,
          placement,
          source: result.source,
          sessionId,
        });
      }
    }

    return json({ source: result.source, items: result.items });
  } catch {
    // Any unexpected failure degrades to "no recommendations" so the theme can
    // fall back to the Ajax API instead of rendering an error.
    return json(EMPTY);
  }
};
