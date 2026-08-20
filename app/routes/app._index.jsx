import { useLoaderData } from 'react-router';
import { boundary } from '@shopify/shopify-app-react-router/server';
import { authenticate } from '../shopify.server';
import { ensureShop } from '../models/shop.server';
import { getDashboardMetrics, rollupRange } from '../models/analytics.server';
import { countOverriddenProducts, listUnsyncedOverrides } from '../models/override.server';
import { analyticsRetentionDays, rawEventRetentionDays } from '../lib/entitlements';
import { addDays, startOfUtcDay } from '../lib/dates';
import { formatNumber, formatPercent, formatShortDate } from '../lib/format';
import QuotaBanner from '../components/QuotaBanner';
import StatCard, { StatCardGrid } from '../components/StatCard';
import MeterBar from '../components/MeterBar';
import Card from '../components/Card';
import { useQuotaStatus } from '../lib/quota-status';

/**
 * Home is a fixed 30-day snapshot (clamped to what the plan retains). Range
 * switching, funnel and the full product breakdown live on /app/analytics —
 * duplicating them here made the two pages the same page.
 */
const HOME_DAYS = 30;

/**
 * Days the dashboard rolls up on load.
 *
 * The rollup is destructive per day (clear then rebuild), so this is kept to a
 * short trailing window: enough that today's and yesterday's events show up
 * without a cron, cheap enough to run on every dashboard visit. `/cron/rollup`
 * still owns the full history.
 */
const LAZY_ROLLUP_DAYS = 3;

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  const retentionDays = analyticsRetentionDays(shop.plan);
  // Fixed window: retention is still the ceiling, so Free shows 7 days.
  const days = Math.min(HOME_DAYS, retentionDays);

  // Raw events only become dashboard numbers once they are rolled up. Doing it
  // here means a merchant who never sets up the cron still sees today's data.
  await rollupRange(shop.id, {
    from: addDays(startOfUtcDay(), -(LAZY_ROLLUP_DAYS - 1)),
    maxAgeDays: rawEventRetentionDays(shop.plan),
  });

  const [metrics, overriddenProducts, unsynced] = await Promise.all([
    getDashboardMetrics(shop.id, { days }),
    countOverriddenProducts(shop.id),
    listUnsyncedOverrides(shop.id),
  ]);

  // The most recent day that actually served tells the merchant whether the
  // theme block is live far better than a total does — a healthy total with
  // nothing for a week means the block was removed.
  const lastServedDay = [...metrics.series].reverse().find((day) => day.served > 0)?.date ?? null;

  return {
    days,
    retentionDays,
    metrics,
    lastServedDay,
    unsyncedCount: unsynced.length,
    overriddenProducts,
  };
};

