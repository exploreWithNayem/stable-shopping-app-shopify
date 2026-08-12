import { formatNumber, formatShortDate } from "../lib/format";
import { useQuotaStatus } from "../lib/quota-status";

/**
 * Shared quota warning, rendered inside each page's <s-page>.
 *
 * Silent below 80% of the limit and on unlimited plans, so it only appears when
 * the merchant can actually act on it.
 */
export default function QuotaBanner() {
  const quota = useQuotaStatus();

  if (!quota || quota.unlimited) return null;
  if (!quota.isOver && !quota.isNearLimit) return null;

  const resets = formatShortDate(quota.resetsAt);

  if (quota.isOver) {
    return (
      <s-banner tone="critical" heading="Recommendation limit reached">
        <s-paragraph>
          You have used all {formatNumber(quota.limit)} recommendations included
          in the {quota.planName} plan this month. Product pages keep working —
          they fall back to Shopify&apos;s own recommendations — but your custom
          recommendations and tracking are paused until {resets}.
        </s-paragraph>
        <s-button href="/app/pricing" variant="primary">
          Upgrade plan
        </s-button>
      </s-banner>
    );
  }

  return (
    <s-banner tone="warning" heading="You are close to your monthly limit">
      <s-paragraph>
        {formatNumber(quota.used)} of {formatNumber(quota.limit)} recommendations
        used ({quota.percentUsed}%). {formatNumber(quota.remaining)} left before
        the limit resets on {resets}.
      </s-paragraph>
      <s-button href="/app/pricing" variant="primary">
        Upgrade plan
      </s-button>
    </s-banner>
  );
}
