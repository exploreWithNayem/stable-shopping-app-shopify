import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import QuotaBanner from "../components/QuotaBanner";
import StatCard, { StatCardGrid } from "../components/StatCard";
import { useQuotaStatus } from "../lib/quota-status";
import { formatNumber, formatShortDate } from "../lib/format";

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  return null;
};

/**
 * Placeholder dashboard. Phase 10 replaces the zeroed widgets with real
 * analytics, adds the top-products table and the 30-day trend chart.
 */
export default function Index() {
  const quota = useQuotaStatus();

  return (
    <s-page heading="Easy Recommendation">
      <QuotaBanner />

      <s-section heading="This month">
        <StatCardGrid>
          <StatCard label="Recommendations served" value={0} />
          <StatCard label="Impressions" value={0} />
          <StatCard label="Clicks" value={0} />
          <StatCard label="Add to carts" value={0} />
        </StatCardGrid>
        <s-paragraph color="subdued">
          Analytics start filling in once the recommendations block is live on
          your product pages.
        </s-paragraph>
      </s-section>

      <s-section heading="Get set up">
        <s-ordered-list>
          <s-list-item>
            Enable the app embed in your theme so recommendations can be
            tracked.
          </s-list-item>
          <s-list-item>
            Add the Recommendations block to your product page template.
          </s-list-item>
          <s-list-item>
            Create your first custom recommendation from the{" "}
            <s-link href="/app/recommendations">Recommendations</s-link> page.
          </s-list-item>
        </s-ordered-list>
      </s-section>

      <s-section slot="aside" heading="Your plan">
        {quota && (
          <s-stack direction="block" gap="small">
            <s-stack direction="inline" gap="small" alignItems="center">
              <s-text type="strong">{quota.planName}</s-text>
              <s-badge tone={quota.isOver ? "critical" : "neutral"}>
                {quota.unlimited
                  ? "Unlimited"
                  : `${formatNumber(quota.used)} / ${formatNumber(quota.limit)}`}
              </s-badge>
            </s-stack>
            <s-text color="subdued">
              {quota.unlimited
                ? "No monthly limit on this plan."
                : `${formatNumber(quota.remaining)} recommendations left. Resets ${formatShortDate(quota.resetsAt)}.`}
            </s-text>
            <s-button href="/app/pricing" variant="secondary">
              View plans
            </s-button>
          </s-stack>
        )}
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
