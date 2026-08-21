@AGENTS.md

# Easy Recommendation App

> Shopify app that lets merchants override, control, and measure product
> recommendations on the Product Detail Page (PDP) and in Checkout.

---

## 1. Product overview

**What it does**

1. Renders a product-recommendations widget on the PDP through a **theme app block**.
2. Renders a recommendations widget in **checkout / thank-you / order status** through a **checkout UI extension**.
3. Recommendations default to Shopify's own **Product Recommendations API**; merchants can
   create **manual overrides** per product that fully replace the Shopify list.
4. Every recommendation served, viewed, clicked, and converted is **tracked**, and surfaced as
   **analytics** in the embedded admin.
5. **Metered billing**: 3 plans with a monthly recommendation quota, with used/remaining shown in the admin.

**Admin surfaces**

| Route | Purpose |
| --- | --- |
| `/app` | Home — headline metrics, **offer list**, storefront status, quota meter, and the **Create offer** action |
| `/app/offers/new` | **Choose Offer Placement** — the step after **Create offer**. Five placement cards; only Product page is built |
| `/app/offers/new?type=PRODUCT_PAGE` | **New offer** builder on the same route: offer type, copy fields, product pickers, and a live preview that is a working carousel for the card-style offer types. Saves drafts, duplicates, deletes, and publishes to the storefront (§4 `Offer`) |
| `/app/offers/new?type=PRODUCT_PAGE&id=…` | The same builder, editing an existing offer |
| `/app/recommendations` | List of all products + their recommendation source, filters + search, override editor. Each row shows its complementary products as thumbnails and picks them inline (§5, Phase 5 deviations) |
| `/app/recommendations/$productId` | Override editor for a single product |
| `/app/analytics` | Deeper analytics (trend charts, per-product breakdown, funnel) |
| `/app/pricing` | 3 plans, current plan, upgrade/downgrade |
| `/app/settings` | Global widget defaults, checkout toggle, tracking options |

**Storefront / checkout surfaces**

