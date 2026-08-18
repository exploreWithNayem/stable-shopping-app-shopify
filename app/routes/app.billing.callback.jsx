import { redirect } from 'react-router';
import { authenticate } from '../shopify.server';
import { ensureShop, setPlan } from '../models/shop.server';
import { getCurrentPeriodForShop } from '../models/usage.server';
import { isPaidPlan } from '../lib/plans';

/**
 * Where Shopify sends the merchant after they approve (or decline) a charge.
 *
 * The approval itself is not proof of anything — the merchant can back out on
 * Shopify's page — so this asks the Billing API what is actually active rather
 * than trusting the `plan` query parameter it was called with.
 */
export const loader = async ({ request }) => {
  const { billing, session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  const url = new URL(request.url);
  const requested = url.searchParams.get('plan') ?? '';

  const next = new URLSearchParams();
  for (const key of ['shop', 'host']) {
    const value = url.searchParams.get(key);
    if (value) next.set(key, value);
  }

  if (!isPaidPlan(requested)) {
    next.set('billing', 'invalid');
    throw redirect(`/app/pricing?${next.toString()}`);
  }

  let check;
  try {
    check = await billing.check({ plans: [requested] });
  } catch (error) {
    next.set('billing', 'error');
    throw redirect(`/app/pricing?${next.toString()}`);
  }

  if (!check.hasActivePayment) {
    // Declined or abandoned: leave the shop on whatever it had before.
    next.set('billing', 'cancelled');
    throw redirect(`/app/pricing?${next.toString()}`);
  }

  const subscription = check.appSubscriptions?.[0] ?? null;
  const updated = await setPlan(shop.id, {
    plan: requested,
    subscriptionId: subscription?.id ?? null,
  });

  // Raise the quota now rather than at the next rollover — the merchant just
  // paid for it.
  await getCurrentPeriodForShop(updated);

  next.set('billing', 'success');
  throw redirect(`/app?${next.toString()}`);
};
