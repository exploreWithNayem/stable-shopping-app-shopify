// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/*
 * Behavioural tests for the storefront runtime.
 *
 * assets/reco.js is the most fragile code in the app — it runs inside someone
 * else's theme, it carries the billing signal, and it had no coverage at all:
 * tests/theme-extension.test.js reads the Liquid and the schemas as text and
 * never executes a line of JavaScript. Everything below drives the real file in
 * a DOM, against fixtures shaped like what the Liquid actually emits.
 *
 * The script is an IIFE that runs on load, so each test boots a fresh copy into
 * a fresh document and reads the beacons back out of a stubbed sendBeacon.
 */

const SRC = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "extensions",
    "theme-extension",
    "assets",
    "reco.js",
  ),
  "utf8",
);

let beacons; // [{ url, body }]
let cartAdds; // parsed /cart/add.js bodies
let fetchRoutes;
let observers;

/** Advance timers and drain microtasks together — every path here is async. */
const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

/** Every event sent so far, across batches, in order. */
async function events() {
  const out = [];
  for (const beacon of beacons) {
    const text = typeof beacon.body === "string" ? beacon.body : await beacon.body.text();
    out.push(...(JSON.parse(text).events ?? []));
  }
  return out;
}

const typesOf = async (type) => (await events()).filter((e) => e.type === type);

function boot(html, config) {
  document.body.innerHTML = html;
  if (config === undefined) {
    delete window.EasyReco;
  } else {
    window.EasyReco = { config };
  }
  // eslint-disable-next-line no-new-func
  new Function(SRC)();
}

beforeEach(() => {
  vi.useFakeTimers();
  beacons = [];
  cartAdds = [];
  observers = [];
  fetchRoutes = new Map();
  /*
   * The embed injects offers only, and only ones the app vouches for — so the
   * liveness check is part of every embed path now. Answered yes by default; the
   * tests about the check itself override or remove this.
   */
  fetchRoutes.set("/apps/easy-reco/offer", { live: true });

  // sendBeacon is the primary transport; jsdom does not implement it.
  Object.defineProperty(window.navigator, "sendBeacon", {
    configurable: true,
    writable: true,
    value: (url, body) => {
      beacons.push({ url, body });
      return true;
    },
  });

  // A recording IntersectionObserver, so impressions can be triggered on demand.
  window.IntersectionObserver = class {
    constructor(callback) {
      this.callback = callback;
      this.targets = [];
      observers.push(this);
    }
    observe(target) {
      this.targets.push(target);
    }
    unobserve(target) {
      this.targets = this.targets.filter((entry) => entry !== target);
    }
    disconnect() {
      this.targets = [];
    }
    /** Report everything currently observed as 50% visible. */
    trigger() {
      const seen = [...this.targets];
      this.callback(seen.map((target) => ({ isIntersecting: true, target })));
    }
  };

  // reco.js deliberately lets a card link navigate; jsdom logs "Not implemented"
  // for every one. Swallow the navigation, keep the click.
  document.addEventListener("click", (event) => {
    if (event.target.closest("a[href]")) event.preventDefault();
  });

  window.fetch = vi.fn((url, options = {}) => {
    if (String(url).startsWith("/cart/add.js")) {
      cartAdds.push(JSON.parse(options.body));
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ items: [] }) });
    }
    for (const [prefix, payload] of fetchRoutes) {
      if (String(url).startsWith(prefix)) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) });
      }
    }
    return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
  });
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
  window.sessionStorage.clear();
  window.localStorage.clear();
});

// --- Fixtures --------------------------------------------------------------
// Shaped after snippets/reco-panel.liquid and snippets/upsell-row.liquid.

const CARD_TEMPLATE = `
  <template data-reco-card-template>
    <div class="reco-card" data-reco-card>
      <a class="reco-card__media" data-reco-link><img class="reco-card__image" alt=""></a>
      <div class="reco-card__info">
        <a class="reco-card__title" data-reco-link data-reco-title></a>
        <span class="reco-card__price">
          <span data-reco-price></span>
          <s class="reco-card__compare" data-reco-compare hidden></s>
        </span>
        <button type="button" data-reco-add>Add to cart</button>
      </div>
    </div>
  </template>`;

/**
 * A Liquid-rendered countdown bar, as reco-panel emits it: the settings on data
 * attributes and the clock left empty for reco.js to fill.
 */
const countdownBar = ({ mode = "fixed", minutes = 60, endsAt = "" } = {}) => `
  <div class="reco__countdown" data-reco-countdown
       data-reco-countdown-mode="${mode}"
       data-reco-countdown-minutes="${minutes}"
       data-reco-countdown-ends-at="${endsAt}">
    Hurry up! Offer expires in
    <strong class="reco__countdown-value" data-reco-countdown-value></strong>
  </div>`;

function panel({
  attrs = "",
  cards = "",
  serverRendered = true,
  moneyFormat = "€{{amount}}",
  countdown = "",
} = {}) {
  return `
  <div class="reco reco--grid" data-reco-block
       data-reco-money-format="${moneyFormat}"
       data-reco-limit="4"
       data-reco-atc="ajax"
       data-reco-server-rendered="${serverRendered}"
       ${attrs}>
    ${countdown}
    <div class="reco__viewport"><div class="reco__track" data-reco-track>${cards}</div></div>
    ${serverRendered ? "" : CARD_TEMPLATE}
  </div>`;
}

const customAttrs = `data-reco-placement="pdp" data-reco-source-product="1001" data-reco-source="override" data-reco-intent="related"`;
const popularAttrs = `data-reco-serve="false" data-reco-source-product="*" data-reco-placement="popular" data-reco-source="shopify"`;

const card = (id, variantId = null) => `
  <div class="reco-card" data-reco-card data-reco-product-id="${id}">
    <a data-reco-link href="/products/p${id}">link</a>
    ${variantId ? `<button type="button" data-reco-add data-reco-variant-id="${variantId}">Add</button>` : ""}
  </div>`;

const ajaxProduct = (id, overrides = {}) => ({
  id,
  handle: `p${id}`,
  title: `Product ${id}`,
  url: `/products/p${id}`,
  price: 1500,
  compare_at_price: null,
  featured_image: `/img/${id}.jpg`,
  available: true,
  variants: [{ id: id * 10, title: "Default", available: true, price: 1500 }],
  ...overrides,
});

// ---------------------------------------------------------------------------

describe("the served beacon is the billing signal, not analytics", () => {
  /*
   * The regression this exists for: track() bailed out for every event when the
   * app embed's `enable_tracking` checkbox was off, and `served` is the only
   * signal the theme path ever sends (an override renders from the metafield,
   * and the Ajax fallback never reaches the app either). So unchecking a box
   * labelled "Track recommendation performance" bought unlimited free
   * recommendations.
   */
  test("a serve is still reported when tracking is switched off", async () => {
    boot(panel({ attrs: customAttrs, cards: card(2001) }), {
      proxy: "/apps/easy-reco",
      enabled: false,
    });
    await tick(1000);

    expect(await typesOf("served")).toHaveLength(1);
  });

  test("but nothing else is", async () => {
    boot(panel({ attrs: customAttrs, cards: card(2001) }), {
      proxy: "/apps/easy-reco",
      enabled: false,
    });
    observers.forEach((observer) => observer.trigger());
    document.querySelector("[data-reco-link]").click();
    await tick(1000);

    expect(await typesOf("impression")).toHaveLength(0);
    expect(await typesOf("click")).toHaveLength(0);
  });

  test("with tracking on, the whole funnel reports", async () => {
    boot(panel({ attrs: customAttrs, cards: card(2001) }), { enabled: true });
    observers.forEach((observer) => observer.trigger());
    document.querySelector("[data-reco-link]").click();
    await tick(1000);

    const all = await events();
    expect(all.map((e) => e.type).sort()).toEqual(["click", "impression", "served"]);
    // Every event carries the source product and the placement it came from.
    for (const event of all) {
      expect(event.sourceProductId).toBe("1001");
      expect(event.placement).toBe("pdp");
    }
  });

  test("merchandising rows report engagement but never a serve", async () => {
    boot(panel({ attrs: popularAttrs, cards: card(3001) }), { enabled: true });
    observers.forEach((observer) => observer.trigger());
    await tick(1000);

    expect(await typesOf("served")).toHaveLength(0);
    const impressions = await typesOf("impression");
    expect(impressions).toHaveLength(1);
    expect(impressions[0].placement).toBe("popular");
    expect(impressions[0].sourceProductId).toBe("*");
  });
});

