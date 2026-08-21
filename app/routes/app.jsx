import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { authenticate } from "../shopify.server";
import { ensureShop } from "../models/shop.server";
import { getQuotaStatusForShop } from "../models/usage.server";
import { ensureStorefrontToken } from "../lib/storefront.server";
import { ensureMetafieldDefinitions } from "../lib/metafield-definitions.server";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);

  // Every page under /app depends on the Shop row existing, so bootstrap it
  // here rather than in each route.
  const shop = await ensureShop(session.shop);

  /*
   * Provision the delegated Storefront token here, not on the page that happens
   * to need it first.
   *
   * Shopify's own recommendations are reachable only through the Storefront API,
   * so without a token every server-side path — the app proxy, the checkout
   * extension, the admin preview — degrades to an empty list. Minting it in one
   * route's loader meant a merchant who never opened the override editor had a
   * silently broken proxy. It is a no-op once the token is on the Shop row.
   *
   * Never fatal: a missing scope or a token cap must not take the whole admin
   * down. The paths that need it already degrade on their own.
   */
  try {
    await ensureStorefrontToken(admin, shop);
  } catch (error) {
    console.error("[easy-reco] storefront token provisioning failed", error);
  }

  /*
   * The metafield *definitions*, which declaring them in shopify.app.toml does not
   * reliably create — see app/lib/metafield-definitions.server.js. Without them the
   * values write fine and Liquid reads nil, so overrides and offers silently render
   * as Shopify's own recommendations.
   *
   * Same treatment as the token: never fatal, cached per process.
   */
  try {
    await ensureMetafieldDefinitions(admin, shop);
  } catch (error) {
    console.error("[easy-reco] metafield definition provisioning failed", error);
  }

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
