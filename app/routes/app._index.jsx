import { useLoaderData } from 'react-router';
import { boundary } from '@shopify/shopify-app-react-router/server';
import { authenticate } from '../shopify.server';
import { ensureShop } from '../models/shop.server';
import { getDashboardMetrics, rollupRange } from '../models/analytics.server';
import { countOverriddenProducts, listUnsyncedOverrides } from '../models/override.server';
import { listOffers } from '../models/offer.server';
import { analyticsRetentionDays, rawEventRetentionDays } from '../lib/entitlements';
import { addDays, startOfUtcDay } from '../lib/dates';
import { formatNumber, formatPercent, formatShortDate } from '../lib/format';
import { offerLocationLabel, offerTypeLabel } from '../lib/offer-labels';
import QuotaBanner from '../components/QuotaBanner';
import EmptyState from '../components/EmptyState';
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

/**
 * Offers listed on Home before it points at the full list.
 *
 * Home is a summary: enough rows to recognise the offer you just saved and get
 * back into it, not a management screen.
 */
const OFFERS_SHOWN = 5;

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

  const [metrics, overriddenProducts, unsynced, offers] = await Promise.all([
    getDashboardMetrics(shop.id, { days }),
    countOverriddenProducts(shop.id),
    listUnsyncedOverrides(shop.id),
    listOffers(shop.id, { take: OFFERS_SHOWN + 1 }),
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
    /*
     * Only the fields the list draws. The stored rows carry whole `targets` and
     * `items` arrays, and sending a dozen of those through a loader so a table can
     * render four short strings is payload nobody reads — Json columns are the
     * easy thing to leak into a page.
     */
    offers: offers.slice(0, OFFERS_SHOWN).map((offer) => ({
      id: offer.id,
      name: offer.name,
      status: offer.status,
      offerType: offer.offerType,
      placement: offer.placement,
    })),
    // One row was over-fetched to answer this without a second count query.
    moreOffers: Math.max(0, offers.length - OFFERS_SHOWN),
  };
};

export default function Index() {
  const { days, metrics, lastServedDay, unsyncedCount, overriddenProducts, offers, moreOffers } =
    useLoaderData();
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

        Opens /app/offers/new, which explains the surfaces an offer can appear
        on and then hands off to the product list. An offer is the same data
        wherever it renders — *where* is a property of the theme block the
        merchant places, not of the saved list — so that page orients rather than
        configures.

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
        <s-button variant="primary" href="/app/offers/new">
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

      {/*
        Offers, the thing this app is now organised around. Home lists a few so a
        merchant can recognise what they just saved and get back into it; it is
        deliberately not a management screen.
      */}
      <s-section heading="Offers">
        {offers.length === 0 ? (
          <EmptyState
            heading="No offers yet"
            description="An offer is a set of products to recommend, plus the product pages it appears on."
            action={{ label: 'Create offer', href: '/app/offers/new' }}
          />
        ) : (
          <s-stack direction="block" gap="base">
            <s-table variant="auto">
              <s-table-header-row>
                <s-table-header listSlot="primary">Offer name</s-table-header>
                <s-table-header>Offer type</s-table-header>
                <s-table-header>Offer location</s-table-header>
                <s-table-header listSlot="kicker">Status</s-table-header>
              </s-table-header-row>

              <s-table-body>
                {offers.map((offer) => {
                  /*
                    Every cell is a description of the offer, so the whole row is the
                    way back into it — `clickDelegate` names the link that click
                    lands on. The link itself stays in the markup rather than being
                    replaced by a row handler: clickDelegate adds no keyboard or
                    screen reader affordance, so the anchor is what keyboard users
                    tab to.
                  */
                  const editHref = `/app/offers/new?type=${offer.placement}&id=${offer.id}`;
                  const linkId = `offer-link-${offer.id}`;

                  return (
                    <s-table-row key={offer.id} clickDelegate={linkId}>
                      <s-table-cell>
                        {/* tone="neutral" because the name is the row's label, not a
                            call to action sitting among plain cells — the row's own
                            hover state is what says it is clickable. */}
                        <s-link id={linkId} href={editHref} tone="neutral">
                          <s-text type="strong">{offer.name || 'Untitled offer'}</s-text>
                        </s-link>
                      </s-table-cell>

                      <s-table-cell>{offerTypeLabel(offer.offerType)}</s-table-cell>

                      <s-table-cell>{offerLocationLabel(offer.placement)}</s-table-cell>

                      <s-table-cell>
                        <s-badge tone={offer.status === 'published' ? 'success' : 'neutral'}>
                          {offer.status === 'published' ? 'Published' : 'Not published'}
                        </s-badge>
                      </s-table-cell>
                    </s-table-row>
                  );
                })}
              </s-table-body>
            </s-table>

            {moreOffers > 0 && (
              <s-paragraph color="subdued">
                {`${formatNumber(moreOffers)} more offer${moreOffers === 1 ? '' : 's'} not shown.`}
              </s-paragraph>
            )}
          </s-stack>
        )}
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
