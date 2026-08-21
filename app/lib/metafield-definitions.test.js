import { beforeEach, describe, expect, test } from "vitest";
import {
  ensureMetafieldDefinitions,
  readDefinitionStatus,
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

  test("a real error is reported, not only logged", async () => {
    /*
     * Swallowing this into the console is how the shop definition could be missing for
     * days: the app kept reporting offers as live while Liquid read nil, and nothing on
     * screen said the storefront could not see them.
     */
    const admin = stubAdmin({ errors: [{ code: "INVALID_VALUE", message: "Nope" }] });
    const result = await ensureMetafieldDefinitions(admin, shop);

    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]).toContain("Nope");
  });

  test("a failed run is retried on the next load", async () => {
    // Only a clean run is remembered; caching a failure would hide it until restart.
    const failing = stubAdmin({ errors: [{ code: "INVALID_VALUE", message: "Nope" }] });
    await ensureMetafieldDefinitions(failing, shop);

    const retry = stubAdmin();
    expect((await ensureMetafieldDefinitions(retry, shop)).created).toHaveLength(2);
  });

  test("force re-checks a shop this process already cleared", async () => {
    // The Settings button is a deliberate retry, not a page load.
    const admin = stubAdmin({
      existing: { PRODUCT: ["reco_overrides"], SHOP: ["reco_offers"] },
    });

    await ensureMetafieldDefinitions(admin, shop);
    const after = admin.calls.length;
    await ensureMetafieldDefinitions(admin, shop, { force: true });

    expect(admin.calls.length).toBeGreaterThan(after);
  });
});

describe("readDefinitionStatus", () => {
  test("says which of the two the storefront can read", async () => {
    /*
     * The Admin API reads a metafield with no definition; Liquid does not. So this is
     * the difference between "the app saved it" and "the storefront can see it" — the
     * exact shape of "specific products works, all products does not".
     */
    const status = await readDefinitionStatus(
      stubAdmin({ existing: { PRODUCT: ["reco_overrides"] } }),
    );

    expect(status).toEqual([
      { ownerType: "PRODUCT", key: "reco_overrides", name: "Recommendation Overrides", present: true },
      { ownerType: "SHOP", key: "reco_offers", name: "Recommendation Offers", present: false },
    ]);
  });

  test("is not cached — it is read when the storefront looks wrong", async () => {
    const admin = stubAdmin();
    await readDefinitionStatus(admin);
    const after = admin.calls.length;
    await readDefinitionStatus(admin);

    expect(admin.calls.length).toBeGreaterThan(after);
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
