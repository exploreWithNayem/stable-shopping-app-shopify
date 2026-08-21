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

function panel({
  attrs = "",
  cards = "",
  serverRendered = true,
  moneyFormat = "€{{amount}}",
} = {}) {
  return `
  <div class="reco reco--grid" data-reco-block
       data-reco-money-format="${moneyFormat}"
       data-reco-limit="4"
       data-reco-atc="ajax"
       data-reco-server-rendered="${serverRendered}"
       ${attrs}>
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

  test("injects the offer after the add-to-cart button", async () => {
    bootEmbed(productPage(), offer());
    await tick(1000);

    const block = document.querySelector('[data-reco-embedded="true"]');
    expect(block).toBeTruthy();

    // Directly after the buttons container, so it lands under the buy area
    // rather than at the end of the document.
    const anchor = document.querySelector('.product-form__buttons');
    expect(anchor.nextElementSibling).toBe(block);
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
    expect(block.previousElementSibling?.style.display).not.toBe('none');
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
