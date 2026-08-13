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
| `/app` | Home — analytics dashboard, widgets, top recommended products, quota meter |
| `/app/recommendations` | List of all products + their recommendation source, filters + search, override editor |
| `/app/recommendations/$productId` | Override editor for a single product |
| `/app/analytics` | Deeper analytics (trend charts, per-product breakdown, funnel) |
| `/app/pricing` | 3 plans, current plan, upgrade/downgrade |
| `/app/settings` | Global widget defaults, checkout toggle, tracking options |

**Storefront / checkout surfaces**

| Extension | Type | Placement |
| --- | --- | --- |
| `pdp-recommendations` | Theme app block (`extensions/theme-extension`) | PDP section block |
| `popular-products` | Theme app block (`extensions/theme-extension`) | Any template — merchandising row |
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

Metafield shape (`$app:reco_overrides`, type `json`):

```json
{
  "v": 1,
  "updatedAt": "2026-08-12T10:00:00Z",
  "items": [
    { "id": "12345678", "handle": "blue-snowboard" },
    { "id": "22345678", "handle": "wax-kit" }
  ]
}
```

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

**Placements**: `pdp` · `checkout` · `thank_you` · `order_status` · `popular`. The last one is the
merchandising block (§7.1), not a recommendation surface — it has no source product (sentinel `"*"`)
and never emits `served`. Keeping it in the list rather than coercing it to `pdp` is what stops a
home-page row landing in some product's recommendation metrics.

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
beacon, and neither would find the other in the database yet.

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

Migration command: `npx prisma migrate dev --name <name>` (never hand-edit migrations).

Seed the local database with `npm run seed` (re-runnable; clears its own shop first).
`SEED_QUOTA_FILL=0.85` / `=1` seeds the warning / over-quota states, `SEED_SHOP` sets the domain.

> ⚠️ `tsconfig.json` only includes `**/*.ts` and `**/*.tsx`, and eslint's `import` plugin is scoped
> to the TypeScript override — so **neither `npm run lint` nor `npm run typecheck` checks the `.js`
> and `.jsx` source files**. Both passing says nothing about this app's code. `npm test` is the
> check that actually exercises it.

### Testing

Vitest, configured in `vitest.config.js` (separate from `vite.config.js`, which loads the
`reactRouter()` plugin). Tests sit next to the code as `app/**/*.test.js`.

```
npm test         # single run
npm run test:watch
```

Integration tests run against the local `prisma/dev.sqlite` — the datasource URL is hardcoded in
`schema.prisma`, so there is no separate test database. Two rules follow from that:

- Every test file scopes its rows to its own `vitest-<name>.myshopify.com` shop and deletes them in
  `beforeEach`/`afterAll`. Cascades from `Shop` clean up children.
- `fileParallelism` is off — concurrent writers hit SQLite's database-level write lock.

Re-run `npm run seed` after a test run if you want the dev fixture back.

---

## 5. Plans & billing

| Plan | Price | Monthly quota | Features |
| --- | --- | --- | --- |
| **Free** | $0 | 100 recommendations | PDP widget, Shopify recommendations, basic analytics (7 days) |
| **Standard** | $29/mo | 1,000 recommendations | + manual overrides, checkout widget, 90-day analytics, CSV export |
| **Enterprise** | $59/mo | Unlimited | + unlimited overrides, full history, priority support |

