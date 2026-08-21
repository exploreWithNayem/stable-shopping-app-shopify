import { beforeEach, describe, expect, test } from "vitest";
import {
  ensureMetafieldDefinitions,
  resetDefinitionCache,
} from "./metafield-definitions.server";

/*
 * Declaring a metafield in shopify.app.toml did **not** create the definition on a
 * real store, and without a definition the metafield is private: `metafieldsSet`
 * writes the value, `syncedAt` gets set, the app reports success, and Liquid reads
 * nil — so overrides and offers render as Shopify's own recommendations with nothing
 * anywhere reporting a failure. That cost a day once; this is the bootstrap that
 * stops it happening on the next store.
 */

/** Records queries, and answers with whichever definitions a test says exist. */
function stubAdmin({ existing = {}, errors = [] } = {}) {
  const calls = [];

  return {
    calls,
    graphql: async (query, options) => {
      const variables = options?.variables ?? {};
      calls.push({ query, variables });

      if (query.includes("RecoMetafieldDefinitions")) {
        return {
          json: async () => ({
            data: {
              metafieldDefinitions: {
                nodes: (existing[variables.ownerType] ?? []).map((key) => ({ key })),
              },
            },
          }),
        };
      }

      return {
        json: async () => ({
          data: {
            metafieldDefinitionCreate: {
              createdDefinition: errors.length > 0 ? null : { id: "gid://shopify/X/1" },
              userErrors: errors,
            },
          },
        }),
      };
    },
  };
}

const shop = { id: "shop-1" };

beforeEach(() => {
  resetDefinitionCache();
});

describe("ensureMetafieldDefinitions", () => {
  test("creates both definitions on a store that has neither", async () => {
    const admin = stubAdmin();
    const result = await ensureMetafieldDefinitions(admin, shop);

    expect(result.created).toEqual(["PRODUCT/reco_overrides", "SHOP/reco_offers"]);

    const created = admin.calls.filter((call) =>
      call.query.includes("RecoCreateMetafieldDefinition"),
    );
    expect(created).toHaveLength(2);

    for (const call of created) {
      // PUBLIC_READ is the whole point: without it Liquid reads nil.
      expect(call.variables.definition.access).toEqual({
        admin: "MERCHANT_READ",
        storefront: "PUBLIC_READ",
      });
      expect(call.variables.definition.namespace).toBe("$app");
      expect(call.variables.definition.type).toBe("json");
    }
  });

  test("creates only what is missing", async () => {
    const admin = stubAdmin({ existing: { PRODUCT: ["reco_overrides"] } });
    const result = await ensureMetafieldDefinitions(admin, shop);

    expect(result.created).toEqual(["SHOP/reco_offers"]);
  });

  test("does nothing when both already exist", async () => {
    const admin = stubAdmin({
      existing: { PRODUCT: ["reco_overrides"], SHOP: ["reco_offers"] },
    });

    expect((await ensureMetafieldDefinitions(admin, shop)).created).toEqual([]);
    expect(
      admin.calls.some((call) => call.query.includes("RecoCreateMetafieldDefinition")),
    ).toBe(false);
  });

  test("checks once per process, not once per page load", async () => {
    // The definitions are permanent once created; re-checking would be two GraphQL
    // calls on every admin request for an answer that cannot change.
    const admin = stubAdmin({
      existing: { PRODUCT: ["reco_overrides"], SHOP: ["reco_offers"] },
    });

    await ensureMetafieldDefinitions(admin, shop);
    const after = admin.calls.length;
    await ensureMetafieldDefinitions(admin, shop);

    expect(admin.calls.length).toBe(after);
  });

  test("TAKEN is a success — another request won the race", async () => {
    const admin = stubAdmin({ errors: [{ code: "TAKEN", message: "Key is in use" }] });
    expect((await ensureMetafieldDefinitions(admin, shop)).created).toHaveLength(2);
  });

  test("a real error is skipped, not thrown", async () => {
    /*
     * A definition that cannot be created must not take the admin down — the paths
     * that need it already degrade to Shopify's own recommendations.
     */
    const admin = stubAdmin({ errors: [{ code: "INVALID_VALUE", message: "Nope" }] });

    const result = await ensureMetafieldDefinitions(admin, shop);
    expect(result.created).toEqual([]);
  });
});
