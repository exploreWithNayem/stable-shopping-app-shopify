import { useLoaderData, useSearchParams } from 'react-router';
import { authenticate } from '../shopify.server';
import { ensureShop } from '../models/shop.server';
import {
  getDashboardMetrics,
  getFunnel,
  getPlacementBreakdown,
  getTopProducts,
  rollupRange,
} from '../models/analytics.server';
import { getProductsByIds } from '../lib/products.server';
import { analyticsRetentionDays, canExportCsv, rawEventRetentionDays } from '../lib/entitlements';
import { addDays, startOfUtcDay } from '../lib/dates';
import { formatMoney, formatNumber, formatPercent, rate } from '../lib/format';
import QuotaBanner from '../components/QuotaBanner';
import EmptyState from '../components/EmptyState';
import ProductThumb from '../components/ProductThumb';
import TrendChart from '../components/TrendChart';
import MeterBar from '../components/MeterBar';
import Card from '../components/Card';
import StatCard, { StatCardGrid } from '../components/StatCard';

const RANGES = [7, 30, 90];
const PRODUCT_ROWS = 50;
const LAZY_ROLLUP_DAYS = 3;

/** Merchant-facing names for the placements CLAUDE.md §3.2 defines. */
const PLACEMENT_LABELS = {
  pdp: 'Product page',
  related: 'Related products block',
  checkout: 'Checkout',
  thank_you: 'Thank you page',
  order_status: 'Order status',
  popular: 'Popular products block',
  collection: 'Collection products block',
  recently_viewed: 'Recently viewed block',
};

const PRODUCT_SORTS = {
  impressions: 'Most impressions',
  clicks: 'Most clicks',
  ctr: 'Best CTR',
  addToCarts: 'Most add to carts',
};

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  const params = new URL(request.url).searchParams;
  const retentionDays = analyticsRetentionDays(shop.plan);
  const requested = Number(params.get('days')) || 30;
  // Retention is the real ceiling: 90 on Free would render 83 empty days.
  const days = Math.min(RANGES.includes(requested) ? requested : 30, retentionDays);
  const sort = Object.keys(PRODUCT_SORTS).includes(params.get('sort'))
    ? params.get('sort')
    : 'impressions';

  await rollupRange(shop.id, {
    from: addDays(startOfUtcDay(), -(LAZY_ROLLUP_DAYS - 1)),
    maxAgeDays: rawEventRetentionDays(shop.plan),
  });

  const to = startOfUtcDay();
  const from = addDays(to, -(days - 1));

  const [metrics, funnel, placements, top] = await Promise.all([
    getDashboardMetrics(shop.id, { days }),
    getFunnel(shop.id, { days }),
    getPlacementBreakdown(shop.id, from, to),
    getTopProducts(shop.id, from, to, { limit: PRODUCT_ROWS }),
  ]);

  const products = await getProductsByIds(
    admin,
    top.map((row) => row.productId),
  );
  const byId = new Map(products.map((product) => [product.id, product]));

  /**
   * Products deleted from the catalogue keep their AnalyticsDaily rows, and
   * `nodes(ids:)` returns null for each one. Rendering those as
   * "Product 9750935961829" gave a row nobody can act on and a link that 404s,
   * so they are dropped from the breakdown and counted instead. The totals and
   * funnel above still include them — those events really happened.
   */
  const rows = top
    .filter((row) => byId.has(row.productId))
    .map((row) => ({
      ...row,
      title: byId.get(row.productId).title,
      image: byId.get(row.productId).image,
      clickThroughRate: rate(row.clicks, row.impressions),
    }));
  const deletedProducts = top.length - rows.length;

  // Sorting happens here rather than in SQL: getTopProducts already caps the
  // set at PRODUCT_ROWS, and CTR is a derived ratio Prisma cannot order by.
  rows.sort((a, b) =>
    sort === 'ctr' ? b.clickThroughRate - a.clickThroughRate : (b[sort] ?? 0) - (a[sort] ?? 0),
  );

  return {
    days,
    ranges: RANGES,
    retentionDays,
    sort,
    sortOptions: Object.entries(PRODUCT_SORTS).map(([value, label]) => ({ value, label })),
    metrics,
    funnel,
    placements: placements.map((row) => ({
      ...row,
      label: PLACEMENT_LABELS[row.placement] ?? row.placement,
      clickThroughRate: rate(row.clicks, row.impressions),
    })),
    products: rows,
    deletedProducts,
    canExport: canExportCsv(shop.plan),
    currencyCode: shop.currencyCode ?? 'USD',
  };
};

/** RFC 4180-ish: quote every field and double any embedded quotes. */
function toCsv(headers, rows) {
  const escape = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  return [headers, ...rows].map((row) => row.map(escape).join(',')).join('\r\n');
}

