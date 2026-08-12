import { afterAll, beforeEach, describe, expect, test } from "vitest";
import prisma from "../db.server";
import {
  ensureShop,
  getShopByDomain,
  markUninstalled,
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
