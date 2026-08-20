import { authenticate } from "../shopify.server";
import db from "../db.server";
import { markUninstalled } from "../models/shop.server";

/**
 * The app was removed from the store.
 *
 * Three things have to happen, and only the first was being done:
 *
 *   1. Drop the sessions — the access token is dead the moment the app is gone.
 *   2. Mark the Shop uninstalled. Without this the row looks live forever:
 *      /cron/rollup filters on `uninstalledAt: null`, so every scheduled run
 *      keeps rolling up and pruning shops that left months ago.
 *   3. Drop the plan to Free and forget the subscription id. Shopify cancels
 *      the charge on uninstall regardless, so a stored subscriptionId is a stale
 *      claim to a paid quota — and a reinstall would otherwise resume on a plan
 *      nobody is paying for.
 *
 * A soft delete on purpose: a merchant who reinstalls keeps their overrides and
 * their history (ensureShop clears the marker and re-anchors the billing
 * window). The hard delete is `shop/redact`, which Shopify sends 48 hours later.
 *
 * Runs even when `session` is null: this webhook can arrive more than once and
 * can arrive after the session rows are already gone, but the Shop row still
 * needs marking.
 */
export const action = async ({ request }) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  if (session) {
    await db.session.deleteMany({ where: { shop } });
  }

  const { count } = await markUninstalled(shop);
  if (count > 0) console.log(`[easy-reco] marked ${shop} uninstalled`);

  return new Response();
};
