import { describe, expect, test } from "vitest";
import { purchaseEventsFromOrder, readLineProperties } from "./attribution.server";

/** Shaped like a real orders/create payload. */
const line = (overrides = {}) => ({
  id: 111,
  product_id: 555,
  quantity: 1,
  price: "25.00",
  properties: [
    { name: "_reco_src", value: "999" },
    { name: "_reco_cid", value: "click-1" },
    { name: "_reco_source", value: "override" },
  ],
  ...overrides,
});

const order = (lineItems) => ({
  id: 7001,
  admin_graphql_api_id: "gid://shopify/Order/7001",
  created_at: "2026-08-12T10:00:00Z",
  line_items: lineItems,
});

describe("readLineProperties", () => {
  // Webhooks send an array of {name, value}; other API surfaces send an object.
  test("reads the webhook array form", () => {
    expect(readLineProperties(line())._reco_src).toBe("999");
  });

  test("reads the object form", () => {
    expect(readLineProperties({ properties: { _reco_src: "1" } })._reco_src).toBe("1");
  });

  test("tolerates missing or odd properties", () => {
    expect(readLineProperties({})).toEqual({});
    expect(readLineProperties(null)).toEqual({});
    expect(readLineProperties({ properties: "nope" })).toEqual({});
  });
});

describe("purchaseEventsFromOrder", () => {
  test("maps a tagged line to a purchase event", () => {
    const [event] = purchaseEventsFromOrder(order([line()]));

    expect(event).toMatchObject({
      type: "purchase",
      sourceProductId: "999",
      recoProductId: "555",
      source: "override",
      orderId: "gid://shopify/Order/7001",
      revenue: "25.00",
    });
  });

  test("multiplies price by quantity", () => {
    const [event] = purchaseEventsFromOrder(
      order([line({ quantity: 3, price: "10.50" })]),
    );
    expect(event.revenue).toBe("31.50");
  });

  // Only the app's own tag counts. Everything else in the cart was sold by the
  // store, not by a recommendation.
  test("ignores lines this app did not tag", () => {
    const untagged = line({ id: 222, properties: [] });
    expect(purchaseEventsFromOrder(order([untagged]))).toHaveLength(0);
    expect(purchaseEventsFromOrder(order([line(), untagged]))).toHaveLength(1);
  });

  // Shopify delivers webhooks at least once, so the key cannot be random.
  test("derives a stable clientId from order and line", () => {
    const first = purchaseEventsFromOrder(order([line()]))[0];
    const second = purchaseEventsFromOrder(order([line()]))[0];

    expect(first.clientId).toBe(second.clientId);
    expect(first.clientId).toBe("order:gid://shopify/Order/7001:line:111");
  });

  test("gives each line its own key", () => {
    const events = purchaseEventsFromOrder(order([line(), line({ id: 112 })]));
    expect(new Set(events.map((e) => e.clientId)).size).toBe(2);
  });

  test("falls back to shopify for an unrecognised source", () => {
    const [event] = purchaseEventsFromOrder(
      order([
        line({
          properties: [
            { name: "_reco_src", value: "999" },
            { name: "_reco_source", value: "haxx" },
          ],
        }),
      ]),
    );
    expect(event.source).toBe("shopify");
  });

  test("stamps the order's creation time", () => {
    const [event] = purchaseEventsFromOrder(order([line()]));
    expect(event.createdAt).toEqual(new Date("2026-08-12T10:00:00Z"));
  });

  test("survives an empty or malformed order", () => {
    expect(purchaseEventsFromOrder({})).toEqual([]);
    expect(purchaseEventsFromOrder(null)).toEqual([]);
    expect(purchaseEventsFromOrder(order([]))).toEqual([]);
  });
});
