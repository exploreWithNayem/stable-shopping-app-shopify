import { authenticate } from "../shopify.server";
import { PLANS, PLAN_KEYS } from "../lib/plans";
import { useQuotaStatus } from "../lib/quota-status";
import { formatNumber } from "../lib/format";

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  return { plans: PLAN_KEYS.map((key) => PLANS[key]) };
};

/**
 * Placeholder. Phase 11 wires these cards to the Billing API — upgrade,
 * downgrade and the subscription callback.
 */
export default function PricingPage() {
  const quota = useQuotaStatus();

  return (
    <s-page heading="Plans">
      <s-section>
        <s-grid
          gap="base"
          gridTemplateColumns="@container (inline-size > 720px) repeat(3, 1fr), 1fr"
        >
          {PLAN_KEYS.map((key) => {
            const plan = PLANS[key];
            const isCurrent = quota?.plan === key;

            return (
              <s-box
                key={key}
                padding="base"
                borderWidth="base"
                borderColor={isCurrent ? "strong" : "subdued"}
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
                    {plan.quota === -1
                      ? "Unlimited recommendations"
                      : `${formatNumber(plan.quota)} recommendations per month`}
                  </s-text>

                  <s-unordered-list>
                    {plan.features.map((feature) => (
                      <s-list-item key={feature}>{feature}</s-list-item>
                    ))}
                  </s-unordered-list>

                  <s-button variant={isCurrent ? "secondary" : "primary"} disabled>
                    {isCurrent ? "Current plan" : "Choose plan"}
                  </s-button>
                </s-stack>
              </s-box>
            );
          })}
        </s-grid>
      </s-section>

      <s-section slot="aside" heading="Billing">
        <s-paragraph color="subdued">
          Plan changes are not connected to Shopify billing yet — that lands in
          Phase 11.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}
