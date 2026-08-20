import { afterAll, beforeEach, describe, expect, test } from "vitest";
import prisma from "../db.server";
import {
  MAX_OVERRIDE_ITEMS,
  countOverriddenProducts,
  countOverrides,
  deleteOverride,
  deleteOverridesForProduct,
  getOverride,
  getOverridesForProducts,
  getProductOverrides,
  hasOverrideForProduct,
  listOverrides,
  listUnsyncedOverrides,
  markOverrideSynced,
  normalizeItems,
  upsertOverride,
} from "./override.server";

const DOMAIN = "vitest-override.myshopify.com";
let shopId;

beforeEach(async () => {
  await prisma.shop.deleteMany({ where: { domain: DOMAIN } });
  const shop = await prisma.shop.create({ data: { domain: DOMAIN } });
  shopId = shop.id;
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { domain: DOMAIN } });
});

const save = (productId, items, extra = {}) =>
  upsertOverride({
    shopId,
    productId,
    productTitle: `Product ${productId}`,
    productHandle: `product-${productId}`,
    items,
    ...extra,
  });

describe("normalizeItems", () => {
  // Liquid resolves these with all_products[handle], capped at 20 lookups/page.
  test(`caps at ${MAX_OVERRIDE_ITEMS} items`, () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ id: i + 1 }));
    expect(normalizeItems(many)).toHaveLength(MAX_OVERRIDE_ITEMS);
  });

  test("dedupes and renumbers positions", () => {
    expect(normalizeItems([{ id: 5 }, { id: 5 }, { id: 6 }])).toEqual([
      { id: "5", handle: null, title: null, position: 0 },
      { id: "6", handle: null, title: null, position: 1 },
    ]);
  });

  test("drops entries without an id", () => {
    expect(normalizeItems([{ handle: "no-id" }, {}, { id: 7 }])).toEqual([
      { id: "7", handle: null, title: null, position: 0 },
    ]);
  });

  // String(0) is truthy, so a zero id sails through a naive check and lands in
  // the metafield as an item Liquid can never resolve.
  test("drops a zero id", () => {
    expect(normalizeItems([{ id: 0 }, { id: "0" }, { id: 7 }])).toHaveLength(1);
  });

  test("coerces numeric ids to strings", () => {
    expect(normalizeItems([{ id: 42 }])[0].id).toBe("42");
  });

  test("tolerates no argument", () => {
    expect(normalizeItems()).toEqual([]);
  });
});

describe("upsertOverride", () => {
  test("updates in place rather than duplicating", async () => {
    const created = await save(999, [{ id: 1 }, { id: 2 }]);
    const updated = await save(999, [{ id: 3 }]);

    expect(updated.id).toBe(created.id);
    expect(await prisma.override.count({ where: { shopId } })).toBe(1);
  });

  test("round-trips items through the Json column", async () => {
    const saved = await save(999, [{ id: 3, handle: "c", title: "C" }]);
    const reloaded = await getOverride({ shopId, productId: 999 });
    expect(reloaded.items).toEqual(saved.items);
    expect(reloaded.items[0]).toMatchObject({ id: "3", handle: "c" });
  });

  test("keeps the same product separate per placement", async () => {
    await save(999, [{ id: 1 }], { placement: "pdp" });
    await save(999, [{ id: 2 }], { placement: "checkout" });
    expect(await prisma.override.count({ where: { shopId } })).toBe(2);
  });

  // The metafield mirror is stale the moment the row changes, so the sync in
  // Phase 6 has something to find.
  test("clears syncedAt on every write", async () => {
    const created = await save(999, [{ id: 1 }]);
    await markOverrideSynced(created.id);
    expect((await getOverride({ shopId, productId: 999 })).syncedAt).toBeInstanceOf(Date);

    expect((await save(999, [{ id: 2 }])).syncedAt).toBeNull();
  });
});

describe("queries", () => {
  test("getOverridesForProducts keys by productId and skips misses", async () => {
    await save(999, [{ id: 1 }]);
    const map = await getOverridesForProducts(shopId, [999, 1000]);
    expect(map.size).toBe(1);
    expect(map.get("999").productId).toBe("999");
  });

  test("listOverrides filters by placement, enabled and title", async () => {
    await save(1, [{ id: 9 }], { placement: "pdp" });
    await save(2, [{ id: 9 }], { placement: "checkout" });
    await save(3, [{ id: 9 }], { enabled: false });

    expect(await listOverrides({ shopId, placement: "checkout" })).toHaveLength(1);
    expect(await listOverrides({ shopId, enabled: false })).toHaveLength(1);
    expect(await listOverrides({ shopId, enabled: true })).toHaveLength(2);
    expect(await listOverrides({ shopId, search: "Product 2" })).toHaveLength(1);
  });

  test("listUnsyncedOverrides surfaces drift only", async () => {
    const synced = await save(1, [{ id: 9 }]);
    await markOverrideSynced(synced.id);
    await save(2, [{ id: 9 }]);

    const drifted = await listUnsyncedOverrides(shopId);
    expect(drifted).toHaveLength(1);
    expect(drifted[0].productId).toBe("2");
  });
});

