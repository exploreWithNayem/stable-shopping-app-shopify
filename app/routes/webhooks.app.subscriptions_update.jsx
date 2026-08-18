import { authenticate } from '../shopify.server';
import { getShopByDomain, setPlan } from '../models/shop.server';
import { getCurrentPeriodForShop } from '../models/usage.server';
import { PLANS } from '../lib/plans';

const ACTIVE_STATUSES = new Set(['ACTIVE', 'ACCEPTED']);

/** Subscription name back to a plan key, so a rename in the Partner Dashboard
 *  cannot silently map a shop onto the wrong quota. */
function planKeyFromName(name) {
  const match = Object.values(PLANS).find((plan) => plan.key === name || plan.name === name);
  return match?.key ?? null;
}

/**
 * Keeps Shop.plan in step with changes made on Shopify's side — a merchant
 * cancelling from the admin, a failed payment, or a charge expiring.
 */
export const action = async ({ request }) => {
  const { payload, shop: shopDomain, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shopDomain}`);

  const shop = await getShopByDomain(shopDomain);
  if (!shop) return new Response();

  const subscription = payload?.app_subscription ?? {};
  const status = String(subscription.status ?? '').toUpperCase();
  const planKey = planKeyFromName(subscription.name);

  const updated =
    ACTIVE_STATUSES.has(status) && planKey
      ? await setPlan(shop.id, {
          plan: planKey,
          subscriptionId: subscription.admin_graphql_api_id ?? shop.subscriptionId,
        })
      : // Anything else (CANCELLED, EXPIRED, DECLINED, FROZEN) drops to Free
        // rather than leaving a shop on a plan nobody is paying for.
        await setPlan(shop.id, { plan: 'free', subscriptionId: null });

  await getCurrentPeriodForShop(updated);

  return new Response();
};