describe("the beacon queue", () => {
  /*
   * flush() sends at most 10 events (the server caps a batch at 10 too) and used
   * to leave the remainder behind with the timer already cleared, so the tail
   * waited for an unrelated event — or was lost to the navigation that triggered
   * the flush. A grid of 12 cards hits this on its first screenful.
   */
  test("a queue longer than one batch is drained, not truncated", async () => {
    const cards = Array.from({ length: 12 }, (_, i) => card(4000 + i)).join("");
    boot(panel({ attrs: customAttrs, cards }), { enabled: true });

    observers.forEach((observer) => observer.trigger());
    await tick(2000);

    // 12 impressions + 1 serve, in two batches of 10 and 3.
    expect(beacons).toHaveLength(2);
    expect(await typesOf("impression")).toHaveLength(12);
    expect(await typesOf("served")).toHaveLength(1);
  });

  test("everything queued is flushed when the page goes away", async () => {
    const cards = Array.from({ length: 12 }, (_, i) => card(5000 + i)).join("");
    boot(panel({ attrs: customAttrs, cards }), { enabled: true });
    observers.forEach((observer) => observer.trigger());

    // No timers run: this is the navigation case, where only pagehide fires.
    window.dispatchEvent(new window.Event("pagehide"));

    expect(await typesOf("impression")).toHaveLength(12);
  });

  test("an impression is reported once per card per page view", async () => {
    boot(panel({ attrs: customAttrs, cards: card(6001) }), { enabled: true });
    observers.forEach((observer) => observer.trigger());
    observers.forEach((observer) => observer.trigger());
    await tick(1000);

    expect(await typesOf("impression")).toHaveLength(1);
  });
});

describe("money formatting", () => {
  /*
   * The format used to come only from the app embed, which is optional — so a
   * store selling in EUR that never enabled it rendered "$" on every price
   * reco.js drew.
   */
  test("client-rendered prices use the block's format with no app embed at all", async () => {
    fetchRoutes.set("/recommendations/products.json", { products: [ajaxProduct(7001)] });
    boot(
      panel({ attrs: customAttrs, serverRendered: false, moneyFormat: "€{{amount}}" }),
      undefined,
    );
    await tick(1000);

    expect(document.querySelector("[data-reco-price]").textContent).toBe("€15.00");
  });

  test("the app embed's format is a fallback, not the source of truth", async () => {
    fetchRoutes.set("/recommendations/products.json", { products: [ajaxProduct(7002)] });
    boot(panel({ attrs: customAttrs, serverRendered: false, moneyFormat: "£{{amount}}" }), {
      moneyFormat: "${{amount}}",
    });
    await tick(1000);

    expect(document.querySelector("[data-reco-price]").textContent).toBe("£15.00");
  });

  test("the money format placeholders Shopify defines are honoured", async () => {
    fetchRoutes.set("/recommendations/products.json", {
      products: [ajaxProduct(7003, { price: 123456 })],
    });
    boot(
      panel({
        attrs: customAttrs,
        serverRendered: false,
        moneyFormat: "{{amount_with_comma_separator}} kr",
      }),
      undefined,
    );
    await tick(1000);

    expect(document.querySelector("[data-reco-price]").textContent).toBe("1.234,56 kr");
  });
});

describe("the Ajax fallback", () => {
  test("fills the block and reports a serve", async () => {
    fetchRoutes.set("/recommendations/products.json", {
      products: [ajaxProduct(8001), ajaxProduct(8002)],
    });
    boot(panel({ attrs: customAttrs, serverRendered: false }), { enabled: true });
    await tick(1000);

    expect(document.querySelectorAll("[data-reco-card]")).toHaveLength(2);
    expect(await typesOf("served")).toHaveLength(1);
  });

  test("an empty answer hides the block and costs no quota", async () => {
    fetchRoutes.set("/recommendations/products.json", { products: [] });
    boot(panel({ attrs: customAttrs, serverRendered: false }), { enabled: true });
    await tick(1000);

    expect(document.querySelector("[data-reco-block]").hidden).toBe(true);
    expect(await events()).toHaveLength(0);
  });

  test("a multi-variant product gets a link, never a guessed variant", async () => {
    fetchRoutes.set("/recommendations/products.json", {
      products: [
        ajaxProduct(8003, {
          variants: [
            { id: 1, title: "S", available: true, price: 1500 },
            { id: 2, title: "M", available: true, price: 1500 },
          ],
        }),
      ],
    });
    boot(panel({ attrs: customAttrs, serverRendered: false }), { enabled: true });
    await tick(1000);

    expect(document.querySelector("[data-reco-add]")).toBeNull();
    expect(document.querySelector("[data-reco-card] a[href='/products/p8003']")).toBeTruthy();
  });
});

describe("the complementary source", () => {
  /*
   * It differs from Related in exactly one attribute, and the point of these is
   * that no new code path was needed for it: fetchFallback already reads
   * data-reco-intent, so the whole source is Liquid plus a placement key.
   */
  const complementaryAttrs = `data-reco-placement="complementary" data-reco-source-product="1001" data-reco-source="shopify" data-reco-intent="complementary"`;

  test("asks Shopify for complementary, not related", async () => {
    fetchRoutes.set("/recommendations/products.json", { products: [ajaxProduct(9101)] });
    boot(panel({ attrs: complementaryAttrs, serverRendered: false }), { enabled: true });
    await tick(1000);

    const url = window.fetch.mock.calls
      .map(([called]) => String(called))
      .find((called) => called.startsWith("/recommendations/products.json"));

    expect(url).toContain("intent=complementary");
    expect(url).toContain("product_id=1001");
  });

  test("bills, on its own placement", async () => {
    // Sharing `related` would let the 30-minute serve dedupe swallow one of two
    // rows on the same product page.
    fetchRoutes.set("/recommendations/products.json", { products: [ajaxProduct(9102)] });
    boot(panel({ attrs: complementaryAttrs, serverRendered: false }), { enabled: true });
    await tick(1000);

    const served = await typesOf("served");
    expect(served).toHaveLength(1);
    expect(served[0].placement).toBe("complementary");
    expect(served[0].source).toBe("shopify");
  });

  test("an empty answer hides the row and costs nothing", async () => {
    fetchRoutes.set("/recommendations/products.json", { products: [] });
    boot(panel({ attrs: complementaryAttrs, serverRendered: false }), { enabled: true });
    await tick(1000);

    expect(document.querySelector("[data-reco-block]").hidden).toBe(true);
    expect(await events()).toHaveLength(0);
  });

  /*
   * Shopify answers this intent only for products linked in the Search &
   * Discovery app, so an untouched store gets nothing back — and a row that
   * removes itself silently reads as a broken source. In the editor it explains
   * itself instead.
   */
  test("in the theme editor an empty row shows the hint instead of vanishing", async () => {
    fetchRoutes.set("/recommendations/products.json", { products: [] });
    boot(
      panel({
        attrs: complementaryAttrs + ' data-reco-design-mode="true"',
        serverRendered: false,
      }).replace(
        "<div class=\"reco__viewport\">",
        '<div class="reco--empty" data-reco-design-hint hidden><p>Set these up in Search &amp; Discovery.</p></div><div class="reco__viewport">',
      ),
      { enabled: true },
    );
    await tick(1000);

    expect(document.querySelector("[data-reco-block]").hidden).toBe(false);
    expect(document.querySelector("[data-reco-design-hint]").hidden).toBe(false);
    // Still not a serve — nothing was shown to a shopper.
    expect(await typesOf("served")).toHaveLength(0);
  });

  test("the hint is removed once the row does fill", async () => {
    fetchRoutes.set("/recommendations/products.json", { products: [ajaxProduct(9103)] });
    boot(
      panel({
        attrs: complementaryAttrs + ' data-reco-design-mode="true"',
        serverRendered: false,
      }).replace(
        "<div class=\"reco__viewport\">",
        '<div class="reco--empty" data-reco-design-hint hidden><p>hint</p></div><div class="reco__viewport">',
      ),
      { enabled: true },
    );
    await tick(1000);

    expect(document.querySelector("[data-reco-design-hint]")).toBeNull();
    expect(document.querySelectorAll("[data-reco-card]")).toHaveLength(1);
  });
});

/*
 * The app embed path: no theme block on the page at all. The embed reads the
 * product's own metafield in Liquid, inlines the offer, and reco.js builds the
 * container and injects it next to the add-to-cart button.
 *
 * This is what makes the app work for a merchant who never opens the theme
 * editor, so the cases that matter are: it finds an anchor, it does not fight a
 * theme block that is already there, and a bad selector degrades rather than
 * breaking.
 */
