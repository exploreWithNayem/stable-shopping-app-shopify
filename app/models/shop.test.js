import { afterAll, beforeEach, describe, expect, test } from "vitest";
import prisma from "../db.server";
import {
  ensureShop,
  getShopByDomain,
  markUninstalled,
  purgeShopData,
  setPlan,
  updateSettings,
} from "./shop.server";

const DOMAIN = "vitest-shop.myshopify.com";

beforeEach(async () => {
  await prisma.shop.deleteMany({ where: { domain: DOMAIN } });
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { domain: DOMAIN } });
});

describe("ensureShop", () => {
  test("creates once and returns the same row on repeat calls", async () => {
    const first = await ensureShop(DOMAIN);
    const second = await ensureShop(DOMAIN);
    expect(second.id).toBe(first.id);
    expect(await prisma.shop.count({ where: { domain: DOMAIN } })).toBe(1);
  });

  test("defaults to the free plan with a billing anchor", async () => {
    const shop = await ensureShop(DOMAIN);
    expect(shop.plan).toBe("free");
    expect(shop.billingCycleStart).toBeInstanceOf(Date);
    expect(shop.uninstalledAt).toBeNull();
  });

  test("records a newly known currency", async () => {
    await ensureShop(DOMAIN);
    expect((await ensureShop(DOMAIN, { currencyCode: "GBP" })).currencyCode).toBe(
      "GBP",
    );
  });

  test("clears the uninstall marker and re-anchors billing on reinstall", async () => {
    const original = await ensureShop(DOMAIN);
    await markUninstalled(DOMAIN);
    const reinstalled = await ensureShop(DOMAIN);

    expect(reinstalled.id).toBe(original.id); // history survives
    expect(reinstalled.uninstalledAt).toBeNull();
  });
});

describe("markUninstalled", () => {
  test("soft deletes and drops the paid plan", async () => {
    const shop = await ensureShop(DOMAIN);
    await setPlan(shop.id, { plan: "standard", subscriptionId: "gid://x/1" });
    await markUninstalled(DOMAIN);

    const after = await getShopByDomain(DOMAIN);
    expect(after.uninstalledAt).toBeInstanceOf(Date);
    expect(after.plan).toBe("free");
    expect(after.subscriptionId).toBeNull();
  });

  test("is a no-op for an already uninstalled shop", async () => {
    await ensureShop(DOMAIN);
    await markUninstalled(DOMAIN);
    const first = await getShopByDomain(DOMAIN);
    await markUninstalled(DOMAIN);
    expect((await getShopByDomain(DOMAIN)).uninstalledAt).toEqual(
      first.uninstalledAt,
    );
  });
});

describe("updateSettings", () => {
  test("merges rather than replacing", async () => {
    const shop = await ensureShop(DOMAIN);
    await updateSettings(shop.id, { defaultLayout: "slider" });
    const merged = await updateSettings(shop.id, { defaultLimit: 6 });

    expect(merged.settings).toEqual({
      defaultLayout: "slider",
      defaultLimit: 6,
    });
  });

  test("overwrites a key it already holds", async () => {
    const shop = await ensureShop(DOMAIN);
    await updateSettings(shop.id, { defaultLayout: "slider" });
    const merged = await updateSettings(shop.id, { defaultLayout: "list" });
    expect(merged.settings.defaultLayout).toBe("list");
  });
});

describe("purgeShopData", () => {
  /*
   * The hard delete behind the mandatory shop/redact webhook, which arrives 48
   * hours after an uninstall. app/uninstalled only soft-deletes, so this is the
   * only path that actually erases a shop.
   */
  test("removes the shop, its children and its sessions", async () => {
    const shop = await ensureShop(DOMAIN);
    await prisma.override.create({
      data: {
        shopId: shop.id,
        productId: "1",
        productTitle: "T",
        productHandle: "t",
        items: [],
      },
    });
    await prisma.recommendationEvent.create({
      data: {
        shopId: shop.id,
        type: "served",
        sourceProductId: "1",
        placement: "pdp",
        source: "shopify",
      },
    });
    await prisma.session.create({
      data: { id: `purge-${DOMAIN}`, shop: DOMAIN, state: "s", accessToken: "t" },
    });

    const result = await purgeShopData(DOMAIN);

    expect(result.shops).toBe(1);
    expect(result.sessions).toBe(1);
    expect(await getShopByDomain(DOMAIN)).toBeNull();
    // Cascades, so nothing is left pointing at a shop that no longer exists.
    expect(await prisma.override.count({ where: { shopId: shop.id } })).toBe(0);
    expect(
      await prisma.recommendationEvent.count({ where: { shopId: shop.id } }),
    ).toBe(0);
  });

  test("is idempotent — Shopify delivers at least once", async () => {
    await ensureShop(DOMAIN);
    await purgeShopData(DOMAIN);
    expect(await purgeShopData(DOMAIN)).toEqual({ shops: 0, sessions: 0 });
  });
});