Implementation: `billing` config in `app/shopify.server.js` using the
[Billing API](https://shopify.dev/docs/api/shopify-app-react-router/apis/billing).

```js
export const PLANS = {
  free:       { key: "free",       name: "Free",       price: 0,  quota: 100 },
  standard:   { key: "standard",   name: "Standard",   price: 29, quota: 1000 },
  enterprise: { key: "enterprise", name: "Enterprise", price: 59, quota: -1 },
};
```

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

## 7. Theme app extension — PDP block

Directory: `extensions/theme-extension/` (already scaffolded; currently holds template demo files
`star_rating.liquid`, `app-embed.liquid`, `stars.liquid` — **delete these in Phase 0**).

```
extensions/theme-extension/
├── blocks/
│   ├── recommendations.liquid     # the PDP app block  (target: section)
│   ├── popular-products.liquid    # merchandising block, any template (§7.1)
│   └── app-embed.liquid           # app embed: loads tracker JS site-wide
├── snippets/
│   ├── reco-card.liquid           # single product card
│   └── reco-empty.liquid
├── assets/
│   ├── reco.js                    # fetch fallback + tracking beacons
│   └── reco.css
└── locales/en.default.json
```

### Block settings schema (all must be implemented)

| Setting | id | Type | Options / default |
| --- | --- | --- | --- |
| Heading | `heading` | text | "You may also like" |
| Layout | `layout` | select | `grid` (default) · `slider` · `list` |
| Products to show | `limit` | range 2–12 | 4 |
| Columns (desktop) | `columns_desktop` | range 2–6 | 4 |
| Columns (mobile) | `columns_mobile` | range 1–3 | 2 |
| Recommendation intent | `intent` | select | `related` · `complementary` |
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

### 7.1 Popular products block (`blocks/popular-products.liquid`)

A second theme app block, added 2026-08-13. Same look as the recommendations block — it renders
through the same `reco-card.liquid` snippet, `reco.css` and `reco.js` — but it is **merchandising,
not recommendation**, and the differences all follow from that:

| | Recommendations | Popular products |
| --- | --- | --- |
| Where it can go | `enabled_on: templates: ["product"]` | any template — home, collection, cart, page |
| Source of products | override metafield → Shopify Ajax API | a merchant-chosen collection, in Liquid |
| Needs a source product | yes (`product.id`) | no (sentinel `"*"`) |
| Network at render | Ajax fallback when no override | none — fully server-rendered |
| `served` beacon | yes | **no** (`data-reco-serve="false"`) |
| Quota cost | 1 per render | 0 |
| Placement | `pdp` | `popular` |

**"Best selling" is the collection's own sort order.** Liquid exposes no sales figures, so the
merchant sets the collection to Best selling once under Products → Collections and every render
follows it. The other `sort_by` options (`newest`, `price_asc`, `price_desc`, `title`) apply Liquid's
`sort` filter — which, without `{% paginate %}`, only sees the collection's first 50 products. Said
plainly on the setting's `info` text rather than hidden.

**Why no `served` event.** A row on the home page renders on every visit; billing it as a
recommendation would burn a Free plan's 100/month in an afternoon (§3.3). It still reports
`impression` / `click` / `add_to_cart`, so the merchant gets engagement numbers for free. `reco.js`
reads `data-reco-serve` before firing the serve beacon; everything else is shared with the PDP block.

**Extra settings** beyond the PDP block's: `collection`, `sort_by`, `exclude_current` (skip the
product being viewed, for when the block is placed on a PDP), `hide_sold_out`. `limit` goes to 24
rather than 12 — the `all_products` 20-lookup cap does not apply, since this iterates
`collection.products` directly. `intent` is dropped (nothing to be related *to*).

When the collection is empty the block renders **nothing** on the storefront, and a dashed hint in
the theme editor only (`request.design_mode`).

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
2. `npx prisma migrate dev --name add_recommendation_models`.
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
   - Filters: source (all/shopify/custom), status (enabled/disabled), placement, has-clicks.
   - Sort: title, most recommended, most clicked, CTR.
   - `<s-table>` columns: Product · Source · # recommendations · Impressions · Clicks · CTR · Actions.
   - Bulk actions: reset to Shopify defaults, disable overrides.
2. `app/routes/app.recommendations.$productId.jsx`:
   - Shows the current Shopify-generated list as a starting point.
   - Product picker via App Bridge `shopify.resourcePicker({ type: "product", multiple: 12 })`.
   - Drag-to-reorder the chosen products (HTML5 DnD, no library).
   - Per-product placement selector (PDP / checkout / both), enable toggle.
   - Save → `upsertOverride()` → triggers the metafield sync (Phase 6).
   - "Reset to Shopify defaults" deletes the override *and* the metafield.
3. Gate override creation behind the Standard plan; on Free, show an upgrade card.

**Deviations made while building (2026-08-12):**
- **Two list modes, not one.** Shopify pages the catalogue, and it has no idea which products carry
  overrides — so "sort by most clicks" cannot be answered against the catalogue without pulling all
  of it. *Catalogue mode* (default) uses Shopify cursor paging with Shopify sort keys; *Custom only*
  mode is driven by the `Override` table and is where the metric sorts live, ranking every override
  then paging the ranked list. Past `METRIC_SORT_CAP` (1000) it falls back to recency and says so.
- **"Shopify defaults only" can return a short page.** The exclusion happens after Shopify has
  already paged, so a 25-row page minus 3 overridden products shows 22.
- **Reorder is up/down buttons, not HTML5 drag-and-drop.** Dragging rows inside `<s-table>` is
  fiddly and inaccessible; buttons work with a keyboard and need no library.
- **Bulk actions are not built.** Per-row edit and reset only — deferred.
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
2. Server-render from `product.metafields.app.reco_overrides` when present
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
- The block declares both `stylesheet` and `javascript`, so it works even if the merchant never
  enables the app embed. The embed only publishes `window.EasyReco.config`, which `reco.js` reads at
  call time so the two can load in either order.

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
5. **Trend chart**: 30-day served vs clicks — inline SVG sparkline/area, no chart library.
6. Date range selector: 7 / 30 / 90 days (90 gated to paid plans).
7. Onboarding checklist for a brand-new install: enable app embed → add block to PDP →
   create your first override.