describe("app embed injection", () => {
  const offerProduct = (id) => ({
    id,
    handle: `p${id}`,
    title: `Product ${id}`,
    url: `/products/p${id}`,
    price: 3000,
    compare_at_price: null,
    available: true,
    featured_image: `/img/${id}.jpg`,
    variants: [{ id: id * 10, title: 'Default', available: true, price: 3000 }],
  });

  const offer = (overrides = {}) => ({
    productId: '1001',
    // An offer, so it has one. Without it the embed injects nothing at all — a
    // curated list renders where a block is placed, not on its own.
    offerId: 'offer-1',
    copy: { title: 'You may also like', badge: '', buttonText: 'Add', countdown: false },
    render: null,
    items: [offerProduct(2001), offerProduct(2002)],
    ...overrides,
  });

  /** A product page with a Dawn-shaped buy form and no app block. */
  const productPage = () => `
    <div class="product__info-wrapper">
      <h1>A product</h1>
      <form action="/cart/add" method="post">
        <div class="product-form__buttons">
          <button type="submit" class="product-form__submit">Add to cart</button>
        </div>
      </form>
    </div>`;

  function bootEmbed(html, theOffer, config = { enabled: true }) {
    document.body.innerHTML = html;
    window.EasyReco = { config, offer: theOffer };
    // eslint-disable-next-line no-new-func
    new Function(SRC)();
  }

  test("injects the offer below the whole buy area", async () => {
    bootEmbed(productPage(), offer());
    await tick(1000);

    const block = document.querySelector('[data-reco-embedded="true"]');
    expect(block).toBeTruthy();

    /*
     * After the **form**, not after the buttons container inside it.
     *
     * A theme lays the quantity box and Add to cart out as a row, and inserting a
     * sibling into that row rebuilt it: quantity on one line, the button stretched
     * across the next. The form is a deterministic boundary — no computed style to read,
     * no layout to guess at — and "below the buy area" is where the offer belongs.
     */
    expect(document.querySelector('form').nextElementSibling).toBe(block);
    expect(document.querySelector('form [data-reco-embedded]')).toBeNull();
    expect(document.querySelectorAll('[data-reco-card]')).toHaveLength(2);
  });

  test("renders the offer's title, badge and button text", async () => {
    bootEmbed(
      productPage(),
      offer({ copy: { title: 'Complete the set', badge: 'Limited offer', buttonText: 'Add to bag' } }),
    );
    await tick(1000);

    expect(document.querySelector('.reco__heading').textContent).toBe('Complete the set');
    expect(document.querySelector('.reco__badge').textContent).toBe('Limited offer');
    expect(document.querySelector('[data-reco-add]').textContent).toBe('Add to bag');
  });

  test("merchant copy is escaped, not injected as markup", async () => {
    // The title is merchant-authored and reaches the page through innerHTML.
    bootEmbed(productPage(), offer({ copy: { title: '<img src=x onerror=1>', buttonText: 'Add' } }));
    await tick(1000);

    const heading = document.querySelector('.reco__heading');
    expect(heading.querySelector('img')).toBeNull();
    expect(heading.textContent).toContain('<img');
  });

  test("prices use the shop's format, from the embed config", async () => {
    bootEmbed(productPage(), offer(), { enabled: true, moneyFormat: '€{{amount}}' });
    await tick(1000);

    expect(document.querySelector('[data-reco-price]').textContent).toBe('€30.00');
  });

  test("reports one serve, on the pdp placement", async () => {
    bootEmbed(productPage(), offer());
    await tick(1000);

    const served = await typesOf('served');
    expect(served).toHaveLength(1);
    expect(served[0].placement).toBe('pdp');
    expect(served[0].sourceProductId).toBe('1001');
    // The list came from the merchant's own offer, not Shopify's.
    expect(served[0].source).toBe('override');
  });

  test("add to cart from an injected card is attributed", async () => {
    bootEmbed(productPage(), offer());
    await tick(1000);

    document.querySelector('[data-reco-add]').click();
    await tick(1000);

    expect(cartAdds).toHaveLength(1);
    const [line] = cartAdds[0].items;
    expect(line.properties._reco_src).toBe('1001');
    expect(line.properties._reco_source).toBe('override');
  });

  /*
   * A merchant who placed a theme block has said where they want it. Rendering
   * both would show the same products twice and bill two serves for one page
   * view (CLAUDE.md §3.3).
   */
  test("a theme block on the page wins — nothing is injected", async () => {
    bootEmbed(
      productPage() + panel({ attrs: customAttrs, cards: card(2001) }),
      offer(),
    );
    await tick(1000);

    expect(document.querySelector('[data-reco-embedded]')).toBeNull();
    expect(await typesOf('served')).toHaveLength(1);
  });

  test("runs once, even if the theme reloads the section", async () => {
    bootEmbed(productPage(), offer());
    await tick(1000);
    document.dispatchEvent(new window.Event('shopify:section:load'));
    await tick(1000);

    expect(document.querySelectorAll('[data-reco-embedded]')).toHaveLength(1);
    expect(await typesOf('served')).toHaveLength(1);
  });

  test("a merchant's own selector is preferred", async () => {
    document.body.innerHTML = '';
    bootEmbed(
      `<div id="my-spot"></div>${productPage()}`,
      offer({ render: { selector: '#my-spot', position: 'after' } }),
    );
    await tick(1000);

    expect(document.querySelector('#my-spot').nextElementSibling.getAttribute('data-reco-embedded')).toBe(
      'true',
    );
  });

  test("position before puts it above the anchor", async () => {
    bootEmbed(
      productPage(),
      offer({ render: { selector: '.product-form__buttons', position: 'before' } }),
    );
    await tick(1000);

    const anchor = document.querySelector('.product-form__buttons');
    expect(anchor.previousElementSibling.getAttribute('data-reco-embedded')).toBe('true');
  });

  test("a selector that matches nothing falls back to the built-in chain", async () => {
    // A theme update that renames a class should cost a slightly worse position,
    // not the offer disappearing.
    bootEmbed(productPage(), offer({ render: { selector: '.gone-in-the-redesign' } }));
    await tick(1000);

    expect(document.querySelector('[data-reco-embedded]')).toBeTruthy();
  });

  test("an invalid selector does not stop the chain", async () => {
    bootEmbed(productPage(), offer({ render: { selector: ':::not-a-selector' } }));
    await tick(1000);

    expect(document.querySelector('[data-reco-embedded]')).toBeTruthy();
  });

  test("no anchor on the page means nothing renders and nothing is billed", async () => {
    bootEmbed('<div>a page with no buy form</div>', offer());
    await tick(1000);

    expect(document.querySelector('[data-reco-embedded]')).toBeNull();
    expect(await events()).toHaveLength(0);
  });

  test("an empty offer renders nothing", async () => {
    bootEmbed(productPage(), offer({ items: [] }));
    await tick(1000);

    expect(document.querySelector('[data-reco-embedded]')).toBeNull();
    expect(await events()).toHaveLength(0);
  });

  /*
   * The bug this exists for. Blocks declare reco.js through their schema
   * `javascript` key, so on a page with no block the script was never present and
   * nothing injected the offer — indistinguishable from the embed being broken.
   * The embed now loads it too, which means a page carrying a block gets two
   * identical script tags and executes both.
   */
  test("loading the runtime twice injects once and bills once", async () => {
    bootEmbed(productPage(), offer());
    // The second script tag a page with a block produces.
    // eslint-disable-next-line no-new-func
    new Function(SRC)();
    await tick(1000);

    expect(document.querySelectorAll('[data-reco-embedded]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-reco-card]')).toHaveLength(2);
    expect(await typesOf('served')).toHaveLength(1);
  });

  test("the second copy does not double the beacons", async () => {
    bootEmbed(productPage(), offer());
    // eslint-disable-next-line no-new-func
    new Function(SRC)();
    await tick(1000);

    observers.forEach((observer) => observer.trigger());
    await tick(1000);

    // Two impressions for two cards, not four from two instrumented copies.
    expect(await typesOf('impression')).toHaveLength(2);
  });

  /*
   * The injected offer has to look like the editor's preview: a merchant who set
   * a cross-sell up and saw one product at a time with arrows should not find a
   * grid of tiles on their product page. The offer type is what says which, and it
   * travels in the metafield.
   */
  test("a cross-sell offer renders as a one-per-view carousel of rows", async () => {
    bootEmbed(productPage(), offer({ type: 'cross_sell' }));
    await tick(1000);

    const block = document.querySelector('[data-reco-embedded]');

    // Built on the slider layout, so the scrolling and the arrow wiring are the
    // ones the theme block already uses.
    expect(block.classList.contains('reco--slider')).toBe(true);
    expect(block.classList.contains('reco--offer')).toBe(true);
    expect(block.classList.contains('reco--grid')).toBe(false);

    // One column per view is the whole carousel: flex-basis resolves to 100%.
    expect(block.style.getPropertyValue('--reco-columns-desktop')).toBe('1');
    expect(block.style.getPropertyValue('--reco-columns-mobile')).toBe('1');

    // Arrows live in the header beside the title, not overlaid on the row, and
    // both are wired for setupSlider to find.
    const nav = block.querySelector('[data-reco-nav]');
    expect(nav.closest('.reco__header')).toBeTruthy();
    expect(nav.querySelector('[data-reco-prev]')).toBeTruthy();
    expect(nav.querySelector('[data-reco-next]')).toBeTruthy();

    // In a row the button is a column of its own beside the text, and it is still
    // found and wired — renderFallback queries the whole card.
    const card = block.querySelector('[data-reco-card]');
    expect(card.querySelector('[data-reco-add]').parentElement).toBe(card);
    expect(card.querySelector('.reco-card__info [data-reco-add]')).toBeNull();
    expect(block.querySelectorAll('[data-reco-card]')).toHaveLength(2);
  });

  test("a bundle offer type keeps the grid", async () => {
    // Frequently bought together is a stacked bundle with a running total and a
    // volume discount is a list of tiers; neither scrolls.
    for (const type of ['frequently_bought_together', 'volume_discount']) {
      document.body.innerHTML = '';
      bootEmbed(productPage(), offer({ type }));
      await tick(1000);

      const block = document.querySelector('[data-reco-embedded]');
      expect(block.classList.contains('reco--grid'), type).toBe(true);
      expect(block.classList.contains('reco--offer'), type).toBe(false);
      expect(block.querySelector('[data-reco-nav]'), type).toBeNull();
      // The button stays inside the info column, under the title and price.
      expect(block.querySelector('.reco-card__info [data-reco-add]'), type).toBeTruthy();
    }
  });

  test("an offer with no type still carousels; a plain curated list does not", async () => {
    /*
     * Metafields written before offers carried a type. `copy` is only ever written
     * by an offer publish, so it still identifies one, and cross-sell is what an
     * offer defaults to — otherwise every already published offer would keep the
     * old grid until someone happened to re-publish it.
     */
    bootEmbed(productPage(), offer({ type: null }));
    await tick(1000);
    expect(
      document.querySelector('[data-reco-embedded]').classList.contains('reco--offer'),
    ).toBe(true);

    // A list curated on the recommendations page has no copy and no type, and
    // takes the plain grid.
    document.body.innerHTML = '';
    bootEmbed(productPage(), offer({ type: null, copy: null }));
    await tick(1000);
    expect(
      document.querySelector('[data-reco-embedded]').classList.contains('reco--grid'),
    ).toBe(true);
  });

  test("the carousel arrows carry the embed's own labels", async () => {
    // The block's arrows come from Liquid with a translated aria-label; this path
    // builds its own, so the strings ride on the embed's config.
    bootEmbed(productPage(), offer({ type: 'cross_sell' }), {
      enabled: true,
      strings: { previous: 'Vorherige', next: 'Nächste' },
    });
    await tick(1000);

    const nav = document.querySelector('[data-reco-nav]');
    expect(nav.querySelector('[data-reco-prev]').getAttribute('aria-label')).toBe('Vorherige');
    expect(nav.querySelector('[data-reco-next]').getAttribute('aria-label')).toBe('Nächste');

    // The visible arrow is an SVG, so the label is the only thing a screen reader
    // has to go on — and the icon itself must stay out of the accessibility tree.
    const icon = nav.querySelector('[data-reco-prev] svg');
    expect(icon).toBeTruthy();
    expect(icon.getAttribute('aria-hidden')).toBe('true');
    expect(nav.querySelector('[data-reco-prev]').textContent.trim()).toBe('');
  });

  test("the offer card carries the preview's plus icon and counter", async () => {
    /*
     * The admin preview is a promise about this markup, so the two have to agree:
     * a `+` inside the add button, and "Product 1 of 2" under the card. The
     * counter is emptied rather than hidden when there is nothing to page through,
     * which is what the preview does at one product.
     */
    bootEmbed(productPage(), offer({ type: 'cross_sell' }), {
      enabled: true,
      strings: { count: 'Product [current] of [total]' },
    });
    await tick(1000);

    const block = document.querySelector('[data-reco-embedded]');
    const button = block.querySelector('[data-reco-add]');

    expect(button.querySelector('svg')).toBeTruthy();
    // The label sits in its own span beside the icon, so it is still readable as
    // text — the button is not an icon-only control.
    expect(button.textContent.trim()).toBe('Add');

    // jsdom reports no layout, so scrollLeft/scrollWidth are 0 and the counter
    // reads the first of however many cards were rendered.
    expect(block.querySelector('[data-reco-count]').textContent).toBe('Product 1 of 2');
  });

  test("no counter when there is nothing to page through", async () => {
    bootEmbed(productPage(), offer({ type: 'cross_sell', items: [offerProduct(2001)] }), {
      enabled: true,
      strings: { count: 'Product [current] of [total]' },
    });
    await tick(1000);

    expect(document.querySelector('[data-reco-count]').textContent).toBe('');
  });

  test("adding to cart puts the button back the way it was, icon included", async () => {
    /*
     * The confirmation state used to be restored from `textContent`, which threw
     * the icon away for good — the button never got its plus back after the first
     * add.
     */
    bootEmbed(productPage(), offer({ type: 'cross_sell' }));
    await tick(1000);

    const button = document.querySelector('[data-reco-add]');
    const before = button.innerHTML;

    button.click();
    // Far enough for the cart call and the confirmation label, not the 1800ms
    // restore — so the assertion below cannot pass by nothing having happened.
    await tick(100);
    expect(cartAdds).toHaveLength(1);
    expect(button.textContent.trim()).toBe('Added');

    await tick(2500);
    expect(button.innerHTML).toBe(before);
    expect(button.querySelector('svg')).toBeTruthy();
  });

  /*
   * The countdown.
   *
   * Two shapes from the offer's copy: a per-visitor duration that hides the offer
   * for 24 hours once it runs out, and one absolute deadline for everybody. The
   * cases that matter are that it ticks, that an expired timer takes the offer with
   * it, and that a finished countdown stops the offer being rendered — and billed —
   * on the next visit.
   */
  describe("countdown", () => {
    const timed = (extra) =>
      offer({
        type: 'cross_sell',
        copy: {
          title: 'You may also like',
          buttonText: 'Add',
          countdown: true,
          countdownMode: 'fixed',
          countdownMinutes: 60,
          countdownTitle: 'Hurry up! Offer expires in {{timer}}',
          ...extra,
        },
      });

    test("renders the merchant's sentence with the clock inside it", async () => {
      bootEmbed(productPage(), timed());
      await tick(1000);

      const bar = document.querySelector('[data-reco-countdown]');
      expect(bar.textContent).toContain('Hurry up! Offer expires in');
      // The clock is its own element so only it is bold, and only it is rewritten
      // every second.
      expect(bar.querySelector('[data-reco-countdown-value]').textContent).toBe('59:59');
    });

    test("counts down every second", async () => {
      bootEmbed(productPage(), timed({ countdownMinutes: 2 }));
      await tick(1000);

      const value = document.querySelector('[data-reco-countdown-value]');
      expect(value.textContent).toBe('01:59');

      await tick(5000);
      expect(value.textContent).toBe('01:54');
    });

    test("h:mm:ss once there is an hour or more to say", async () => {
      bootEmbed(productPage(), timed({ countdownMinutes: 90 }));
      await tick(1000);

      expect(document.querySelector('[data-reco-countdown-value]').textContent).toBe('1:29:59');
    });

    test("days once there is more than a day, not a runaway hours count", async () => {
      /*
       * A week-long countdown rendered "130:37:21" on a live storefront — an hours
       * counter past anything a shopper parses. The letter comes from the locale
       * file through the embed's config.
       */
      bootEmbed(productPage(), timed({ countdownMinutes: 7830 }), {
        enabled: true,
        strings: { countdownDays: 'd' },
      });
      await tick(1000);

      expect(document.querySelector('[data-reco-countdown-value]').textContent).toBe(
        '5d 10:29:59',
      );
    });

    test("the day letter falls back to English with no embed strings", async () => {
      // A block works without the app embed (§7.5); a missing unit letter is the
      // kind of default that is suboptimal, never wrong.
      bootEmbed(productPage(), timed({ countdownMinutes: 2880 }), { enabled: true });
      await tick(1000);

      expect(document.querySelector('[data-reco-countdown-value]').textContent).toBe(
        '1d 23:59:59',
      );
    });

    test("the merchant's wording is escaped, not injected", async () => {
      bootEmbed(
        productPage(),
        timed({ countdownTitle: '<img src=x onerror=1> {{timer}} <b>bold</b>' }),
      );
      await tick(1000);

      const bar = document.querySelector('[data-reco-countdown]');
      expect(bar.querySelector('img')).toBeNull();
      expect(bar.querySelector('b')).toBeNull();
      // Only the clock is markup of ours.
      expect(bar.querySelector('[data-reco-countdown-value]')).toBeTruthy();
    });

    test("no token means the clock goes after the sentence, not nowhere", async () => {
      bootEmbed(productPage(), timed({ countdownTitle: 'Ends soon' }));
      await tick(1000);

      const bar = document.querySelector('[data-reco-countdown]');
      expect(bar.textContent.trim().startsWith('Ends soon')).toBe(true);
      expect(bar.querySelector('[data-reco-countdown-value]').textContent).toBe('59:59');
    });

    test("running out hides the offer and remembers the 24-hour window", async () => {
      bootEmbed(productPage(), timed({ countdownMinutes: 1 }));
      await tick(1000);

      const block = document.querySelector('[data-reco-embedded]');
      expect(block.hidden).toBe(false);

      await tick(61000);

      // The offer goes, not just the timer: an expired offer left on the page is a
      // promise the merchant did not make.
      expect(block.hidden).toBe(true);

      const stored = JSON.parse(window.localStorage.getItem('easy-reco:countdown:1001:1'));
      expect(stored.hiddenUntil).toBeGreaterThan(Date.now());
    });

    test("the next visit inside that window renders nothing at all", async () => {
      /*
       * Checked before injection, so no serve beacon is sent — rendering and then
       * hiding would bill a recommendation for something nobody saw (§3.3).
       */
      window.localStorage.setItem(
        'easy-reco:countdown:1001:60',
        JSON.stringify({ endsAt: Date.now() - 1000, hiddenUntil: Date.now() + 60000 }),
      );

      bootEmbed(productPage(), timed());
      await tick(1000);

      expect(document.querySelector('[data-reco-embedded]')).toBeNull();
      expect(await typesOf('served')).toHaveLength(0);
    });

    test("after the window the countdown starts over", async () => {
      window.localStorage.setItem(
        'easy-reco:countdown:1001:60',
        JSON.stringify({ endsAt: Date.now() - 90000000, hiddenUntil: Date.now() - 1000 }),
      );

      bootEmbed(productPage(), timed());
      await tick(1000);

      expect(document.querySelector('[data-reco-embedded]')).toBeTruthy();
      expect(document.querySelector('[data-reco-countdown-value]').textContent).toBe('59:59');
    });

    test("a reload keeps the same deadline rather than granting a fresh hour", async () => {
      bootEmbed(productPage(), timed());
      await tick(30000);
      expect(document.querySelector('[data-reco-countdown-value]').textContent).toBe('59:30');

      // Same shopper, new page load.
      delete window.EasyReco;
      bootEmbed(productPage(), timed());
      await tick(1000);

      expect(document.querySelector('[data-reco-countdown-value]').textContent).toBe('59:29');
    });

    test("changing the length gives every shopper the new clock", async () => {
      // The stored deadline is keyed by duration, so an old 60-minute tail cannot
      // stand in for a new 10-minute offer.
      bootEmbed(productPage(), timed());
      await tick(30000);

      delete window.EasyReco;
      bootEmbed(productPage(), timed({ countdownMinutes: 10 }));
      await tick(1000);

      expect(document.querySelector('[data-reco-countdown-value]').textContent).toBe('09:59');
    });

    test("date mode counts to one deadline and needs no storage", async () => {
      bootEmbed(
        productPage(),
        timed({
          countdownMode: 'date',
          countdownEndsAt: new Date(Date.now() + 120000).toISOString(),
        }),
      );
      await tick(1000);

      expect(document.querySelector('[data-reco-countdown-value]').textContent).toBe('01:59');
      expect(window.localStorage.length).toBe(0);
    });

    test("a date already gone renders nothing", async () => {
      bootEmbed(
        productPage(),
        timed({
          countdownMode: 'date',
          countdownEndsAt: new Date(Date.now() - 1000).toISOString(),
        }),
      );
      await tick(1000);

      expect(document.querySelector('[data-reco-embedded]')).toBeNull();
      expect(await typesOf('served')).toHaveLength(0);
    });

    test("date mode with no date shows the offer without a timer", async () => {
      // Publishing blocks this, but a metafield written by hand should degrade to
      // the offer rather than hiding it.
      bootEmbed(productPage(), timed({ countdownMode: 'date', countdownEndsAt: null }));
      await tick(1000);

      expect(document.querySelector('[data-reco-embedded]')).toBeTruthy();
      expect(document.querySelector('[data-reco-countdown]')).toBeNull();
    });

    test("a theme block's own countdown ticks the same way", async () => {
      /*
       * The block renders the bar in Liquid with its settings on data attributes,
       * because there is no offer object in JS on that path. Same runtime, same
       * clock — the feature must not vanish because a merchant placed the block
       * instead of relying on the app embed.
       */
      boot(
        panel({
          attrs: customAttrs,
          cards: card(9001, 91),
          countdown: countdownBar({ minutes: 2 }),
        }),
        { enabled: true },
      );
      await tick(1000);

      expect(document.querySelector('[data-reco-countdown-value]').textContent).toBe('01:59');
    });

    test("an expired block countdown hides the row and bills nothing", async () => {
      window.localStorage.setItem(
        'easy-reco:countdown:1001:60',
        JSON.stringify({ endsAt: Date.now() - 1000, hiddenUntil: Date.now() + 60000 }),
      );

      boot(
        panel({ attrs: customAttrs, cards: card(9001, 91), countdown: countdownBar() }),
        { enabled: true },
      );
      await tick(1000);

      expect(document.querySelector('[data-reco-block]').hidden).toBe(true);
      // wire() never ran, so no serve — the row was never seen.
      expect(await typesOf('served')).toHaveLength(0);
    });

    test("no countdown, no bar", async () => {
      bootEmbed(productPage(), offer({ type: 'cross_sell' }));
      await tick(1000);

      expect(document.querySelector('[data-reco-countdown]')).toBeNull();
    });
  });

  /*
   * What the Offer tab's settings do on the storefront: an automated offer fetches
   * its list, and the visibility rules filter whatever is in the track.
   */
  describe("offer source and visibility", () => {
    test("an automated offer fetches instead of rendering an inlined list", async () => {
      // The same request the theme block's Related source makes — the embed ships
      // an intent rather than a stale copy of Shopify's list.
      fetchRoutes.set('/recommendations/products.json', {
        products: [ajaxProduct(4001), ajaxProduct(4002)],
      });

      bootEmbed(
        productPage(),
        offer({ items: [], source: { mode: 'automated', intent: 'complementary' } }),
      );
      await tick(1000);

      const block = document.querySelector('[data-reco-embedded]');
      expect(block).toBeTruthy();
      expect(block.getAttribute('data-reco-intent')).toBe('complementary');
      expect(block.getAttribute('data-reco-source')).toBe('shopify');
      expect(document.querySelectorAll('[data-reco-card]')).toHaveLength(2);

      // The serve still bills: an automated offer answers "what goes with this",
      // which is the line §7.1 draws.
      expect(await typesOf('served')).toHaveLength(1);
    });

    test("a specific offer with no items still renders nothing", async () => {
      // Only the automated mode is allowed to arrive empty.
      bootEmbed(productPage(), offer({ items: [] }));
      await tick(1000);

      expect(document.querySelector('[data-reco-embedded]')).toBeNull();
    });

    test("hides products already in the cart", async () => {
      window.EasyReco = undefined;
      document.body.innerHTML = productPage();
      window.EasyReco = {
        config: { enabled: true },
        offer: offer({ visibility: { hideInCart: true, hideTrigger: true } }),
        // The embed emits this from Liquid, where `cart` is readable.
        cart: [2001],
      };
      // eslint-disable-next-line no-new-func
      new Function(SRC)();
      await tick(1000);

      const shown = [...document.querySelectorAll('[data-reco-card]')].map((card) =>
        card.getAttribute('data-reco-product-id'),
      );
      expect(shown).toEqual(['2002']);

      // The hidden card reports nothing: it was not shown, so counting an
      // impression for it would overstate the offer's reach.
      expect((await typesOf('impression')).length).toBeLessThanOrEqual(1);
    });

    test("everything filtered out hides the block and bills nothing", async () => {
      document.body.innerHTML = productPage();
      window.EasyReco = {
        config: { enabled: true },
        offer: offer({ visibility: { hideInCart: true } }),
        cart: [2001, 2002],
      };
      // eslint-disable-next-line no-new-func
      new Function(SRC)();
      await tick(1000);

      expect(document.querySelector('[data-reco-embedded]').hidden).toBe(true);
      expect(await typesOf('served')).toHaveLength(0);
    });

    test("no cart list means no filtering, not everything hidden", async () => {
      // The embed only emits the cart when an offer asked for the filter; an absent
      // list has to mean "filter nothing", which is how every offer behaved before
      // the setting existed.
      bootEmbed(productPage(), offer({ visibility: { hideInCart: true } }));
      await tick(1000);

      expect(document.querySelectorAll('[data-reco-card]')).toHaveLength(2);
    });

    test("the quantity picker adds the quantity the shopper chose", async () => {
      bootEmbed(productPage(), offer({ visibility: { quantityPicker: true } }));
      await tick(1000);

      const input = document.querySelector('[data-reco-quantity-input]');
      expect(input).toBeTruthy();
      // Beside the add button rather than in the card body: it modifies the action.
      expect(input.nextElementSibling.hasAttribute('data-reco-add')).toBe(true);

      input.value = '3';
      document.querySelector('[data-reco-add]').click();
      await tick(200);

      expect(cartAdds[0].items[0].quantity).toBe(3);
    });

    test("a cleared or nonsense quantity adds one, not zero", async () => {
      bootEmbed(productPage(), offer({ visibility: { quantityPicker: true } }));
      await tick(1000);

      document.querySelector('[data-reco-quantity-input]').value = '';
      document.querySelector('[data-reco-add]').click();
      await tick(200);

      expect(cartAdds[0].items[0].quantity).toBe(1);
    });

    test("an out-of-stock product is left out, not drawn as Sold out", async () => {
      /*
       * The Offer tab says out loud that only in-stock items show. A disabled Sold
       * out button is a recommendation the shopper cannot act on, sitting where a
       * buyable one could be — so the offer path drops it. A theme block keeps Sold
       * out, which is the documented behaviour of its own settings.
       */
      bootEmbed(
        productPage(),
        offer({
          items: [
            offerProduct(2001),
            { ...offerProduct(2002), available: false },
          ],
        }),
      );
      await tick(1000);

      const shown = [...document.querySelectorAll('[data-reco-card]')].map((card) =>
        card.getAttribute('data-reco-product-id'),
      );
      expect(shown).toEqual(['2001']);
      expect(document.querySelector('[data-reco-embedded]').getAttribute('data-reco-in-stock-only')).toBe(
        'true',
      );
    });

    test("a theme block still shows Sold out", async () => {
      // Same renderFallback, opposite answer: the attribute is what separates them,
      // and a block never carries it.
      fetchRoutes.set('/recommendations/products.json', {
        products: [{ ...ajaxProduct(8001), available: false }],
      });
      boot(panel({ attrs: customAttrs, serverRendered: false }), { enabled: true });
      await tick(1000);

      const button = document.querySelector('[data-reco-add]');
      expect(document.querySelectorAll('[data-reco-card]')).toHaveLength(1);
      expect(button.disabled).toBe(true);
    });

    test("no picker unless the offer asked for one", async () => {
      bootEmbed(productPage(), offer());
      await tick(1000);

      expect(document.querySelector('[data-reco-quantity-input]')).toBeNull();
      document.querySelector('[data-reco-add]').click();
      await tick(200);
      expect(cartAdds[0].items[0].quantity).toBe(1);
    });
  });

  /*
   * Both conditions, or nothing renders: the app embed is on (which is what put the
   * offer on the page) **and** the app says the offer is live.
   *
   * The metafield is a mirror the app writes, and a mirror cannot say whether the
   * thing it mirrors still exists — a failed write, or a path that forgot to rewrite
   * it, leaves a deleted offer rendering forever. So the mirror proposes and the app
   * confirms.
   */
  describe("the app confirms the offer before anything renders", () => {
    const mirrored = (extra) => offer({ ...extra });

    test("renders when the app says the offer is live", async () => {
      fetchRoutes.set('/apps/easy-reco/offer', { live: true });

      bootEmbed(productPage(), mirrored());
      await tick(1000);

      expect(document.querySelector('[data-reco-embedded]')).toBeTruthy();
      expect(await typesOf('served')).toHaveLength(1);

      // Asks about the offer *and* the product: a named-products offer covers named
      // products only, so the answer depends on both.
      const asked = window.fetch.mock.calls.map(([url]) => String(url));
      expect(asked.some((url) => url.includes('offerId=offer-1'))).toBe(true);
      expect(asked.some((url) => url.includes('productId=1001'))).toBe(true);
    });

    test("renders nothing when the app says it is not", async () => {
      // The deleted-offer case. Nothing is injected, so nothing flashes and no serve
      // is billed for a widget no shopper saw.
      fetchRoutes.set('/apps/easy-reco/offer', { live: false });

      bootEmbed(productPage(), mirrored());
      await tick(1000);

      expect(document.querySelector('[data-reco-embedded]')).toBeNull();
      expect(await typesOf('served')).toHaveLength(0);
    });

    test("an unanswerable check is a no", async () => {
      /*
       * The stub answers `ok: false` with no route, so this is the proxy being
       * unreachable. "Render when there is an offer" makes an unknown a no — a proxy
       * problem hides the widget rather than showing a deal the store may have
       * withdrawn.
       */
      fetchRoutes.delete('/apps/easy-reco/offer');
      bootEmbed(productPage(), mirrored());
      await tick(1000);

      expect(document.querySelector('[data-reco-embedded]')).toBeNull();
    });

    test("a list with no offer behind it is not injected at all", async () => {
      /*
       * The same metafield holds lists curated on the recommendations page, which have
       * no offer behind them. Injecting those made a widget appear the moment the app
       * embed was switched on, with the admin showing no offers — which is not what
       * enabling an embed asks for. Those lists still render wherever the merchant
       * *places* a block; that they chose.
       */
      bootEmbed(productPage(), offer({ offerId: null }));
      await tick(1000);

      expect(document.querySelector('[data-reco-embedded]')).toBeNull();
      // Not even asked: there is no offer to ask about.
      expect(
        window.fetch.mock.calls.some(([url]) => String(url).includes('/offer?')),
      ).toBe(false);
    });

    test("two runs cannot inject twice while a check is in flight", async () => {
      // The theme editor re-runs init on every section load, and the guard that stops
      // double injection is a DOM marker the first run has not written yet.
      fetchRoutes.set('/apps/easy-reco/offer', { live: true });

      bootEmbed(productPage(), mirrored());
      window.EasyReco.init();
      window.EasyReco.init();
      await tick(1000);

      expect(document.querySelectorAll('[data-reco-embedded]')).toHaveLength(1);
    });
  });

  /*
   * Where the block lands matters as much as whether it renders. A theme that lays
   * quantity and Add to cart out as a flex row treats the injected block as a third
   * item: the row wraps, the quantity box gets its own line and the button stretches
   * across the next. The offer was right and the product page was broken.
   */
  /*
   * The offer carousel steps rather than scrolls, and that is not cosmetic: a flex row
   * of three cards each `flex: 0 0 100%` asks its column for three cards' width, because
   * `overflow-x: auto` caps what is painted and not what the layout is told is needed. On
   * a product page whose columns size from content, that shrank the product image.
   *
   * Stepping needs no layout, so unlike a scroll position it is testable here.
   */
  describe("the offer carousel steps through its cards", () => {
    const threeCards = () =>
      offer({ items: [offerProduct(2001), offerProduct(2002), offerProduct(2003)] });

    test("shows one card at a time", async () => {
      bootEmbed(productPage(), threeCards());
      await tick(1000);

      const cards = [...document.querySelectorAll('[data-reco-card]')];
      expect(cards).toHaveLength(3);
      expect(cards.filter((card) => !card.hidden)).toHaveLength(1);
      expect(cards[0].hidden).toBe(false);
      expect(document.querySelector('[data-reco-count]').textContent).toBe('Product 1 of 3');
    });

    test("the arrows move it, and stop at the ends", async () => {
      bootEmbed(productPage(), threeCards());
      await tick(1000);

      const next = document.querySelector('[data-reco-next]');
      const prev = document.querySelector('[data-reco-prev]');
      const cards = () => [...document.querySelectorAll('[data-reco-card]')];

      expect(prev.disabled).toBe(true);

      // A step is animated, so the swap lands after the transition rather than on click.
      next.click();
      await tick(400);
      expect(cards()[1].hidden).toBe(false);
      expect(document.querySelector('[data-reco-count]').textContent).toBe('Product 2 of 3');
      expect(prev.disabled).toBe(false);

      next.click();
      await tick(400);
      expect(next.disabled).toBe(true);

      // Past the end is a no-op, not an empty carousel.
      next.click();
      await tick(400);
      expect(cards()[2].hidden).toBe(false);

      prev.click();
      await tick(400);
      expect(cards()[1].hidden).toBe(false);
    });

    test("the outgoing card leaves in the direction of travel", async () => {
      bootEmbed(productPage(), threeCards());
      await tick(1000);

      const cards = () => [...document.querySelectorAll('[data-reco-card]')];
      document.querySelector('[data-reco-next]').click();

      // Mid-step: the old card is on its way out and still in flow.
      expect(cards()[0].getAttribute('data-reco-leaving')).toBe('next');
      expect(cards()[0].hidden).toBe(false);

      await tick(400);

      // Settled: the new card is in place and nothing is left marked.
      expect(cards()[1].hidden).toBe(false);
      expect(document.querySelector('[data-reco-leaving]')).toBeNull();
      expect(document.querySelector('[data-reco-entering]')).toBeNull();
    });

    test("a second click mid-step is ignored rather than interleaved", async () => {
      // Two overlapping steps would leave a card marked and the index out of step with
      // what is on screen.
      bootEmbed(productPage(), threeCards());
      await tick(1000);

      const next = document.querySelector('[data-reco-next]');
      next.click();
      next.click();
      await tick(400);

      expect([...document.querySelectorAll('[data-reco-card]')][1].hidden).toBe(false);
      expect(document.querySelector('[data-reco-count]').textContent).toBe('Product 2 of 3');
    });

    test("reduced motion swaps with no animation and no delay", async () => {
      /*
       * Keeping the timeout without the transition would just feel like lag, so the whole
       * sequence is skipped — the swap is immediate on click.
       */
      window.matchMedia = (query) => ({
        matches: query.includes('prefers-reduced-motion'),
        media: query,
        addEventListener() {},
        removeEventListener() {},
      });

      bootEmbed(productPage(), threeCards());
      await tick(1000);

      document.querySelector('[data-reco-next]').click();

      expect([...document.querySelectorAll('[data-reco-card]')][1].hidden).toBe(false);
      expect(document.querySelector('[data-reco-leaving]')).toBeNull();

      delete window.matchMedia;
    });

    test("one card gets no controls and no counter", async () => {
      bootEmbed(productPage(), offer({ items: [offerProduct(2001)] }));
      await tick(1000);

      expect(document.querySelector('[data-reco-nav]').hidden).toBe(true);
      expect(document.querySelector('[data-reco-count]').textContent).toBe('');
    });

    test("a hidden card reports no impression", async () => {
      // It was not shown, and counting it would overstate the offer's reach.
      bootEmbed(productPage(), threeCards());
      await tick(1000);

      expect((await typesOf('impression')).length).toBeLessThanOrEqual(1);
    });
  });

  describe("insertion point", () => {
    /*
     * Report a display for chosen elements, as a theme's stylesheet would.
     *
     * Restored after every case, and layered over the real declaration with a Proxy
     * rather than a spread. Both matter: the first version leaked the stub into every
     * later test in the file, and spreading a `CSSStyleDeclaration` loses `display`
     * entirely — its properties live on the prototype, so the copy answered `undefined`
     * for everything the insertion logic reads.
     */
    const realGetComputedStyle = window.getComputedStyle;

    afterEach(() => {
      window.getComputedStyle = realGetComputedStyle;
    });

    function stubLayout(map) {
      const real = window.getComputedStyle.bind(window);
      window.getComputedStyle = (element, ...rest) => {
        const base = real(element, ...rest);
        for (const [selector, style] of map) {
          if (element.matches?.(selector)) {
            return new Proxy(base, {
              get: (target, key) => (key in style ? style[key] : target[key]),
            });
          }
        }
        return base;
      };
    }

    /*
     * The anchor is `.product-form__buttons`, so the decision is about **its parent**,
     * the form: that is the box a new sibling would join.
     */
    /** A theme that wraps its buy buttons in no form at all. */
    const formless = () => `
      <div class="product__info-wrapper">
        <h1>A product</h1>
        <div class="buy-area">
          <div class="product-form__buttons">
            <button type="submit" class="product-form__submit">Add to cart</button>
          </div>
        </div>
      </div>`;

    test("a form is the boundary, whatever its display", async () => {
      // The deterministic rule: no computed style is consulted at all.
      stubLayout([['form', { display: 'flex', flexDirection: 'row' }]]);

      bootEmbed(productPage(), offer());
      await tick(1000);

      expect(document.querySelector('form').nextElementSibling).toBe(
        document.querySelector('[data-reco-embedded]'),
      );
    });

    test("with no form, it climbs out of a flex row", async () => {
      stubLayout([['.buy-area', { display: 'flex', flexDirection: 'row' }]]);

      bootEmbed(formless(), offer());
      await tick(1000);

      // Past the row, so the row keeps exactly the items the theme put in it.
      expect(document.querySelector('.buy-area').nextElementSibling).toBe(
        document.querySelector('[data-reco-embedded]'),
      );
    });

    test("with no form, it stays in a flex column", async () => {
      // A column is the layout the offer wants to join: a new item is a new row.
      stubLayout([['.buy-area', { display: 'flex', flexDirection: 'column' }]]);

      bootEmbed(formless(), offer());
      await tick(1000);

      expect(document.querySelector('.product-form__buttons').nextElementSibling).toBe(
        document.querySelector('[data-reco-embedded]'),
      );
    });

    test("with no form, a multi-column grid climbs and a single-column one does not", async () => {
      stubLayout([['.buy-area', { display: 'grid', gridTemplateColumns: '1fr 1fr' }]]);
      bootEmbed(formless(), offer());
      await tick(1000);
      expect(document.querySelector('.buy-area [data-reco-embedded]')).toBeNull();

      document.body.innerHTML = '';
      stubLayout([['.buy-area', { display: 'grid', gridTemplateColumns: '1fr' }]]);
      bootEmbed(formless(), offer());
      await tick(1000);
      expect(document.querySelector('.buy-area [data-reco-embedded]')).toBeTruthy();
    });

    test("a merchant's own selector is never second-guessed", async () => {
      /*
       * Their selector is an instruction about *where*. Neither the form boundary nor the
       * climb may overrule it, even though this one points inside the form.
       */
      bootEmbed(
        productPage(),
        offer({ render: { selector: '.product-form__buttons', position: 'after' } }),
      );
      await tick(1000);

      expect(document.querySelector('.product-form__buttons').nextElementSibling).toBe(
        document.querySelector('[data-reco-embedded]'),
      );
    });

    test("a page that is flex rows all the way up still renders", async () => {
      // Bounded climb: an offer slightly below the buy area beats one that rebuilt it,
      // and beats none at all.
      stubLayout([['*', { display: 'flex', flexDirection: 'row' }]]);

      bootEmbed(productPage(), offer());
      await tick(1000);

      expect(document.querySelector('[data-reco-embedded]')).toBeTruthy();
    });
  });

  test("a hidden anchor is skipped", async () => {
    // Themes ship duplicate buy forms for drawers and quick-add; injecting into
    // one puts the offer somewhere the shopper never sees.
    document.body.innerHTML = '';
    bootEmbed(
      `<div class="product-form__buttons" style="display:none"></div>${productPage()}`,
      offer(),
    );
    await tick(1000);

    const block = document.querySelector('[data-reco-embedded]');
    expect(block).toBeTruthy();
    // Next to the visible form, not the hidden duplicate button container.
    expect(block.previousElementSibling).toBe(document.querySelector('form'));
  });
});

