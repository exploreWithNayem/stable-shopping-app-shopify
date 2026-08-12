import { authenticate } from "../shopify.server";
import QuotaBanner from "../components/QuotaBanner";
import EmptyState from "../components/EmptyState";

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  return null;
};

/** Placeholder. Phase 9 builds the trends, funnel and per-product breakdown. */
export default function AnalyticsPage() {
  return (
    <s-page heading="Analytics">
      <QuotaBanner />
      <s-section>
        <EmptyState
          heading="No data yet"
          description="Once the recommendations block is live, this page will break down impressions, clicks, add to carts and attributed revenue."
          action={{ label: "Set up recommendations", href: "/app/recommendations" }}
        />
      </s-section>
    </s-page>
  );
}
