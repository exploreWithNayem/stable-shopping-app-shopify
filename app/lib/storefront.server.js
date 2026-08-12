import prisma from "../db.server";

/**
 * Storefront API access.
 *
 * Shopify's own product recommendations are only exposed through the Storefront
 * API — the Admin API has no productRecommendations query — so the app
 * delegates an unauthenticated token to itself and calls the shop's public
 * GraphQL endpoint with it.
 */

/** Keep in sync with ApiVersion in app/shopify.server.js. */
export const STOREFRONT_API_VERSION = "2026-07";

const TOKEN_TITLE = "Easy Recommendation";

const CREATE_TOKEN_MUTATION = `#graphql
  mutation CreateStorefrontAccessToken($input: StorefrontAccessTokenInput!) {
    storefrontAccessTokenCreate(input: $input) {
      storefrontAccessToken {
        accessToken
      }
      userErrors {
        field
        message
      }
    }
  }`;

/**
 * The shop's delegated Storefront token, creating one the first time.
 *
 * Persisted on the Shop row because a shop supports only ~100 active tokens —
 * minting one per request would exhaust that quickly. Requires an admin
 * context, so provisioning happens on admin page loads; the app proxy only ever
 * reads the stored value (see getStoredStorefrontToken).
 */
export async function ensureStorefrontToken(admin, shop) {
  if (shop.storefrontToken) return shop.storefrontToken;

  const response = await admin.graphql(CREATE_TOKEN_MUTATION, {
    variables: { input: { title: TOKEN_TITLE } },
  });
  const body = await response.json();
  const result = body?.data?.storefrontAccessTokenCreate;

  const userErrors = result?.userErrors ?? [];
  if (userErrors.length > 0) {
    throw new Error(
      `storefrontAccessTokenCreate failed: ${userErrors
        .map((e) => e.message)
        .join(", ")}`,
    );
  }

  const token = result?.storefrontAccessToken?.accessToken;
  if (!token) {
    throw new Error("storefrontAccessTokenCreate returned no token");
  }

  await prisma.shop.update({
    where: { id: shop.id },
    data: { storefrontToken: token },
  });

  return token;
}

/** Token already on the Shop row, or null. Safe to call without an admin context. */
export function getStoredStorefrontToken(shop) {
  return shop?.storefrontToken ?? null;
}

/**
 * POST a Storefront API query. Throws on transport errors and on GraphQL
 * errors, so callers can decide whether to degrade or surface the failure.
 */
export async function storefrontGraphql(
  shopDomain,
  token,
  query,
  variables = {},
) {
  const response = await fetch(
    `https://${shopDomain}/api/${STOREFRONT_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Storefront-Access-Token": token,
      },
      body: JSON.stringify({ query, variables }),
    },
  );

  if (!response.ok) {
    throw new Error(
      `Storefront API responded ${response.status} for ${shopDomain}`,
    );
  }

  const body = await response.json();

  if (body?.errors?.length) {
    throw new Error(
      `Storefront API errors: ${body.errors.map((e) => e.message).join(", ")}`,
    );
  }

  return body?.data ?? {};
}