export default function Index() {
  const { days, metrics, lastServedDay, unsyncedCount, overriddenProducts } = useLoaderData();
  const quota = useQuotaStatus();

  const { totals, deltas } = metrics;
  // "Has this app ever done anything" — decides checklist vs dashboard.
  const hasData = totals.served > 0 || totals.impressions > 0;

  return (
    <s-page heading="Easy Recommendation">
      {/*
        In the content column, not the `primary-action` slot. That slot hoists the
        button into the Shopify admin's own top bar next to the "..." menu, which
        puts it outside the app's frame entirely and a long way from the content
        it acts on.

        An offer is a product plus the products to recommend alongside it, so
        there is no "new offer" route to send this to — it opens the product list,
        where a product is chosen and its complementary products picked inline.

        Deliberately never disabled. The product allowance is a limit on *new*
        offers, and the list page enforces it there with its own banner; greying
        this out would also block a merchant at the limit from editing the offers
        they already have, which is the wrong door to close.
      */}
      <s-stack
        direction="inline"
        justifyContent="end"
        paddingBlockStart="base"
        paddingBlockEnd="base"
      >
        <s-button variant="primary" href="/app/recommendations">
          Create offer
        </s-button>
      </s-stack>

      <QuotaBanner />

      {/* Headline numbers only. Range switching, the funnel and the full
          per-product breakdown belong to /app/analytics — repeating them here
          made the two pages indistinguishable. */}
      <s-section heading={`Last ${days} days`}>
        <StatCardGrid columns={4} minWidth={700}>
          <StatCard label="Recommendations served" value={totals.served} delta={deltas.served} />
          <StatCard label="Impressions" value={totals.impressions} delta={deltas.impressions} />
          <StatCard
            label="Clicks"
            value={totals.clicks}
            delta={deltas.clicks}
            caption={`${formatPercent(totals.clickThroughRate)} CTR`}
          />
          <StatCard
            label="Add to carts"
            value={totals.addToCarts}
            delta={deltas.addToCarts}
            caption={`${formatPercent(totals.addToCartRate)} of clicks`}
          />
        </StatCardGrid>
      </s-section>

      <s-section>
        <s-query-container>
          <s-grid
            gap="base"
            alignItems="start"
            gridTemplateColumns="@container (inline-size > 700px) 1fr 1fr, 1fr"
          >
            {/* Operational status — the thing only the home page answers:
                is this actually running, and is anything broken? */}
            <Card>
              <s-stack direction="block" gap="base">
                <s-heading>Storefront status</s-heading>

                <s-stack direction="inline" gap="small" alignItems="center">
                  <s-badge tone={lastServedDay ? 'success' : 'warning'}>
                    {lastServedDay ? 'Serving' : 'Not detected'}
                  </s-badge>
                  <s-text color="subdued">
                    {lastServedDay
                      ? `Last served ${formatShortDate(lastServedDay)}`
                      : 'No recommendations served yet'}
                  </s-text>
                </s-stack>

                {!lastServedDay && (
                  <s-paragraph color="subdued">
                    Add the Recommendations block to your product template in the theme editor, then
                    reload a product page.
                  </s-paragraph>
                )}

                <s-divider />

                <s-stack direction="inline" gap="small" alignItems="center">
                  <s-badge tone={unsyncedCount > 0 ? 'warning' : 'neutral'}>
                    {`${formatNumber(overriddenProducts)} custom`}
                  </s-badge>
                  <s-text color="subdued">
                    {unsyncedCount > 0
                      ? `${formatNumber(unsyncedCount)} not yet live on the storefront`
                      : 'All custom lists are live on the storefront'}
                  </s-text>
                </s-stack>

                {unsyncedCount > 0 && (
                  <s-button href="/app/settings" variant="secondary">
                    Re-sync overrides
                  </s-button>
                )}
              </s-stack>
            </Card>

            <Card>
              <s-stack direction="block" gap="small">
                <s-heading>Your plan</s-heading>
                {quota && (
                  <>
                    <s-stack direction="inline" gap="small" alignItems="center">
                      <s-text type="strong">{quota.planName}</s-text>
                      <s-badge tone={quota.isOver ? 'critical' : 'neutral'}>
                        {quota.unlimited
                          ? 'Unlimited'
                          : `${formatNumber(quota.used)} / ${formatNumber(quota.limit)}`}
                      </s-badge>
                    </s-stack>
                    {!quota.unlimited && <MeterBar value={quota.used} max={quota.limit} />}
                    <s-text color="subdued">
                      {quota.unlimited
                        ? 'No monthly limit on this plan.'
                        : `${formatNumber(quota.remaining)} recommendations left. Resets ${formatShortDate(quota.resetsAt)}.`}
                    </s-text>
                    <s-button href="/app/pricing" variant="secondary">
                      View plans
                    </s-button>
                  </>
                )}
              </s-stack>
            </Card>
          </s-grid>
        </s-query-container>
      </s-section>

      {!hasData && (
        <s-section heading="Get set up">
          <s-ordered-list>
            <s-list-item>
              Enable the app embed in your theme so recommendations can be tracked.
            </s-list-item>
            <s-list-item>Add the Recommendations block to your product page template.</s-list-item>
            <s-list-item>
              Create your first custom recommendation from the{' '}
              <s-link href="/app/recommendations">Recommendations</s-link> page.
            </s-list-item>
          </s-ordered-list>
        </s-section>
      )}
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
