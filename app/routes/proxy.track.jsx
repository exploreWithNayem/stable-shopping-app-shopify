import { authenticate } from "../shopify.server";
import { getShopByDomain } from "../models/shop.server";
import { recordEvents } from "../models/event.server";
import { canServe, recordServed } from "../models/usage.server";
import {
  checkRateLimit,
  parseEventBatch,
  selectBillableServes,
} from "../lib/tracking.server";

/**
 * POST /apps/easy-reco/track
 *
 * Receives batched impression / click / add-to-cart beacons from the storefront.
 *
 * Answers 204 to almost everything on purpose. The caller is
 * navigator.sendBeacon, which cannot read a response and will not retry, so an
 * error status buys nothing and a noisy failure in the console is worse than a
 * dropped analytics event.
 */

const noContent = () => new Response(null, { status: 204 });

/** sendBeacon may send text/plain, so the body is parsed rather than trusted. */
async function readBody(request) {
  try {
    return JSON.parse(await request.text());
  } catch {
    return null;
  }
}

export const action = async ({ request }) => {
  if (request.method !== "POST") {
    return new Response(null, { status: 405 });
  }

  let session;
  try {
    ({ session } = await authenticate.public.appProxy(request));
  } catch {
    return new Response(null, { status: 401 });
  }

  if (!session?.shop) return noContent();

  try {
    // Flood protection before any database work.
    if (!checkRateLimit(session.shop)) return noContent();

    const body = await readBody(request);
    const { events } = parseEventBatch(body);
    if (events.length === 0) return noContent();

    const shop = await getShopByDomain(session.shop);
    if (!shop) return noContent();

    // `served` beacons come from widgets this app never rendered — the theme
    // block builds overrides straight from the metafield, and the Ajax fallback
    // never reaches us either. So quota is counted here as well as in
    // proxy.recommendations, which is what makes the count whole.
    const serves = events.filter((event) => event.type === "served");

    if (serves.length > 0 && !(await canServe(shop.id))) {
      // Over quota: the widget still renders, but nothing is counted or stored.
      return noContent();
    }

    // Resolved before anything is written — recordEvents would otherwise store
    // these serves and the check would find its own rows.
    const billable = await selectBillableServes({ shopId: shop.id, serves });

    // Replays are collapsed by clientId inside recordEvents.
    await recordEvents(shop.id, events);

    if (billable.length > 0) await recordServed(shop.id, billable.length);
  } catch {
    // Swallowed deliberately — see the note above.
  }

  return noContent();
};

/** Beacons are POSTs; a GET here is a mistake worth naming. */
export const loader = () => new Response(null, { status: 405 });
