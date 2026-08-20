import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

/*
 * The placement picker is specified as a design: six named cards with fixed copy
 * and buttons. Only one of them is a surface this app has built, so the risk is
 * not that a card looks wrong — it is that one of the five unbuilt ones quietly
 * acquires a link and becomes a dead end, or that a placement ships and the card
 * is left saying it has not.
 *
 * Read as source rather than rendered: these are declarations in a module-level
 * array, and asserting on them directly is both cheaper and more precise than
 * mounting a route that needs an authenticated Shopify session.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/*
 * This file lives in tests/ rather than beside the route it reads, because
 * `flatRoutes()` scans app/routes/ and turns *every* file there into a route —
 * app/routes/app.offers.new.test.js became a real route at /app/offers/new/test
 * and broke `npm run build`, which then tried to bundle vitest for the browser.
 * Only app/routes.test.js is safe at the app/ level; nothing may go inside
 * app/routes/.
 */
const source = readFileSync(join(root, "app", "routes", "app.offers.new.jsx"), "utf8");

/** The PLACEMENTS array, parsed out of the module. */
function placements() {
  const body = source.slice(
    source.indexOf("const PLACEMENTS = ["),
    source.indexOf("\n];", source.indexOf("const PLACEMENTS = [")),
  );

  return body
    .split(/\n\x20{2}\{\n/)
    .slice(1)
    .map((entry) => ({
      id: entry.match(/id: '([^']+)'/)?.[1],
      title: entry.match(/title: '([^']+)'/)?.[1],
      button: entry.match(/button: '([^']+)'/)?.[1],
      badge: entry.match(/badge: '([^']+)'/)?.[1] ?? null,
      available: /available: true/.test(entry),
      href: entry.match(/href: '([^']+)'/)?.[1] ?? null,
      waiting: entry.match(/waiting:\s*'([^']+)'/)?.[1] ?? null,
    }));
}

