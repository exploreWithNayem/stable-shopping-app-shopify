import { useLoaderData, useSearchParams } from 'react-router';
import { boundary } from '@shopify/shopify-app-react-router/server';
import { authenticate } from '../shopify.server';
import { ensureShop } from '../models/shop.server';
import {
  getDashboardMetrics,
  getFunnel,
  getTopProducts,
  rollupRange,
} from '../models/analytics.server';
import { countOverriddenProducts } from '../models/override.server';
import { getProductsByIds } from '../lib/products.server';
import { analyticsRetentionDays, rawEventRetentionDays } from '../lib/entitlements';
import { addDays, startOfUtcDay } from '../lib/dates';
import { formatMoney, formatNumber, formatPercent, formatShortDate, rate } from '../lib/format';
import QuotaBanner from '../components/QuotaBanner';
import StatCard, { StatCardGrid } from '../components/StatCard';
import EmptyState from '../components/EmptyState';
import ProductThumb from '../components/ProductThumb';
import TrendChart from '../components/TrendChart';
import MeterBar from '../components/MeterBar';
import { useQuotaStatus } from '../lib/quota-status';

const RANGES = [7, 30, 90];

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
  const { admin, session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  const retentionDays = analyticsRetentionDays(shop.plan);
  const requested = Number(new URL(request.url).searchParams.get('days')) || 30;
  // A plan's retention is the real ceiling — asking for 90 on Free would render
  // 60 days of guaranteed-empty chart.
  const days = Math.min(RANGES.includes(requested) ? requested : 30, retentionDays);

  // Raw events only become dashboard numbers once they are rolled up. Doing it
  // here means a merchant who never sets up the cron still sees today's data.
  await rollupRange(shop.id, {
    from: addDays(startOfUtcDay(), -(LAZY_ROLLUP_DAYS - 1)),
    maxAgeDays: rawEventRetentionDays(shop.plan),
  });

  const to = startOfUtcDay();
  const [metrics, funnel, top, overriddenProducts] = await Promise.all([
    getDashboardMetrics(shop.id, { days }),
    getFunnel(shop.id, { days }),
    getTopProducts(shop.id, addDays(to, -(days - 1)), to, { limit: 10 }),
    countOverriddenProducts(shop.id),
  ]);

  // AnalyticsDaily stores ids only; titles and images come from the catalogue.
  const products = await getProductsByIds(
    admin,
    top.map((row) => row.productId),
  );
  const productById = new Map(products.map((product) => [product.id, product]));

  return {
    days,
    ranges: RANGES,
    retentionDays,
    metrics,
    funnel,
    topProducts: top.map((row) => ({
      ...row,
      title: productById.get(row.productId)?.title ?? `Product ${row.productId}`,
      image: productById.get(row.productId)?.image ?? null,
      clickThroughRate: rate(row.clicks, row.impressions),
    })),
    overriddenProducts,
    currencyCode: shop.currencyCode ?? 'USD',
  };
};