export default function AnalyticsPage() {
  const {
    days,
    ranges,
    retentionDays,
    sort,
    sortOptions,
    metrics,
    funnel,
    placements,
    products,
    deletedProducts,
    canExport,
    currencyCode,
  } = useLoaderData();
  const [, setSearchParams] = useSearchParams();

  const { totals, deltas, series } = metrics;
  const hasData = totals.impressions > 0 || totals.served > 0;
  const showRevenue = products.some((product) => product.revenue > 0);

  const setParam = (key, value) =>
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.set(key, String(value));
        return next;
      },
      { replace: true },
    );

  const exportCsv = () => {
    const csv = toCsv(
      [
        'Product',
        'Product ID',
        'Impressions',
        'Clicks',
        'CTR %',
        'Add to carts',
        'Purchases',
        'Revenue',
      ],
      products.map((product) => [
        product.title,
        product.productId,
        product.impressions,
        product.clicks,
        product.clickThroughRate.toFixed(2),
        product.addToCarts,
        product.purchases,
        product.revenue,
      ]),
    );

    // Built in the browser rather than served from a route: the admin embeds
    // this app in an iframe, and a same-document blob avoids a top-level
    // navigation just to hand over a file.
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `easy-reco-products-${days}d.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <s-page heading="Analytics">
      <QuotaBanner />

      <s-section heading={`Last ${days} days`}>
        <s-stack direction="inline" gap="base" alignItems="center">
          <s-button-group gap="base">
            {ranges.map((range) => {
              const locked = range > retentionDays;
              return (
                <s-button
                  key={range}
                  variant={range === days ? 'primary' : 'secondary'}
                  onClick={() => setParam('days', range)}
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
              Your plan keeps {retentionDays} days. <s-link href="/app/pricing">Upgrade</s-link> for
              more history.
            </s-text>
          )}
        </s-stack>
      </s-section>

      <s-section>
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

      <s-section heading="Impressions vs clicks">
        {hasData ? (
          <TrendChart
            series={series}
            seriesKeys={['impressions', 'clicks']}
            labels={['Impressions', 'Clicks']}
          />
        ) : (
          <s-paragraph color="subdued">
            Trends appear once the widget has been seen on your storefront.
          </s-paragraph>
        )}
      </s-section>

      <s-section>
        <s-query-container>
          <s-grid
            gap="base"
            alignItems="start"
            gridTemplateColumns="@container (inline-size > 700px) 1fr 1fr, 1fr"
          >
            <Card>
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
                  <s-paragraph color="subdued">Steps appear once the widget serves.</s-paragraph>
                )}
              </s-stack>
            </Card>

            <Card>
              <s-stack direction="block" gap="base">
                <s-heading>By placement</s-heading>
                {placements.length === 0 ? (
                  <s-paragraph color="subdued">
                    Nothing recorded yet. Placements appear as each block goes live.
                  </s-paragraph>
                ) : (
                  <s-table variant="auto">
                    <s-table-header-row>
                      <s-table-header listSlot="primary">Placement</s-table-header>
                      <s-table-header format="numeric">Impressions</s-table-header>
                      <s-table-header format="numeric">Clicks</s-table-header>
                      <s-table-header format="numeric">CTR</s-table-header>
                    </s-table-header-row>
                    <s-table-body>
                      {placements.map((row) => (
                        <s-table-row key={row.placement}>
                          <s-table-cell>{row.label}</s-table-cell>
                          <s-table-cell>{formatNumber(row.impressions)}</s-table-cell>
                          <s-table-cell>{formatNumber(row.clicks)}</s-table-cell>
                          <s-table-cell>{formatPercent(row.clickThroughRate)}</s-table-cell>
                        </s-table-row>
                      ))}
                    </s-table-body>
                  </s-table>
                )}
              </s-stack>
            </Card>
          </s-grid>
        </s-query-container>
      </s-section>

      <s-section heading="Per-product breakdown">
        {products.length === 0 ? (
          <EmptyState
            heading="No product data yet"
            description="Once shoppers see the widget, every recommended product is broken down here."
            action={{ label: 'Set up recommendations', href: '/app/recommendations' }}
          />
        ) : (
          <s-stack direction="block" gap="base">
            <s-stack direction="inline" gap="base" alignItems="end">
              <s-select
                label="Sort by"
                name="sort"
                value={sort}
                onChange={(event) => setParam('sort', event.currentTarget.value)}
              >
                {sortOptions.map((option) => (
                  <s-option key={option.value} value={option.value}>
                    {option.label}
                  </s-option>
                ))}
              </s-select>

              {/* Nothing is shown on Free rather than an upsell line — the
                  gate still holds, it just does not nag. */}
              {canExport && (
                <s-button variant="secondary" onClick={exportCsv}>
                  Export CSV
                </s-button>
              )}
            </s-stack>

            <s-paragraph color="subdued">
              Top {products.length} recommended products by {PRODUCT_SORTS[sort].toLowerCase()}.
              {deletedProducts > 0 &&
                ` ${formatNumber(deletedProducts)} deleted ${
                  deletedProducts === 1 ? 'product is' : 'products are'
                } not shown, though their activity still counts in the totals above.`}
            </s-paragraph>

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
                {products.map((product) => (
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
          </s-stack>
        )}
      </s-section>
    </s-page>
  );
}