describe("the placement picker", () => {
  const cards = placements();

  test("parses six cards", () => {
    // Guards the parser above as much as the page: a silent 0 would make every
    // assertion below vacuously pass.
    expect(cards).toHaveLength(6);
    expect(cards.every((card) => card.id && card.title && card.button)).toBe(true);
  });

  test("carries the six specified placements, in order", () => {
    expect(cards.map((card) => card.title)).toEqual([
      "Product page",
      "Cart page",
      "Pop-up",
      "Post purchase page",
      "Suggest new placement type",
      "Checkout nudge",
    ]);
  });

  test("each card keeps its specified button label", () => {
    expect(cards.map((card) => card.button)).toEqual([
      "Select this placement type",
      "Select this placement type",
      "Select this placement type",
      "Select this placement type",
      "Suggest a new placement type",
      "Get on Shopify App Store",
    ]);
  });

  test("only Cart page carries a plan badge", () => {
    const badged = cards.filter((card) => card.badge);
    expect(badged.map((card) => [card.title, card.badge])).toEqual([
      ["Cart page", "Essential plan"],
    ]);
  });

  test("Product page is the one built placement, and it links to the product list", () => {
    const available = cards.filter((card) => card.available);
    expect(available.map((card) => card.title)).toEqual(["Product page"]);
    expect(available[0].href).toBe("/app/recommendations");
  });

  /*
   * The rule that matters. An unbuilt placement must not navigate: pressing its
   * button explains what it is waiting on, in place. A route whose only job is to
   * say "not implemented" is worse than a button that says so where it stands.
   */
  test("no unbuilt placement has a link", () => {
    for (const card of cards.filter((entry) => !entry.available)) {
      expect(card.href, `${card.title} has an href`).toBeNull();
    }
  });

  test("every unbuilt placement explains what it is waiting on", () => {
    for (const card of cards.filter((entry) => !entry.available)) {
      expect(card.waiting, `${card.title} has no explanation`).toBeTruthy();
      expect(card.waiting.length, `${card.title}'s explanation is too thin`).toBeGreaterThan(30);
    }
  });

  test("an unbuilt card's button reports rather than navigates", () => {
    // setPending is the only handler they get; none may be given an href.
    const unavailable = source.slice(source.indexOf("placement.available ?"));
    expect(unavailable).toContain("setPending(placement)");
  });

  /*
   * The grid silently collapsed to one column because the value carried two
   * @container clauses. Polaris does not parse that, and an unparsed value falls
   * back to the last track list — `1fr` — so the page rendered as a single
   * column with nothing logged and every test still green.
   */
  test("no grid in the app uses more than one container query", () => {
    const routes = join(root, "app", "routes");
    const files = readdirSync(routes).filter((file) => file.endsWith(".jsx"));
    const offenders = [];

    for (const file of files) {
      const text = readFileSync(join(routes, file), "utf8");
      for (const [, value] of text.matchAll(/gridTemplateColumns="([^"]+)"/g)) {
        const queries = value.match(/@container/g)?.length ?? 0;
        if (queries > 1) offenders.push(`${file}: ${value}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  test("the placement grid asks for three columns", () => {
    const value = source.match(/gridTemplateColumns="([^"]+)"/)?.[1];
    expect(value).toBeTruthy();
    // Three tracks above the breakpoint, one below.
    expect(value).toMatch(/@container \(inline-size > \d+px\) 1fr 1fr 1fr, 1fr/);
  });

  test("the pop-up modal is centred over the page", () => {
    // It shipped pushed to the right edge. Derived from the viewBox rather than
    // hardcoded so it stays centred if the drawing area changes.
    const thumb = readFileSync(join(root, "app", "components", "PlacementThumb.jsx"), "utf8");
    const popup = thumb.slice(thumb.indexOf("popup: ("), thumb.indexOf("post_purchase: ("));

    expect(popup).toContain("x={(W - 116) / 2}");
    expect(popup).not.toMatch(/x=\{\d+\}/);
  });

  test("the product page's right column shares one edge", () => {
    /*
     * The details, the offer block and the caption lines are one stack, not three
     * things that happen to be near each other — they were drifting apart as the
     * diagram was tuned, which read as a misaligned page rather than a layout.
     */
    const thumb = readFileSync(join(root, "app", "components", "PlacementThumb.jsx"), "utf8");

    expect(thumb).toContain("const RIGHT_X = ");
    // The offer block must use the shared edge and width, not its own numbers.
    const card = thumb.slice(thumb.indexOf("product_page: ("), thumb.indexOf("cart_page: ("));
    expect(card).toContain("x={RIGHT_X}");
    expect(card).toContain("w={RIGHT_W}");
  });

  test("the heading is in the content column, with a way back", () => {
    /*
     * `s-page heading` is hoisted into the Shopify admin's own header strip, so
     * on its own it left the top of the page blank. The heading is repeated in
     * the content, and the back arrow goes with it — this page is a step in a
     * flow and has no other exit.
     */
    expect(source).toContain('Choose Offer Placement');

    /*
     * A plain <h1>, deliberately. `s-heading` takes no size prop and ignores an
     * inline fontSize on the host — it sets its own inside its shadow DOM — so it
     * rendered at card-title size no matter what was passed. Going back to
     * `s-heading` here silently shrinks the page title again.
     */
    expect(source).toMatch(/<h1\s/);
    expect(source).toMatch(/fontSize: '[\d.]+rem'/);
    expect(source).not.toMatch(/<s-heading style=/);
    expect(source).toContain('heading="Choose Offer Placement"');
    expect(source).toContain('icon="arrow-left"');
    expect(source).toContain('href="/app"');
  });

  test("the diagram named by every card exists", () => {
    const thumb = readFileSync(
      join(root, "app", "components", "PlacementThumb.jsx"),
      "utf8",
    );
    const known = [...thumb.matchAll(/^\x20{2}([a-z_]+): \(/gm)].map((m) => m[1]);

    expect(known.length).toBeGreaterThan(0);
    for (const card of cards) {
      const diagram = source.match(
        new RegExp(`id: '${card.id}',\\n\\s*diagram: '([a-z_]+)'`),
      )?.[1];
      expect(known, `${card.title} names a diagram that does not exist`).toContain(diagram);
    }
  });
});
