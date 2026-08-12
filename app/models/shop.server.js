import prisma from "../db.server";
import { startOfUtcDay } from "../lib/dates";

/**
 * Data access for the Shop record. Every authenticated admin request funnels
 * through ensureShop() so the rest of the app can assume a Shop row exists.
 */

export function getShopByDomain(domain) {
  return prisma.shop.findUnique({ where: { domain } });
}

export function getShopById(id) {
  return prisma.shop.findUnique({ where: { id } });
}

/**
 * Find-or-create the Shop for `domain`.
 *
 * Deliberately reads before writing: this runs on every authenticated request,
 * and an unconditional upsert would mean a DB write per page load. Only patches
 * when something actually changed (reinstall, or a newly known currency).
 */
export async function ensureShop(domain, { currencyCode } = {}) {
  const existing = await prisma.shop.findUnique({ where: { domain } });

  if (!existing) {
    return prisma.shop.create({
      data: {
        domain,
        currencyCode: currencyCode ?? null,
        billingCycleStart: startOfUtcDay(),
      },
    });
  }

  const patch = {};
  // Reinstall: keep the historical data, clear the uninstall marker.
  if (existing.uninstalledAt) {
    patch.uninstalledAt = null;
    patch.billingCycleStart = startOfUtcDay();
  }
  if (currencyCode && existing.currencyCode !== currencyCode) {
    patch.currencyCode = currencyCode;
  }

  if (Object.keys(patch).length === 0) return existing;

  return prisma.shop.update({ where: { id: existing.id }, data: patch });
}

/** Called from the app/uninstalled webhook. Soft delete — data is kept. */
export function markUninstalled(domain) {
  return prisma.shop.updateMany({
    where: { domain, uninstalledAt: null },
    data: { uninstalledAt: new Date(), subscriptionId: null, plan: "free" },
  });
}

export function setPlan(shopId, { plan, subscriptionId = null }) {
  return prisma.shop.update({
    where: { id: shopId },
    data: { plan, subscriptionId },
  });
}

export function getSettings(shop) {
  return shop?.settings ?? {};
}

/** Shallow-merges into Shop.settings so callers can patch one key at a time. */
export async function updateSettings(shopId, patch) {
  const shop = await prisma.shop.findUniqueOrThrow({ where: { id: shopId } });
  return prisma.shop.update({
    where: { id: shopId },
    data: { settings: { ...(shop.settings ?? {}), ...patch } },
  });
}
