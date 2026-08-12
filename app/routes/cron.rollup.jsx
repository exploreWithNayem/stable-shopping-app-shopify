import prisma from "../db.server";
import { rollupRange, deleteDailyBefore } from "../models/analytics.server";
import { deleteEventsBefore } from "../models/event.server";
import { addDays, startOfUtcDay } from "../lib/dates";
import { rawEventRetentionDays } from "../lib/entitlements";

/**
 * Scheduled maintenance: roll raw events into daily figures, then prune what
 * has aged out.
 *
 * Not part of the admin app, so it authenticates with a shared secret rather
 * than a Shopify session. Point a scheduler at
 * `POST /cron/rollup` with `Authorization: Bearer $CRON_SECRET`.
 *
 * The dashboard also rolls up the last few days on load, so this exists to
 * catch shops nobody has opened and to run the pruning.
 */

/** How far back a scheduled run rebuilds. Late webhooks are the reason. */
const ROLLUP_WINDOW_DAYS = 7;

function unauthorized() {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}

export const action = async ({ request }) => {
  // eslint-disable-next-line no-undef
  const secret = process.env.CRON_SECRET;

  // Refuse rather than run unprotected if the secret was never configured.
  if (!secret) {
    return Response.json({ error: "CRON_SECRET is not set" }, { status: 503 });
  }

  const provided = request.headers.get("authorization");
  if (provided !== `Bearer ${secret}`) return unauthorized();

  const today = startOfUtcDay();
  const shops = await prisma.shop.findMany({
    where: { uninstalledAt: null },
    select: { id: true, domain: true, plan: true },
  });

  const results = [];

  for (const shop of shops) {
    const retentionDays = rawEventRetentionDays(shop.plan);

    try {
      const { rolled, skipped } = await rollupRange(shop.id, {
        from: addDays(today, -ROLLUP_WINDOW_DAYS),
        to: today,
        maxAgeDays: retentionDays,
      });

      // Raw events go once they are rolled up; the daily figures they produced
      // outlive them. Daily rows are kept far longer for year-on-year views.
      const prunedEvents = await deleteEventsBefore(
        shop.id,
        addDays(today, -retentionDays),
      );
      const prunedDaily = await deleteDailyBefore(shop.id, addDays(today, -730));

      results.push({
        shop: shop.domain,
        rolledDays: rolled.length,
        skippedDays: skipped.length,
        prunedEvents: prunedEvents.count,
        prunedDaily: prunedDaily.count,
      });
    } catch (error) {
      // One bad shop must not stop the rest of the run.
      results.push({ shop: shop.domain, error: error.message });
    }
  }

  return Response.json({ ok: true, shops: results.length, results });
};

/** Scheduled runs POST; a GET here is a misconfiguration worth naming. */
export const loader = () => new Response(null, { status: 405 });