8. Empty states for every widget when there is no data yet.

### Phase 11 — Pricing & billing
1. Add the `billing` config to `app/shopify.server.js` with the three plan definitions.
2. `app/routes/app.pricing.jsx`:
   - Three plan cards, current plan badge, feature comparison list, quota meter at the top.
   - Upgrade → action → `billing.request()` → App Bridge redirect to the confirmation URL.
   - Downgrade to Free → `billing.cancel()` + set `Shop.plan = "free"`.
3. `app/routes/app.billing.callback.jsx` — verify the charge, persist plan + `subscriptionId`,
   create a fresh `UsagePeriod` snapshot, redirect to `/app` with a success toast.
4. `app_subscriptions/update` webhook → keep `Shop.plan` in sync on Shopify-side changes.
5. Enforcement helper `app/lib/entitlements.js` → `canUseOverrides(plan)`, `canUseCheckout(plan)`,
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
   - Global defaults for new blocks (layout, limit, intent).
   - Enable/disable checkout recommendations.
   - Tracking: enable/disable, respect customer privacy/consent API.
   - Data retention preference.
2. "Re-sync all overrides" repair action (Phase 6.3).
3. Theme editor deep link: `shopify.app.deepLink` / `/admin/themes/current/editor?template=product&addAppBlockId=…`.

### Phase 14 — Webhooks, privacy & hardening
1. Webhooks: `app/uninstalled` (soft-delete shop data, cancel period), `app/scopes_update`,
   `orders/create`, `app_subscriptions/update`, `products/delete` (clean up orphan overrides).
2. Mandatory GDPR webhooks: `customers/data_request`, `customers/redact`, `shop/redact`.
3. Verify HMAC on every webhook (the library does this — never bypass with a custom handler).
4. Rate limiting on proxy endpoints; input validation everywhere.
5. Error boundaries on all admin routes.

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
- [ ] At 100% quota: Shopify defaults still render, banner shows, tracking stops
- [ ] Upgrade → quota raised immediately; downgrade → reverts
- [ ] Dashboard numbers match the raw event table for a known test session
- [ ] Checkout extension renders on thank-you page and adds lines to the order
- [ ] Uninstall → reinstall does not duplicate shop/override rows
- [ ] No console errors on the storefront; no CLS from the widget

---

## 12. Open questions

1. **Quota unit** — confirm "1 recommendation = 1 widget served" (Section 3.3).
2. **Complementary vs related** — should merchants pick per block, or globally in Settings? (Currently per block.)
3. **Checkout placement on non-Plus stores** — thank-you/order-status only; is that acceptable for the Standard plan pitch?
4. **Trial** — 14-day free trial on paid plans, yes/no?
5. **Analytics retention on Free** — 7-day dashboard window vs 30-day raw retention; confirm.

---

## 13. Progress

**Update this section every time a feature is completed.** Tick the box, set the date, and add a
one-line note. Keep `Current status` and `Next up` accurate.

**Current status:** Phases 0–9 complete — the full path exists end to end, from a merchant picking
recommendations, to a card rendering on a product page, to tracking beacons rolled up into daily
analytics with revenue attributed from orders. Plus a second theme block, **Popular products**
(§7.1), placeable on any template. 213 Vitest tests pass; lint, typecheck and build are clean.

`CRON_SECRET` needs setting in the environment before `POST /cron/rollup` will run.

⛔ **Revenue attribution is disabled in `shopify.app.toml`** pending protected customer data
approval — see the note at the end of Phase 9. Code is written and tested; config is off.

**None of the storefront code has ever run.** The Liquid has never been rendered by Shopify, neither
block has appeared in a theme editor, and `reco.js` has never executed in a browser. The static
tests in `tests/theme-extension.test.js` catch malformed schema JSON, out-of-bounds range defaults
and missing translation keys — nothing more. Equally, `npm run deploy` has not been run, so the
scopes, metafield definition and app proxy are not live, and no real Admin or Storefront API call
has ever executed.

**Next up:** Phase 10 — the home dashboard, which renders what Phase 9 now computes. Still
outstanding and still recommended first: a live pass on a dev store (`npm run deploy`, `npm run dev`,
add both blocks in the theme editor on Dawn, walk the QA checklist in §11).
**Last updated:** 2026-08-13

