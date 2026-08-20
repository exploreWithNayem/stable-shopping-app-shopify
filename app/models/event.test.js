import { afterAll, beforeEach, describe, expect, test } from "vitest";
import prisma from "../db.server";
import {
  countEvents,
  deleteEventsBefore,
  deleteEventsForOrders,
  getEventsForRange,
  getSourceProductMetrics,
  normalizeEvent,
  recordEvent,
  recordEvents,
} from "./event.server";

const DOMAIN = "vitest-event.myshopify.com";
let shopId;

beforeEach(async () => {
  await prisma.shop.deleteMany({ where: { domain: DOMAIN } });
  const shop = await prisma.shop.create({ data: { domain: DOMAIN } });
  shopId = shop.id;
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { domain: DOMAIN } });
});

const click = (overrides = {}) => ({
  type: "click",
  sourceProductId: "1",
  recoProductId: "2",
  placement: "pdp",
  source: "override",
  ...overrides,
});

describe("normalizeEvent", () => {
  test("rejects unknown types and missing source products", () => {
    expect(normalizeEvent("s", { type: "nope", sourceProductId: "1" })).toBeNull();
    expect(normalizeEvent("s", { type: "click", sourceProductId: "" })).toBeNull();
    expect(normalizeEvent("s", null)).toBeNull();
  });

  // Beacons come from the storefront, so anything unrecognised is coerced to a
  // safe default instead of poisoning the analytics with junk dimensions.
  test("falls back on unrecognised placement and source", () => {
    const row = normalizeEvent("s", click({ placement: "bogus", source: "bogus" }));
    expect(row).toMatchObject({ placement: "pdp", source: "shopify" });
  });

  // The merchandising sources sit on any template and have no source product,
  // so they beacon the sentinel. Coercing their placement to "pdp" would fold a
  // home page row into that product's recommendation metrics.
  test.each(["popular", "recently_viewed"])(
    "keeps the %s placement distinct",
    (placement) => {
      const row = normalizeEvent("s", click({ placement, sourceProductId: "*" }));
      expect(row).toMatchObject({ placement, sourceProductId: "*" });
    },
  );

  // Related shares the product page with the custom source, and the serve
  // dedupe keys on (session, product, placement) — folding it into "pdp" would
  // make one of the two rows free.
  test("keeps the related placement distinct from pdp", () => {
    const row = normalizeEvent("s", click({ placement: "related", source: "shopify" }));
    expect(row).toMatchObject({ placement: "related", sourceProductId: "1" });
  });

  test("coerces ids to strings and blanks to null", () => {
    const row = normalizeEvent("s", click({ sourceProductId: 1, recoProductId: 2 }));
    expect(row).toMatchObject({ sourceProductId: "1", recoProductId: "2" });
    expect(normalizeEvent("s", click({ recoProductId: null })).recoProductId).toBeNull();
  });
});

describe("recordEvents", () => {
  test("ignores a replayed beacon with the same clientId", async () => {
    const beacon = click({ clientId: "dupe-1" });
    await recordEvents(shopId, [beacon]);
    await recordEvents(shopId, [beacon]);

    expect(await countEvents(shopId, { type: "click" })).toBe(1);
  });

  test("writes events without a clientId every time", async () => {
    await recordEvent(shopId, { type: "served", sourceProductId: "1" });
    await recordEvent(shopId, { type: "served", sourceProductId: "1" });

    expect(await countEvents(shopId, { type: "served" })).toBe(2);
  });

  test("keeps the valid events in a mixed batch", async () => {
    const written = await recordEvents(shopId, [
      { type: "not_a_type", sourceProductId: "1" },
      { type: "served", sourceProductId: "" },
      click({ clientId: "ok-1" }),
    ]);

    expect(written).toBe(1);
    expect(await countEvents(shopId)).toBe(1);
  });

  test("returns zero for an empty or fully invalid batch", async () => {
    expect(await recordEvents(shopId, [])).toBe(0);
    expect(await recordEvents(shopId, [{ type: "bogus" }])).toBe(0);
  });

  test("honours a supplied createdAt", async () => {
    const when = new Date("2026-08-01T10:00:00Z");
    await recordEvent(shopId, click({ clientId: "dated", createdAt: when }));

    const [row] = await getEventsForRange(
      shopId,
      new Date("2026-08-01T00:00:00Z"),
      new Date("2026-08-02T00:00:00Z"),
    );
    expect(row.createdAt).toEqual(when);
  });

  test("stores revenue as a decimal", async () => {
    await recordEvent(shopId, {
      type: "purchase",
      sourceProductId: "1",
      recoProductId: "2",
      orderId: "gid://shopify/Order/1",
      revenue: "129.99",
      clientId: "purchase-1",
    });

    const row = await prisma.recommendationEvent.findFirst({
      where: { shopId, type: "purchase" },
    });
    expect(Number(row.revenue)).toBe(129.99);
  });
});

