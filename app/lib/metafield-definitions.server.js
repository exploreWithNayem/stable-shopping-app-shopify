import { METAFIELD_NAMESPACE } from "./metafields.server";
import { SHOP_OFFERS_KEY } from "./shop-offers.server";

/**
 * Create the app's metafield **definitions** on the store, if they are missing.
 *
 * Declaring them in `shopify.app.toml` is not enough. On
 * `stable-shipping-store.myshopify.com` the `[product.metafields.app.reco_overrides]`
 * block shipped in the deploy bundle and **no definition existed on the store** —
 * verified by listing `metafieldDefinitions(ownerType: PRODUCT)` afterwards. The
 * failure is silent and expensive to diagnose: `metafieldsSet` writes the value
 * happily, `syncedAt` gets set, the app reports success, and Liquid reads **nil**,
 * because without a definition the metafield is private. The PDP then falls back to
 * Shopify's own recommendations and looks like the sync is broken.
 *
 * A definition and a value are separate objects, and the definition adopts values
 * that were already written — so creating one repairs a store retroactively with no
 * re-sync.
 *
 * Called from the `/app` loader beside `ensureStorefrontToken`, for the same reason:
 * whichever page a merchant opens first, the app has to be usable.
 */

const DEFINITIONS = [
  {
    ownerType: "PRODUCT",
    key: "reco_overrides",
    name: "Recommendation Overrides",
    description: "Manual product recommendations that replace the Shopify-generated list",
  },
  {
    ownerType: "SHOP",
    key: SHOP_OFFERS_KEY,
    name: "Recommendation Offers",
    description: "Offers that apply to a whole catalogue or to collections",
  },
];

const LIST_QUERY = `#graphql
  query RecoMetafieldDefinitions($ownerType: MetafieldOwnerType!, $namespace: String!) {
    metafieldDefinitions(ownerType: $ownerType, namespace: $namespace, first: 25) {
      nodes {
        key
      }
    }
  }`;

const CREATE_MUTATION = `#graphql
  mutation RecoCreateMetafieldDefinition($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition {
        id
      }
      userErrors {
        code
        field
        message
      }
    }
  }`;

/**
 * Shops already checked in this process.
 *
 * The definitions are permanent once created, so re-checking on every admin request
 * would be two GraphQL calls per page load for an answer that cannot change. Held in
 * memory rather than on the Shop row because it is a cache, not a fact about the
 * shop: a fresh process re-checks, which is what makes it self-healing if someone
 * deletes a definition by hand.
 */
const checked = new Set();

/** Definitions this store is missing, by owner type. */
async function missingFor(admin, ownerType) {
  const wanted = DEFINITIONS.filter((definition) => definition.ownerType === ownerType);

  const response = await admin.graphql(LIST_QUERY, {
    variables: { ownerType, namespace: METAFIELD_NAMESPACE },
  });
  const body = await response.json();
  const existing = new Set(
    (body?.data?.metafieldDefinitions?.nodes ?? []).map((node) => node.key),
  );

  return wanted.filter((definition) => !existing.has(definition.key));
}

/**
 * Which definitions this store has, and which it is missing.
 *
 * Read-only, and read on every Settings load rather than cached: a merchant looks at
 * this precisely when the storefront is not behaving, and a cached "present" would be
 * the least useful thing the page could say.
 *
 * The distinction matters because **the Admin API can read a metafield with no
 * definition and Liquid cannot**. So the app can report an offer as live, and the
 * storefront still shows nothing — which is exactly the shape of "specific products
 * works, all products does not": the product definition was created by hand months
 * ago, the shop one never was.
 */
export async function readDefinitionStatus(admin) {
  const ownerTypes = [...new Set(DEFINITIONS.map((definition) => definition.ownerType))];
  const status = [];

  for (const ownerType of ownerTypes) {
    const missing = new Set((await missingFor(admin, ownerType)).map((entry) => entry.key));

    for (const definition of DEFINITIONS.filter((entry) => entry.ownerType === ownerType)) {
      status.push({
        ownerType,
        key: definition.key,
        name: definition.name,
        present: !missing.has(definition.key),
      });
    }
  }

  return status;
}

export async function ensureMetafieldDefinitions(admin, shop, { force = false } = {}) {
  if (!force && checked.has(shop.id)) return { created: [], errors: [] };

  const created = [];
  const errors = [];
  const ownerTypes = [...new Set(DEFINITIONS.map((definition) => definition.ownerType))];

  for (const ownerType of ownerTypes) {
    for (const definition of await missingFor(admin, ownerType)) {
      const response = await admin.graphql(CREATE_MUTATION, {
        variables: {
          definition: {
            ownerType,
            namespace: METAFIELD_NAMESPACE,
            key: definition.key,
            name: definition.name,
            description: definition.description,
            type: "json",
            access: {
              admin: "MERCHANT_READ",
              // The whole point: without this Liquid reads nil.
              storefront: "PUBLIC_READ",
            },
          },
        },
      });

      const body = await response.json();

      /*
       * TAKEN means another request won the race, which is a success from here.
       * Anything else is logged and skipped rather than thrown: a definition that
       * cannot be created must not take the admin down, and the paths that need it
       * already degrade to Shopify's own recommendations.
       */
      const real = (body?.data?.metafieldDefinitionCreate?.userErrors ?? []).filter(
        (error) => error.code !== "TAKEN",
      );
      if (real.length > 0) {
        /*
         * Collected *and* logged. Swallowing this into the console is how the shop
         * definition could be missing for days: the app kept reporting offers as live
         * while Liquid read nil, and nothing on screen said the storefront could not
         * see them.
         */
        const message = `${ownerType}/${definition.key}: ${real
          .map((error) => error.message)
          .join(", ")}`;
        console.error("[easy-reco] metafieldDefinitionCreate failed", message);
        errors.push(message);
        continue;
      }

      created.push(`${ownerType}/${definition.key}`);
    }
  }

  // Only a clean run is remembered: a failure has to be retried on the next load.
  if (errors.length === 0) checked.add(shop.id);
  return { created, errors };
}

/** Test seam: the in-process cache would otherwise leak between cases. */
export function resetDefinitionCache() {
  checked.clear();
}