| Phase | Status | Completed | Notes |
| --- | --- | --- | --- |
| 0. Project setup & cleanup | ✅ Done | 2026-08-12 | Renamed to `easy-recommendation-app`, scopes → `read_products,write_products,read_orders,read_customer_events`, API version aligned to `2026-07`, `[app_proxy]` + `$app:reco_overrides` metafield added, demo metafields/metaobjects/routes/liquid removed. Deploy still pending. |
| 1. Data model | ✅ Done | 2026-08-12 | 4 models migrated (`add_recommendation_models`); `app/models/{shop,override,usage,event,analytics}.server.js` + `app/lib/dates.js`; `npm run seed`. Verified by a 23-check smoke run over the model layer. |
| 2. Plan & quota service | ✅ Done | 2026-08-12 | `app/lib/plans.js`; billing-window/quota service in `usage.server.js` (`getBillingWindow`, `getCurrentPeriod`, `getQuotaStatus`, `canServe`, `recordServed`). Vitest added — 78 tests across 7 files. Rollover needs no job; the window is derived from the anchor. |
| 3. Admin shell | ✅ Done | 2026-08-12 | 5-item nav; `/app` loader bootstraps the shop and exposes quota via `useQuotaStatus()`; `QuotaBanner`, `StatCard`(+`StatCardGrid`), `EmptyState`, `ProductThumb`; placeholder routes for Recommendations/Analytics/Pricing/Settings so no nav link 404s. Polaris markup validated against the App Home validator. |
| 4. Recommendation engine | ✅ Done | 2026-08-12 | `recommendations.server.js` (`resolveRecommendations`, `getShopifyRecommendations`, `hydrateOverrideItems`, normaliser, 60s LRU) + `storefront.server.js`. **Plan corrected: the Admin API has no `productRecommendations`** — switched to the Storefront API, added `Shop.storefrontToken` and the `unauthenticated_read_product_listings` scope. 104 tests. |
| 5. Recommendations page | ✅ Done | 2026-08-12 | List (catalog + custom modes, cursor/offset paging, debounced search, source/placement/status filters, per-source metrics) and the override editor (resource picker, reorder, placement, enable, reset). `products.server.js`, `entitlements.js`, `getSourceProductMetrics`. 126 tests. **Overrides do not reach the storefront until Phase 6 syncs the metafield.** See deviations below. |
| 6. Metafield sync | ✅ Done | 2026-08-12 | `metafields.server.js` — `syncOverrideMetafield` (set or delete via `shouldPublishToStorefront`), `deleteOverrideMetafield`, `syncAllOverrides` batched at 25 with per-batch error reporting. Wired into save/reset; failures surface a "saved, but not live yet" banner and leave `syncedAt` null. Re-sync repair action added to Settings (early, from Phase 13). 142 tests. |
| 7. App proxy API | ✅ Done | 2026-08-12 | `proxy.recommendations.jsx` (quota gate, 30-min serve dedupe, `no-store`, degrades to `{items:[]}`) and `proxy.track.jsx` (batch cap 10, per-shop rate limit, always 204). `tracking.server.js`. 155 tests. Not yet exercised over a real proxy request. |
| 8. Theme app block (PDP) | ✅ Done | 2026-08-12 | `blocks/recommendations.liquid` (26 settings), `snippets/reco-card.liquid`, `assets/reco.{css,js}`, app embed config, locales. Server-renders overrides from the metafield; Ajax fallback otherwise. Impressions/clicks/ATC beacons, `served` beacon drives quota. Static schema+locale test suite added. **Never rendered on a real theme.** See deviations below. |
| 8.1 Popular products block | ✅ Done | 2026-08-13 | Second theme app block (§7.1), placeable on any template. Renders a merchant-chosen collection server-side from Liquid; reuses `reco-card.liquid`, `reco.css`, `reco.js`. New `popular` placement; no `served` beacon, so no quota cost. 213 tests. **Never rendered on a real theme.** |
| 9. Analytics pipeline | ✅ Done | 2026-08-12 | `rollupDay`/`rollupRange` (idempotent, refuses pruned days), `getDashboardMetrics` (totals + prior-period deltas + gapless series), `getFunnel`, `WIDGET_TOTAL` sentinel; `attribution.server.js` + `orders/create` webhook with order-derived idempotency keys; `cron.rollup` route with retention pruning. 202 tests. |
| 10. Home dashboard | ⬜ Not started | — | Widgets, top products, trend chart |
| 11. Pricing & billing | ⬜ Not started | — | 3 plans, upgrade/downgrade flow |
| 12. Checkout extension | ⬜ Not started | — | Checkout / thank-you / order status |
| 13. Settings page | ⬜ Not started | — | Global defaults, re-sync, deep links |
| 14. Webhooks & privacy | ⬜ Not started | — | GDPR, orders/create, hardening |
| 15. QA & launch | ⬜ Not started | — | Postgres, listing, BFS review |

Status legend: ⬜ Not started · 🟡 In progress · ✅ Done · ⛔ Blocked