describe("getSourceProductMetrics", () => {
  test("counts each event type per source product", async () => {
    await recordEvents(shopId, [
      { type: "served", sourceProductId: "1", clientId: "a" },
      { type: "served", sourceProductId: "1", clientId: "b" },
      click({ sourceProductId: "1", clientId: "c" }),
      { type: "add_to_cart", sourceProductId: "1", recoProductId: "2", clientId: "d" },
      { type: "served", sourceProductId: "9", clientId: "e" },
    ]);

    const metrics = await getSourceProductMetrics(shopId, ["1", "9"]);
    expect(metrics.get("1")).toMatchObject({ served: 2, clicks: 1, addToCarts: 1 });
    expect(metrics.get("9")).toMatchObject({ served: 1, clicks: 0 });
  });

  // The table renders a row per product, so every requested id needs an entry
  // even when it has no events at all.
  test("returns zeroed metrics for products with no events", async () => {
    const metrics = await getSourceProductMetrics(shopId, ["404"]);
    expect(metrics.get("404")).toEqual({
      served: 0,
      impressions: 0,
      clicks: 0,
      addToCarts: 0,
      purchases: 0,
    });
  });

  test("honours the date window", async () => {
    await recordEvents(shopId, [
      { type: "served", sourceProductId: "1", clientId: "old", createdAt: new Date("2026-01-01Z") },
      { type: "served", sourceProductId: "1", clientId: "new", createdAt: new Date("2026-08-01Z") },
    ]);

    const metrics = await getSourceProductMetrics(shopId, ["1"], {
      from: new Date("2026-06-01Z"),
    });
    expect(metrics.get("1").served).toBe(1);
  });

  test("coerces and dedupes the id list", async () => {
    await recordEvents(shopId, [{ type: "served", sourceProductId: "1", clientId: "x" }]);
    const metrics = await getSourceProductMetrics(shopId, [1, "1"]);
    expect(metrics.size).toBe(1);
    expect(metrics.get("1").served).toBe(1);
  });

  test("returns an empty map for no ids", async () => {
    expect((await getSourceProductMetrics(shopId, [])).size).toBe(0);
  });
});

describe("retention", () => {
  test("deletes only events older than the cutoff", async () => {
    await recordEvent(shopId, click({ clientId: "old", createdAt: new Date("2026-01-01Z") }));
    await recordEvent(shopId, click({ clientId: "new", createdAt: new Date("2026-08-01Z") }));

    await deleteEventsBefore(shopId, new Date("2026-06-01Z"));
    expect(await countEvents(shopId)).toBe(1);
  });
});

describe("deleteEventsForOrders", () => {
  /*
   * The whole of customers/redact. `orderId` is the only field in this table
   * that leads back to a person — everything else is a product id, a placement
   * or an opaque session id — and it appears only on purchase rows.
   */
  const purchase = (orderId) => ({
    type: "purchase",
    sourceProductId: "1",
    recoProductId: "2",
    placement: "pdp",
    source: "override",
    orderId,
    revenue: "10.00",
  });

  test("removes only the named orders", async () => {
    await recordEvents(shopId, [purchase("111"), purchase("222"), purchase("333")]);

    const { count } = await deleteEventsForOrders(shopId, ["111", "333"]);

    expect(count).toBe(2);
    const left = await prisma.recommendationEvent.findMany({ where: { shopId } });
    expect(left.map((row) => row.orderId)).toEqual(["222"]);
  });

  test("leaves everything that is not tied to an order", async () => {
    await recordEvents(shopId, [
      purchase("111"),
      { type: "click", sourceProductId: "1", recoProductId: "2", placement: "pdp", source: "shopify" },
    ]);

    await deleteEventsForOrders(shopId, ["111"]);

    const left = await prisma.recommendationEvent.findMany({ where: { shopId } });
    expect(left.map((row) => row.type)).toEqual(["click"]);
  });

  test("an empty list is a no-op, not a table wipe", async () => {
    await recordEvents(shopId, [purchase("111")]);
    expect(await deleteEventsForOrders(shopId, [])).toEqual({ count: 0 });
    expect(await countEvents(shopId)).toBe(1);
  });

  test("never reaches another shop's rows", async () => {
    const other = await prisma.shop.create({
      data: { domain: "vitest-event-other.myshopify.com" },
    });
    await recordEvents(other.id, [purchase("111")]);
    await recordEvents(shopId, [purchase("111")]);

    await deleteEventsForOrders(shopId, ["111"]);

    expect(await countEvents(other.id)).toBe(1);
    await prisma.shop.delete({ where: { id: other.id } });
  });
});
