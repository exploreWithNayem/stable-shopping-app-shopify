import { authenticate } from "../shopify.server";
import { purgeShopData } from "../models/shop.server";

/**
 * GDPR: 48 hours after an uninstall, erase the shop. Mandatory.
 *
 * This is the hard delete that app/uninstalled deliberately is not. The
 * uninstall handler soft-deletes so a merchant who reinstalls the same day keeps
 * their overrides and history; by the time this arrives, Shopify has decided the
 * relationship is over.
 *
 * Deleting the Shop row cascades to overrides, usage periods, raw events and
 * daily rollups.
 */
export const action = async ({ request }) => {
  const { shop, topic } = await authenticate.webhook(request);

  const { shops, sessions } = await purgeShopData(shop);

  console.log(
    `[easy-reco] ${topic} for ${shop}: purged ${shops} shop row(s), ${sessions} session(s)`,
  );

  return new Response();
};
