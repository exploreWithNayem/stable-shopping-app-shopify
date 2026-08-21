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
      type: entry.match(/type: '([^']+)'/)?.[1],
      diagram: entry.match(/diagram: '([^']+)'/)?.[1],
      available: /available: true/.test(entry),
      href: entry.match(/href: '([^']+)'/)?.[1] ?? null,
      waiting: entry.match(/waiting:\s*'([^']+)'/)?.[1] ?? null,
    }));
}

describe("the placement picker", () => {
  const cards = placements();

  test("parses five cards", () => {
    // Guards the parser above as much as the page: a silent 0 would make every
    // assertion below vacuously pass.
    expect(cards).toHaveLength(5);
    expect(cards.every((card) => card.id && card.title && card.button)).toBe(true);
  });

  test("carries the five specified placements, in order", () => {
    // Checkout nudge was removed on request; it was the only card with an
    // overflow control, so that branch went with it.
    expect(cards.map((card) => card.title)).toEqual([
      "Product page",
      "Cart page",
      "Pop-up",
      "Post purchase page",
      "Suggest new placement type",
    ]);
  });

  test("each card keeps its specified button label", () => {
    expect(cards.map((card) => card.button)).toEqual([
      "Select this placement type",
      "Select this placement type",
      "Select this placement type",
      "Select this placement type",
      "Suggest a new placement type",
    ]);
  });

  test("only Cart page carries a plan badge", () => {
    const badged = cards.filter((card) => card.badge);
    expect(badged.map((card) => [card.title, card.badge])).toEqual([
      ["Cart page", "Essential plan"],
    ]);
  });

  test("Product page is the one built placement, and it opens the offer editor", () => {
    const available = cards.filter((card) => card.available);
    expect(available.map((card) => card.title)).toEqual(["Product page"]);
    // Same route: `?type=` selects the editor over the picker.
    expect(available[0].href).toBe("/app/offers/new?type=PRODUCT_PAGE");
    expect(available[0].type).toBe("PRODUCT_PAGE");
  });

  test("every card declares a unique placement type", () => {
    // The type is what the URL carries and what the loader validates against.
    for (const card of cards) {
      expect(card.type, `${card.title} has no type`).toMatch(/^[A-Z_]+$/);
    }
    expect(new Set(cards.map((card) => card.type)).size).toBe(cards.length);
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

  test("the grid is not wrapped in a section", () => {
    // A section draws its own white rounded surface, which put a second card
    // behind the cards. Each tile already has its own background from `Card`.
    expect(source).not.toContain("<s-section>");
    expect(source).toContain("<s-query-container>");
  });

  test("the placement grid asks for three columns", () => {
    // Scoped to the picker: the editor on the same route has its own two-track
    // grid, and an unscoped match found that one first.
    const picker = source.slice(source.indexOf("function PlacementPicker"));
    const value = picker.match(/gridTemplateColumns="([^"]+)"/)?.[1];

    expect(value).toBeTruthy();
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
    // The heading row is shared by both screens, so its back target is a prop.
    expect(source).toContain('back="/app"');
  });

  test("no diagram hardcodes a colour", () => {
    /*
     * Everything is drawn in `currentColor` so one file covers the admin's light
     * and dark themes. The Checkout nudge diagram was the sole exception, with a
     * literal red for its warning pill, and it went with that card.
     */
    const thumb = readFileSync(join(root, "app", "components", "PlacementThumb.jsx"), "utf8");
    expect(thumb).not.toMatch(/#[0-9a-fA-F]{3,6}/);
  });

  test("the diagram named by every card exists", () => {
    const thumb = readFileSync(
      join(root, "app", "components", "PlacementThumb.jsx"),
      "utf8",
    );
    const known = [...thumb.matchAll(/^\x20{2}([a-z_]+): \(/gm)].map((m) => m[1]);

    expect(known.length).toBeGreaterThan(0);
    for (const card of cards) {
      expect(known, `${card.title} names a diagram that does not exist`).toContain(card.diagram);
    }
  });
});

/*
 * The offer builder, behind `?type=`. Everything on it is local state: the app
 * has no `Offer` model, and the fields a merchant would expect to save — title,
 * badge, button text — currently come from the theme block's own settings. So the
 * risk here is a screen that looks like it saves; Publish has to say what it is
 * waiting for instead.
 */
describe("the offer editor", () => {
  test("lives on the same route, selected by ?type=", () => {
    expect(source).toContain("params.get('type')");
    // An unknown or unbuilt type falls back to the picker rather than erroring —
    // the parameter comes from a URL a merchant can edit or bookmark.
    expect(source).toContain("BUILDABLE.includes(requested) ? requested : null");
  });

  test("an existing offer opens by id, scoped to the shop", () => {
    // An id from a URL is not proof of ownership, so the lookup carries shop.id.
    expect(source).toContain("params.get('id')");
    expect(source).toContain("getOffer(shop.id, id)");
  });

  test("only a built placement can open it", () => {
    expect(source).toMatch(/const BUILDABLE = PLACEMENTS\.filter\(/);
  });

  test("carries the four offer types, named in one shared place", () => {
    /*
     * The builder's radios and the Home offer list draw the same names, so the
     * labels live in app/lib/offer-labels.js and both read them from there —
     * a fifth type is one edit, not three that can drift.
     */
    const labels = readFileSync(join(root, "app", "lib", "offer-labels.js"), "utf8");

    for (const label of [
      "Cross-sell",
      "Volume discount",
      "Frequently bought together",
      "Product add-on",
    ]) {
      expect(labels).toContain(label);
    }

    expect(source).toContain("OFFER_TYPE_KEYS.map(");
    expect(source).toContain("OFFER_TYPE_LABELS[value]");
  });

  test("carries the four tabs, with Content first", () => {
    const start = source.indexOf("const TABS = [");
    const block = source.slice(start, source.indexOf("];", start));
    expect([...block.matchAll(/label: '([^']+)'/g)].map((m) => m[1])).toEqual([
      "Content",
      "Offer",
      "Design",
      "Placement",
    ]);
  });

  /*
   * Publish has storefront side effects: it writes an Override per target product
   * and syncs each metafield. The rules that must not slip are that a draft can
   * be saved incomplete, that publishing cannot exceed the plan's product
   * allowance, and that taking an offer down is never gated — that is how a
   * merchant at the limit frees slots.
   */
  test("the route has an action handling save, publish and unpublish", () => {
    expect(source).toMatch(/export const action/);
    for (const intent of ["'save'", "'publish'", "'unpublish'"]) {
      expect(source, `no ${intent} branch`).toContain(intent);
    }
  });

  test("a draft is validated more loosely than a publish", () => {
    // A merchant who has picked products but not written a title should be able
    // to save and come back, so only publishing demands a complete offer.
    expect(source).toContain(
      "intent === 'publish' ? validateForPublish(input) : validateOffer(input)",
    );
  });

  test("publishing enforces the product allowance server-side", () => {
    expect(source).toContain("publishedTargetIds(shop.id");
    expect(source).toContain("newlyOccupiedTargets(saved, occupied)");
    expect(source).toContain("limitReached: true");
  });

  test("unpublishing is not gated", () => {
    // It runs before any allowance check and needs only the offer id.
    const unpublish = source.slice(
      source.indexOf("if (intent === 'unpublish')"),
      source.indexOf("if (intent !== 'save'"),
    );
    expect(unpublish).toContain("unpublishOffer(");
    expect(unpublish).not.toContain("canAddOverride");
    expect(unpublish).not.toContain("overrideLimit(");
  });

  /*
   * The admin's contextual save bar renders in Shopify's own top bar, so unsaved
   * changes belong there rather than in a banner of our own. Two things make it
   * work: a baseline to compare against, and resetting that baseline from the
   * persisted row — not from the values we happened to send.
   */
  test("unsaved changes raise the contextual save bar", () => {
    expect(source).toContain('<SaveBar id="offer-save-bar" open={dirty}>');
    expect(source).toContain("const dirty = !sameForm(current, baseline)");
    // App Bridge looks for variant="primary" to find the confirming button, and
    // these are plain <button>s, not Polaris ones.
    expect(source).toMatch(/<button variant="primary"[^>]*onClick=\{\(\) => submit\('save'\)\}/);
    expect(source).toContain("restore(baseline)");
  });

  test("the save bar clears from the persisted row", () => {
    // Resetting it from the submitted values would leave the bar showing after a
    // save that normalised anything — a trimmed name, a deduped product list.
    expect(source).toContain("setBaseline(formValues(result.offer))");
  });

  test("product lists are compared by id, not deep equality", () => {
    /*
     * Stored rows carry a `position` and a `title` the picker does not always
     * return, so a structural compare reported changes the merchant had not made
     * — and a save bar that will not go away is worse than none.
     */
    const compare = source.slice(source.indexOf("function sameForm"));
    expect(compare).toContain("ids(a.targets) === ids(b.targets)");
    expect(compare).toContain("ids(a.items) === ids(b.items)");
  });

  test("saving twice updates one row rather than leaving drafts behind", () => {
    // The row only exists after the first save, so the returned id has to be
    // held — without it every press of Save created another draft.
    expect(source).toContain("setId(result.offer.id)");
  });

  test("the Offer tab picks both product lists", () => {
    expect(source).toContain("Show this offer on");
    expect(source).toContain("Recommend these products");
    // A product must never be a recommendation for itself.
    expect(source).toContain("exclude={targets.map((target) => target.id)}");
  });

  test("the preview is wired to the copy fields", () => {
    // The point of a preview is judging the copy as it is typed, so it has to
    // read state rather than repeat the defaults as literals.
    const preview = source.slice(source.indexOf("preview */"));
    expect(preview).toContain("{title ||");
    expect(preview).toContain("{buttonText ||");
    expect(preview).toContain("{badge &&");
  });

  test("says the offer is unsaved", () => {
    expect(source).toContain("Not published");
  });
});
