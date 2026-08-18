import { useFetcher, useLoaderData } from 'react-router';
import { APP_URL, TRIAL_DAYS, authenticate } from '../shopify.server';
import { ensureShop } from '../models/shop.server';
import { setPlan } from '../models/shop.server';
import { getCurrentPeriodForShop, getQuotaStatusForShop } from '../models/usage.server';
import { PLANS, PLAN_KEYS, isPaidPlan, isUnlimited } from '../lib/plans';
import { formatNumber, formatShortDate } from '../lib/format';

/** Test charges so a dev store is never actually billed. Flip for production. */
const IS_TEST_BILLING = true;

function billingReturnUrl(request, plan) {
  const url = new URL(request.url);
  const appUrl = APP_URL || url.origin;
  const params = new URLSearchParams({ plan });
  // host/shop are carried through so the callback can land back inside admin
  // rather than as a bare top-level page.
  for (const key of ['shop', 'host']) {
    const value = url.searchParams.get(key);
    if (value) params.set(key, value);
  }
  return `${appUrl}/app/billing/callback?${params.toString()}`;
}

export const loader = async ({ request }) => {
  const { billing, session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const quota = await getQuotaStatusForShop(shop);

  // Shopify is the authority on what is actually being paid for. A mismatch
  // means a change happened outside the app (or a webhook was missed), so the
  // page says so instead of quietly trusting the local column.
  let activePlan = null;
  let billingError = null;
  try {
    const check = await billing.check();
    activePlan = check.appSubscriptions?.[0]?.name ?? null;
  } catch (error) {
    billingError = error.message;
  }

  return {
    trialDays: TRIAL_DAYS,
    plans: PLAN_KEYS.map((key) => PLANS[key]),
    currentPlan: shop.plan,
    activePlan,
    billingError,
    subscriptionId: shop.subscriptionId,
    quota: {
      used: quota.used,
      limit: isUnlimited(quota.limit) ? null : quota.limit,
      resetsAt: quota.resetsAt,
    },
  };
};

export const action = async ({ request }) => {
  const { billing, session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  const formData = await request.formData();
  const intent = String(formData.get('intent') ?? '');
  const plan = String(formData.get('plan') ?? '');

  if (intent === 'upgrade') {
    if (!isPaidPlan(plan)) {
      return { ok: false, error: 'That plan cannot be purchased.' };
    }
    // Always throws: the library redirects out of the iframe to Shopify's
    // confirmation page, using App Bridge headers for fetcher requests.
    await billing.request({
      plan,
      isTest: IS_TEST_BILLING,
      returnUrl: billingReturnUrl(request, plan),
    });
  }

  if (intent === 'downgrade') {
    // Free needs no subscription, so downgrading is a cancel plus a local write.
    if (shop.subscriptionId) {
      try {
        await billing.cancel({
          subscriptionId: shop.subscriptionId,
          isTest: IS_TEST_BILLING,
          prorate: true,
        });
      } catch (error) {
        return { ok: false, error: `Could not cancel the subscription: ${error.message}` };
      }
    }

    const updated = await setPlan(shop.id, { plan: 'free', subscriptionId: null });
    // Re-reads the window and rewrites the period's quota snapshot, so the new
    // limit applies now rather than at the next rollover.
    await getCurrentPeriodForShop(updated);
    return { ok: true, downgraded: true };
  }

  return { ok: false, error: 'Unknown action.' };
};

export default function PricingPage() {
  const { plans, currentPlan, activePlan, billingError, quota, trialDays } = useLoaderData();
  const fetcher = useFetcher();
  const isBusy = fetcher.state !== 'idle';
  const result = fetcher.data;

  const choose = (planKey) =>
    fetcher.submit(
      planKey === 'free' ? { intent: 'downgrade' } : { intent: 'upgrade', plan: planKey },
      { method: 'POST' },
    );

  return (
    <s-page heading="Plans">
      {result?.error && (
        <s-banner tone="critical" heading="Could not change your plan">
          <s-paragraph>{result.error}</s-paragraph>
        </s-banner>
      )}

      {result?.downgraded && (
        <s-banner tone="success" heading="Switched to Free">
          <s-paragraph>
            Your subscription was cancelled and the Free quota applies from now.
          </s-paragraph>
        </s-banner>
      )}

      {billingError && (
        <s-banner tone="warning" heading="Could not reach Shopify billing">
          <s-paragraph>Showing your saved plan. {billingError}</s-paragraph>
        </s-banner>
      )}

      <s-section>
        <s-grid
          gap="base"
          gridTemplateColumns="@container (inline-size > 720px) repeat(3, 1fr), 1fr"
        >
          {plans.map((plan) => {
            const isCurrent = currentPlan === plan.key;

            return (
              <s-box
                key={plan.key}
                padding="base"
                borderWidth="base"
                borderColor={isCurrent ? 'strong' : 'subdued'}
                borderRadius="base"
                background="base"
              >
                <s-stack direction="block" gap="small">
                  <s-stack direction="inline" gap="small" alignItems="center">
                    <s-heading>{plan.name}</s-heading>
                    {isCurrent && <s-badge tone="success">Current plan</s-badge>}
                  </s-stack>

                  <s-text fontVariantNumeric="tabular-nums">
                    <s-heading>${plan.price}/month</s-heading>
                  </s-text>

                  <s-text color="subdued">
                    {isUnlimited(plan.quota)
                      ? 'Unlimited recommendations'
                      : `${formatNumber(plan.quota)} recommendations per month`}
                  </s-text>

                  <s-unordered-list>
                    {plan.features.map((feature) => (
                      <s-list-item key={feature}>{feature}</s-list-item>
                    ))}
                  </s-unordered-list>

                  <s-button
                    variant={isCurrent ? 'secondary' : 'primary'}
                    onClick={() => choose(plan.key)}
                    {...(isBusy ? { loading: true } : {})}
                    {...(isCurrent ? { disabled: true } : {})}
                  >
                    {isCurrent
                      ? 'Current plan'
                      : plan.price === 0
                        ? 'Switch to Free'
                        : `Upgrade to ${plan.name}`}
                  </s-button>
                </s-stack>
              </s-box>
            );
          })}
        </s-grid>
      </s-section>

      <s-section slot="aside" heading="This billing period">
        <s-stack direction="block" gap="small">
          <s-text fontVariantNumeric="tabular-nums">
            <s-heading>
              {quota.limit === null
                ? formatNumber(quota.used)
                : `${formatNumber(quota.used)} / ${formatNumber(quota.limit)}`}
            </s-heading>
          </s-text>
          <s-text color="subdued">
            Recommendations served. Resets {formatShortDate(quota.resetsAt)}.
          </s-text>

          {activePlan && (
            <>
              <s-divider />
              <s-text color="subdued">Shopify subscription: {activePlan}</s-text>
            </>
          )}

          <s-divider />
          <s-text color="subdued">
            Paid plans include a {trialDays}-day free trial. Charges are in test mode on development
            stores.
          </s-text>
        </s-stack>
      </s-section>
    </s-page>
  );
}
