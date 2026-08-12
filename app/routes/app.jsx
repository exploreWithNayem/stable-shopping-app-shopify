import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { authenticate } from "../shopify.server";
import { ensureShop } from "../models/shop.server";
import { getQuotaStatusForShop } from "../models/usage.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);

  // Every page under /app depends on the Shop row existing, so bootstrap it
  // here rather than in each route.
  const shop = await ensureShop(session.shop);
  const quota = await getQuotaStatusForShop(shop);

  return {
    // eslint-disable-next-line no-undef
    apiKey: process.env.SHOPIFY_API_KEY || "",
    shopDomain: shop.domain,
    currencyCode: shop.currencyCode ?? "USD",
    quota: {
      ...quota,
      // Serialised explicitly so pages read predictable ISO strings.
      periodStart: quota.periodStart.toISOString(),
      resetsAt: quota.resetsAt.toISOString(),
    },
  };
};

export default function App() {
  const { apiKey } = useLoaderData();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">Home</s-link>
        <s-link href="/app/recommendations">Recommendations</s-link>
        <s-link href="/app/analytics">Analytics</s-link>
        <s-link href="/app/pricing">Pricing</s-link>
        <s-link href="/app/settings">Settings</s-link>
      </s-app-nav>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