| Extension | Type | Placement |
| --- | --- | --- |
| `recommendations` | Theme app block (`extensions/theme-extension`), shown as **Smart Recommendations** | **Product templates only** (`enabled_on`). One `source` setting: `custom` (per-product lists, billable) · `related` (Shopify's own recommendations, billable) · `complementary` (Shopify's own, `intent: complementary`, billable) |
| `product-showcase` | Theme app block, shown as **Product Showcase** | Any template. One `source` setting: `popular` (best sellers, collection optional) · `collection` (the picked collection) · `recently_viewed` (the shopper's own history). Owns the Collection picker. Free — no `served` beacon |
| `upsell` | Theme app block, shown as **Bought Together** | **Product templates only.** The product being viewed plus its recommendations, checkboxes, a running total, one multi-line add to cart. A cross-sell bundle, not an upsell — `upsell` is the internal key only (§7.4). Billable |
| `checkout-recommendations` | Checkout UI extension | `purchase.checkout.block.render`, `purchase.thank-you.block.render`, `customer-account.order-status.block.render` |
| `reco-pixel` | Web pixel extension (optional, Phase 12) | Purchase attribution |

---

## 2. Tech stack (already in the repo — do not change)

- **Framework**: React Router 7 (`@react-router/*`) with `flatRoutes()` file routing (`app/routes.js`)
- **Language**: **JavaScript + JSX** (not TypeScript). Match existing files.
- **Admin UI**: **Polaris web components** (`<s-page>`, `<s-section>`, `<s-button>`, `<s-table>`…) via
  `@shopify/shopify-app-react-router/react` `AppProvider`. **Do not** install `@shopify/polaris` React package.
- **Auth/session**: `@shopify/shopify-app-react-router` + `PrismaSessionStorage`
- **DB**: Prisma + SQLite (`prisma/schema.prisma`, `app/db.server.js`). Postgres for production.
- **Admin API**: GraphQL only, via `admin.graphql()` from `authenticate.admin(request)`
- **Tooling**: Use the [Shopify AI Toolkit](https://shopify.dev/docs/apps/build/ai-toolkit) skills
  (`shopify-admin`, `shopify-polaris-app-home`, `use-shopify-cli`) for all API/config work.

**API version**: `2026-07` everywhere — `ApiVersion.July26` in `app/shopify.server.js` and
`api_version = "2026-07"` in `shopify.app.toml`. This is the newest version the installed
`@shopify/shopify-api` exposes; bump both together when upgrading the package.

---

## 3. Architecture

### 3.1 Recommendation resolution order

```
PDP request                                    Checkout / admin
   │                                                │
   ├─ 1. Liquid reads metafield                     ├─ 1. Override row in Prisma, hydrated via
   │     app.reco_overrides ──► render (0 hops)     │     Storefront API  nodes(ids:)
   │                                                │
   └─ 2. no override ──► browser fetch              └─ 2. no override ──► Storefront API
         /recommendations/products.json                   productRecommendations(productId:, intent:)
         (Ajax API, no auth)                              (app/lib/recommendations.server.js)
```

**Two paths on purpose.** The PDP never waits on this app: Liquid renders overrides straight from
the metafield, and the browser falls back to Shopify's Ajax API. The server-side engine exists for
surfaces with no theme to do that — checkout extensions and the admin preview.

> ⚠️ **The Admin API has no `productRecommendations` query** (verified 2026-08-12 — the docs URL
> 404s). Shopify's recommendations are only reachable through the **Storefront API**, which is why
> the app delegates itself a storefront token (`unauthenticated_read_product_listings`) and stores
> it on `Shop.storefrontToken`. Minting is capped near 100 tokens per shop, so it happens once,
> lazily, from an admin request — the proxy only ever reads the stored value.

**Why a metafield mirror?** Prisma is the source of truth for the admin UI (filters, search,
analytics joins), but the storefront cannot read Prisma cheaply. Mirroring each override into an
app-owned, storefront-readable product metafield lets the Liquid block render server-side with
**zero** extra network hops. Every write to an override must sync the metafield (Phase 6).

Metafield shape (`$app:reco_overrides`, type `json`) — **`v: 2` since 2026-08-20**:

```json
{
  "v": 2,
  "updatedAt": "2026-08-12T10:00:00Z",
  "type": "cross_sell",
  "copy": {
    "title": "Complete the set",
    "badge": "Limited offer",
    "buttonText": "Add to cart",
    "countdown": true,
    "countdownMode": "fixed",
    "countdownMinutes": 60,
    "countdownTitle": "Hurry up! Offer expires in {{timer}}"
  },
  "items": [
    { "id": "12345678", "handle": "blue-snowboard" },
    { "id": "22345678", "handle": "wax-kit" }
  ]
}
```

`type` is the published offer's type, and like `copy` and `render` it is an **optional** v2 key rather
than a version bump — omitted for a list curated on the recommendations page, which has no offer
behind it. Only the app embed reads it (§7.6): a theme block's layout is a block setting, but the
embed has no block settings to read, so the type is the only thing that can say whether the injected
offer renders as a carousel of rows or a grid.

`copy` is what a published **Offer** says, and it is **omitted entirely** when there is none — a list
curated on the recommendations page produces the v1 shape plus a version bump. `reco-panel.liquid`
therefore does a plain nil check rather than a version test, which is why **every v1 metafield
written before offers existed keeps working with no backfill**. An offer's `title` beats the block's
`heading` setting and its `buttonText` beats `add_to_cart_label`; `badge` has no block setting to
fall back to, because a badge is something an offer says rather than a property of where the block
sits. Only the `custom` source reads any of this — the other sources never touch the metafield.

**The copy is denormalised onto `Override.presentation`**, not looked up from the Offer at sync time.
That row is what gets written, and `syncAllOverrides()` (the Settings repair action) iterates rows
with no offer in hand — reading the copy from the caller instead would make a repair silently blank
every merchant's wording. `type` rides along on the same row for the same reason, and
`normalizePresentation()` keeps it — it dropped every unknown field when the type was first added, so
the type reached the row's caller and went no further while every test stayed green.

> ⚠️ **`upsertOverride()` leaves `presentation` alone unless the caller passes it** (fixed
> 2026-08-21). It used to default to `null`, so every save from the recommendations page — a route
> that knows nothing about offers — silently stripped a published offer's title, badge, button text,
> anchor and type out of the metafield. The storefront lost the offer's wording and fell back to the
> grid, with nothing anywhere to say why. Now omitting the key preserves the stored value and only an
> explicit `null` clears it, which is what a publish whose offer has no copy does. Pinned by tests in
> `app/models/override.test.js`.

IDs *and* handles are stored: Liquid resolves products with `all_products[handle]`
(hard limit **20 lookups per page** — cap override lists at 12). IDs are strings, matching how
Prisma stores them, so nothing has to agree on number formatting.

**Only PDP-visible overrides are published.** The metafield is read by the theme block alone, so
`shouldPublishToStorefront()` writes it for enabled `pdp`/`both` overrides and *deletes* it for
checkout-only, disabled or empty ones — otherwise turning an override off would leave the old list
rendering on the product page.

### 3.2 Tracking pipeline

```
Storefront / Checkout
   │  navigator.sendBeacon (batched, ≤10 events)
   ▼
App Proxy  POST /apps/easy-reco/track     (authenticate.public.appProxy)
   ▼
RecommendationEvent  (raw, append-only)
   ▼
nightly / on-read rollup ──► AnalyticsDaily (shop × date × productId × type)
   ▼
Admin dashboard reads AnalyticsDaily only (never scans raw events)
```

One deliberate exception: `AnalyticsDaily` aggregates by *recommended* product, but the
recommendations list page asks "how did the widget on **this** product's page perform" — a *source*
product question. `getSourceProductMetrics()` answers it from raw events, bounded three ways: an
explicit id list (one page of the table), a date range, and the `(shopId, sourceProductId, type)`
index.

**Event types**: `served` · `impression` · `click` · `add_to_cart` · `purchase`

**Placements**: `pdp` · `related` · `complementary` · `upsell` · `checkout` · `thank_you` ·
`order_status` · `popular` · `collection` · `recently_viewed`. The last three are merchandising (§7.1), not
recommendation surfaces — they have no source product (sentinel `"*"`) and never emit `served`.
Keeping them in the list rather than coercing them to `pdp` is what stops a home-page row landing in
some product's recommendation metrics. `related` and `complementary` (§7.2) and `upsell` (§7.4) are the reverse case:
real recommendations that bill, each given its own placement because one product page can carry a
Custom row, a Related row, a Complementary row *and* an Upsell bundle, and the serve dedupe keys on
`(session, product, placement)` — sharing `pdp` would make all but one of them free.

The list is enforced in one place, `PLACEMENTS` in `app/models/event.server.js`. Anything absent
from it is coerced to `pdp` silently, so a new storefront placement must be added there in the same
change — `tests/theme-extension.test.js` asserts every `data-reco-placement` **any** block emits is
known to the server. `PLACEMENT_LABELS` in `app/routes/app.analytics.jsx` needs the same addition, or
the analytics breakdown shows a raw key.

**Attribution**: when a shopper adds to cart from a widget, attach cart line attributes
`_reco_src` (source product ID) and `_reco_cid` (client event ID). The `orders/create` webhook
reads them back and writes `purchase` events with revenue.

### 3.3 What counts against the quota

**1 recommendation = 1 `served` event** — one widget render that returned ≥1 product,
deduplicated per `(shop, sessionId, productId, placement)` within 30 minutes.
Impressions, clicks, and add-to-carts are **free** (they are analytics, not billable units).

> ⚠️ Assumption — confirm with the merchant/stakeholder before Phase 2 ships.
> The alternative (count each recommended product tile) would burn a 100/mo free plan in ~10 page views.

**Over quota**: the widget still renders using **Shopify's default** recommendations
(overrides disabled), tracking stops, and the admin shows an upgrade banner. Never hard-break the storefront.

**Where the count happens.** Both `proxy.recommendations` *and* `proxy.track` increment it, because
the two render paths do not share a request: an override rendered from the metafield never reaches
this app, and neither does the Ajax fallback. So `reco.js` emits a `served` beacon for every widget
that displayed products, and `track` counts it. `selectBillableServes()` deduplicates against stored
events *and* within the batch — a block that re-initialises can put two identical serves in one
beacon, and neither would find the other in the database yet. That in-batch check ignores whether a
session id came with the serve: the key is `(session, product, placement)`, and two serves agreeing
on all three are the same serve even when the session part is empty (fixed 2026-08-20 — it used to
skip the check entirely without one, so a re-initialising block billed once per copy).

> ⚠️ **`served` is the one event exempt from the app embed's tracking toggle.** It is not analytics,
> it is the meter, and on the theme path it is the only signal that ever reaches the app. Routing it
> through the same `if (!config().enabled) return` as impressions and clicks turned a checkbox
> labelled "Track recommendation performance" into unlimited free recommendations (fixed
> 2026-08-20). Anything added to `reco.js` that gates event sending has to make the same exception.

---

## 4. Data model (`prisma/schema.prisma`)

Keep the existing `Session` model untouched. Add:

```prisma
model Shop {
  id                String   @id @default(cuid())
  domain            String   @unique          // my-store.myshopify.com
  plan              String   @default("free") // free | standard | enterprise
  subscriptionId    String?                   // Shopify AppSubscription GID
  billingCycleStart DateTime?                 // anchor for the monthly window
  currencyCode      String?                   // cached for money formatting
  storefrontToken   String?                   // delegated Storefront API token (Phase 4)
  installedAt       DateTime @default(now())
  uninstalledAt     DateTime?
  settings          Json?                     // global widget defaults
  overrides         Override[]
  usage             UsagePeriod[]
  events            RecommendationEvent[]
  daily             AnalyticsDaily[]
}

model Override {
  id          String   @id @default(cuid())
  shopId      String
  shop        Shop     @relation(fields: [shopId], references: [id], onDelete: Cascade)
  productId   String                          // numeric Shopify product ID
  productTitle String
  productHandle String
  placement   String   @default("pdp")        // pdp | checkout | both
  enabled     Boolean  @default(true)
  items       Json                            // [{ id, handle, title, position }]
  syncedAt    DateTime?                       // last metafield sync
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@unique([shopId, productId, placement])
  @@index([shopId, enabled])
}

model UsagePeriod {
  id           String   @id @default(cuid())
  shopId       String
  shop         Shop     @relation(fields: [shopId], references: [id], onDelete: Cascade)
  periodStart  DateTime                       // first day of the billing month, UTC
  periodEnd    DateTime
  servedCount  Int      @default(0)
  quota        Int                            // snapshot of plan limit (-1 = unlimited)
  planAtStart  String

  @@unique([shopId, periodStart])
}

model RecommendationEvent {
  id           String   @id @default(cuid())
  shopId       String
  shop         Shop     @relation(fields: [shopId], references: [id], onDelete: Cascade)
  type         String                         // served|impression|click|add_to_cart|purchase
  sourceProductId String                      // the PDP/cart product
  recoProductId   String?                     // the recommended product (null for `served`)
  placement    String                         // pdp | checkout | thank_you | order_status
  source       String                         // shopify | override
  sessionId    String?
  clientId     String?  @unique               // idempotency key from the client
  orderId      String?
  revenue      Decimal?
  createdAt    DateTime @default(now())

  @@index([shopId, type, createdAt])
  @@index([shopId, recoProductId, type])
}

model AnalyticsDaily {
  id           String   @id @default(cuid())
  shopId       String
  shop         Shop     @relation(fields: [shopId], references: [id], onDelete: Cascade)
  date         DateTime                       // UTC midnight
  productId    String                         // recommended product
  placement    String
  served       Int      @default(0)
  impressions  Int      @default(0)
  clicks       Int      @default(0)
  addToCarts   Int      @default(0)
  purchases    Int      @default(0)
  revenue      Decimal  @default(0)

  @@unique([shopId, date, productId, placement])
  @@index([shopId, date])
}
```

Migration command: `npm run prisma -- migrate dev --name <name>` (never hand-edit migrations, and
see the wrapper note below for why this is not `npx prisma`).

**The datasource URL is `env("DATABASE_URL")`, not a literal** (changed 2026-08-20). It used to be
`url = "file:dev.sqlite"`, which meant the Docker image shipped a SQLite file *inside the container*
— recreated empty on every redeploy, taking every shop, override and event with it.

Only the **Prisma CLI** reads `.env`. Plain `node prisma/seed.js` does not, and neither does Vite's
dev server for server-side `process.env` — so `app/lib/database-url.server.js` resolves it, and both
`app/db.server.js` and `prisma/seed.js` call it before constructing a client:

| | Result |
| --- | --- |
| `DATABASE_URL` set | used as given |
| unset, `NODE_ENV != production` | `file:dev.sqlite` — relative paths resolve against `prisma/`, so byte-for-byte what the schema used to hardcode. A fresh clone runs `npm test` and `npm run seed` with no setup. |
| unset, `NODE_ENV == production` | **throws at boot**, naming the variable |

That last row is the entire point. Defaulting in production is what made the original bug invisible:
the app came up, wrote to a doomed file, and lost everything on the next deploy. The `Dockerfile`
deliberately sets **no** default for the same reason.

`vitest.config.js` pins the value anyway rather than relying on the fallback, so a test run can never
be steered at a real database by an inherited environment.

**The Prisma CLI is a separate process**, so the fallback above cannot reach it — it never loads
`app/db.server.js`, and it reads `.env` only if one exists. `shopify.web.toml` shells out to it twice
before the app boots (`predev` and `dev`), so making the datasource env-driven broke
`shopify app dev` outright: a clone with no `.env` died at `prisma generate` with P1012.

**Everything therefore goes through `scripts/prisma.js`**, which calls `resolveDatabaseUrl()` and
then spawns the CLI — `shopify.web.toml`, `npm run setup`, and `npm run prisma -- <args>` (use that
instead of `npx prisma`, e.g. `npm run prisma -- migrate dev --name x`). `app/lib/database-url.test.js`
asserts that no npm script and no line of `shopify.web.toml` invokes the CLI directly, because that
is the shape of the regression.

> ⚠️ **This does not make the app Postgres-ready.** Prisma requires `provider` to be a literal, so
> production also needs `provider = "postgresql"` here plus a regenerated migration history — and the
> test suite would need a running Postgres, since `fileParallelism` is off specifically for SQLite's
> write lock. Phase 15 still owns that. The in-memory rate limiter (`tracking.server.js`) and the
> in-memory recommendation LRU (`recommendations.server.js`) also make the app single-instance until
> they move to a shared store.

Seed the local database with `npm run seed` (re-runnable; clears its own shop first).
`SEED_QUOTA_FILL=0.85` / `=1` seeds the warning / over-quota states, `SEED_SHOP` sets the domain.

> ⚠️ **`npm run typecheck` does not look at this app's code.** `tsconfig.json` includes only
> `**/*.ts` and `**/*.tsx`, so every `.js` and `.jsx` file — which is all of them — is invisible to
> `tsc`. It passing says nothing.
>
> `npm run lint` *does* cover `.js`/`.jsx`: the React override matches
> `**/*.{js,jsx,ts,tsx}`, so `eslint:recommended`, `react`, `react-hooks` and `jsx-a11y` all run.
> Only the `import` plugin is scoped to the TypeScript override. (Corrected 2026-08-20; this note
> previously claimed neither tool checked anything.)
>
> `npm test` is still the check that actually exercises the app.

### Testing

Vitest, configured in `vitest.config.js` (separate from `vite.config.js`, which loads the
`reactRouter()` plugin). Tests sit next to the code as `app/**/*.test.js`.

```
npm test         # single run
npm run test:watch
```

> ⚠️ **Never put a test file in `app/routes/`.** `flatRoutes()` turns *every* file in that directory
> into a route, test files included — `app/routes/app.offers.new.test.js` became a live route at
> `/app/offers/new/test` and broke `npm run build`, which then tried to bundle vitest for the browser.
> `npm test` did not catch it: the file's own assertions passed. `app/routes.test.js` is safe because
> it sits at `app/`, not inside `app/routes/`; a test that reads a route's source belongs in `tests/`.
> `app/routes.test.js` now fails if any route file matches `.test.`/`.spec.`.

Integration tests run against the local `prisma/dev.sqlite` — the datasource URL is hardcoded in
`schema.prisma`, so there is no separate test database. Two rules follow from that:

- Every test file scopes its rows to its own `vitest-<name>.myshopify.com` shop and deletes them in
  `beforeEach`/`afterAll`. Cascades from `Shop` clean up children.
- `fileParallelism` is off — concurrent writers hit SQLite's database-level write lock.

Re-run `npm run seed` after a test run if you want the dev fixture back.

**Two suites live in `tests/` rather than beside the code, because their subject is the theme
extension:**

- `tests/theme-extension.test.js` reads the Liquid and the block schemas *as text and JSON*. It
  catches malformed schema JSON, out-of-bounds range defaults, the 25-character block `name` cap,
  missing translation keys, placeholder heading defaults, drift between the two duplicated settings
  arrays, and every `data-reco-placement` a block emits being one `PLACEMENTS` keeps. It executes
  nothing.
- `tests/reco-runtime.test.js` **runs `reco.js` in jsdom** (added 2026-08-20). It boots the real file
  into fixtures shaped like the panel's and the bundle's output, stubs `sendBeacon`, `fetch` and
  `IntersectionObserver`, and asserts on the beacons and the `/cart/add.js` bodies that come out:
  the serve/impression/click/add-to-cart funnel, the tracking-toggle exemption, batch draining,
  money formatting, the Ajax fallback, and the bundle's per-line attribution. Before it existed the
  most fragile file in the app — 1,000 lines running inside someone else's theme, carrying the
  billing signal — had no behavioural coverage at all, and four of the bugs fixed on 2026-08-20 were
  in it.

`jsdom` is a devDependency for that suite; the file opts in with `// @vitest-environment jsdom`.

---

## 5. Plans & billing

| Plan | Price | Monthly quota | Custom recommendations | Features |
| --- | --- | --- | --- | --- |
| **Free** | $0 | 100 recommendations | **10 products** | PDP widget, Shopify recommendations, basic analytics (7 days) |
| **Standard** | $29/mo | 1,000 recommendations | unlimited | + checkout widget, 90-day analytics, CSV export |
| **Enterprise** | $59/mo | Unlimited | unlimited | + full history, priority support |

Implementation: `billing` config in `app/shopify.server.js` using the
[Billing API](https://shopify.dev/docs/api/shopify-app-react-router/apis/billing).

```js
export const PLANS = {
  free:       { key: "free",       name: "Free",       price: 0,  quota: 100,  overrideLimit: 10 },
  standard:   { key: "standard",   name: "Standard",   price: 29, quota: 1000, overrideLimit: -1 },
  enterprise: { key: "enterprise", name: "Enterprise", price: 59, quota: -1,   overrideLimit: -1 },
};
```

**Free gets a real override allowance, not zero** (changed 2026-08-17). Overrides are the app's
whole point, so locking them away entirely gives a Free merchant nothing to evaluate. Ten products
is enough to prove the feature on a store's best sellers and small enough that a catalogue-wide
rollout needs a paid plan.

`overrideLimit` counts **products**, not rows: a product with a `pdp` row and a `checkout` row is
one against the allowance (`countOverriddenProducts()`, not `countOverrides()`). Editing or
disabling an existing override is never gated — only adding the (limit + 1)th product is — and
"Reset to Shopify defaults" is always allowed, since it is how a merchant at the limit frees a slot.

- Free plan needs **no** Shopify subscription — it is the local default.
- Paid plans: `billing.request({ plan, isTest: true, returnUrl })` → confirmation URL → redirect
  via App Bridge (`open(url, "_top")`, **not** a plain redirect, since the app is embedded).
- `app_subscriptions/update` webhook keeps `Shop.plan` and `subscriptionId` in sync.
- 14-day trial on paid plans (`trialDays: 14`) — decide in Phase 11.
- Alternative worth evaluating: **Shopify Managed Pricing** (plans configured in the Partner
  Dashboard, Shopify renders the pricing page). Rejected for now because the spec requires a
  custom in-app pricing page showing live quota usage.

---

## 6. App Proxy contract

`shopify.app.toml`:

```toml
[app_proxy]
url = "https://<app-url>/proxy"
subpath = "easy-reco"
prefix = "apps"
```

Storefront URL `https://shop.com/apps/easy-reco/<path>` → app route `app/routes/proxy.<path>.jsx`.
All handlers start with `await authenticate.public.appProxy(request)`.

| Method + path | Route file | Body / query | Response |
| --- | --- | --- | --- |
| `GET /apps/easy-reco/recommendations` | `proxy.recommendations.jsx` | `productId` (required), `limit`, `placement`, `intent`, `sessionId` | `{ source, items: [...] }`, plus `quotaExceeded: true` when over the limit |
| `POST /apps/easy-reco/track` | `proxy.track.jsx` | `{ events: [{ clientId, type, ... }] }` | `204` |

Rules:
- Always `application/json`, never throw a 500 at the storefront — degrade to `{ items: [] }`.
- `Cache-Control: no-store` on recommendations. A cached response never reaches this server, and the
  `served` count would silently drift below reality.
- Rate-limit `track` per shop; drop (don't error) on flood. The limiter is in-memory, so a
  multi-instance deployment gets the limit *per instance* — fine as flood protection, not billing.
- `clientId` gives idempotency — a duplicate beacon must not double-count.
- `track` answers `204` to almost everything, including malformed bodies. The caller is
  `sendBeacon`, which cannot read the response and will not retry, so an error status buys nothing.
- The response carries **no quota figures**. The contract originally exposed `quota: { used, limit }`,
  but the theme has no use for it and it is the merchant's commercial data on a public endpoint.

---

## 7. Theme app extension — the two storefront blocks

Directory: `extensions/theme-extension/` (already scaffolded; currently holds template demo files
`star_rating.liquid`, `app-embed.liquid`, `stars.liquid` — **delete these in Phase 0**).

```
extensions/theme-extension/
├── blocks/
│   ├── recommendations.liquid        # Smart Recommendations — custom + related,
│   │                                #   enabled_on: templates: ["product"]
│   ├── product-showcase.liquid      # Product Showcase — popular + collection +
│   │                                #   recently_viewed, any template (§7.1, §7.3)
│   ├── upsell.liquid                # Bought Together — product templates
│   │                                #   only (§7.4)
│   └── app-embed.liquid             # app embed: loads tracker JS site-wide
├── snippets/
│   ├── reco-panel.liquid            # block chrome, shared by the two card blocks
│   ├── reco-collection-cards.liquid # merchandising product loop, shared
│   ├── reco-card.liquid             # single product card
│   └── upsell-row.liquid            # single bundle line (§7.4)
├── assets/
│   ├── reco.js                      # fetch fallback + tracking beacons
│   └── reco.css
└── locales/en.default.json
```

**Two blocks, split on the one line that actually divides the five sources.** Custom and Related both
need a product, so their block declares `"enabled_on": { "templates": ["product"] }` and never offers
itself where it cannot work. Popular, Collection products and Recently viewed go on any template, so
a block carrying them could never declare that — and they are the three that own the Collection
picker, which has to be a real resource input and therefore cannot hide (§7.3).

Everything they share is genuinely shared, not copied: `snippets/reco-panel.liquid` holds the
wrapper, data-attributes, heading, track, slider nav, client-render template and theme-editor empty
state, branched on a `mode` parameter; `snippets/reco-collection-cards.liquid` holds the
merchandising product loop. **Only the `{% schema %}` JSON duplicates** — Liquid offers no way to
share one — and `tests/theme-extension.test.js` compares the two settings arrays id by id so they
cannot drift. Two settings differ on purpose and are listed in that test: `source`, and `limit`
(max 12 on the PDP block, where an override list is bounded by the `all_products` lookup cap; max 24
on the showcase block, which iterates `collection.products` directly).

### Block settings schema (all must be implemented)

| Setting | id | Type | Options / default |
| --- | --- | --- | --- |
| Heading | `heading` | text | "You may also like" |
| Layout | `layout` | select | `grid` (default) · `slider` · `list` |
| Products to show | `limit` | range 2–12 | 4 |
| Columns (desktop) | `columns_desktop` | range 2–6 | 4 |
| Columns (mobile) | `columns_mobile` | range 1–3 | 2 |
| Show product title | `show_title` | checkbox | true |
| Show price | `show_price` | checkbox | true |
| Show compare-at price | `show_compare_price` | checkbox | true |
| Show vendor | `show_vendor` | checkbox | false |
| Show rating | `show_rating` | checkbox | false |
| Show "Add to cart" | `show_add_to_cart` | checkbox | true |
| Add-to-cart label | `add_to_cart_label` | text | "Add to cart" |
| Add-to-cart behavior | `atc_behavior` | select | `ajax` (stay on page) · `redirect_cart` · `open_drawer` |
| Show quick view | `show_quick_view` | checkbox | false |
| Image ratio | `image_ratio` | select | `square` · `portrait` · `natural` |
| Hover second image | `hover_image` | checkbox | true |
| Card border | `show_border` | checkbox | false |
| Slider autoplay | `autoplay` | checkbox | false (slider only) |
| Autoplay speed (s) | `autoplay_speed` | range 2–10 | 4 |
| Heading size | `heading_size` | select | `sm` · `md` · `lg` |
| Text alignment | `text_align` | select | `left` · `center` |
| Accent color | `accent_color` | color | theme default |
| Button style | `button_style` | select | `solid` · `outline` · `text` |
| Top/bottom padding | `padding_top`, `padding_bottom` | range 0–100 | 32 |

Implementation notes:
- `{% schema %}` must include `"target": "section"` and `"available_if"` is **not** needed;
  use `"enabled_on": { "templates": ["product"] }` so it only appears on the PDP.
- Layout is pure CSS (`grid` / `flex + scroll-snap` / stacked) — **no JS carousel library**.
- Add to cart posts to `/cart/add.js` with `properties[_reco_src]` and `properties[_reco_cid]`,
  then dispatches the theme's cart-update event and fires an `add_to_cart` beacon.
- `reco.js` must be defer-loaded, framework-free, and namespaced (`window.EasyReco`).
- Impressions via `IntersectionObserver` at 50% visibility, fired once per card per page view.
- Respect `prefers-reduced-motion` for the slider.

### 7.1 Popular products source (`source: "popular"`, Product Showcase block)

Added 2026-08-13 as its own block; folded into a shared `source` select on 2026-08-18 (see 8.2 in
§13 — `blocks/popular-products.liquid` no longer exists), and since 8.6 it lives on **Product
Showcase** with the other two merchandising sources. Same look as the recommendation sources — it
renders through the same `reco-panel.liquid`, `reco-card.liquid`, `reco.css` and `reco.js` — but it
is **merchandising, not recommendation**, and the differences all follow from that:

| | Recommendations | Popular products |
| --- | --- | --- |
| Where it can go | `enabled_on: templates: ["product"]` | any template — home, collection, cart, page |
| Source of products | override metafield → Shopify Ajax API | a merchant-chosen collection, or the whole catalogue, in Liquid |
| Needs a source product | yes (`product.id`) | no (sentinel `"*"`) |
| Network at render | Ajax fallback when no override | none — fully server-rendered |
| `served` beacon | yes | **no** (`data-reco-serve="false"`) |
| Quota cost | 1 per render | 0 |
| Placement | `pdp` | `popular` |

**"Best selling" is the collection's own sort order.** Liquid exposes no sales figures, so the
merchant sets the collection to Best selling once under Products → Collections and every render
follows it — which is also why `popular` keeps an optional Collection picker: pointed at a
Best-selling collection it means best sellers, and left empty it follows whatever order Shopify gives
`collections.all`. The other `sort_by` options (`newest`, `price_asc`, `price_desc`, `title`) apply
Liquid's `sort` filter — which, without `{% paginate %}`, only sees the first 50 products. Said
plainly on the setting's `info` text rather than hidden.

**Why no `served` event.** A row on the home page renders on every visit; billing it as a
recommendation would burn a Free plan's 100/month in an afternoon (§3.3). It still reports
`impression` / `click` / `add_to_cart`, so the merchant gets engagement numbers for free. `reco.js`
reads `data-reco-serve` before firing the serve beacon; everything else is shared with the PDP block.

**Extra settings** beyond the recommendation block's: `collection`, `sort_by`, `exclude_current`
(skip the product being viewed, for when the block is placed on a PDP), `hide_sold_out`,
`background_color`.
The background is this block's alone — a merchandising row goes on any template and often wants to
be its own colour band, while the PDP block sits inside a product section that already has one. It
defaults to fully transparent and only applies (as `reco--has-background`, which also adds the
panel's inline padding) when the colour's `alpha > 0`; an opaque default would repaint every
already-placed block on the next deploy. `limit` goes to 24
rather than 12 — the `all_products` 20-lookup cap does not apply, since this iterates
`collection.products` directly.

When the collection is empty the block renders **nothing** on the storefront, and a dashed hint in
the theme editor only (`request.design_mode`).

### 7.2 Related and Complementary sources (`source: "related"` / `"complementary"`, Smart Recommendations block)

**Complementary was added 2026-08-20** and is Related with one word changed: it asks Shopify for
`intent: complementary` — products bought *with* this one — instead of `related`, products like it.
Everything else is identical, and **`reco.js` needed no new code path at all**: `fetchFallback`
already read `data-reco-intent`, so the source is a schema option, a Liquid branch and a placement
key. It bills for the §7.1 reason, on its own `complementary` placement for the §3.2 reason.

> ⚠️ **This app cannot write Shopify's complementary products, and never will be able to.** They live
> in `shopify--discovery--product_recommendation.complementary_products`, and `shopify--` is a
> Shopify-controlled reserved prefix — an app may only write metafields under its own `$app:` prefix
> ([ownership](https://shopify.dev/docs/apps/build/custom-data/ownership),
> [reserved prefixes](https://shopify.dev/docs/apps/build/custom-data/reserved-prefixes)). So no admin
> UI in this app can populate this source; that is why the merchant-curated equivalent is the **Custom**
> source over `$app:reco_overrides`, surfaced as "Complementary products" on the recommendations list
> (2026-08-20). Do not attempt a `metafieldsSet` against the `shopify--` namespace.

> ⚠️ **Complementary needs merchant setup before it returns anything.** Shopify builds `related` from
> order history, but `complementary` comes only from products a merchant has explicitly linked in the
> **Search & Discovery** app (Apps → Search & Discovery → Product → Complementary products, stored as
> `shopify--discovery--product_recommendation.complementary_products`). On a store that has never
> touched it, `/recommendations/products.json?intent=complementary` returns an empty list for every
> product — so the source works perfectly and shows nothing. That is why the theme editor now carries
> an explicit hint (`complementary.empty`) rather than letting `reco.js` hide the row: an empty row is
> the expected first-run state here, not a fault, and a vanished block reads as a broken feature.

This is what §12 Q2 had been asking about. It is a *source*, not the removed *Recommendation type*
picker and not a store-wide default in Settings: a global switch would make it impossible to run a
Related row and a Complementary row on the same product page, which is the main thing a merchant
would want it for. The picker stays deleted — a "Recommendation type: Related / Complementary" select
sitting next to a source already labelled "Related products" is the contradiction that removed it.

---

#### Related, in detail

Added 2026-08-19. Shopify's own product recommendations for the product being viewed, with **no
override consulted** — the `custom` source's fallback path, promoted to a source of its own.

**Why it exists when `custom` already falls back to it.** Two reasons. A merchant who never intends
to curate lists should not have to pick something called "Custom recommendations" to get Shopify's;
the label is the feature's discoverability. And a merchant who *does* curate can now run two rows on
one product page — their list, plus Shopify's — which the single `custom` source made impossible.

| | Custom | Related |
| --- | --- | --- |
| Reads the override metafield | yes | **no** |
| Server-rendered | when an override exists | never — always the Ajax API |
| Shopify intent asked for | `related` (fixed) | `related` (fixed) |
| `source` on events | `override` or `shopify` | always `shopify` |
| Placement | `pdp` | `related` |
| `served` beacon / quota | yes | yes |

**It bills.** It has a source product and answers "what goes with this", which is the line §7.1 draws
between recommendation and merchandising — the same line, not a new one. `custom` on a product with
no override already renders exactly this list and charges for it, so leaving `related` free would
have been a quota bypass that gutted the metering model rather than a discount.

**No `intent` picker on either source.** *Related products* set to *Complementary* is a
contradiction on screen, so this source never had one — and on 2026-08-19 the picker was removed from
Custom too, at the merchant's request. It had only ever governed Custom's fallback, and two adjacent
rows where one is labelled "Related products" and the other offers a *Recommendation type* of Related
or Complementary is a distinction that has to be explained to be understood.

`complementary` was already supported the whole way down — `proxy.recommendations` accepts an
`intent` query parameter and `getShopifyRecommendations()` passes it to the Storefront API — and as
of 2026-08-20 the theme chooses it again, as the third **source** rather than a picker beside the
other two. Custom and Related send `data-reco-intent="related"`; Complementary sends
`data-reco-intent="complementary"`. The distinction now lives in the source list, where the label
explains it, instead of in a select that had to be explained.

Everything else is shared: `reco.js` needs no new code path (`fetchFallback` already reads
`data-reco-intent` and `data-reco-source-product`), and the cards, tracking and add-to-cart wiring
are the same as every other source.

### 7.3 Collection products source (`source: "collection"`, Product Showcase block)

Added 2026-08-19. The merchant picks a collection and the block renders it. Merchandising, like
`popular`: any template, sentinel source product, no `served` beacon, placement `collection`.

**It shares `popular`'s machinery deliberately.** Same Liquid branch, same `sort_by` /
`exclude_current` / `hide_sold_out` settings, same Collection picker. One difference, and it is the
reason both exist: **an untouched picker means `collections.all` for `popular` and the store's first
collection for `collection`.** "Show my best sellers" has a sensible answer without a collection;
"show the collection I chose" does not, and answering it with the entire catalogue reads as a bug.
Neither renders empty, so a merchant who picks the source and touches nothing else still sees
products.

`collections` exposes no first/index accessor, so "first" is `for shop_collection in collections` +
`break`. Shopify documents neither the iteration order nor whether the catch-all `all` collection is
in the list, so the loop skips handle `all` — landing on it would make this source silently identical
to `popular`. The `collection.needs_collection` editor hint covers only the one case the fallback
cannot: a store with no collections at all.

> **The picker is not pre-filled — this is a render default.** Liquid cannot write a block setting,
> so choosing the source cannot populate the field; it stays visually empty until the merchant uses
> it, and the block renders the fallback meanwhile. `autofill: true` is the only mechanism Shopify
> offers here and it does something different: it binds a resource setting to a *dynamic source*
> (the parent section's resource, or the template's global one) at the moment the block is added. On
> a collection template that would point the picker at the collection being viewed — arguably an
> upgrade, but it applies to `popular` too and changes what an existing block renders, so it is
> deliberately not enabled.

> ⚠️ **The Collection picker is `"type": "collection"`, lives on the Product Showcase block, and is
> visible for all three of that block's sources. Settled 2026-08-19 after building every
> alternative — do not re-litigate.** Shopify offers no setting type that both browses collections
> only *and* accepts `visible_if`:
>
> | | browses collections only | can hide when unused |
> | --- | --- | --- |
> | `"type": "collection"` ← chosen | ✅ | ❌ rejected at deploy |
> | `"type": "url"` | ❌ also products / pages / blogs / policies | ✅ |
>
> `visible_if` on a *resource* input fails deploy with
> `settings: with id="collection" 'visible_if' is not a valid attribute`, enforced since July 2025
> and [intentional](https://community.shopify.dev/t/using-visible-if-to-show-hide-resource-inputs/20208):
> *"We don't allow conditional resource settings, this is an intentional limitation as it conflicts
> with `closest.<<resource>>`."* Not on the roadmap
> ([Shopify/cli#6206](https://github.com/Shopify/cli/issues/6206) is still open).
>
> **The `url` route was built and rejected on its picker.** It hides correctly, but its menu lists
> Collections, Products, Pages, Blogs, Blog posts, Policies and apps, and the docs give the `url`
> setting no attribute to filter that — only `type`, `id`, `label`, `default` and `info`. It also
> stores a link rather than a resource, so the handle had to be split back out and a wrong pick
> needed its own editor warning. A field that can hold the *wrong* answer is a worse defect than a
> field that is merely in the way.
>
> **What made the resource input affordable is the block split, not a change in the constraint.** On
> the old five-source block the picker sat inert under four of them. On Product Showcase, `popular`
> and `collection` both read it and only `recently_viewed` ignores it — one source out of three,
> which is the accepted cost. `popular` regained its optional collection narrowing precisely because
> the field is on screen there anyway; leaving it unread would have been the worse of the two.
>
> A third shape — Collection products alone in its own third block, so nothing anywhere sees an
> inert field — was built and reverted: three entries in the Add-block list was not wanted, and the
> chosen split is the one that also buys `enabled_on` for the recommendation block.
>
> `tests/theme-extension.test.js` pins every dead end: the showcase block's `collection` must be
> `"type": "collection"` with **no** `visible_if`, no `collection_url` may exist and no
> `/collections/` link parsing may reappear, the recommendation block must carry no collection field
> at all, and the two schemas must agree on everything they share.

---

### 7.4 Bought Together block (`blocks/upsell.liquid`)

Added 2026-08-19. The product being viewed plus a few recommended products, each on its own line with
a checkbox, a running total underneath, and one button that adds every ticked line in a single
`/cart/add.js` call.

> **Named for what it does, not the category it sits in.** It shipped as "Upsell" and was renamed the
> same day. This is a **cross-sell** bundle — complementary products bought alongside this one. A true
> upsell sells a *better version of the same thing*, and Shopify's recommendation API cannot supply
> that: `related` is not ranked by price or upgrade path (§7.2), so there is no "the better version of
> this" query. Building one would mean curating it in an override, filtering recommendations by price,
> or using the product's own variants — none of which this block does, so it must not claim the word.
>
> **"Bought Together", not "Frequently Bought Together".** A block schema `name` is capped at
> **25 characters** and Shopify fails the deploy rather than truncating —
> `Invalid tag 'schema': name: must have a maximum of 25 characters`. The full phrase is 26. The
> default *heading* carries it in full, where there is no cap.
> `tests/theme-extension.test.js` now checks the cap for every block, since nothing else in the suite
> read the name and the only other signal was a broken `shopify app dev`.
>
> `upsell` survives as the **internal identifier only**: the filename, the `upsell` placement key, the
> `.upsell__*` CSS prefix and the `data-upsell-*` attributes. It names the surface category, and a
> placement key has to stay stable once events are written against it. A test pins the merchant-facing
> name and requires the default heading to match it.

**Why it is a block and not a sixth `source`.** §7.3 settled the test for a split — a new block needs
a structural reason, not a cosmetic one — and this one clears it on markup. Every other source
renders `reco-card` tiles into a grid, slider or list; this renders a stacked list of rows with a
variant picker per line, a price total, and a multi-line cart add. None of `reco-panel`'s layout,
column, slider or per-card-button machinery applies. Like Custom and Related it needs a product, so
it also declares `"enabled_on": { "templates": ["product"] }`.

**It is not a sixth source either.** The list comes from exactly the Custom source's rule — the
`$app:reco_overrides` metafield when the merchant has curated one, Shopify's Ajax recommendations in
the browser when they have not. A merchant who curates a list for a product gets it in both the row
*and* the bundle without setting anything up twice.

| | Custom row (§7 / 7.2) | Upsell bundle |
| --- | --- | --- |
| Product list | override → Ajax fallback | **the same** |
| Markup | `reco-card` tiles via `reco-panel` | `upsell-row` lines, own footer |
| Add to cart | one button per card, one line | one button, every ticked line at once |
| Variant handling | single-variant only; others link to the PDP | **picker per line** |
| `click` signal | clicking the card | ticking the line (or its View link) |
| `served` / quota | yes | yes |
| Placement | `pdp` / `related` | `upsell` |

**It bills.** It has a source product and answers "what goes with this", which is the line §7.1 draws
between recommendation and merchandising. Its own placement, for the §3.2 reason: one product page
can carry a Custom row, a Related row and this bundle, and a shared placement would let the 30-minute
serve dedupe swallow two of the three.

**Where it differs from every other surface, and why:**

- **A variant picker per line, not a guess.** §7's rule elsewhere is that add-to-cart appears only for
  single-variant products, because "add the first variant" puts the wrong size in someone's cart. A
  bundle cannot do that — a line the shopper cannot buy fails the whole add — and skipping every
  multi-variant product would empty the block on most stores. So each line offers a `<select>` built
  from that product's **available** variants only. Sold-out products are dropped entirely.
- **The current product's variant is resolved at click time.** The theme owns the PDP variant picker
  and most themes record a change by rewriting `?variant=` without firing `popstate`, so a value read
  at render time goes stale the moment the shopper picks a different size. `currentVariantId()` reads
  the URL when the button is pressed. Best-effort, in the same sense as `open_drawer` (§9 Phase 8).
- **The "This item" line is never attributed to itself.** It carries no `data-reco-card`, so it emits
  no impression or click, and its cart line carries **no** `_reco_*` properties — otherwise the
  `orders/create` webhook would book the shopper's own product as a recommendation-driven sale.
- **One `add_to_cart` event per recommended line.** A three-product bundle reports three, not one,
  or every bundle would under-report as a single conversion.
- **Ticking a line reports `click`.** There is no per-card button to click here, so the tick is the
  engagement signal — once per row per page view, which keeps
  served → impression → click → add_to_cart intact. The View link fires the same event, deduped.
- **A bundle of one does not render.** If the fetch finds nothing to bundle with, the block removes
  itself rather than showing a lone "This item" row with a total, which is just a second add-to-cart
  button on the product page.

**The runtime lives in `reco.js`, not a second asset.** It needs the beacon queue, the session id and
the money formatter, and two assets would mean a load-order dependency between them for no gain. The
block carries `data-reco-block` so the shared tracking wiring applies, and `initUpsell()` marks it
`data-reco-ready` so the card-based loop skips it.

**Its labels ride on the block, not the app embed.** `data-upsell-add-one` / `-add-many` /
`-add-none` / `-total-label` are rendered from the locale file, with `[count]` substituted in JS. The
embed is optional, and a button that says nothing until someone enables it is a broken button.

> `limit` maxes at **5** recommended products, and its `info` says out loud that Shopify supplies at
> most 10 per product (§7.2). The fetch over-fetches by 4, capped at Shopify's 10, to leave room for
> the lines this block drops for having no sellable variant.

### 7.6 App embed rendering — the offer with no theme block

Added 2026-08-20. The merchant enables the app embed once and never opens the theme editor: a
published offer appears on its product pages on its own.

**What made this possible with no new plumbing.** The embed runs on *every* page, so on a product
template it can read that product's own `$app:reco_overrides` metafield — the same mirror the theme
block reads (§3.1). Nothing shop-level is needed for `PRODUCT_PAGE`.

> ⚠️ **The embed has to load `reco.js` itself.** The three blocks declare it through their schema
> `javascript` key, so on a product page with **no block** the script was never on the page and the
> offer the embed had just inlined had nothing to draw it — which looks exactly like the embed being
> broken, and was the first thing to go wrong with this path. The embed now emits
> `<script src="{{ 'reco.js' | asset_url }}" defer>` whenever it inlined an offer.
>
> That means a page carrying a block gets **two identical script tags and executes both**. So
> `reco.js` opens with a `window.EasyReco.loaded` guard and returns immediately on the second run.
> The DOM markers (`data-reco-ready`, `data-reco-embedded`) already stopped double *rendering*; they
> did not stop double *instrumenting* — two beacon queues, two sets of listeners. Anything new added
> at the top of that file goes below the guard.

`app-embed.liquid` resolves the list with `all_products` and inlines it as `window.EasyReco.offer`,
in the shape of Shopify's Ajax product JSON. Two consequences worth keeping: prices are formatted by
the shop's own rules in the shop's own currency, and **reco.js makes no request at all** — the offer
renders from markup already on the page. It also emits `reco.css`, which blocks normally emit for
themselves.

`initEmbeddedOffer()` in `reco.js` builds the container and injects it. The pieces that matter:

| | |
| --- | --- |
| Anchor | The offer's own CSS selector first, then a built-in chain (`.product-form__buttons`, the submit button, `.shopify-payment-button`, `product-form`, the cart form, then the info wrapper). A selector that matches nothing **falls through to the chain** — a theme rename should cost a worse position, not the offer |
| Visibility | Ancestors are walked for `display:none` / `visibility:hidden` / `[hidden]`, and `querySelectorAll` is used so a hidden duplicate earlier in the document does not consume the selector's turn. Themes ship duplicate buy forms for drawers and quick-add |
| Position | `before` / `after` the anchor, from the offer |
| A theme block wins | If any `[data-reco-block][data-reco-placement="pdp"]` is on the page, nothing is injected. The merchant placed it and said where they want it; rendering both would double the products *and* bill two serves for one page view (§3.3) |
| Idempotent | `data-reco-embedded` guards re-entry, so `shopify:section:load` cannot inject twice |
| Escaping | The title, badge and button text are merchant-authored and reach the page through `innerHTML`, so they go through `escapeHtml()` |

> ⚠️ **Not `offsetParent !== null` for the visibility check.** That is the usual shorthand and it is
> wrong here: it reports null for `position: fixed` elements, so a theme with a sticky add-to-cart bar
> would have its only anchor rejected. The ancestor walk needs no layout, gives the same answer for
> the case that matters, and is testable in jsdom — where `offsetParent` is always null.

**The injected offer is laid out by the offer's type** (2026-08-21). The admin preview shows a
cross-sell as a carousel — one product at a time, as a row — and the storefront rendered a grid of
tiles, so the preview was describing a block that did not exist. The type now travels in the
metafield (§3.1) and `buildBlock()` branches on it:

| | `cross_sell` · `product_add_on` | `frequently_bought_together` · `volume_discount` |
| --- | --- | --- |
| Classes | `reco--slider reco--offer` | `reco--grid` |
| Cards per view | 1 (`--reco-columns-*: 1`) | the grid's own columns |
| Card shape | row: image, title + price, button on the trailing edge | tile: image over text |
| Arrows | in the header beside the title | none |

- **It reuses the slider, it is not a second carousel.** `reco--slider` is what brings the scroll-snap
  CSS and makes `wire()` call `setupSlider()`; one card per view is just the column count set to 1,
  which the existing `flex-basis` calc resolves to 100%. `reco--offer` only turns each card into a row.
- **The arrows sit in the header**, via `.reco__nav--header` resetting the absolute positioning the
  block's slider uses. Overlaid arrows straddle the first and last card, which works for a row of
  tiles and would cover the image and the button on a single wide row. They start `hidden` and
  `setupSlider()` unhides them only when the track overflows, so a one-product offer shows no controls.
- **The arrow is an inline SVG, and it is bare in the header** (2026-08-21). It was the `‹` / `›` text
  glyph, which every theme font draws at a different weight, size and baseline — thin, small and
  sitting high in most of them. `chevron()` in `reco.js` and the copy in `reco-panel.liquid` draw the
  identical path, pinned together by a test, and `currentColor` lets the same icon sit on a white disc
  over photography and bare beside a heading. The disc exists to lift the arrow off product
  photography; next to a heading there is nothing to lift it off, so the header variant drops the
  border, background and shadow, and the button flex-centres the icon rather than trusting a font's
  line-height.
- **Their labels come from the embed's `strings`** (`recommendations.previous` / `.next`), because
  these arrows are built in JS and there is no block Liquid on the page to translate them. This is the
  one place §7.5's rule does not bite: the injected offer *is* the embed.
- **A missing `type` still carousels when there is `copy`.** Only an offer publish writes `copy`, and
  `cross_sell` is what an offer defaults to — without that fallback every already-published offer
  would keep the grid until someone happened to re-publish it. No copy and no type means a list
  curated on the recommendations page, which stays a grid.
- **`box-sizing: border-box` is now set on `.reco` and its descendants.** Most themes set it globally,
  but a card that is 100% wide *plus* its own padding and border overflows its own scroller in one
  that does not — and this block is injected into themes the app has never seen.
- **The card is matched to the admin preview, detail by detail** (2026-08-21). The preview is a promise
  about this markup, so the two are kept level: 72px thumbnail with an 8px radius, 1rem inset, 12px
  card radius, name at weight 600 with the price subdued under it, a `+` icon inside the add button,
  the heading one step down (`--sm`, since this sits in the buy area rather than heading a section),
  and a **"Product 1 of 2"** line under the card. The counter is `recommendations.count` with
  `[current]`/`[total]` substituted in JS — merchant-visible storefront copy belongs in the locale
  file, not in the runtime — and it is **emptied** rather than hidden when there is nothing to page
  through, so a one-product offer shows no counter at all. Only the offer carousel gets one; the
  block's slider shows several cards at once, where "product 1 of 6" describes nothing on screen.

> ⚠️ **The add button's confirmation state restores markup, not text.** `original` in `addToCart()`
> was `button.textContent`, so the 1800ms "Added" state threw the `+` icon away permanently on the
> first add. It is `innerHTML` now — a round-trip of the button's own markup. Anything else put inside
> a card button has the same trap waiting for it.

### 7.7 The offer countdown

Added 2026-08-21. The `countdown` boolean had reached the metafield since offers shipped and drew
nothing: a countdown needs something to count down *to*, and the model had no end time. It has one
now, in two shapes, and **`copy.countdown` is read before its settings** — a switched-off timer
publishes none of them.

| | `fixed` | `date` |
| --- | --- | --- |
| Deadline | now + `countdownMinutes`, per visitor | `countdownEndsAt`, one instant for everybody |
| Remembered | in `localStorage`, so a reload does not hand out a fresh hour | nothing to remember |
| When it runs out | offer hides for **24 hours**, then the cycle starts again | offer is over |
| Publish needs | nothing — minutes are clamped | the date; publishing without one is refused |

- **Why the 24-hour cycle.** A per-visitor timer on a page most people see once has to be able to
  come back, or the second visit shows an offer with a dead clock. `COUNTDOWN_HIDE_MS` is that
  window; after it, the stored deadline is thrown away and a new one starts.
- **The storage key carries the duration** (`easy-reco:countdown:<productId>:<minutes>`). A merchant
  who changes 60 minutes to 10 has changed the offer, and every shopper should get the new clock
  rather than the tail of the old one.
- **Expiry is checked before anything is injected or wired.** Rendering and then hiding would flash
  the offer, fire the `served` beacon and bill a recommendation nobody saw (§3.3). On the embed path
  `initEmbeddedOffer` returns early; on the block path the `init` loop hides the row and skips
  `wire()`.
- **Fixed / Custom end date is `CountdownModeToggle`**, built from `s-box` + two `s-clickable`s in a
  two-column `s-grid`: the selected half is `background="subdued"` against `transparent`, inside one
  bordered, rounded box with `overflow="hidden"` (without which the selected half's square background
  paints over the box's rounded corner). Polaris tokens throughout — no hardcoded colour, which is
  what keeps it native to the admin.

  > ⚠️ **Two dead ends before this, both pinned out by tests.**
  >
  > `s-button-group gap="none"` is what Polaris *documents* as the segmented control, and it rendered
  > an **empty box**: the group's props are `ActionSlots`, so plain children land in no slot and never
  > display. The validator was green, lint was green, all 527 tests were green — nothing any of them
  > reads can tell whether a slotted child is displayed. Only a screenshot caught it.
  >
  > Two `s-button`s in a grid then *did* render, and still read wrong: a button brings its own chrome,
  > so the selected half showed as a bordered white button and the other as bare text — one button
  > and one label, not one control. `s-clickable` is the primitive that takes a `background`, which is
  > why the control is built from boxes rather than buttons.

- **The date and time halves share a two-column grid**, not an inline stack. Polaris fields fill their
  container, so in a stack the select took the whole row and pushed the date button onto its own
  line. The `s-popover` sits *outside* the grid: an overlay is still a DOM child, and inside it would
  claim a third cell.

- **The fixed-length field carries no icon**, though the design shows a clock and `NumberFieldProps`
  reads as if it inherits `FieldDecorationProps`. The React wrapper omits it and the validator says so
  outright — *"Property 'icon' does not exist"*. `s-select` genuinely takes one, which is why the time
  half has its clock and this does not. Its label is hidden rather than dropped
  (`labelAccessibilityVisibility="exclusive"`), and the help line is the reference's own: *"The offer
  will disappear for 24 hours after the countdown ends"*.
- **A custom end date is one deadline in two pills**, side by side as a deadline reads. The pair holds
  one stored local `YYYY-MM-DDTHH:mm` string, split for rendering and reassembled on change.
  - The **date is a button** carrying the chosen date as its label (`Aug 22, 2026`), opening
    `s-date-picker` in an `s-popover`. Not `s-date-field`: that is full width and takes **no icon** —
    its props omit `FieldDecorationProps` entirely, so there is no supported way to put a calendar in
    it, and the design's control is a pill with one. Formatted from `new Date(\`${value}T12:00\`)`,
    local noon, because `new Date("2026-08-22")` is UTC midnight and lands on the previous day in any
    negative offset.
  - The **time is a matching pill** that opens `TimePicker` in its own popover: hour, minute and
    AM/PM as three columns, the selected cell `background="strong"`, the two scrolling ones in
    `s-scroll-box` — the only Polaris element that scrolls, since a box's `overflow` accepts nothing
    but `hidden` and `visible`. AM/PM gets no scroller: two items in one would leave an empty
    half-column beside the other two.

    It replaced an `s-select` of half-hour slots, for two reasons. A native menu beside a calendar
    made the two halves of one deadline behave differently, and half-hours could not say **6:04** at
    all — the picker is minute-precise.

  - **Stored 24-hour, shown 12-hour.** `readTime` / `writeTime` / `formatClockTime` /
    `formatDayLabel` are in `app/lib/countdown.js` and unit-tested there, so the pill's label and the
    picker's highlighted cells cannot disagree. Two traps they carry:
    - **`Number("")` is 0 and finite**, so a blank time read as *midnight* instead of the default —
      the same trap `clampCountdownMinutes` already had. Blank now falls back to `DEFAULT_END_TIME`,
      whose two halves the fallback is derived from so they cannot drift.
    - **The date label is parsed at local noon.** `new Date("2026-08-22")` is UTC midnight, which is
      the day *before* in any negative offset — a deadline reading a day early.
    - A date picked with no time means the **end of that day** (23:30), not that morning.
  - The select's label is hidden rather than absent (`labelAccessibilityVisibility="exclusive"`), and
    the date button's purpose lives in `accessibilityLabel` since its visible text is the date. The
    design shows no labels; a screen reader still needs both.
- **The clock steps up to days past 24 hours** — `5d 10:37:21`, not `130:37:21`, which is what a
  week-long countdown actually rendered on the storefront. Hours are padded from the days step on, so
  the tail keeps a fixed width while it counts down. The day letter comes from
  `recommendations.countdown_days` through the embed's config (fallback `"d"`, the kind of
  embed-only string §7.5 permits); the shared admin copy takes it as a `dayUnit` parameter.
- **`{{timer}}` is a token in the merchant's own sentence**, not a fixed prefix — so "Hurry up! Offer
  expires in 09:12" and "09:12 left on this offer" are both writable. Both halves are escaped; only
  the clock is markup of ours. **No token puts the clock after their sentence**, which is the only
  reading that still renders a timer.
- **Both storefront paths render it.** The embed builds the bar in `buildBlock`; `reco-panel.liquid`
  emits the same markup with the settings on `data-reco-countdown-*` attributes, because on that path
  there is no offer object in JS. One runtime drives both. Leaving it to the embed would have made an
  offer's countdown disappear the moment a merchant placed the block — the documented path.
- **The admin preview ticks.** It used to say "Countdown timer shows here on the storefront", which
  told a merchant nothing about their own wording. Fixed mode counts from the moment the preview
  mounts (a shopper's first view); date mode counts to the deadline, and one already passed says the
  offer would not show rather than freezing at 00:00.
- **An empty minutes field means "nothing given", not zero.** `Number("")` is 0 and finite, so the
  clamp turned a cleared box into a one-minute countdown. Guarded in `clampCountdownMinutes`, pinned
  by a test.

> ⚠️ **`app/lib/countdown.js` is client-safe, and that is not incidental.** The constants, the clamp
> and the formatter live there because the offer builder renders them **in a component**. Importing
> them from `app/models/offer.server.js` broke `npm run build` outright —
> *"Server-only module referenced by client"* — which neither lint nor `npm test` can see (§4). Any
> value the builder's JSX needs belongs in a plain lib, never in a `.server` module.
>
> `reco.js` carries its own copy of the formatter: the storefront runtime is a plain theme asset with
> no bundler and cannot import from `app/`. Both copies are pinned behaviourally against the same
> expected strings — `app/lib/countdown.test.js` runs one, `tests/reco-runtime.test.js` runs the
> other — and a test checks their defaults and the token still match. A drift means the preview
> promises a clock the shopper does not get.

`tests/reco-runtime.test.js` drives all of this in jsdom against a Dawn-shaped buy form: injection
position, the offer's copy, escaping, money format, the serve beacon, attributed add-to-cart, the
block-wins rule, re-entry, a merchant selector, `before`, a stale selector, an invalid selector, no
anchor at all, an empty offer, a hidden duplicate, and the carousel-vs-grid branch with its nav
markup and labels.

The anchor is set on the **Placement** tab of the offer builder and travels as `render` in the v2
metafield (§3.1).

---

### 7.5 The app embed is optional — so nothing may depend on it

Added 2026-08-20, after two bugs with the same root cause.

`blocks/app-embed.liquid` publishes `window.EasyReco.config` and records the recently-viewed
history. It is an *app embed*: the merchant enables it in Theme settings, and plenty never will.
Every block declares `reco.js` itself precisely so it works either way — which means **anything
`reco.js` needs in order to render correctly has to arrive on the block**, and the embed's copy is
at most a fallback.

| Needed by reco.js | Where it comes from | If the embed is off |
| --- | --- | --- |
| Money format | `data-reco-money-format` on the wrapper, embed as fallback | correct |
| Proxy path | embed only | falls back to `/apps/easy-reco`, the real subpath |
| Tracking on/off | embed only | tracking on, which is the default anyway |
| Upsell button labels | `data-upsell-add-*` on the block | correct |
| Card strings (Sold out, Choose options) | embed only | English defaults in `reco.js` |
| The injected offer (§7.6) | embed only | **nothing renders** — this path *is* the embed |

> The last row is the one exception to this section's rule, and it is not a violation of it: an offer
> injected by the embed is a feature *of* the embed, not something a block needs from it. A merchant
> who never enables the embed still gets everything the theme blocks render.

**The money format is the one that actually broke.** It came from the embed alone, with a hardcoded
`"${{amount}}"` fallback, so a store selling in EUR that never enabled the embed rendered `$` on
every price `reco.js` drew. In the Bought Together block it was worse than wrong, it was
inconsistent: Liquid formatted the row prices with `| money` and only the running total underneath
came from JS, so one block showed two currencies. Both copies now go through `strip_html` — some
stores still hold a `<span class="money">` wrapper in `shop.money_format`, and that would land in
`textContent` as literal tags.

The remaining embed-only values are all *strings or defaults* whose fallback is merely suboptimal,
never wrong. A number or a currency must never be in that column.

---

## 8. Checkout UI extension

Directory: `extensions/checkout-recommendations/`

- Targets: `purchase.checkout.block.render` (⚠️ **Shopify Plus only**),
  `purchase.thank-you.block.render` and `customer-account.order-status.block.render` (all plans).
- Build all three; the merchant places them in the checkout editor.
- Data: `fetch` the app proxy `recommendations` endpoint (requires
  `[extensions.capabilities] network_access = true` in the extension toml).
- Source product = first line item in the cart (or highest-value line).
- Add to cart uses `useApplyCartLinesChange()` — **not** `/cart/add.js`.
- Settings exposed via the extension's `settings` schema: heading, max products, show price, show image.
- Gate behind the **Standard** plan (return `null` on Free).

---

## 9. Step-by-step implementation plan

Each phase is independently shippable. Run `npm test` + `npm run lint` + `npm run typecheck` before
marking done.

### Phase 0 — Project setup & cleanup
1. Rename the app: `name = "easy-recommendation-app"` in `shopify.app.toml`, `package.json` `name`.
2. Align API version: set `ApiVersion` in `app/shopify.server.js` and `[webhooks] api_version` to the same value.
3. Update `[access_scopes] scopes` to `read_products,write_products,read_orders,read_customer_events`
   (Phase 4 adds `unauthenticated_read_product_listings` for the Storefront API).
4. Delete template demo artifacts: `product.metafields.app.demo_info`, `product.metafields.app.internal_sku`,
   `metaobjects.app.example`, `metaobjects.app.author` from the toml; delete
   `extensions/theme-extension/blocks/star_rating.liquid`, `blocks/app-embed.liquid`,
   `snippets/stars.liquid`, `assets/thumbs-up.png`.
5. Delete demo routes `app/routes/app.additional.jsx`, `app/routes/app.nayem.jsx` and their nav links.
6. Add `[app_proxy]` config (Section 6).
7. Declare the `$app:reco_overrides` product metafield with
   `type = "json"`, `access.admin = "merchant_read"`, `access.storefront = "public_read"`.
8. `npm run deploy` to push the config; verify in the Partner Dashboard.

### Phase 1 — Data model
1. Add the models from Section 4 to `prisma/schema.prisma`.
2. `npm run prisma -- migrate dev --name add_recommendation_models`.
3. Create `app/models/` with one file per entity: `shop.server.js`, `override.server.js`,
   `usage.server.js`, `event.server.js`, `analytics.server.js`. **All Prisma access lives here** —
   routes never import `db.server.js` directly.
4. Seed script `prisma/seed.js` for local dev data.

### Phase 2 — Shop bootstrap, plan & quota service
1. `app/models/shop.server.js` → `ensureShop(shopDomain)` — upsert on every authenticated load.
2. `app/lib/plans.js` → the `PLANS` map from Section 5.
3. `app/models/usage.server.js`:
   - `getCurrentPeriod(shopId)` — find-or-create the `UsagePeriod` for the current billing month.
   - `getQuotaStatus(shopId)` → `{ plan, used, limit, remaining, percentUsed, isOver, resetsAt }`.
   - `incrementServed(shopId, n)` — atomic `update … { increment }`.
   - `canServe(shopId)` — false when `used >= limit` (limit `-1` = always true).
4. Rollover: when `now > periodEnd`, create the next period rather than mutating the old one.
5. Unit-test the month boundary and the unlimited case.

### Phase 3 — Admin shell
1. Rewrite `app/routes/app.jsx` nav:
   Home · Recommendations · Analytics · Pricing · Settings.
2. Root `app/app.jsx` loader calls `ensureShop` and returns `quotaStatus` for the shared banner.
3. Build `app/components/QuotaBanner.jsx` — critical banner at ≥100%, warning at ≥80%.
4. Build shared UI in `app/components/`: `StatCard.jsx`, `EmptyState.jsx`, `ProductThumb.jsx`.
   All with Polaris web components.

### Phase 4 — Recommendation engine (server)
1. `app/lib/recommendations.server.js`:
   - `getShopifyRecommendations({ shop, productId, intent, limit })` — Storefront API
     `productRecommendations`. **Not** the Admin API, which has no such query.
   - `resolveRecommendations({ shopId, productId, placement, limit })` —
     override first, Shopify fallback, returns `{ source: "override"|"shopify", items }`.
2. Normalize the product shape once: `{ id, gid, handle, title, image, price, compareAtPrice, available, url }`.
3. In-memory LRU cache (60s TTL) keyed by `shop:product:intent:limit`.

### Phase 5 — Recommendations admin page
1. `app/routes/app.recommendations.jsx`:
   - Loader: paginated product list from Admin GraphQL (cursor-based, 25/page), left-joined with
     `Override` rows to show **Source: Shopify / Custom**.
   - Search by product title (GraphQL `query:` param, debounced 300ms).
   - Filters: source (all/shopify/custom) only. Status and placement were removed — see the
     deviations below.
   - Sort: none — fixed to most-recent-first. See the deviations below.
   - `<s-table>` columns: Product · Complementary products · Source · Actions. The metric columns
     (# recommendations, Impressions, Clicks, CTR) were all removed on 2026-08-20 — see the
     deviations below.
   - Bulk actions: reset to Shopify defaults, disable overrides.
2. `app/routes/app.recommendations.$productId.jsx`:
   - Shows the current Shopify-generated list as a starting point.
   - Product picker via App Bridge `shopify.resourcePicker({ type: "product", multiple: 12 })`.
   - Drag-to-reorder the chosen products (HTML5 DnD, no library).
   - Per-product placement selector (PDP / checkout / both), enable toggle.
   - Save → `upsertOverride()` → triggers the metafield sync (Phase 6).
   - "Reset to Shopify defaults" deletes the override *and* the metafield.
3. Cap override creation at the plan's `overrideLimit` (§5) — Free stops at 10 products and both
   pages show the allowance used, with an upgrade CTA when it runs out.

**Deviations made while building (2026-08-12):**
- **Two list modes, not one.** Shopify pages the catalogue, and it has no idea which products carry
  overrides. *Catalogue mode* (default) uses Shopify cursor paging with Shopify sort keys; *Custom
  only* mode is driven by the `Override` table and pages it directly.
- **No metrics on this page at all** (2026-08-20). Clicks and CTR went first, then Recommendations
  and Impressions — this page manages *which products go together*, and `/app/analytics` reports how
  they performed. Removing the columns also removed the machinery behind them: the metric sorts
  ("Most recommendations", "Most clicks"), the `METRIC_SORT_CAP` fallback and its warning banner, and
  a `getSourceProductMetrics()` aggregation over raw events on every page load. Those sorts ranked by
  numbers the page no longer displayed, which is worse than not offering them.
- **No Apply button** (2026-08-20). Source applies on change and the search box is debounced at
  300ms, so Apply only ever short-circuited that wait — a button whose sole purpose was to beat a
  delay the merchant cannot perceive. Removing it also removed the `searchRef`, which existed only so
  the button could read the field's current value.
- **The controls are Search and Source, nothing else** (2026-08-20). Placement and Status were
  removed along with Sort and the metric columns. Both only ever appeared in *Custom only* mode, and
  both filtered on fields this page no longer displays — a merchant could hide rows by a placement or
  an enabled flag they could not see, which reads as rows going missing. `listOverrides()` still takes
  `placement` and `enabled`; the route just stops passing them, and a stale `?placement=`/`?status=`
  in a bookmarked URL is ignored. Both fields are still edited in the override editor, which is where
  they are visible.
- **No Sort control; ordering is fixed to most-recent-first** (2026-08-20). The page went through
  three rounds of sort options that each outlived their reason — the metric sorts ranked by numbers
  the table stopped showing, and the title sorts that replaced them existed only so the control would
  not be left with a single option — so the control went too. Recent-first is what curating lists
  actually wants: the product just edited sits at the top. Catalogue mode passes Shopify's
  `UPDATED_AT` sort key; custom mode orders the `Override` table by its own `updatedAt`, which is when
  the *merchant* last edited the list rather than when Shopify last touched the product. A stale
  `?sort=` in a bookmarked URL is ignored rather than honoured. `SORT_KEYS` / `DEFAULT_SORT` stay in
  `products.server.js` — the override editor's product search still uses them.
- **Complementary products are picked inline** (2026-08-20). Each row shows its list as thumbnails
  and opens the App Bridge picker in place; the editor route still owns placement, the enable toggle,
  reordering and the Shopify-defaults preview. See the progress row for 8.9 and the reserved-prefix
  warning in §7.2 — this is the app's own list, not Shopify's complementary metafield.
- **"Shopify defaults only" can return a short page.** The exclusion happens after Shopify has
  already paged, so a 25-row page minus 3 overridden products shows 22.
- **Reorder is up/down buttons, not HTML5 drag-and-drop.** Dragging rows inside `<s-table>` is
  fiddly and inaccessible; buttons work with a keyboard and need no library.
- **Bulk actions are not built.** Per-row edit and reset only — deferred.
- **Two ways to choose products, not one** (added 2026-08-17). Alongside the App Bridge resource
  picker, the editor has an "Add products by search" section: `intent: "search"` on the route's
  action runs `listProducts()` and each result gets an Add button. The picker is admin-hosted, so
  when it fails to open there is nothing the app can do about it and no other way to build a list —
  search needs only the Admin API. `openPicker` also catches its own failures now and shows them in
  a banner instead of leaving an unhandled rejection in the console.
- `app/lib/entitlements.js` was created here rather than in Phase 11, because the plan gate is
  needed now. Phase 11 extends it.
- Saving writes to Prisma only. **The storefront still shows Shopify's list until Phase 6 mirrors
  overrides into the metafield** — the save path carries `TODO(Phase 6)` markers.

### Phase 6 — Metafield sync
1. `app/lib/metafields.server.js`:
   - `syncOverrideMetafield(admin, override)` → `metafieldsSet` with `$app:reco_overrides`.
   - `deleteOverrideMetafield(admin, productId)` → `metafieldsDelete`.
2. Call on every override write; store `syncedAt`.
3. `syncAllOverrides(shopId)` repair action on the Settings page for drift.
4. Batch with `metafieldsSet` (25 per call) for bulk operations.

### Phase 7 — App proxy API
1. `app/routes/proxy.recommendations.jsx` — GET; `canServe()` check; on over-quota return
   Shopify defaults with `{ quotaExceeded: true }`; on success `incrementServed(1)` + write a
   `served` event.
2. `app/routes/proxy.track.jsx` — POST; validate + cap the batch at 10; upsert by `clientId`;
   return `204`.
3. Shared validation in `app/lib/tracking.server.js` (allowed types, ID coercion, session dedupe).
4. Test with `curl` against the dev tunnel before wiring the storefront.

### Phase 8 — Theme app block (PDP)
1. Create `blocks/recommendations.liquid` with the full settings schema from Section 7.
2. Server-render from `product.metafields["$app"].reco_overrides` when present
   (**not** `metafields.app.…` — that looks for a literal namespace named `app`, resolves to
   nil, and drops every override to the Ajax fallback without an error)
   (`all_products[handle]` lookups, capped at 12).
3. `assets/reco.js` handles: Shopify Ajax fallback fetch, IntersectionObserver impressions,
   click beacons, add-to-cart with `_reco_src` / `_reco_cid` line properties, slider scroll-snap nav.
4. `assets/reco.css` — grid / slider / list layouts, all settings mapped to CSS custom properties
   set inline on the block wrapper.
5. `blocks/app-embed.liquid` — app embed that injects `window.EasyReco.config` (shop, proxy path,
   plan flags) and loads `reco.js` once.
6. `locales/en.default.json` for every merchant-facing string.
7. Test on Dawn: grid, slider, list, add-to-cart, mobile, over-quota, no-recommendations.

**Deviations made while building (2026-08-12):**
- **`show_quick_view` was dropped.** A quick-view modal needs variant selection and theme-specific
  cart wiring; shipping a setting that renders something janky is worse than not offering it.
  Add-to-cart covers the same intent — see below.
- **Add to cart only appears for single-variant products.** "Add the first variant" is a guess, and
  guessing wrong puts the wrong size in someone's cart. Multi-variant products get a
  "Choose options" link to the PDP, which is what Dawn does. Applies to both render paths.
- **`open_drawer` is best-effort.** There is no cross-theme API for opening a cart drawer. The block
  fires `cart:refresh` / `cart:updated` and calls `open()` on a Dawn-style `<cart-drawer>` if one
  exists; otherwise the shopper gets the events and the button's "Added" state.
- **Slider is CSS scroll-snap, no carousel library.** Swipeable, keyboard scrollable, and degrades
  to a plain scroller if the script never loads. Autoplay stops permanently on first interaction and
  is skipped entirely under `prefers-reduced-motion`.
- **`show_rating` reads `product.metafields.reviews.rating`** — the convention most review apps
  write. Renders nothing when unset rather than inventing stars.
- **The block works without the app embed**, which is optional. The schema declares
  `"javascript": "reco.js"` and the CSS is emitted inline by `reco-panel.liquid` /
  `upsell.liquid` as `{{ 'reco.css' | asset_url | stylesheet_tag }}` — so a page carrying three
  blocks emits three identical `<link>` tags, which browsers dedupe. (The schema does *not* declare
  `stylesheet`; this note used to claim it did.)
- **Anything `reco.js` needs must ride on the block, not the embed.** The embed only publishes
  `window.EasyReco.config`, and `reco.js` reads it at call time so the two can load in either order
   — but a merchant who never enables it must still get correct output. Two bugs came from
  forgetting that, both fixed 2026-08-20: prices were formatted with a hardcoded `"${{amount}}"`
  (now `data-reco-money-format` on the wrapper, §7.5), and the embed's tracking checkbox could
  suppress the `served` beacon (§3.3).

### Phase 9 — Analytics pipeline
1. `app/models/analytics.server.js`:
   - `rollupEvents(shopId, date)` — aggregate raw events into `AnalyticsDaily` (idempotent upsert).
   - `getDashboardMetrics(shopId, range)` — totals, deltas vs previous period, sparkline series.
   - `getTopRecommendedProducts(shopId, range, limit)` — ordered by served, with CTR + revenue.
   - `getFunnel(shopId, range)` — served → impression → click → ATC → purchase.
2. Trigger the rollup lazily on dashboard load for any un-rolled day, plus a `/cron/rollup` route
   protected by a shared secret.
3. Retention: delete raw `RecommendationEvent` rows older than 90 days (30 on Free).
4. `orders/create` webhook → read `_reco_src` / `_reco_cid` line properties → `purchase` events + revenue.

**Notes from building it (2026-08-12):**
- **`served` has no recommended product**, so it is booked against the sentinel `productId = "*"`
  (`WIDGET_TOTAL`). Product-level queries exclude it; totals include it, which is what makes `served`
  add up. `productId` is not nullable because SQLite treats NULLs as distinct in a unique index,
  which would break the `(shop, date, product, placement)` key.
- Consequently **`getTopProducts` ranks by impressions**, not `served` — every real product row has
  `served = 0`.
- **The rollup is destructive by design** (clear-then-rebuild, so re-running is idempotent). That
  makes it dangerous for days whose raw events have been pruned: rebuilding would replace real
  history with zeroes. `rollupRange` refuses days older than `maxAgeDays`, which the cron passes from
  `rawEventRetentionDays(plan)`.
- A third line property, `_reco_source`, was added so purchases record whether the sale came from an
  override or Shopify's list, rather than the webhook guessing.
- `POST /cron/rollup` needs `CRON_SECRET`; without it the route returns 503 rather than running
  unauthenticated.

> ⛔ **Revenue attribution is switched off in config.** `orders/create` carries protected customer
> data, and Shopify refuses the entire dev preview while an unapproved app declares it:
> *"This app is not approved to subscribe to webhook topics containing protected customer data."*
> The subscription is commented out in `shopify.app.toml`, and `read_orders` /
> `read_customer_events` are withheld from `scopes` for the same reason.
>
> The handler, the mapper and their tests are all written and passing — only the config is disabled.
> To turn it on: Partner Dashboard → App setup → **Protected customer data access**, request
> Level 2 (order data), then uncomment the subscription and restore the two scopes. Everything else
> in the app works without it; only `purchase` events and attributed revenue are missing.

### Phase 10 — Home dashboard
1. Rewrite `app/routes/app._index.jsx`.
2. Widget row (`StatCard`): **Total recommendations** · **Impressions** · **Clicks (CTR)** ·
   **Add to carts** · **Attributed revenue** — each with a period-over-period delta.
3. **Quota widget**: used / limit, remaining, progress bar, reset date, upgrade CTA.
4. **Top recommended products** table: thumbnail, title, served, clicks, CTR, revenue (top 10).
5. ~~**Trend chart**: 30-day served vs clicks~~ — **removed from Home on 2026-08-20.** The
   `TrendChart` component stays and is still used on `/app/analytics`, which is where trends belong;
   Home keeps the stat cards, storefront status, the quota meter and the onboarding checklist. The
   loader still builds `metrics.series` — `lastServedDay` is derived from it.
6. Date range selector: 7 / 30 / 90 days (90 gated to paid plans).
7. Onboarding checklist for a brand-new install: enable app embed → add block to PDP →
   create your first override.
8. **Create offer** button (2026-08-20), right-aligned at the top of the content column, linking to
   `/app/offers/new`. Deliberately never disabled: the product allowance limits *new* offers and the
   list page enforces it there, whereas greying this out would also stop a merchant at the limit from
   editing offers they already have.

   > ⚠️ **Not `<s-page slot="primary-action">`.** In an embedded app that slot hoists the button out of
   > the app frame and into the Shopify admin's own top bar, beside the "..." menu — visually detached
   > from the content it acts on. It was built that way first and moved the same day. The same goes
   > for `secondary-actions` and `breadcrumb-actions`; put page actions in the content column unless
   > the intent really is to occupy Shopify's chrome.

9. **`/app/offers/new` — "Choose placement type"** (2026-08-20): `app.offers.new.jsx` plus
   `components/PlacementThumb.jsx` for the wireframe diagrams (inline SVG in `currentColor`, so one
   file covers both admin themes and there are no image assets to keep in step; a test asserts no
   diagram hardcodes a colour).

   **Five cards, fixed by design**: Product page · Cart page *(Essential plan)* · Pop-up ·
   Post purchase page · Suggest new placement type. A sixth, **Checkout nudge**, was built and
   removed on request — it was the only card with an overflow (`···`) control and the only diagram
   using a literal colour, so both went with it.

   > ⚠️ **Only Product page is built.** The other four are surfaces this app does not have — Cart page,
   > Pop-up and Post purchase are unbuilt, and Suggest has no inbox to post to — and the
   > "Essential plan" badge names a tier that does not exist here (the plans are
   > Free / Standard / Enterprise, §5). A first pass adapted the cards to what the app really offers
   > and was reverted: the cards and their copy are the specified design, so they stay.
   >
   > **What they must not do is navigate.** Pressing an unbuilt card names the placement and what it
   > is waiting on, in a notice above the grid, and offers the product page instead. A route whose
   > only job is to say "not implemented" is worse than a button that says so where it stands.
   > `tests/placement-picker.test.js` pins the five titles, their button labels, the single plan badge,
   > that Product page is the only card with an `href`, and that every unbuilt card carries an
   > explanation. When a placement ships, flip `available: true` and give it an `href` — and
   > `app/routes.test.js` starts checking that href resolves.

   Only the plan's product allowance can stop the flow before it starts, so the loader answers it up
   front rather than after a placement has been chosen.

   **`?type=` selects the second screen on the same route.** `/app/offers/new` is the picker;
   `/app/offers/new?type=PRODUCT_PAGE` is the **New offer** builder — offer type radios, the internal
   name field, Title / Badge / Button text, a countdown toggle, four tabs (Content · Offer · Design ·
   Placement) and a live preview that follows the copy fields as they are typed. A query parameter
   rather than a path segment because the placement is a *choice within* creating an offer, not a
   different resource: the back arrow and the eventual save belong to one flow. An unknown or unbuilt
   `type` falls back to the picker rather than erroring — the value comes from a URL a merchant can
   edit or bookmark, and only types in `BUILDABLE` open the editor.

   **The builder saves and publishes** (2026-08-20). `Offer` in `prisma/schema.prisma`,
   `app/models/offer.server.js` for persistence and `app/lib/offers.server.js` for the side effects.

   **An Offer sits above Override, it does not replace it.** Publishing projects the offer onto the
   existing pipeline — one `Override` row per target product, then a metafield sync each — so the
   whole Phase 6/8 storefront path is reused unchanged and **the theme block has no idea offers
   exist**; it just finds a list in `$app:reco_overrides`. Unpublishing removes exactly what it wrote,
   metafield included, because a stale metafield keeps the old list rendering (§3.1).

   Rules worth not breaking, each pinned by a test:

   - **A draft is validated more loosely than a publish.** `validateOffer` wants a name, placement and
     type; `validateForPublish` also wants targets, items and a title. A merchant who has picked
     products but not written a title must not lose the products. **A live offer is validated as a
     publish**, because saving it is one.
   - **Saving a live offer republishes it** (2026-08-21). This was the sharpest bug in the flow:
     editing a published offer wrote the `Offer` row, said **"Draft saved — nothing is live yet"**, and
     changed nothing on the product page, because the theme reads only the `Override` rows and their
     metafields. The merchant's own fix was Unpublish then Publish, which is not a workflow, it is a
     workaround for a lie. Now the action reads the row's status *before* the write and a save on a
     `published` offer falls through to `publishOffer()` — same allowance gate, same per-product error
     reporting — and the banner reads **"Changes are live"**.
   - **A re-publish is subtractive as well as additive.** `publishOffer({ previousTargets })` deletes
     the Override row and metafield for every product the offer no longer targets. Without that, a
     product dropped from a live offer kept rendering it with nothing in the admin still claiming it
     did — and no way left to take it down short of the Settings re-sync.
   - **The countdown is four more columns on `Offer`** (`countdownMode`, `countdownMinutes`,
     `countdownEndsAt`, `countdownTitle`, migration `offer_countdown`) and four more keys in the
     metafield's `copy`. What they mean is §7.7; what matters here is that publishing a `date`-mode
     countdown with no date is **refused**, because the storefront would render no timer and hide the
     offer instead — the worst of both.
   - **A save can still never publish a draft.** Only an offer that is *already* live republishes on
     save; `saveOffer()` itself never touches `status`, so going live is always a deliberate press of
     Publish.
   - **One failing product does not take the publish down.** A metafield write fails per product (a
     deleted product, a throttled shop); each failure is reported, `syncedAt` is left null for the
     Settings repair action, and the offer is still `published` if *any* product went live — calling
     it a draft would say nothing is showing when something is.
   - **The product allowance is enforced server-side**, counting only targets no published offer
     already occupies — the §5 per-product rule. Unpublishing is never gated: it is how a merchant at
     the limit frees slots.
   - **An id in a form field is not proof of ownership.** Every lookup is scoped to `shop.id`.
   - **`listOffers` orders by `updatedAt` *and* `id`.** `updatedAt` alone is not a total order — SQLite
     stores milliseconds, same-tick saves compared equal, and the list came back in planner order.
     Found by an intermittently failing test.

   **Unsaved changes raise the admin's contextual save bar** (`SaveBar` from
   `@shopify/app-bridge-react`, 2026-08-20). It renders in Shopify's own top bar rather than in the
   page, which is where a merchant already looks for Save/Discard — so this is not a banner of our
   own. Its children are plain `<button>` elements, not Polaris ones: App Bridge looks for
   `variant="primary"` to find the confirming button, which is why `.eslintrc.cjs` allows `variant`
   through `react/no-unknown-property`.

   Two details it depends on. The baseline is reset from **the row the action returns**, not from the
   values that were submitted — otherwise a save that normalised anything (a trimmed name, a deduped
   list) would leave the bar showing. And product lists are compared **by id in order**, not
   structurally: stored rows carry a `position` and a `title` the picker does not always return, so a
   deep compare reported changes the merchant never made, and a save bar that will not go away is
   worse than none. Discard restores the baseline rather than reloading, so the current tab and any
   result banner survive.

   Tabs: **Content** (copy) and **Offer** (both product lists) are functional. **Design** explains
   that layout and colours are theme block settings rather than offer settings, which is true and not
   a placeholder. **Placement** shows the chosen type and where to add the block.

   **The preview is a working carousel for the card-style offer types** (2026-08-21). It used to
   stack every chosen product and show two disabled arrows next to a hardcoded `$30.00` and the words
   "White color" on every card. Now:

   - **`CAROUSEL_TYPES` = `cross_sell` + `product_add_on`** — one card at a time, with arrows that
     step through the list. **The storefront now matches**, through the same split: the type travels
     in the metafield and `reco.js` lays the injected offer out the same way (§7.6). Keep the two
     lists in step — a preview that describes a layout the shopper does not get is worse than no
     preview. `frequently_bought_together` is a stacked bundle with a running total
     (§7.4) and `volume_discount` is a list of quantity tiers, so both keep the stacked preview and
     the **arrows are hidden rather than disabled**: arrows over a list that does not scroll
     misrepresent the block.
   - **The index is clamped on read**, not corrected in an effect — removing products on the Offer tab
     can leave it past the end, and an effect renders one frame of an empty carousel first. Arrows
     disable at the ends instead of wrapping, so the control itself says how many products there are.
   - **No invented prices.** A price renders only when one is known; a made-up number on a card reads
     as the offer's own pricing, and this block never changes a price. `normalizeAdminProduct` now
     carries `price` (the cheapest variant) and `currencyCode`, as the raw amount rather than a
     formatted string.
   - **Images and prices are hydrated per load, never stored.** The offer stores
     `{id, handle, title, position}` — enough to publish. `hydrateProducts()` in the loader fills in
     image and price for both lists in **one `nodes(ids:)` call**, and a failed hydrate degrades to no
     images rather than an error page. Newly picked products get the same fields straight off the
     resource picker's result, so the preview updates with no round trip. `submit()` strips them back
     with `storedProduct` before posting: the server drops them anyway (`normalizeProducts`), and
     sending them would imply a product's price is part of the offer — it is not, or every price
     change would need every offer re-saved.

   **Delete and Duplicate** (2026-08-21), in the content-column header beside Publish/Unpublish:

   - Both appear **only once the row exists** (`id`). Before the first save there is nothing to copy
     or remove, and that is also when **Save draft** shows instead — the contextual save bar only
     appears once something is dirty, so a merchant who changed nothing still needs a way to store
     the defaults. Once the row exists, the save bar is where saving happens.
   - **Delete unpublishes first, then deletes.** The theme block renders from the metafield (§3.1), so
     deleting the row alone would leave products showing an offer that no longer exists in the admin,
     with nothing left to unpublish it with. A metafield that will not delete is reported and the
     offer still goes — refusing would leave a row the merchant cannot remove — and that is the one
     case that **does not redirect**, because the warning has to be readable.
   - It asks first, through `s-modal` + `commandFor`. The confirm button sits in the **modal body**,
     not an action slot: `primaryAction`/`secondaryActions` are slot names the TypeScript validator
     cannot check, and a confirmation rendering in the wrong place is worse than one rendering plainly.
   - **A duplicate is always a draft**, whatever the original was (`duplicateOffer`): publishing writes
     an Override row and a metafield per target, so a copy born published would overwrite the
     original's storefront output on every product the two share. The products come along — re-picking
     twelve by hand is the work being saved.
   - **Duplicate is disabled while the save bar is up.** The copy is made from the stored row, so
     duplicating mid-edit would silently drop the changes on screen. Delete stays enabled: deleting
     makes unsaved changes moot.
   - Both send **only the id** — posting the form body would imply the copy or the takedown used the
     unsaved edits. And both **navigate**, since `?id=` is what the editor opens from: a duplicate
     lands on the copy, a clean delete lands on `/app`.

   **Not built from the reference design: Translations.** The screenshot carries an "Add translation"
   section; there is no translation storage on `Offer` and no Translate & Adapt integration, so a
   button there would do nothing. It needs its own decision about whether offer copy is translated in
   this app or in Shopify's.

   **Title, Badge and Button text now reach the storefront** (2026-08-20). The metafield carries a
   `copy` object (§3.1, `v: 2`), `reco-panel.liquid` prefers it over the block's own settings, and the
   badge renders beside the heading. `reco.js` needed no change: the client-rendered path only runs
   when there is *no* override, so there is no offer copy to apply — the block settings are correct
   there by definition.

   > ⚠️ **Layout and colours are still theme block settings.** Offers own the *wording*; columns,
   > image shape, button style and padding remain in the theme editor, which is what the Design tab
   > says. Moving them onto the offer is the app-embed direction's step 4, and it needs `reco.css` to
   > take them as custom properties set from JS rather than inline from Liquid.
   >
   > One exception, and it is not a settings move: on the **app embed** path there is no block and so
   > no block settings, so the offer's *type* picks the layout there (§7.6, 2026-08-21). A block a
   > merchant placed keeps its own `layout` setting — they chose it, and an offer must not overrule the
   > theme editor.

   **The heading is repeated in the content column**, with a back arrow beside it. `s-page heading`
   alone is hoisted into the admin's header strip — the same place `primary-action` goes (see the
   warning under item 8) — which left the top of the page blank. This is a step in a flow, so the
   arrow is its only way out.

   > ⚠️ **`s-heading` cannot be resized, and ignores an inline `fontSize`.** Polaris derives heading
   > size from section nesting and exposes no size prop, and setting `style={{ fontSize }}` on the
   > host does nothing because the element sets its own font-size inside its shadow DOM — it rendered
   > at card-title size whatever was passed. A page-level heading that needs a specific size has to be
   > a plain element (`<h1>` here, with `margin: 0` so the browser default does not push the content
   > down). The installed `@shopify/polaris-types` ships no font-size custom properties to use
   > instead, so there is no token-based route.

   > ⚠️ **`gridTemplateColumns` takes one `@container` query plus a fallback, never two.** This grid
   > shipped as
   > `"@container (inline-size > 900px) 1fr 1fr 1fr, @container (inline-size > 560px) 1fr 1fr, 1fr"`
   > and rendered as a **single column**: Polaris does not parse a second clause, and an unparsed value
   > falls back to the last track list. Nothing was logged and every test stayed green. The working
   > shape is the one `app.pricing.jsx` uses —
   > `"@container (inline-size > 720px) 1fr 1fr 1fr, 1fr"`. `tests/placement-picker.test.js` now fails
   > if any route's grid carries more than one `@container` clause.
8. Empty states for every widget when there is no data yet.
9. **Offer list** (2026-08-20), directly under the metrics. Capped at 5 rows with an "N more" line —
   Home is a summary, not a management screen. `npm run seed` creates one published and one draft
   offer so both states render locally.

   **Four columns — Offer name · Offer type · Offer location · Status** (revised 2026-08-21). It
   first shipped as name / status / "shows on N products" / "recommends N products" / an Edit link;
   the counts and the Edit column were replaced by what the offer *is*, which is what a merchant
   scanning a list of offers is actually reading for. Consequences worth keeping:

   - **The whole row is the link**, via `clickDelegate` on `s-table-row` pointing at the name's
     `s-link` id — which is why the anchor stays in the markup rather than becoming a row `onClick`:
     `clickDelegate` is documented as click-only and adds no keyboard or screen-reader affordance.
     The id is per-offer (`offer-link-<id>`) or every row would open the same offer. That is what
     retired the Edit column: a second link to the same place in a row that is already one link.
   - The href is still `?type=<placement>&id=<id>` — a row missing `?type=` bounces back to the
     placement picker instead of opening the offer, so `app/routes.test.js` pins the shape.
   - The name is `s-text type="strong"` inside `s-link tone="neutral"`, not a default accent link:
     it labels the row rather than acting as a call to action among plain cells.
   - Draft rows read **"Not published"**, not "Draft" — the same badge wording the design uses.
   - **The loader projects five scalars** (`id`, `name`, `status`, `offerType`, `placement`) and
     never the `targets`/`items` Json columns; the test now asserts neither word appears in the
     projection at all, since no column counts them any more.
   - **The labels live in `app/lib/offer-labels.js`**, client-safe, and are the only copy of them:
     the builder's offer-type radios map over `OFFER_TYPE_KEYS`/`OFFER_TYPE_LABELS`, and
     `app/models/offer.server.js` validates against the same keys, so a fifth offer type is one
     edit. Unknown keys humanise rather than render an empty cell — a blank cell reads as a bug.

### Phase 11 — Pricing & billing
1. Add the `billing` config to `app/shopify.server.js` with the three plan definitions.
2. `app/routes/app.pricing.jsx`:
   - Three plan cards, current plan badge, feature comparison list, quota meter at the top.
   - Upgrade → action → `billing.request()` → App Bridge redirect to the confirmation URL.
   - Downgrade to Free → `billing.cancel()` + set `Shop.plan = "free"`.
3. `app/routes/app.billing.callback.jsx` — verify the charge, persist plan + `subscriptionId`,
   create a fresh `UsagePeriod` snapshot, redirect to `/app` with a success toast.
4. `app_subscriptions/update` webhook → keep `Shop.plan` in sync on Shopify-side changes.
5. Enforcement helper `app/lib/entitlements.js` → `overrideLimit(plan)`,
   `canAddOverride(plan, count)`, `remainingOverrides(plan, count)`, `canUseCheckout(plan)`,
   `analyticsRetentionDays(plan)`. Enforce **server-side** in every loader/action, not just the UI.
6. Test with `isTest: true` on a dev store; verify upgrade, downgrade, and quota reset.

### Phase 12 — Checkout UI extension
1. `npm run generate extension` → checkout UI extension named `checkout-recommendations`.
2. Implement the three targets (Section 8) sharing one `<Recommendations>` component.
3. `network_access = true`; fetch from the app proxy; handle loading/error/empty.
4. Add to cart with `useApplyCartLinesChange`; track `click` / `add_to_cart` with `placement: "checkout"`.
5. Gate on plan; document the Plus-only limitation for the checkout target in the app listing.

### Phase 13 — Settings page
1. `app/routes/app.settings.jsx` storing into `Shop.settings` (JSON):
   - Global defaults for new blocks (layout, limit, and `intent` if §12 Q2 says yes).
   - Enable/disable checkout recommendations.
   - Tracking: enable/disable, respect customer privacy/consent API.
   - Data retention preference.
2. "Re-sync all overrides" repair action (Phase 6.3).
3. Theme editor deep link: `shopify.app.deepLink` / `/admin/themes/current/editor?template=product&addAppBlockId=…`.

### Phase 14 — Webhooks, privacy & hardening
1. ✅ Webhooks: `app/uninstalled` (soft-delete shop data, cancel period), `app/scopes_update`,
   `orders/create`, `app_subscriptions/update`, `products/delete` (clean up orphan overrides).
2. ✅ Mandatory GDPR webhooks: `customers/data_request`, `customers/redact`, `shop/redact`.
3. ✅ Verify HMAC on every webhook (the library does this — never bypass with a custom handler).
4. ✅ Rate limiting on proxy endpoints; input validation everywhere.
5. Error boundaries on all admin routes. **Still outstanding** — only `app.jsx` and `app._index.jsx`
   export one.

**Done 2026-08-20 (items 1–4).**

The three GDPR endpoints go in `[webhooks.privacy_compliance]` with **absolute** URLs, unlike the
relative `uri` on a normal subscription — keep them in step with `application_url`.
`app/routes.test.js` checks that each one has both a route and a config line and that the two agree
on the path: a handler with no toml entry is never called, and a toml entry with no handler is a 404
at review time.

**What the two customer webhooks actually do**, since the honest answer is "almost nothing":

- `customers/data_request` returns no data, because the app holds none. Nothing in the schema is
  keyed to a person — `RecommendationEvent` carries product ids, a placement, an opaque per-tab
  session id, and on purchase rows an order id. There is no name, email or customer id anywhere, and
  no customer scopes are requested. The handler still has to exist and still has to verify the HMAC,
  which is what review tests.
- `customers/redact` deletes the `purchase` events for the orders named in `orders_to_redact`.
  `orderId` is the only field that leads back to a person. Revenue already rolled into
  `AnalyticsDaily` is a per-day total and identifies nobody, so it stays — but the raw rows must
  actually go, or a later rollup of the same day would rebuild them.
- `shop/redact` is the hard delete (`purgeShopData`). Deleting the `Shop` row cascades to overrides,
  usage periods, raw events and daily rollups.

**`app/uninstalled` is a soft delete, `shop/redact` is the hard one.** The uninstall handler was
only deleting sessions, so `Shop.uninstalledAt` was never set — and `/cron/rollup` filters on
`uninstalledAt: null`, meaning every scheduled run kept rolling up and pruning shops that had left
months earlier. It now also drops the plan to Free and clears `subscriptionId`: Shopify cancels the
charge on uninstall regardless, so a stored id is a stale claim to a paid quota. The soft delete is
deliberate — a merchant who reinstalls the same day keeps their overrides and history, because
`ensureShop` clears the marker and re-anchors the billing window.

### Phase 15 — QA, performance & launch
1. Checklist in Section 11.
2. Lighthouse on a PDP with the block enabled — target CLS < 0.1, no render-blocking resources.
3. Move to Postgres, run `prisma migrate deploy`, set production env vars.
4. App Store listing: screenshots, pricing, privacy policy, demo store.
5. Built for Shopify checklist review.

---

## 10. Conventions

- **Route files**: `app.<page>.jsx` for admin, `proxy.<endpoint>.jsx` for app-proxy,
  `webhooks.<topic>.jsx` for webhooks (flat routes — dots are path separators).
- **A page with sub-routes must be `<page>._index.jsx`, not `<page>.jsx`.** In flat routes
  `app.recommendations.jsx` becomes the *layout* of `app.recommendations.$productId.jsx`, so unless it
  renders an `<Outlet />` the child route silently never appears — its loader runs, then the parent
  renders instead. This cost the override editor a whole day of being unreachable (fixed 2026-08-17);
  `app/routes.test.js` now asserts every parent route renders an Outlet.
- **No Prisma in routes** — always go through `app/models/*.server.js`.
- **`.server.js` suffix** for any module touching the DB, secrets, or the Admin API.
- **GraphQL**: inline template literals tagged with `#graphql` (matches the template + codegen).
- **Money**: store `Decimal` in Prisma; format with `Intl.NumberFormat` and the shop currency.
- **Dates**: store UTC; the billing month is anchored to `Shop.billingCycleStart`, not the calendar month.
- **Never** block the storefront on our backend — every widget path has a Shopify-default fallback.
- **Loaders return plain objects**; no `json()` wrapper (React Router 7 single-fetch style, as in the template).
- Quota values that can be unlimited serialise as `null`, never `Infinity` — loaders JSON-encode.
- Run `npm test`, `npm run lint` and `npm run typecheck` before considering a phase done.

## 11. QA checklist (per release)

- [ ] Fresh install: shop row created, free plan, onboarding checklist shown
- [ ] Block renders on Dawn in grid, slider, and list layouts
- [ ] Add to cart works in all three `atc_behavior` modes
- [ ] Mobile columns setting respected; slider swipes; reduced-motion honoured
- [ ] Override replaces the Shopify list on the PDP within seconds of saving
- [ ] "Reset to defaults" restores the Shopify list and removes the metafield
- [ ] Quota increments once per widget render, not per product
- [ ] On Free, the 10th custom recommendation saves and an 11th product is refused; resetting one
      frees the slot again
- [ ] At 100% quota: Shopify defaults still render, banner shows, tracking stops
- [ ] Upgrade → quota raised immediately; downgrade → reverts
- [ ] Dashboard numbers match the raw event table for a known test session
- [ ] Checkout extension renders on thank-you page and adds lines to the order
- [ ] Uninstall → reinstall does not duplicate shop/override rows
- [ ] No console errors on the storefront; no CLS from the widget
- [ ] Prices render in the shop's own currency **with the app embed disabled** (§7.5)
- [ ] Turning off the embed's "Track recommendation performance" stops impressions and clicks but
      **still counts the serve** (§3.3)
- [ ] A block added in the theme editor shows a real heading, not the word "Heading"
- [ ] A grid of 12 cards reports 12 impressions, not 10
- [ ] Uninstall sets `Shop.uninstalledAt` and drops the plan to Free; `shop/redact` erases the shop
- [ ] Deleting a product removes its override rows and frees a slot against the Free allowance
- [ ] An override whose products have all been deleted falls back to Shopify's list, not an empty row

---

## 12. Open questions

1. **Quota unit** — confirm "1 recommendation = 1 widget served" (Section 3.3).
2. ~~**Complementary vs related**~~ — **answered 2026-08-20.** Neither a per-block *picker* nor a
   Settings default: `complementary` is its own **source** on Smart Recommendations, labelled
   "Complementary products" (§7.2). A global default was the other candidate and was rejected because
   it makes one product page carrying a Related row *and* a Complementary row impossible, which is
   the whole reason a merchant would want it. The removed picker is not coming back — a *Recommendation
   type* select next to a source already named "Related products" is the contradiction that got it
   deleted.
3. **Checkout placement on non-Plus stores** — thank-you/order-status only; is that acceptable for the Standard plan pitch?
4. **Trial** — 14-day free trial on paid plans, yes/no?
5. **Analytics retention on Free** — 7-day dashboard window vs 30-day raw retention; confirm.

---

## 13. Progress

**Update this section every time a feature is completed.** Tick the box, set the date, and add a
one-line note. Keep `Current status` and `Next up` accurate.

**Current status:** Phases 0–11 complete — the full path exists end to end, from a merchant picking
recommendations, to a card rendering on a product page, to tracking beacons rolled up into daily
analytics with revenue attributed from orders, to a metered plan that raises the quota. The
storefront is **two** theme blocks: **Smart Recommendations** (Custom, Related, Complementary —
product templates only) and **Product Showcase** (Popular, Collection products, Recently viewed —
any template), split
so the first can declare `enabled_on` and the second can own a real collection picker (§7.1–7.3).
They share their markup through `reco-panel` and `reco-collection-cards`; only the schema JSON
duplicates, and a test pins the two copies together. A third block, **Upsell**, is a
**Bought Together** bundle over the same Custom list (§7.4) — product templates only, its own
`upsell` placement, billable. 541 Vitest tests pass; lint and typecheck are clean — though see the
warning in §4: typecheck does not read a single `.js`/`.jsx` file, which is all of them.

Custom recommendations are no longer a paid-only feature: **Free covers 10 products** and the
allowance is enforced in the editor's action as well as the UI (§5).

`CRON_SECRET` needs setting in the environment before `POST /cron/rollup` will run.

⛔ **Revenue attribution is disabled in `shopify.app.toml`** pending protected customer data
approval — see the note at the end of Phase 9. Code is written and tested; config is off.

**The Liquid has still never been rendered by Shopify.** No block has appeared in a theme editor,
`npm run deploy` has not been run, so the scopes, the metafield definition and the app proxy are not
live, and no real Admin or Storefront API call has ever executed. Everything below is verified
against tests and nothing else.

`reco.js` is no longer in that category: `tests/reco-runtime.test.js` executes it in jsdom against
fixtures shaped like the Liquid's output (added 2026-08-20, see §4 Testing). That is a real safety
net for its logic — beacons, batching, money formatting, cart payloads — but it is not a browser and
its fixtures are hand-written, so it cannot catch a mismatch between them and what Liquid actually
emits. Only a live pass can.

The Collection picker is a real `"type": "collection"` resource input on **Product Showcase**,
visible for all three of that block's sources (§7.3, settled 2026-08-19). `popular` reads it as an
optional narrowing; `collection` requires it and falls back to the store's first collection. The
`"type": "url"` variant and the Collection-only third block were both built and rejected — see 8.5
and 8.6. This paragraph described the `url` attempt and claimed the app was still one theme block
long after 8.6 landed three; corrected 2026-08-20.

**Next up, in order:**

1. **A live pass on a dev store.** `npm run deploy`, `npm run dev`, add each block in the theme
   editor on Dawn once per source, walk the QA checklist in §11. This is the single highest-value
   thing left and has been deferred through eight feature phases; every finding below came from
   reading code, and the storefront still has never been rendered by Shopify.
2. **Postgres** (§4 warning) — `provider`, migration history, and a plan for the two in-memory
   caches. The URL is env-driven now; the provider is not.
3. **Phase 12** — the checkout UI extension. `canUseCheckout()` has been written and unused since
   Phase 5; "Checkout recommendations" was pulled from the Standard plan's feature list on
   2026-08-20 rather than keep selling it, and goes back the moment the extension ships.
4. **Phase 13** — Settings, and with it §12 Q2 (a global `intent` default).
5. **Error boundaries on the remaining admin routes** (Phase 14 item 5, the only one left).

**Last updated:** 2026-08-21

| Phase | Status | Completed | Notes |
| --- | --- | --- | --- |
| 0. Project setup & cleanup | ✅ Done | 2026-08-12 | Renamed to `easy-recommendation-app`, scopes → `read_products,write_products,read_orders,read_customer_events`, API version aligned to `2026-07`, `[app_proxy]` + `$app:reco_overrides` metafield added, demo metafields/metaobjects/routes/liquid removed. Deploy still pending. |
| 1. Data model | ✅ Done | 2026-08-12 | 4 models migrated (`add_recommendation_models`); `app/models/{shop,override,usage,event,analytics}.server.js` + `app/lib/dates.js`; `npm run seed`. Verified by a 23-check smoke run over the model layer. |
| 2. Plan & quota service | ✅ Done | 2026-08-12 | `app/lib/plans.js`; billing-window/quota service in `usage.server.js` (`getBillingWindow`, `getCurrentPeriod`, `getQuotaStatus`, `canServe`, `recordServed`). Vitest added — 78 tests across 7 files. Rollover needs no job; the window is derived from the anchor. |
| 3. Admin shell | ✅ Done | 2026-08-12 | 5-item nav; `/app` loader bootstraps the shop and exposes quota via `useQuotaStatus()`; `QuotaBanner`, `StatCard`(+`StatCardGrid`), `EmptyState`, `ProductThumb`; placeholder routes for Recommendations/Analytics/Pricing/Settings so no nav link 404s. Polaris markup validated against the App Home validator. |
| 4. Recommendation engine | ✅ Done | 2026-08-12 | `recommendations.server.js` (`resolveRecommendations`, `getShopifyRecommendations`, `hydrateOverrideItems`, normaliser, 60s LRU) + `storefront.server.js`. **Plan corrected: the Admin API has no `productRecommendations`** — switched to the Storefront API, added `Shop.storefrontToken` and the `unauthenticated_read_product_listings` scope. 104 tests. |
| 5. Recommendations page | ✅ Done | 2026-08-12 | List (catalog + custom modes, cursor/offset paging, debounced search, source/placement/status filters, per-source metrics) and the override editor (resource picker, reorder, placement, enable, reset). `products.server.js`, `entitlements.js`, `getSourceProductMetrics`. 126 tests. **Overrides do not reach the storefront until Phase 6 syncs the metafield.** See deviations below. Plan gate revised 2026-08-17: Free allows 10 overridden products instead of none (§5). |
| 6. Metafield sync | ✅ Done | 2026-08-12 | `metafields.server.js` — `syncOverrideMetafield` (set or delete via `shouldPublishToStorefront`), `deleteOverrideMetafield`, `syncAllOverrides` batched at 25 with per-batch error reporting. Wired into save/reset; failures surface a "saved, but not live yet" banner and leave `syncedAt` null. Re-sync repair action added to Settings (early, from Phase 13). 142 tests. |
| 7. App proxy API | ✅ Done | 2026-08-12 | `proxy.recommendations.jsx` (quota gate, 30-min serve dedupe, `no-store`, degrades to `{items:[]}`) and `proxy.track.jsx` (batch cap 10, per-shop rate limit, always 204). `tracking.server.js`. 155 tests. Not yet exercised over a real proxy request. |
| 8. Theme app block (PDP) | ✅ Done | 2026-08-12 | `blocks/recommendations.liquid` (26 settings), `snippets/reco-card.liquid`, `assets/reco.{css,js}`, app embed config, locales. Server-renders overrides from the metafield; Ajax fallback otherwise. Impressions/clicks/ATC beacons, `served` beacon drives quota. Static schema+locale test suite added. **Never rendered on a real theme.** See deviations below. |
| 8.1 Popular products block | ✅ Done | 2026-08-13 | Second theme app block (§7.1), placeable on any template. Renders a merchant-chosen collection server-side from Liquid; reuses `reco-card.liquid`, `reco.css`, `reco.js`. New `popular` placement; no `served` beacon, so no quota cost. 213 tests. **Never rendered on a real theme.** |
| 8.2 One block, three sources | ✅ Done | 2026-08-18 | Collapsed to a single **Smart Recommendations** block with a `source` select: `custom` (override metafield → Ajax fallback, `pdp`, billable), `popular` (collection, Liquid-rendered), `recently_viewed` (localStorage, recorded by the app embed on every PDP, re-fetched via `/products/<handle>.js`). `popular-products.liquid` deleted. `visible_if` scopes the per-source settings; Shopify rejects it on the `collection` resource input, so that one is scoped by info text — the five sources were later split across two blocks, see 8.6. |
| 8.3 Related products source | ✅ Done | 2026-08-19 | Fourth `source` option (§7.2): Shopify's own recommendations with the override skipped entirely, PDP only, client-rendered, `intent` fixed to `related`. Billable like `custom`, on its own `related` placement so a Custom row and a Related row on one page are not deduped into a single serve. No `reco.js` change was needed. Fixed alongside: `recently_viewed` was missing from `PLACEMENTS` in `event.server.js`, so every event from that source had been silently recorded as `pdp` — the analytics page has had a label for it since 8.2 that could never appear. 239 tests. |
| 8.4 Collection products source | ✅ Done | 2026-08-19 | Fifth `source` option (§7.3): the merchant picks a collection and the block renders it. Shares `popular`'s Liquid branch and its `sort_by` / `exclude_current` / `hide_sold_out` settings; the one behavioural difference is what an untouched picker falls back to — the store's first collection here, `collections.all` for `popular`. New `collection` placement, no `served` beacon. **Where the picker lives changed twice the same day — see 8.5 and 8.6.** |
| 8.5 Collection picker, attempt 1 | ⛔ Superseded | 2026-08-19 | Recorded because the dead ends matter. The Collection field showed on all five sources, doing nothing on four. `visible_if` is rejected on resource inputs, so the field was changed to `"type": "url"` scoped to `source == 'collection'`, parsing the handle out of the stored link — **rejected on its picker**, which also lists Products, Pages, Blogs and Policies with no way to filter them. A Collection-only third block was then built and **reverted** as one block too many. Superseded by 8.6. |
| 8.7 Bought Together block | ✅ Done | 2026-08-19 | (§7.4) Shipped as "Upsell" and renamed the same day: it is a **cross-sell** bundle, and an upsell means a better version of the same product, which Shopify's `related` list cannot supply. Named "Bought Together" because a block `name` is capped at 25 characters and the full phrase is 26 — a cap the suite now checks for every block. `upsell` remains the internal key — filename, placement, CSS prefix. Build: `blocks/upsell.liquid` + `snippets/upsell-row.liquid`, product templates only. The viewed product plus its recommendations as ticked lines, a running total, and one `/cart/add.js` carrying every ticked variant. List comes from the Custom source's own rule — override metafield, else Shopify's Ajax recommendations — so a curated list drives the bundle too. New `upsell` placement (billable, own placement so it is not deduped against a Custom or Related row on the same page) added to `PLACEMENTS` and `PLACEMENT_LABELS`. A variant `<select>` per line built from available variants only, rather than the guess the card blocks refuse to make; the current product's variant is read from `?variant=` at click time; the "This item" line carries no `_reco_*` properties so it is never attributed to itself; one `add_to_cart` per recommended line; ticking a line reports `click`. Runtime added to `reco.js` (not a second asset) so it reuses the beacon queue and money formatter. 285 tests. |
| 8.6 Two blocks, split PDP vs merchandising | ✅ Done | 2026-08-19 | The Collection field showed on all five sources of the single block, doing nothing on four, and Shopify rejects `visible_if` on resource inputs by design. A `"type": "url"` field was built first and rejected on its picker (it also lists Products, Pages, Blogs and Policies, with no attribute to filter them); a Collection-only third block was built and reverted. Settled shape: **`recommendations.liquid`** = Custom + Related with `enabled_on: templates: ["product"]` — declarable for the first time, since both need a product — and **`product-showcase.liquid`** = Popular + Collection products + Recently viewed, any template, owning a real `"type": "collection"` picker that two of its three sources read. `popular` regained its optional collection narrowing. Markup shared through new `reco-panel` / `reco-collection-cards` snippets; only the schema duplicates, held together by a test comparing the two settings arrays. `limit` maxes at 12 on the PDP block and 24 on the showcase block. The **Recommendation type (`intent`) picker was removed** the same day: it governed only Custom's fallback and read as a contradiction beside the Related source, so both now send `data-reco-intent="related"` — `complementary` still works through the proxy and the engine, see §7.2 and §12 Q2. 261 tests. See §7.3 — settled, with tests blocking each dead end. |

| 9. Analytics pipeline | ✅ Done | 2026-08-12 | `rollupDay`/`rollupRange` (idempotent, refuses pruned days), `getDashboardMetrics` (totals + prior-period deltas + gapless series), `getFunnel`, `WIDGET_TOTAL` sentinel; `attribution.server.js` + `orders/create` webhook with order-derived idempotency keys; `cron.rollup` route with retention pruning. 202 tests. Analytics page (`/app/analytics`) built 2026-08-18: range selector, impressions-vs-clicks trend, funnel bars, per-placement breakdown (`getPlacementBreakdown`), sortable 50-row per-product table, CSV export gated by `canExportCsv`. |
| 10. Home dashboard | ✅ Done | 2026-08-18 | Real metrics with period deltas, 7/30/90 range (clamped to plan retention), top-10 products, funnel, onboarding checklist shown only before first data. Loader rolls up a 3-day trailing window so numbers appear without the cron. The served-vs-clicks trend chart was **removed on 2026-08-20** — `TrendChart` still renders it on `/app/analytics`. |
| 11. Pricing & billing | ✅ Done | 2026-08-18 | `billing` config in `shopify.server.js` (paid plans only, 14-day trial, `isTest`); pricing page upgrade/downgrade actions; `app.billing.callback` verifies with `billing.check()` rather than trusting the return URL; `app_subscriptions/update` webhook drops non-active subscriptions to Free. Quota snapshot is rewritten on every plan change so the new limit applies immediately. |
| 12. Checkout extension | ⬜ Not started | — | Checkout / thank-you / order status. "Checkout recommendations" removed from the Standard plan's feature list 2026-08-20 until it exists. |
| 13. Settings page | ⬜ Not started | — | Global defaults, re-sync, deep links |
| 14. Webhooks & privacy | 🟡 Mostly done | 2026-08-20 | Items 1–4 done: the three mandatory GDPR endpoints (`customers/data_request`, `customers/redact`, `shop/redact`), `products/delete`, and a completed `app/uninstalled`. Item 5 (error boundaries on every admin route) outstanding. |
| 15. QA & launch | ⬜ Not started | — | Postgres provider + migrations, listing, BFS review. `DATABASE_URL` is env-driven as of 2026-08-20; the rest of the move is still here. |
| 8.9 Inline complementary products | ✅ Done | 2026-08-20 | Each row of `/app/recommendations` now shows its curated products as thumbnails (4, then "+N") and picks them inline through the App Bridge resource picker — no round trip to the editor per product, which was the slow part of curating a catalogue. New `action` on the list route, `getProductOverrides()` in the override model, `components/ComplementaryCell.jsx`. **The action preserves the row's existing placement** rather than assuming `pdp`: a product can hold a `pdp` row and a `checkout` row, so defaulting would write a duplicate beside the existing row and charge two products against the plan allowance — pinned by tests. Plan allowance enforced server-side, as everywhere. **This route cannot empty a list** — the inline Clear button was removed on request the same day, so emptying is the editor's "Reset to Shopify defaults", which is never gated and is therefore how a merchant who has used their whole allowance frees a slot. Thumbnails are hydrated in one `nodes(ids:)` call per page, capped at the 4 chips actually drawn and narrowed to rows that survive the "Shopify defaults only" filter. A picked product since deleted still shows a chip, titled "no longer available", because it still occupies a slot. **Not** Shopify's complementary metafield — see the reserved-prefix warning in §7.2. |
| 8.8 Complementary source | ✅ Done | 2026-08-20 | Third `source` on Smart Recommendations, labelled "Complementary products" (§7.2). Asks Shopify for `intent: complementary` — bought *with* this product rather than like it. `reco.js` needed no change: `fetchFallback` already read `data-reco-intent`, so this is a schema option, a Liquid branch in `reco-panel`, and a new `complementary` placement in `PLACEMENTS` + `PLACEMENT_LABELS`. Billable, own placement so a Related row and a Complementary row on one page are not deduped into a single serve. **Answers §12 Q2**: a source, not the deleted Recommendation-type picker and not a store-wide Settings default — a global switch would rule out running both rows on one page, which is the point. **Shopify answers this intent only for products a merchant has linked in the Search & Discovery app**, so an untouched store gets an empty list and the row used to remove itself silently — indistinguishable from a broken source. `reco.js` now unhides a design-mode-only hint (`complementary.empty`) instead of hiding the block, and does the same for `related` / `custom` (`related.empty`, for a store with too little order history). The live storefront still just hides an empty row. Also on this page: the **Clicks and CTR columns were removed** from the recommendations list; both still live on `/app/analytics`. |
| H1. Audit & hardening pass | ✅ Done | 2026-08-20 | A code read of the whole app, then the fixes. **Two billing holes:** the app embed's tracking checkbox suppressed the `served` beacon, which on the theme path is the only billing signal, so unchecking it bought unlimited free recommendations (§3.3); and `selectBillableServes()` skipped its in-batch dedupe for serves with no session id, billing once per copy from a single beacon. **Two silent-failure paths:** the Storefront token was minted only by the override editor's loader, so every server-side recommendation path returned `{items: []}` for a merchant who never opened that one page (now provisioned in the `/app` loader); and an override whose products had all been deleted returned an empty list instead of falling back to Shopify, rendering nothing. **Two storefront defects:** prices used a hardcoded `"${{amount}}"` unless the optional app embed was on (§7.5), and both card blocks shipped `"default": "Heading"` — a literal `<h2>Heading</h2>` on the merchant's live product page. **Plus:** the beacon queue dropped everything past the first batch of 10 (a 12-card grid hit it immediately), slider autoplay leaked an interval per theme-editor re-render, and the product search interpolated raw input into Shopify's search grammar. **Infrastructure:** `DATABASE_URL` is now an env var rather than a container-local SQLite file — with a dev fallback and a hard failure in production, applied through `scripts/prisma.js` because `shopify.web.toml` shells out to the Prisma CLI twice before the app boots (making it env-driven broke `shopify app dev` with P1012 until the wrapper landed). Phase 14's webhooks landed. **Coverage:** `tests/reco-runtime.test.js` runs `reco.js` in jsdom — 24 tests where there had been none. 285 → 337 tests. **Docs:** §13 still described the rejected `url` picker and claimed one theme block after 8.6 shipped three; §7 claimed a `stylesheet` declaration that does not exist; §4 claimed lint ignored `.jsx`, which it does not. All corrected. |

Status legend: ⬜ Not started · 🟡 In progress · ✅ Done · ⛔ Blocked
