/**
 * Local dev seed: one shop, a few overrides, 30 days of analytics and 3 days of
 * raw events to exercise the rollup.
 *
 * Run with `npm run seed`. Re-runnable — it clears its own shop first.
 *
 * Uses PrismaClient directly rather than app/models/*.server.js: those use
 * extensionless imports, which plain `node` ESM cannot resolve.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const SHOP_DOMAIN = process.env.SEED_SHOP ?? "easy-reco-dev.myshopify.com";
const DAYS = 30;
const QUOTA = 1000; // standard plan

/**
 * How full the quota meter should be, as a fraction of QUOTA. Fixed rather than
 * derived from the seeded analytics so the fixture does not drift with the day
 * of the month. Override to exercise the other states:
 *   SEED_QUOTA_FILL=0.85 npm run seed   -> warning banner (>=80%)
 *   SEED_QUOTA_FILL=1    npm run seed   -> over quota, widget falls back
 */
const QUOTA_FILL = Number(process.env.SEED_QUOTA_FILL ?? 0.62);

/** Seeded PRNG so repeated runs produce the same numbers. */
function mulberry32(seed) {
  return function random() {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = mulberry32(20260812);
const randInt = (min, max) => min + Math.floor(random() * (max - min + 1));

function startOfUtcDay(date) {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

const PRODUCTS = [
  { id: "8001", handle: "alpine-snowboard", title: "Alpine Snowboard" },
  { id: "8002", handle: "powder-bindings", title: "Powder Bindings" },
  { id: "8003", handle: "all-weather-boots", title: "All-Weather Boots" },
  { id: "8004", handle: "thermal-gloves", title: "Thermal Gloves" },
  { id: "8005", handle: "goggle-pro", title: "Goggle Pro" },
  { id: "8006", handle: "board-wax-kit", title: "Board Wax Kit" },
  { id: "8007", handle: "travel-board-bag", title: "Travel Board Bag" },
  { id: "8008", handle: "merino-base-layer", title: "Merino Base Layer" },
];

const item = (product, position) => ({
  id: product.id,
  handle: product.handle,
  title: product.title,
  position,
});

async function main() {
  const today = startOfUtcDay(new Date());
  const periodStart = startOfUtcDay(
    new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)),
  );
  const periodEnd = startOfUtcDay(
    new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1)),
  );

  // Cascades wipe overrides, usage, events and daily rows for this shop.
  await prisma.shop.deleteMany({ where: { domain: SHOP_DOMAIN } });

  const shop = await prisma.shop.create({
    data: {
      domain: SHOP_DOMAIN,
      plan: "standard",
      currencyCode: "USD",
      billingCycleStart: periodStart,
      settings: { defaultLayout: "grid", defaultLimit: 4, intent: "related" },
    },
  });

  await prisma.override.createMany({
    data: [
      {
        shopId: shop.id,
        productId: PRODUCTS[0].id,
        productTitle: PRODUCTS[0].title,
        productHandle: PRODUCTS[0].handle,
        placement: "pdp",
        enabled: true,
        items: [item(PRODUCTS[1], 0), item(PRODUCTS[2], 1), item(PRODUCTS[5], 2)],
        syncedAt: new Date(),
      },
      {
        shopId: shop.id,
        productId: PRODUCTS[2].id,
        productTitle: PRODUCTS[2].title,
        productHandle: PRODUCTS[2].handle,
        placement: "both",
        enabled: true,
        items: [item(PRODUCTS[3], 0), item(PRODUCTS[7], 1)],
        syncedAt: null, // deliberately unsynced, to exercise the drift repair
      },
      {
        shopId: shop.id,
        productId: PRODUCTS[4].id,
        productTitle: PRODUCTS[4].title,
        productHandle: PRODUCTS[4].handle,
        placement: "pdp",
        enabled: false,
        items: [item(PRODUCTS[6], 0)],
        syncedAt: new Date(),
      },
    ],
  });

  // 30 days of rolled-up metrics, funnel-shaped: served > impressions > clicks.
  const dailyRows = [];

  for (let offset = DAYS - 1; offset >= 0; offset -= 1) {
    const date = addDays(today, -offset);

    for (const product of PRODUCTS) {
      if (random() < 0.25) continue; // not every product shows every day

      const served = randInt(3, 40);
      const impressions = Math.round(served * (0.6 + random() * 0.35));
      const clicks = Math.round(impressions * (0.04 + random() * 0.12));
      const addToCarts = Math.round(clicks * (0.15 + random() * 0.35));
      const purchases = Math.round(addToCarts * (0.2 + random() * 0.4));

      dailyRows.push({
        shopId: shop.id,
        date,
        productId: product.id,
        placement: random() < 0.85 ? "pdp" : "checkout",
        served,
        impressions,
        clicks,
        addToCarts,
        purchases,
        revenue: purchases * (40 + randInt(0, 120)),
      });
    }
  }

  await prisma.analyticsDaily.createMany({ data: dailyRows });

  // Raw events for the last 3 days only — enough to test the rollup without
  // seeding tens of thousands of rows.
  const rawEvents = [];
  for (let offset = 2; offset >= 0; offset -= 1) {
    const date = addDays(today, -offset);

    for (let n = 0; n < 40; n += 1) {
      const source = PRODUCTS[randInt(0, PRODUCTS.length - 1)];
      let reco = PRODUCTS[randInt(0, PRODUCTS.length - 1)];
      if (reco.id === source.id) reco = PRODUCTS[(randInt(0, 6) + 1) % 8];

      const sessionId = `seed-session-${offset}-${Math.floor(n / 4)}`;
      const createdAt = new Date(date.getTime() + randInt(0, 86399) * 1000);
      const base = {
        shopId: shop.id,
        sourceProductId: source.id,
        placement: "pdp",
        source: random() < 0.3 ? "override" : "shopify",
        sessionId,
        createdAt,
      };

      rawEvents.push({
        ...base,
        type: "served",
        clientId: `seed-${offset}-${n}-served`,
      });
      rawEvents.push({
        ...base,
        type: "impression",
        recoProductId: reco.id,
        clientId: `seed-${offset}-${n}-impression`,
      });

      if (random() < 0.35) {
        rawEvents.push({
          ...base,
          type: "click",
          recoProductId: reco.id,
          clientId: `seed-${offset}-${n}-click`,
        });
      }
      if (random() < 0.12) {
        rawEvents.push({
          ...base,
          type: "add_to_cart",
          recoProductId: reco.id,
          clientId: `seed-${offset}-${n}-atc`,
        });
      }
    }
  }

  await prisma.recommendationEvent.createMany({ data: rawEvents });

  const servedCount = Math.round(QUOTA * QUOTA_FILL);

  await prisma.usagePeriod.create({
    data: {
      shopId: shop.id,
      periodStart,
      periodEnd,
      quota: QUOTA,
      planAtStart: "standard",
      servedCount,
    },
  });

  console.log(`Seeded ${SHOP_DOMAIN}`);
  console.log(`  overrides:      3`);
  console.log(`  analytics rows: ${dailyRows.length} over ${DAYS} days`);
  console.log(`  raw events:     ${rawEvents.length} over 3 days`);
  console.log(
    `  usage:          ${servedCount}/${QUOTA} served (${Math.round(QUOTA_FILL * 100)}%)`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