export default function Index() {
  const {
    days,
    ranges,
    retentionDays,
    metrics,
    funnel,
    topProducts,
    overriddenProducts,
    currencyCode,
  } = useLoaderData();
  const quota = useQuotaStatus();
  const [, setSearchParams] = useSearchParams();

  const { totals, deltas, series } = metrics;
  // "Has this app ever done anything" — decides checklist vs dashboard.
  const hasData = totals.served > 0 || totals.impressions > 0;
  /**
   * Revenue attribution rides on the orders/create webhook, which is disabled
   * until the app has protected customer data approval (CLAUDE.md §9). Until
   * then every cell reads $0.00, so the column is dropped rather than crowding
   * a table that already wraps at admin widths.
   */
  const showRevenue = topProducts.some((product) => product.revenue > 0);

  // Default "base" width on purpose: it matches the admin's own pages and the
  // rest of this app, and it is the only width where the aside slot renders.
  return (
    <s-page heading="Easy Recommendation">
      <QuotaBanner />

      <s-section heading={`Last ${days} days`}>
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="base" alignItems="center">
            {/* The whole scale stays visible; what the plan does not cover is
                disabled rather than hidden, so a Free shop can see 30 and 90
                exist instead of facing a lone "7 days" button. */}
            <s-button-group gap="base">
              {ranges.map((range) => {
                const locked = range > retentionDays;
                return (
                  <s-button
                    key={range}
                    variant={range === days ? 'primary' : 'secondary'}
                    onClick={() => setSearchParams({ days: String(range) }, { replace: true })}
                    {...(locked ? { disabled: true } : {})}
                    accessibilityLabel={
                      locked ? `${range} days, not included in your plan` : `${range} days`
                    }
                  >
                    {`${range} days`}
                  </s-button>
                );
              })}
            </s-button-group>

            {retentionDays < 90 && (
              <s-text color="subdued">
                Your plan keeps {retentionDays} days. <s-link href="/app/pricing">Upgrade</s-link>{' '}
                for more history.
              </s-text>
            )}
          </s-stack>

          <StatCardGrid>
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
            <StatCard
              label="Attributed revenue"
              value={formatMoney(totals.revenue, currencyCode)}
              delta={deltas.revenue}
              caption={`${formatNumber(totals.purchases)} purchases`}
            />
            <StatCard label="Products with custom lists" value={overriddenProducts} />
          </StatCardGrid>
        </s-stack>
      </s-section>

      {/* Chart and funnel share a row instead of stacking: the funnel is five
          short rows and left a half-page of dead space beside it at desktop
          widths. Collapses to one column below 760px. */}
      <s-section>
        <s-query-container>
          <s-grid gap="base" gridTemplateColumns="@container (inline-size > 760px) 3fr 2fr, 1fr">
            <s-box
              padding="base"
              borderWidth="base"
              borderColor="subdued"
              borderRadius="base"
              background="base"
            >
              <s-stack direction="block" gap="base">
                <s-heading>Served vs clicks</s-heading>
                {hasData ? (
                  <TrendChart
                    series={series}
                    seriesKeys={['served', 'clicks']}
                    labels={['Served', 'Clicks']}
                  />
                ) : (
                  <s-paragraph color="subdued">
                    The chart fills in once the block starts serving recommendations.
                  </s-paragraph>
                )}
              </s-stack>
            </s-box>

            <s-box
              padding="base"
              borderWidth="base"
              borderColor="subdued"
              borderRadius="base"
              background="base"
            >
              <s-stack direction="block" gap="base">
                <s-heading>Funnel</s-heading>
                {hasData ? (
                  <s-stack direction="block" gap="base">
                    {funnel.map((step) => (
                      <s-stack key={step.key} direction="block" gap="small-400">
                        <s-stack
                          direction="inline"
                          gap="small"
                          alignItems="center"
                          justifyContent="space-between"
                        >
                          <s-text>{step.label}</s-text>
                          <s-text fontVariantNumeric="tabular-nums" type="strong">
                            {formatNumber(step.value)}
                          </s-text>
                        </s-stack>
                        <MeterBar value={step.value} max={funnel[0].value} />
                        <s-text color="subdued">
                          {formatPercent(step.rateFromPrevious)} of previous step
                        </s-text>
                      </s-stack>
                    ))}
                  </s-stack>
                ) : (
                  <s-paragraph color="subdued">
                    Steps appear once the widget starts serving.
                  </s-paragraph>
                )}
              </s-stack>
            </s-box>
          </s-grid>
        </s-query-container>
      </s-section>

      <s-section heading="Top recommended products">
        {topProducts.length === 0 ? (
          <EmptyState
            heading="No recommendation data yet"
            description="Once shoppers see the widget, the products it recommends most will be ranked here."
            action={{ label: 'Set up recommendations', href: '/app/recommendations' }}
          />
        ) : (
          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header listSlot="primary">Product</s-table-header>
              <s-table-header format="numeric">Impressions</s-table-header>
              <s-table-header format="numeric">Clicks</s-table-header>
              <s-table-header format="numeric">CTR</s-table-header>
              <s-table-header format="numeric">Add to carts</s-table-header>
              {showRevenue && <s-table-header format="numeric">Revenue</s-table-header>}
            </s-table-header-row>
            <s-table-body>
              {topProducts.map((product) => (
                <s-table-row key={product.productId}>
                  <s-table-cell>
                    <ProductThumb
                      title={product.title}
                      image={product.image}
                      href={`/app/recommendations/${product.productId}`}
                    />
                  </s-table-cell>
                  <s-table-cell>{formatNumber(product.impressions)}</s-table-cell>
                  <s-table-cell>{formatNumber(product.clicks)}</s-table-cell>
                  <s-table-cell>{formatPercent(product.clickThroughRate)}</s-table-cell>
                  <s-table-cell>{formatNumber(product.addToCarts)}</s-table-cell>
                  {showRevenue && (
                    <s-table-cell>{formatMoney(product.revenue, currencyCode)}</s-table-cell>
                  )}
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
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

      <s-section slot="aside" heading="Your plan">
        {quota && (
          <s-stack direction="block" gap="small">
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
            <s-divider />
            <s-button href="/app/pricing" variant="secondary">
              View plans
            </s-button>
          </s-stack>
        )}
      </s-section>

      <s-section slot="aside" heading="Quick actions">
        <s-stack direction="block" gap="small">
          <s-link href="/app/recommendations">Manage recommendations</s-link>
          <s-link href="/app/analytics">Full analytics</s-link>
          <s-link href="/app/settings">Widget settings</s-link>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
