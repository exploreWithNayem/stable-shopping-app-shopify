import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, test } from "vitest";

/**
 * Guards the flat-route tree itself.
 *
 * `app.recommendations.jsx` used to sit above `app.recommendations.$productId.jsx`
 * as its layout, and because the list page renders no <Outlet /> the override
 * editor was unreachable: /app/recommendations/123 ran the editor's loader and
 * then rendered the list again. Nothing in the app crashed, so nothing caught it
 * — hence this test rather than a render test.
 */

const appDirectory = fileURLToPath(new URL(".", import.meta.url));

let routes;

beforeAll(async () => {
  // flatRoutes() reads the app directory from a global the React Router CLI sets.
  // eslint-disable-next-line no-undef
  globalThis.__reactRouterAppDirectory = appDirectory;
  const { flatRoutes } = await import("@react-router/fs-routes");
  routes = await flatRoutes();
});

function flatten(list, parent = null) {
  return list.flatMap((route) => {
    const self = { ...route, parent };
    return [self, ...flatten(route.children ?? [], self)];
  });
}

/**
 * A route's URL path, walked up through its parents.
 *
 * `route.path` on a nested route is *relative* — the placement picker's is
 * "offers/new", not "app/offers/new" — so comparing it to an href directly
 * silently never matches.
 */
function fullPath(route) {
  const segments = [];
  for (let node = route; node; node = node.parent) {
    if (node.path) segments.unshift(node.path);
  }
  return `/${segments.join("/")}`;
}

/** Every addressable path in the tree, index routes included. */
function allPaths() {
  return flatten(routes).map(fullPath);
}