describe("counting against the plan allowance", () => {
  // The allowance is per product; placement rows must not double-count it.
  test("countOverriddenProducts counts products, countOverrides counts rows", async () => {
    await save(1, [{ id: 9 }], { placement: "pdp" });
    await save(1, [{ id: 9 }], { placement: "checkout" });
    await save(2, [{ id: 9 }]);

    expect(await countOverrides(shopId)).toBe(3);
    expect(await countOverriddenProducts(shopId)).toBe(2);
  });

  test("countOverriddenProducts is zero for a shop with none", async () => {
    expect(await countOverriddenProducts(shopId)).toBe(0);
  });

  // A disabled override still occupies its slot — the row is still there.
  test("hasOverrideForProduct ignores placement and enabled state", async () => {
    await save(1, [{ id: 9 }], { placement: "checkout", enabled: false });

    expect(await hasOverrideForProduct(shopId, 1)).toBe(true);
    expect(await hasOverrideForProduct(shopId, "1")).toBe(true);
    expect(await hasOverrideForProduct(shopId, 2)).toBe(false);
  });
});

describe("deletion", () => {
  test("deleteOverride removes one placement", async () => {
    await save(999, [{ id: 1 }], { placement: "pdp" });
    await save(999, [{ id: 2 }], { placement: "checkout" });

    await deleteOverride({ shopId, productId: 999, placement: "pdp" });
    expect(await prisma.override.count({ where: { shopId } })).toBe(1);
  });

  test("deleteOverridesForProduct removes every placement", async () => {
    await save(999, [{ id: 1 }], { placement: "pdp" });
    await save(999, [{ id: 2 }], { placement: "checkout" });

    await deleteOverridesForProduct(shopId, 999);
    expect(await prisma.override.count({ where: { shopId } })).toBe(0);
  });
});

/*
 * The inline editor on the list page edits a product's items and must leave the
 * placement alone. A product can hold a `pdp` row and a `checkout` row, so
 * assuming `pdp` would write a second row beside an existing one rather than
 * editing it — the merchant would see their list unchanged on the storefront
 * and a duplicate against the plan's product allowance.
 */
describe("getProductOverrides", () => {
  const save = (placement, items) =>
    upsertOverride({
      shopId,
      productId: 900,
      productTitle: "Source",
      productHandle: "source",
      placement,
      items,
    });

  test("returns every placement for one product", async () => {
    await save("pdp", [{ id: "1" }]);
    await save("checkout", [{ id: "2" }]);

    const rows = await getProductOverrides(shopId, 900);
    expect(rows.map((row) => row.placement).sort()).toEqual(["checkout", "pdp"]);
  });

  test("is empty for a product with no list", async () => {
    expect(await getProductOverrides(shopId, 901)).toEqual([]);
  });

  test("accepts a numeric or string product id", async () => {
    await save("pdp", [{ id: "1" }]);
    expect(await getProductOverrides(shopId, "900")).toHaveLength(1);
    expect(await getProductOverrides(shopId, 900)).toHaveLength(1);
  });

  test("never reaches another shop's rows", async () => {
    const other = await prisma.shop.create({
      data: { domain: "vitest-override-other.myshopify.com" },
    });
    await upsertOverride({
      shopId: other.id,
      productId: 900,
      productTitle: "Theirs",
      productHandle: "theirs",
      items: [{ id: "9" }],
    });
    await save("pdp", [{ id: "1" }]);

    const rows = await getProductOverrides(shopId, 900);
    expect(rows).toHaveLength(1);
    expect(rows[0].productTitle).toBe("Source");

    await prisma.shop.delete({ where: { id: other.id } });
  });

  test("reusing the found placement edits the row instead of duplicating it", async () => {
    // This is the sequence the inline action performs.
    await save("checkout", [{ id: "1" }]);
    const [existing] = await getProductOverrides(shopId, 900);

    await upsertOverride({
      shopId,
      productId: 900,
      productTitle: "Source",
      productHandle: "source",
      placement: existing.placement,
      items: [{ id: "2" }, { id: "3" }],
    });

    const rows = await getProductOverrides(shopId, 900);
    expect(rows).toHaveLength(1);
    expect(rows[0].placement).toBe("checkout");
    expect(rows[0].items.map((item) => item.id)).toEqual(["2", "3"]);
    // Still one product against the plan allowance.
    expect(await countOverriddenProducts(shopId)).toBe(1);
  });

  test("defaulting to pdp instead would have duplicated the row", async () => {
    // Guards the bug the placement lookup exists to prevent.
    await save("checkout", [{ id: "1" }]);
    await save("pdp", [{ id: "2" }]);

    expect(await getProductOverrides(shopId, 900)).toHaveLength(2);
    expect(await countOverrides(shopId)).toBe(2);
  });
});