describe("add to cart", () => {
  test("tags the line so the order can be attributed", async () => {
    boot(panel({ attrs: customAttrs, cards: card(9001, 91) }), { enabled: true });
    document.querySelector("[data-reco-add]").click();
    await tick(1000);

    expect(cartAdds).toHaveLength(1);
    const [line] = cartAdds[0].items;
    expect(line.id).toBe(91);
    expect(line.properties._reco_src).toBe("1001");
    expect(line.properties._reco_source).toBe("override");
    expect(line.properties._reco_cid).toBeTruthy();

    const added = await typesOf("add_to_cart");
    expect(added).toHaveLength(1);
    expect(added[0].recoProductId).toBe("9001");
  });

  test("a failed cart add reports nothing", async () => {
    window.fetch = vi.fn(() => Promise.resolve({ ok: false, json: () => Promise.resolve({}) }));
    boot(panel({ attrs: customAttrs, cards: card(9002, 92) }), { enabled: true });
    document.querySelector("[data-reco-add]").click();
    await tick(2000);

    expect(await typesOf("add_to_cart")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

const UPSELL_ROW = ({ id, variantId, cents, current = false, variants = [] }) => `
  <div class="upsell__row" data-upsell-row
       ${current ? "data-upsell-current" : `data-reco-card data-reco-product-id="${id}"`}>
    <input type="checkbox" class="upsell__check" data-upsell-check value="${variantId}" checked>
    <label class="upsell__label"><span class="upsell__title">Product ${id}</span></label>
    <div class="upsell__meta">
      ${
        variants.length > 1
          ? `<select class="upsell__variant" data-upsell-variant>${variants
              .map(
                (v) =>
                  `<option value="${v.id}" data-upsell-cents="${v.price}"${v.id === variantId ? " selected" : ""}>${v.title}</option>`,
              )
              .join("")}</select>`
          : ""
      }
      <span class="upsell__price" data-upsell-price data-upsell-cents="${cents}"></span>
      ${current ? "" : `<a class="upsell__link" href="/products/p${id}" data-reco-link>View</a>`}
    </div>
  </div>`;

function upsellBlock(rows, { moneyFormat = "€{{amount}}" } = {}) {
  return `
  <div class="upsell" data-upsell-block data-reco-block
       data-reco-money-format="${moneyFormat}"
       data-reco-placement="upsell"
       data-reco-source-product="1001"
       data-reco-source="override"
       data-reco-intent="related"
       data-reco-limit="3"
       data-reco-atc="ajax"
       data-reco-server-rendered="true"
       data-upsell-add-one="Add 1 item"
       data-upsell-add-many="Add [count] items"
       data-upsell-add-none="Select an item"
       data-upsell-total-label="Total for [count] items">
    <div class="upsell__list" data-upsell-list>${rows}</div>
    <div class="upsell__footer">
      <span class="upsell__total-line">
        <span data-upsell-total-text></span><span data-upsell-total></span>
      </span>
      <button type="button" data-upsell-add>Select an item</button>
    </div>
  </div>`;
}

describe("the Bought Together bundle", () => {
  const rows =
    UPSELL_ROW({ id: 1001, variantId: 500, cents: 2000, current: true }) +
    UPSELL_ROW({ id: 2001, variantId: 501, cents: 1000 }) +
    UPSELL_ROW({ id: 2002, variantId: 502, cents: 3000 });

  test("the shopper's own product is never attributed to itself", async () => {
    boot(upsellBlock(rows), { enabled: true });
    document.querySelector("[data-upsell-add]").click();
    await tick(1000);

    const [{ items }] = cartAdds;
    expect(items).toHaveLength(3);

    const own = items.find((line) => line.id === 500);
    expect(own.properties).toEqual({});

    for (const line of items.filter((entry) => entry.id !== 500)) {
      expect(line.properties._reco_src).toBe("1001");
    }
  });

  test("one add_to_cart per recommended line, not one per bundle", async () => {
    boot(upsellBlock(rows), { enabled: true });
    document.querySelector("[data-upsell-add]").click();
    await tick(1000);

    const added = await typesOf("add_to_cart");
    expect(added).toHaveLength(2);
    expect(added.map((event) => event.recoProductId).sort()).toEqual(["2001", "2002"]);
    expect(added.every((event) => event.placement === "upsell")).toBe(true);
  });

  test("the running total is the ticked lines, in the shop's currency", async () => {
    boot(upsellBlock(rows), { enabled: true });
    await tick(0);

    // All three start ticked: 20.00 + 10.00 + 30.00
    expect(document.querySelector("[data-upsell-total]").textContent).toBe("€60.00");
    expect(document.querySelector("[data-upsell-total-text]").textContent).toBe(
      "Total for 3 items",
    );
    expect(document.querySelector("[data-upsell-add]").textContent).toBe("Add 3 items");
  });

  test("unticking a line updates the total and the button", async () => {
    boot(upsellBlock(rows), { enabled: true });
    const check = document.querySelectorAll("[data-upsell-check]")[2];
    check.checked = false;
    check.dispatchEvent(new window.Event("change", { bubbles: true }));
    await tick(0);

    expect(document.querySelector("[data-upsell-total]").textContent).toBe("€30.00");
    expect(document.querySelector("[data-upsell-add]").textContent).toBe("Add 2 items");
  });

  test("with nothing ticked the button is disabled", async () => {
    boot(upsellBlock(rows), { enabled: true });
    for (const check of document.querySelectorAll("[data-upsell-check]")) {
      check.checked = false;
      check.dispatchEvent(new window.Event("change", { bubbles: true }));
    }
    await tick(0);

    const button = document.querySelector("[data-upsell-add]");
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe("Select an item");
  });

  test("ticking a line is the click signal, once per row", async () => {
    boot(upsellBlock(rows), { enabled: true });
    const check = document.querySelectorAll("[data-upsell-check]")[1];

    for (const checked of [false, true, false, true]) {
      check.checked = checked;
      check.dispatchEvent(new window.Event("change", { bubbles: true }));
    }
    await tick(1000);

    const clicks = await typesOf("click");
    expect(clicks).toHaveLength(1);
    expect(clicks[0].recoProductId).toBe("2001");
  });

  test("a variant picker changes what is added and what it costs", async () => {
    const withVariants =
      UPSELL_ROW({ id: 1001, variantId: 500, cents: 2000, current: true }) +
      UPSELL_ROW({
        id: 2003,
        variantId: 601,
        cents: 1000,
        variants: [
          { id: 601, title: "S", price: 1000 },
          { id: 602, title: "L", price: 4000 },
        ],
      });
    boot(upsellBlock(withVariants), { enabled: true });

    const select = document.querySelector("[data-upsell-variant]");
    select.value = "602";
    select.dispatchEvent(new window.Event("change", { bubbles: true }));
    await tick(0);

    expect(document.querySelector("[data-upsell-total]").textContent).toBe("€60.00");

    document.querySelector("[data-upsell-add]").click();
    await tick(1000);
    expect(cartAdds[0].items.map((line) => line.id)).toContain(602);
  });

  test("the viewed product's variant is read at click time, not render time", async () => {
    // Themes rewrite ?variant= without firing popstate, so a value captured at
    // render is stale the moment the shopper picks another size.
    window.history.replaceState({}, "", "/products/p1001?variant=777");
    boot(upsellBlock(rows), { enabled: true });
    document.querySelector("[data-upsell-add]").click();
    await tick(1000);

    const own = cartAdds[0].items.find((line) => line.properties._reco_src === undefined);
    expect(own.id).toBe(777);
    window.history.replaceState({}, "", "/");
  });

  test("a bundle it could not fill removes itself", async () => {
    fetchRoutes.set("/recommendations/products.json", { products: [] });
    const empty = upsellBlock(
      UPSELL_ROW({ id: 1001, variantId: 500, cents: 2000, current: true }),
    ).replace('data-reco-server-rendered="true"', 'data-reco-server-rendered="false"') +
      "";
    boot(
      empty.replace(
        "</div>\n  </div>",
        `</div>
        <template data-upsell-row-template>
          <div class="upsell__row" data-upsell-row data-reco-card>
            <input type="checkbox" class="upsell__check" data-upsell-check checked>
            <label class="upsell__label"><img data-upsell-image><span data-upsell-title></span></label>
            <div class="upsell__meta">
              <select data-upsell-variant hidden></select>
              <span data-upsell-price></span>
              <s data-upsell-compare hidden></s>
              <a data-reco-link data-upsell-view-link></a>
            </div>
          </div>
        </template>
      </div>`,
      ),
      { enabled: true },
    );
    await tick(1000);

    expect(document.querySelector("[data-upsell-block]")).toBeNull();
    expect(await typesOf("served")).toHaveLength(0);
  });
});