describe("route tree", () => {
  test("every route with children renders an Outlet", () => {
    const offenders = flatten(routes)
      .filter((route) => (route.children ?? []).length > 0)
      .filter((route) => {
        const source = readFileSync(`${appDirectory}${route.file}`, "utf8");
        return !source.includes("Outlet");
      })
      .map((route) => route.file);

    expect(offenders).toEqual([]);
  });

  /*
   * The three GDPR endpoints are mandatory for every public app: review rejects
   * an app that does not subscribe, and Shopify probes them with a signed
   * request during review. They were missing entirely.
   *
   * Both halves have to line up — a handler with no toml entry is never called,
   * and a toml entry with no handler is a 404 at review time — so this checks
   * the route file, the config, and that they agree on the path.
   */
  test("the mandatory GDPR webhooks are routed and configured", () => {
    const toml = readFileSync(`${appDirectory}../shopify.app.toml`, "utf8");
    const paths = flatten(routes)
      .map((route) => route.path)
      .filter(Boolean);

    const required = {
      customer_data_request_url: "webhooks/customers/data_request",
      customer_deletion_url: "webhooks/customers/redact",
      shop_deletion_url: "webhooks/shop/redact",
    };

    expect(toml).toContain("[webhooks.privacy_compliance]");

    for (const [key, path] of Object.entries(required)) {
      expect(paths, `no route serves ${path}`).toContain(path);
      const line = toml.split("\n").find((row) => row.trim().startsWith(key));
      expect(line, `${key} is not configured`).toBeTruthy();
      expect(line, `${key} points somewhere else`).toContain(`/${path}`);
    }
  });

  test("products/delete is routed and subscribed", () => {
    // Otherwise a deleted product's override rows sit there forever, holding a
    // slot against the plan's product allowance for something that is gone.
    const toml = readFileSync(`${appDirectory}../shopify.app.toml`, "utf8");
    const paths = flatten(routes).map((route) => route.path);

    expect(paths).toContain("webhooks/products/delete");
    expect(toml).toContain('uri = "/webhooks/products/delete"');
    expect(toml).toContain('topics = [ "products/delete" ]');
  });

  test("no test file is inside app/routes", () => {
    /*
     * flatRoutes() turns every file in app/routes/ into a route, test files
     * included: app/routes/app.offers.new.test.js became a real route at
     * /app/offers/new/test, and `npm run build` then failed trying to bundle
     * vitest for the browser. `npm test` alone did not catch it — the file's own
     * assertions passed.
     *
     * This file is safe because it sits at app/, not app/routes/. Tests that read
     * a route's source belong in tests/.
     */
    const offenders = flatten(routes)
      .map((route) => route.file)
      .filter((file) => /\.(test|spec)\./.test(file));

    expect(offenders).toEqual([]);
  });

  test("the app loader provisions the metafield definitions", () => {
    /*
     * Declaring them in shopify.app.toml did not create them on a real store, and
     * without a definition the metafield is private: values write fine and Liquid
     * reads nil, so every override and offer renders as Shopify's own
     * recommendations with nothing reporting a failure.
     *
     * Beside the storefront token for the same reason — whichever page a merchant
     * opens first, the app has to work — and never fatal, because a failed
     * provision must not take the whole admin down.
     */
    const shell = readFileSync(`${appDirectory}routes/app.jsx`, "utf8");

    expect(shell).toContain("ensureMetafieldDefinitions(admin, shop)");
    const call = shell.slice(shell.indexOf("ensureMetafieldDefinitions(admin, shop)"));
    expect(call.slice(0, 200)).toContain("catch");
  });

  test("Create offer reaches the placement picker", () => {
    /*
     * Two halves that have to agree: the route has to exist at the path the
     * button points at, and nothing may turn the picker into a layout — it
     * renders no Outlet, so a child would silently never appear, which is the
     * bug the first test in this file exists for.
     */
    expect(allPaths()).toContain("/app/offers/new");

    const picker = flatten(routes).find((route) =>
      route.file.endsWith("app.offers.new.jsx"),
    );
    expect(picker).toBeDefined();
    expect(picker.children ?? []).toHaveLength(0);

    const home = readFileSync(`${appDirectory}routes/app._index.jsx`, "utf8");
    expect(home).toContain('href="/app/offers/new"');
    expect(home).toContain("Create offer");
  });

  test("the placement picker only links to pages that exist", () => {
    // Every enabled card navigates somewhere real. The unbuilt placements are
    // badged and disabled rather than pointing at a route whose only job would
    // be to say "not built yet".
    const page = readFileSync(`${appDirectory}routes/app.offers.new.jsx`, "utf8");
    const known = allPaths();

    const linked = [...page.matchAll(/href: ["'](\/app[^"']*)["']/g)].map((m) => m[1]);
    expect(linked.length, "no card links found — did the shape change?").toBeGreaterThan(0);

    for (const href of linked) {
      // A card may carry a query string (`?type=PRODUCT_PAGE` selects the offer
      // editor on the same route); only the path has to resolve.
      const path = href.split("?")[0];
      expect(known, `${href} has no route`).toContain(path);
    }
  });

  test("Home lists offers and links back into the editor", () => {
    /*
     * The offer list is Home's way back into something a merchant just saved, so
     * the link has to carry both the placement type and the id — `?type=` is what
     * selects the editor over the placement picker, and without it the row would
     * bounce back to the picker.
     */
    const home = readFileSync(`${appDirectory}routes/app._index.jsx`, "utf8");

    expect(home).toContain('heading="Offers"');
    expect(home).toContain("offer.placement}&id=${offer.id}");
    expect(allPaths()).toContain("/app/offers/new");

    // The empty state has to offer the way in, not just say there is nothing.
    expect(home).toContain("No offers yet");
    expect(home).toContain("href: '/app/offers/new'");
  });

  test("Home does not ship whole Json columns to the client", () => {
    // `targets` and `items` are unbounded lists and the table names neither of
    // them, so sending the arrays themselves is payload nobody reads.
    const home = readFileSync(`${appDirectory}routes/app._index.jsx`, "utf8");
    const payload = home.slice(home.indexOf("offers: offers.slice("), home.indexOf("moreOffers:"));

    // The four columns the table draws, and nothing else.
    expect(payload).toContain("name: offer.name");
    expect(payload).toContain("offerType: offer.offerType");
    expect(payload).toContain("placement: offer.placement");
    expect(payload).toContain("status: offer.status");
    expect(payload).not.toMatch(/targets/);
    expect(payload).not.toMatch(/items/);
  });

  test("the Home offer rows are clickable, with a real link to delegate to", () => {
    /*
     * Every cell describes the offer, so the row itself is the way back in.
     * `clickDelegate` is click-only — it adds no keyboard or screen reader
     * affordance — so the row must still contain the anchor it points at, and the
     * id has to be per-offer or every row would open the same one.
     */
    const home = readFileSync(`${appDirectory}routes/app._index.jsx`, "utf8");

    expect(home).toContain("const linkId = `offer-link-${offer.id}`");
    expect(home).toContain("clickDelegate={linkId}");
    expect(home).toContain("<s-link id={linkId}");
  });

  test("the storefront can ask whether an offer is still live", () => {
    /*
     * The widget renders only when both are true: the app embed is on, and the app
     * says the offer is live. The second half needs an endpoint, because a metafield
     * is a mirror the app writes and cannot say whether the offer it mirrors still
     * exists.
     */
    expect(allPaths()).toContain("/proxy/offer");

    const route = readFileSync(`${appDirectory}routes/proxy.offer.jsx`, "utf8");

    // App proxy authentication, like every other storefront endpoint.
    expect(route).toContain("authenticate.public.appProxy(request)");
    // Not live for everything that is not an explicit yes — an unanswerable question
    // is not a yes, so a proxy problem hides the widget rather than showing a deal
    // the store may have withdrawn.
    expect(route).toContain("const NOT_LIVE = { live: false }");
    expect(route).toContain("isOfferLive(shop.id, offerId, productId)");
    // A cached "live" would outlive the offer it describes.
    expect(route).toContain('"Cache-Control": "no-store"');

    // And the runtime waits for it before injecting anything.
    const runtime = readFileSync(
      new URL("../extensions/theme-extension/assets/reco.js", import.meta.url),
      "utf8",
    );
    expect(runtime).toContain("function offerIsLive(offer)");
    expect(runtime).toContain("offerIsLive(offer).then(function (live) {");
    expect(runtime).toContain("if (!live) return;");
    /*
     * No offer id, no injection. The metafield also holds lists curated on the
     * recommendations page; injecting those made a widget appear the moment the app
     * embed was switched on, with no offer anywhere in the admin.
     */
    expect(runtime).toContain("if (!offer.offerId) return Promise.resolve(false)");
  });

  test("Settings can read what the storefront is actually showing", () => {
    /*
     * Every other repair on that page reasons from the database. This one asks
     * Shopify, because the two can disagree — a delete whose metafield write failed
     * leaves an offer live with nothing in the admin to explain it — and when they
     * disagree it is the metafield that renders.
     *
     * Shopify offers no way to *find* products carrying an app metafield (searching by
     * metafield needs a filterable definition, which `json` cannot be), so the
     * merchant points at a product and the app reads it.
     */
    const settings = readFileSync(`${appDirectory}routes/app.settings.jsx`, "utf8");

    // Reads, and never takes the page down when the read fails.
    expect(settings).toContain("readShopOffers(admin)");
    expect(settings).toContain("readOverrideMetafield(admin, productId)");
    expect(settings).toContain("storefront.error");

    // Clears, both scopes: the shop list outright, and one product's own data.
    expect(settings).toContain("intent === 'clear-shop-offers'");
    expect(settings).toContain("intent === 'clear-product'");
    expect(settings).toContain("deleteShopOffers(admin)");
    expect(settings).toContain("deleteOverrideMetafield(admin, productId)");

    // The raw value is shown, because a summary is what hides the mismatch.
    expect(settings).toContain("result.inspected.raw");
  });

  test("the storefront repair is reachable on a product with no override", () => {
    /*
     * "I deleted the offer and it is still showing" ends here: a product whose row is
     * gone but whose metafield survived — a takedown that missed it, a failed
     * metafield delete — renders recommendations forever, and "Reset to Shopify
     * defaults" is the only thing that clears it. The button was behind
     * `{override && ...}`, which hid the repair whenever it was actually needed.
     *
     * The action already deletes the metafield unconditionally; only the button was
     * conditional.
     */
    const editor = readFileSync(
      `${appDirectory}routes/app.recommendations.$productId.jsx`,
      "utf8",
    );

    const reset = editor.slice(editor.indexOf("Reset to Shopify defaults", editor.indexOf("onClick={reset}") - 400));
    expect(editor).not.toContain("{override && (\n            <>\n              <s-divider />");
    // Rendered unconditionally, and it says which of the two jobs it is doing.
    expect(editor).toContain("clears the leftover storefront data");
    expect(reset.length).toBeGreaterThan(0);

    // The action clears the metafield whether or not a row existed.
    const action = editor.slice(editor.indexOf("if (intent === 'reset')"));
    expect(action.slice(0, 600)).toContain("deleteOverrideMetafield(admin, productId)");
  });

  test("the override editor is reachable at /app/recommendations/:productId", () => {
    const editor = flatten(routes).find((route) =>
      route.file.endsWith("app.recommendations.$productId.jsx"),
    );

    expect(editor).toBeDefined();

    // Full path from the root, so a future re-nesting shows up here.
    const segments = [];
    for (let node = editor; node; node = node.parent) {
      if (node.path) segments.unshift(node.path);
    }
    expect(segments.join("/")).toBe("app/recommendations/:productId");
  });
});
