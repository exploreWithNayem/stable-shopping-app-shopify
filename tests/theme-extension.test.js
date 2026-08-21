import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

/**
 * Static checks on the theme app extension.
 *
 * Liquid only fails at render time on a real storefront, so these catch the
 * mistakes that would otherwise surface as a broken block in a merchant's theme
 * editor: malformed schema JSON, a range default outside its own bounds, a
 * select default that matches no option, and translation keys with no string.
 */

/**
 * Lives here rather than inside the extension: a theme app extension may only
 * contain assets/, blocks/, snippets/, locales/ and its toml, and everything in
 * that directory is uploaded to Shopify.
 */
const EXTENSION = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "extensions",
  "theme-extension",
);
const BLOCKS = join(EXTENSION, "blocks");
const SNIPPETS = join(EXTENSION, "snippets");

const blockFiles = readdirSync(BLOCKS).filter((name) => name.endsWith(".liquid"));

/**
 * Two product blocks, split along the one line that actually divides them: the
 * recommendation sources need a product and can therefore declare
 * `enabled_on: templates: ["product"]`; the merchandising sources go anywhere
 * and own the Collection picker (CLAUDE.md 7.3). They share their markup
 * through `reco-panel`, so a check on what a block *renders* has to read the
 * snippet with it — only the schema is per-block.
 */
const RECOMMENDATIONS = "recommendations.liquid";
const SHOWCASE = "product-showcase.liquid";
const UPSELL = "upsell.liquid";
const PANEL = join(SNIPPETS, "reco-panel.liquid");
const locales = JSON.parse(
  readFileSync(join(EXTENSION, "locales", "en.default.json"), "utf8"),
);

function readSchema(file) {
  const source = readFileSync(join(BLOCKS, file), "utf8");
  const match = source.match(/\{%\s*schema\s*%\}([\s\S]*?)\{%\s*endschema\s*%\}/);
  if (!match) return null;
  return JSON.parse(match[1]);
}

/** Walks a dotted key like "recommendations.add_to_cart". */
function lookupLocale(key) {
  return key.split(".").reduce((node, part) => node?.[part], locales);
}

/**
 * Comments describe the patterns these tests ban, so they have to come out
 * before scanning or the prose trips the check. Handles both `{% comment %}`
 * blocks and the bare `comment` form inside a `{% liquid %}` tag.
 */
function stripComments(source) {
  return source
    .replace(/\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g, "")
    .replace(/^[ \t]*comment\b[\s\S]*?^[ \t]*endcomment\b/gm, "");
}

function readLiquid(path) {
  return stripComments(readFileSync(path, "utf8"));
}

/**
 * Matches an HTML attribute regardless of quote style — a Liquid formatter run
 * over a block rewrites `"` to `'` and would otherwise fail these checks for a
 * change that alters nothing.
 */
function hasAttribute(source, name, value) {
  return new RegExp(`${name}=["']${value}["']`).test(source);
}

describe("block schemas", () => {
  test("every block has one", () => {
    expect(blockFiles.length).toBeGreaterThan(0);
    for (const file of blockFiles) {
      expect(readSchema(file), `${file} has no parsable schema`).toBeTruthy();
    }
  });

  test.each(blockFiles)("%s declares a name and a valid target", (file) => {
    const schema = readSchema(file);
    expect(schema.name).toBeTruthy();
    expect(["section", "body", "head"]).toContain(schema.target);
  });

  test.each(blockFiles)("%s has unique setting ids", (file) => {
    const ids = (readSchema(file).settings ?? [])
      .filter((setting) => setting.id)
      .map((setting) => setting.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // Shopify rejects the whole schema if a range default is out of bounds or off
  // step — the block then simply refuses to appear in the theme editor.
  test.each(blockFiles)("%s range defaults are in bounds and on step", (file) => {
    const ranges = (readSchema(file).settings ?? []).filter((s) => s.type === "range");

    for (const setting of ranges) {
      expect(setting, `${setting.id} needs min/max/step/default`).toMatchObject({
        min: expect.any(Number),
        max: expect.any(Number),
        step: expect.any(Number),
        default: expect.any(Number),
      });
      expect(setting.default, `${setting.id} default below min`).toBeGreaterThanOrEqual(setting.min);
      expect(setting.default, `${setting.id} default above max`).toBeLessThanOrEqual(setting.max);
      expect(
        (setting.default - setting.min) % setting.step,
        `${setting.id} default is not a multiple of step from min`,
      ).toBe(0);
      expect(
        (setting.max - setting.min) % setting.step,
        `${setting.id} range is not divisible by step`,
      ).toBe(0);
    }
  });

  test.each(blockFiles)("%s select defaults match an option", (file) => {
    const selects = (readSchema(file).settings ?? []).filter((s) => s.type === "select");

    for (const setting of selects) {
      const values = setting.options.map((option) => option.value);
      expect(values, `${setting.id} default is not an option`).toContain(setting.default);
    }
  });

  /*
   * Shopify caps a block schema `name` at 25 characters and fails the deploy
   * outright — `Invalid tag 'schema': name: must have a maximum of 25
   * characters` — rather than truncating. Nothing else in this suite reads the
   * name, so without this the only signal is a broken `shopify app dev`.
   */
  test.each(blockFiles)("%s has a name within Shopify's 25-character cap", (file) => {
    const schema = readSchema(file);
    if (!schema) return;
    expect(schema.name, `"${schema.name}" is ${schema.name?.length} characters`)
      .toBeTruthy();
    expect(schema.name.length).toBeLessThanOrEqual(25);
  });

  test("both product blocks load their own assets", () => {
    // The stylesheet is pulled in explicitly, not declared in the schema:
    // Shopify does not reliably serve a block's declared assets when several
    // blocks from one extension are on the same page, which rendered the block
    // as unstyled markup. Asserted so nobody "tidies" it back into the schema.
    // It lives in the shared panel, so one assertion covers both blocks.
    expect(readLiquid(PANEL)).toContain("'reco.css' | asset_url | stylesheet_tag");

    for (const file of [RECOMMENDATIONS, SHOWCASE]) {
      expect(readSchema(file).stylesheet, file).toBeUndefined();
      expect(readSchema(file).javascript, file).toBe("reco.js");
    }
  });

  test("only the recommendation block is pinned to product templates", () => {
    // Custom and Related both need `product`, and a block carrying Popular or
    // Recently viewed could never declare this — which is the reason the two
    // are separate blocks at all.
    expect(readSchema(RECOMMENDATIONS).enabled_on).toEqual({ templates: ["product"] });
    expect(readSchema(SHOWCASE).enabled_on).toBeUndefined();
  });

  /*
   * all_products allows 20 lookups per page, and only the custom source uses
   * it. The `limit` setting no longer bounds that — it goes to 24 because
   * Popular and Recently viewed page through far more products — so the real
   * ceiling is how many items an override may hold. That cap lives in
   * app/models/override.server.js, which is why this reads it from there
   * rather than trusting the block's own range.
   */
  test("an override can never exceed the all_products lookup cap", () => {
    const model = readFileSync(
      join(EXTENSION, "..", "..", "app", "models", "override.server.js"),
      "utf8",
    );
    const max = Number(model.match(/MAX_OVERRIDE_ITEMS = (\d+)/)[1]);

    expect(max).toBeLessThanOrEqual(12);
    // The loop is bounded by the stored list, so `limit` cannot widen it.
    expect(readLiquid(join(BLOCKS, "recommendations.liquid"))).toContain(
      "for item in overrides.items limit: limit",
    );
  });
});

/*
 * Comments are not inert in Liquid, and both ways of getting this wrong report
 * the same misleading error — "'comment' tag was never closed", pointing at the
 * comment rather than at the cause:
 *
 *   1. A `{% liquid %}` tag ends at its first `%}`, including one inside a
 *      comment within it. A tag written out in full there truncates the tag.
 *   2. Shopify parses tags nested inside a comment block, so a comment tag
 *      quoted inside a comment opens a second one, and the closing endcomment
 *      closes the inner rather than the outer.
 *
 * Both are invisible until a real theme parses the file, which is why they are
 * checked here.
 */
describe("liquid comments", () => {
  const liquidFiles = [
    ...blockFiles.map((file) => join(BLOCKS, file)),
    ...readdirSync(SNIPPETS)
      .filter((name) => name.endsWith(".liquid"))
      .map((file) => join(SNIPPETS, file)),
  ];

  /** Bodies of `{% liquid %}` tags, cut at the first `%}` exactly as Liquid does. */
  const liquidTagBodies = (source) => {
    const found = [];
    const opener = /\{%-?\s*liquid\b/g;
    let match;

    while ((match = opener.exec(source))) {
      const end = source.indexOf("%}", match.index);
      if (end === -1) continue;
      found.push(source.slice(match.index + match[0].length, end));
    }

    return found;
  };

  /** Contents of `{% comment %}` blocks, cut at the first endcomment. */
  const commentBodies = (source) =>
    [
      ...source.matchAll(
        /\{%-?\s*comment\s*-?%\}([\s\S]*?)\{%-?\s*endcomment\s*-?%\}/g,
      ),
    ].map(([, body]) => body);

  test.each(liquidFiles)("%s writes no tag inside a liquid tag", (path) => {
    for (const body of liquidTagBodies(readFileSync(path, "utf8"))) {
      expect(body, "a nested `{%` truncates the enclosing liquid tag").not.toContain("{%");
    }
  });

  test.each(liquidFiles)("%s writes no tag inside a comment block", (path) => {
    for (const body of commentBodies(readFileSync(path, "utf8"))) {
      expect(body, "Liquid parses tags nested in a comment").not.toContain("{%");
    }
  });

  test.each(liquidFiles)("%s balances comment/endcomment inside liquid tags", (path) => {
    for (const body of liquidTagBodies(readFileSync(path, "utf8"))) {
      const opens = (body.match(/^\s*comment\b/gm) ?? []).length;
      const closes = (body.match(/^\s*endcomment\b/gm) ?? []).length;
      expect(closes, `${opens} comment / ${closes} endcomment`).toBe(opens);
    }
  });
});

describe("two blocks, six sources", () => {
  // Markup assertions have to see the shared panel, which is where it lives.
  const panel = readLiquid(PANEL);
  const source = readLiquid(join(BLOCKS, RECOMMENDATIONS)) + panel;
  const showcase = readLiquid(join(BLOCKS, SHOWCASE)) + panel;
  const schema = readSchema(RECOMMENDATIONS);
  const showcaseSchema = readSchema(SHOWCASE);
  const setting = schema.settings.find((entry) => entry.id === "source");

  test("the six sources are split across exactly two blocks", () => {
    // Upsell is a third block but not a sixth source — it is the same Custom
    // list in bundle form, so it does not belong to this split (CLAUDE.md 7.4).
    expect(blockFiles.sort()).toEqual(
      ["app-embed.liquid", RECOMMENDATIONS, SHOWCASE, UPSELL].sort(),
    );
  });

  test("the recommendation block offers the three product-page sources", () => {
    expect(setting.type).toBe("select");
    expect(setting.options.map((option) => option.value)).toEqual([
      "custom",
      "related",
      "complementary",
    ]);
    expect(setting.default).toBe("custom");

    // The label is the feature's discoverability — a merchant looking for
    // "bought with this" has to recognise it in the list.
    expect(setting.options.map((option) => option.label)).toEqual([
      "Custom recommendations",
      "Related products",
      "Complementary products",
    ]);
  });

  test("the showcase block offers the three merchandising sources", () => {
    const split = showcaseSchema.settings.find((entry) => entry.id === "source");
    expect(split.options.map((option) => option.value)).toEqual([
      "popular",
      "collection",
      "recently_viewed",
    ]);
    expect(split.default).toBe("popular");

    // No source appears in both blocks, and between them they cover all six.
    const all = [
      ...setting.options.map((o) => o.value),
      ...split.options.map((o) => o.value),
    ];
    expect(new Set(all).size).toBe(6);
  });

  /*
   * Complementary is Related with one word changed: it asks Shopify for
   * `complementary` instead of `related` — products bought *with* this one
   * rather than products like it. reco.js needed no new code path, because
   * fetchFallback already reads data-reco-intent.
   *
   * §12 Q2 asked whether this belonged in Settings as a store-wide default
   * instead. It is a per-block source so one product page can carry a Related
   * row *and* a Complementary row, which a global switch makes impossible.
   */
  test("an empty complementary row explains itself in the editor", () => {
    /*
     * Shopify answers `complementary` only for products a merchant has linked in
     * the Search & Discovery app, so an untouched store gets an empty list — and
     * the row removing itself silently looks exactly like a broken source. The
     * hint is design-mode only; the live storefront still just hides the row.
     */
    expect(panel).toContain("complementary.empty");
    expect(panel).toContain("data-reco-design-hint");
    // reco.js needs the flag to know it is in the editor.
    const branch = panel.slice(
      panel.indexOf("elsif mode == 'complementary'"),
      panel.indexOf("{%- else %}", panel.indexOf("elsif mode == 'complementary'")),
    );
    expect(branch).toContain("request.design_mode");
  });

  test("the complementary source asks Shopify for a different intent", () => {
    expect(hasAttribute(source, "data-reco-intent", "complementary")).toBe(true);
    expect(hasAttribute(source, "data-reco-placement", "complementary")).toBe(true);

    // Never reads the override — that is the custom source's job.
    expect(panel).toContain("elsif mode == 'complementary'");
    expect(source).not.toContain("mode == 'complementary' and overrides");
  });

  test("complementary bills like every other recommendation source", () => {
    /*
     * It has a source product and answers "what goes with this", which is the
     * line §7.1 draws between recommendation and merchandising. Its own
     * placement because the 30-minute serve dedupe keys on
     * (session, product, placement): sharing `related` would make one of the two
     * rows on a page free.
     */
    const branch = panel.slice(
      panel.indexOf("elsif mode == 'complementary'"),
      panel.indexOf("{%- else %}", panel.indexOf("elsif mode == 'complementary'")),
    );
    expect(branch).not.toContain('data-reco-serve="false"');
    expect(branch).toContain('data-reco-source-product="{{ product.id }}"');
    // Shopify's own list, so never the override source.
    expect(branch).toContain('data-reco-source="shopify"');
  });

  test("it is a product-page source, so it stays on the PDP block", () => {
    // enabled_on is only declarable because every source on this block needs a
    // product; complementary must not weaken that.
    expect(schema.enabled_on).toEqual({ templates: ["product"] });
    const showcaseSources = showcaseSchema.settings
      .find((entry) => entry.id === "source")
      .options.map((option) => option.value);
    expect(showcaseSources).not.toContain("complementary");
  });

  test("source-specific settings are scoped", () => {
    const by = (id) => schema.settings.find((entry) => entry.id === id);
    const byShowcase = (id) => showcaseSchema.settings.find((entry) => entry.id === id);

    // The intent picker is gone: both sources ask Shopify for `related`, and
    // neither block may bring the setting back (CLAUDE.md 7.2).
    expect(by("intent")).toBeUndefined();
    expect(byShowcase("intent")).toBeUndefined();
    expect(panel).not.toContain("block.settings.intent");

    // The sort and stock filters belong to the two collection-driven sources.
    for (const id of ["sort_by", "hide_sold_out"]) {
      expect(byShowcase(id).visible_if, `${id} is not scoped to popular`).toContain(
        "'popular'",
      );
      expect(byShowcase(id).visible_if, `${id} is not scoped to collection`).toContain(
        "'collection'",
      );
    }

    // exclude_current applies to all three showcase sources, so it is not
    // scoped there — and has no meaning in the PDP block at all.
    expect(byShowcase("exclude_current").visible_if).toBeUndefined();
    expect(by("exclude_current")).toBeUndefined();
  });

  /*
   * The Collection picker is a real resource input: it browses the store's
   * collections and nothing else. That is only possible on a block where it
   * does not have to hide, because `visible_if` on a resource input is rejected
   * outright at deploy —
   *   settings: with id="collection" 'visible_if' is not a valid attribute
   * — which Shopify calls an intentional limitation (it conflicts with
   * `closest.<<resource>>`).
   *
   * A `"type": "url"` field was built as the alternative and rejected: it hides
   * correctly, but its picker also lists Products, Pages, Blogs and Policies
   * with no attribute to filter them, and it stores a link whose handle has to
   * be parsed back out. Keeping the picker honest and putting it on the block
   * where two of three sources use it is the settled shape (CLAUDE.md §7.3).
   */
  test("the collection picker is a real collection picker, on the showcase block", () => {
    const picker = showcaseSchema.settings.find((entry) => entry.id === "collection");
    expect(picker.type).toBe("collection");
    // It must NOT carry visible_if — that is what fails deploy.
    expect(picker.visible_if).toBeUndefined();

    // The url experiment must not come back: no link parsing anywhere.
    expect(showcaseSchema.settings.find((e) => e.id === "collection_url")).toBeUndefined();
    expect(showcase).not.toContain("split: '/collections/'");
    expect(showcase).toContain("assign collection_source = block.settings.collection");
  });

  test("the recommendation block has no collection field at all", () => {
    // Neither of its sources reads a collection, so neither field belongs here.
    for (const id of ["collection", "collection_url", "sort_by", "hide_sold_out"]) {
      expect(schema.settings.find((entry) => entry.id === id), id).toBeUndefined();
    }
  });

  test("no setting is left permanently on screen", () => {
    // A field that shows for a source it does nothing for is the defect this
    // block keeps regressing on. Heading, layout and the presentation settings
    // apply to every source; everything source-specific must be scoped, the
    // collection picker included — which is what cost it its resource type.
    const global = new Set([
      "source",
      "heading",
      "layout",
      "limit",
      "columns_desktop",
      "columns_mobile",
      "image_ratio",
      "hover_image",
      "show_border",
      "text_align",
      "heading_size",
      "show_title",
      "show_price",
      "show_compare_price",
      "show_vendor",
      "show_rating",
      "show_add_to_cart",
      "add_to_cart_label",
      "atc_behavior",
      "button_style",
      "autoplay",
      "autoplay_speed",
      "background_color",
      "accent_color",
      "padding_top",
      "padding_bottom",
    ]);

    for (const setting of schema.settings) {
      if (!setting.id || global.has(setting.id)) continue;
      expect(setting.visible_if, `${setting.id} is always visible`).toBeTruthy();
    }
  });

  test("the collection picker sits directly under the source select", () => {
    // It is the only setting that qualifies the source, so it belongs next to
    // it — not below Heading, where it read as a global.
    const ids = showcaseSchema.settings.map((entry) => entry.id);
    expect(ids[ids.indexOf("source") + 1]).toBe("collection");
  });

  /*
   * The price of two blocks is two copies of the settings JSON — Liquid has no
   * way to share a schema. Everything else is shared for real through
   * `reco-panel` and `reco-collection-cards`, so this is the only place the two
   * can drift, and drift here shows up as one block quietly missing an option
   * the other has.
   */
  test("the two schemas agree on every setting they share", () => {
    const byId = (s) => new Map(s.settings.map((e) => [e.id, e]));
    const a = byId(schema);
    const b = byId(showcaseSchema);

    // Settings that belong to one block only, by design.
    const pdpOnly = new Set();
    const showcaseOnly = new Set([
      "collection",
      "sort_by",
      "hide_sold_out",
      "exclude_current",
      "background_color",
    ]);
    // `source` differs by construction; `limit` differs by ceiling — 12 on the
    // PDP block, where an override list is capped by all_products, and 24 on
    // the showcase block, which iterates collection.products directly.
    // `heading` differs too: "You may also like" answers the recommendation
    // question, and there is no reading of it that fits a Recently viewed row.
    const differsByDesign = new Set(["source", "limit", "heading"]);

    const strip = (setting) =>
      Object.fromEntries(
        Object.entries(setting).filter(([key]) => key !== "visible_if" && key !== "info"),
      );

    for (const [id, entry] of a) {
      if (pdpOnly.has(id) || differsByDesign.has(id)) continue;
      expect(b.has(id), `${id} is missing from ${SHOWCASE}`).toBe(true);
      expect(strip(b.get(id)), `${id} differs between the blocks`).toEqual(strip(entry));
    }
    for (const id of b.keys()) {
      if (showcaseOnly.has(id) || differsByDesign.has(id)) continue;
      expect(a.has(id), `${id} is missing from ${RECOMMENDATIONS}`).toBe(true);
    }

    expect(a.get("limit").max).toBe(12);
    expect(b.get("limit").max).toBe(24);
  });

  test("only the recommendation sources cost quota", () => {
    // Popular and Recently viewed render on every visit; billing those as
    // recommendations would burn a Free plan in an afternoon (CLAUDE.md 3.3).
    // They share the one opt-out branch; Custom and Related do not set it.
    expect(hasAttribute(source, "data-reco-serve", "false")).toBe(true);

    for (const placement of [
      "pdp",
      "related",
      "complementary",
      "popular",
      "collection",
      "recently_viewed",
    ]) {
      expect(
        hasAttribute(source, "data-reco-placement", placement),
        `missing placement ${placement}`,
      ).toBe(true);
    }
  });

  test("every placement any block emits is one the server keeps", () => {
    // An unlisted placement is coerced to "pdp" in normalizeEvent, which would
    // fold a merchandising row into a product's recommendation metrics and let
    // the serve dedupe swallow a second recommendation row on the same page.
    const model = readFileSync(
      join(EXTENSION, "..", "..", "app", "models", "event.server.js"),
      "utf8",
    );
    const known = model.match(/PLACEMENTS = \[([\s\S]*?)\]/)[1].match(/"([a-z_]+)"/g);

    // Every block, not just this one: a new storefront placement that the
    // server does not know is silently coerced to "pdp" in normalizeEvent.
    const everything = blockFiles
      .map((file) => readLiquid(join(BLOCKS, file)))
      .concat(readLiquid(PANEL))
      .join("\n");

    const emitted = [
      ...new Set(
        [...everything.matchAll(/data-reco-placement=["']([a-z_]+)["']/g)].map(
          ([, placement]) => placement,
        ),
      ),
    ];
    expect(emitted.length).toBeGreaterThan(0);
    for (const placement of emitted) {
      expect(known, `${placement} is not in PLACEMENTS`).toContain(`"${placement}"`);
    }
  });

  test("the related source never claims an override it did not read", () => {
    // It bypasses the metafield entirely, so the attribution on every event it
    // sends has to say shopify.
    expect(source).toContain('data-reco-placement="related"');
    expect(source).toMatch(
      /data-reco-placement="related"[\s\S]{0,200}?data-reco-source="shopify"/,
    );
  });

  /*
   * An offer's wording reaches the storefront through the v2 metafield: `copy`
   * is present when the list came from a published offer and absent otherwise —
   * including in every v1 metafield written before offers existed. So the panel
   * needs a plain nil check, never a version test, and a merchant who curated the
   * list on the recommendations page must keep the block settings they set.
   */
  /*
   * The app embed path: no theme block on the page at all. On a product template
   * the embed reads that product's own metafield — the same mirror the block
   * reads — and inlines the offer for reco.js to inject.
   */
  test("the app embed inlines the product's offer", () => {
    const embed = readLiquid(join(BLOCKS, "app-embed.liquid"));

    expect(embed).toContain('product.metafields["$app"].reco_overrides.value');
    expect(embed).toContain("window.EasyReco.offer");
    // Guarded to product templates: the embed runs everywhere, and `product` is
    // nil elsewhere.
    expect(embed).toContain("template.name == 'product'");
  });

  test("the embed resolves products in Liquid, not over the network", () => {
    /*
     * `all_products` means prices come out formatted by the shop's own rules in
     * the shop's own currency, and reco.js makes no request at all. The shape
     * matches Shopify's Ajax product JSON so renderFallback needs no second
     * renderer.
     */
    const embed = readLiquid(join(BLOCKS, "app-embed.liquid"));

    expect(embed).toContain("all_products[entry.handle]");
    for (const field of ['"price"', '"compare_at_price"', '"featured_image"', '"variants"']) {
      expect(embed, `${field} missing from the inlined product`).toContain(field);
    }
  });

  test("the embed loads the runtime, not just the config", () => {
    /*
     * The blocks declare reco.js through their schema `javascript` key, so on a
     * product page with no block the script was absent entirely and the offer
     * never rendered. The embed has to load it itself.
     */
    const embed = readLiquid(join(BLOCKS, "app-embed.liquid"));
    expect(embed).toContain("'reco.js' | asset_url");

    // Safe to load from both places only because the runtime bails if it has
    // already run.
    const runtime = readFileSync(join(EXTENSION, "assets", "reco.js"), "utf8");
    expect(runtime).toContain("if (window.EasyReco.loaded) return;");
    expect(runtime).toContain("window.EasyReco.loaded = true;");
  });

  test("the counter string is a locale key, not English in the runtime", () => {
    /*
     * "Product 1 of 2" is merchant-visible copy on a live storefront, so it goes
     * through the locale file like every other string; reco.js substitutes the
     * numbers. The English default stays in the file as the fallback for a store
     * with the embed off — which cannot happen on this path, but the runtime must
     * not be the place a translation lives.
     */
    const locales = JSON.parse(
      readFileSync(join(EXTENSION, "locales", "en.default.json"), "utf8"),
    );
    const runtime = readFileSync(join(EXTENSION, "assets", "reco.js"), "utf8");
    const embed = readLiquid(join(BLOCKS, "app-embed.liquid"));

    expect(locales.recommendations.count).toContain("[current]");
    expect(locales.recommendations.count).toContain("[total]");
    expect(embed).toContain("recommendations.count");
    expect(runtime).toContain('config().strings.count');
  });

  test("the countdown wording and its token come from the offer", () => {
    /*
     * The merchant's sentence carries `{{timer}}` where the clock goes, so both
     * halves are escaped and only the clock is markup of ours. The locale file
     * holds the fallback sentence for a store whose offer said nothing.
     */
    const runtime = readFileSync(join(EXTENSION, "assets", "reco.js"), "utf8");
    const css = readFileSync(join(EXTENSION, "assets", "reco.css"), "utf8");
    const locales = JSON.parse(
      readFileSync(join(EXTENSION, "locales", "en.default.json"), "utf8"),
    );

    expect(runtime).toContain('var COUNTDOWN_TOKEN = "{{timer}}"');
    expect(runtime).toContain("escapeHtml(lead)");
    expect(runtime).toContain("escapeHtml(trail)");
    expect(locales.recommendations.countdown).toContain("{{timer}}");

    // The clock is the only bold thing in the bar, and tabular figures stop the
    // row jittering as the digits change.
    expect(css).toContain(".reco__countdown-value");
    expect(css).toContain("font-variant-numeric: tabular-nums");
  });

  test("the storefront clock and the admin's agree on their defaults", () => {
    /*
     * reco.js is a plain theme asset with no bundler, so it cannot import
     * app/lib/countdown.js — each carries its own copy of the same clock. The
     * *format* is pinned behaviourally on both sides (tests/reco-runtime.test.js
     * runs reco.js, app/lib/countdown.test.js runs the shared one, against the
     * same expected strings); what this checks is that the fallbacks match, since
     * a preview promising a clock the shopper does not get is the failure here.
     */
    const runtime = readFileSync(join(EXTENSION, "assets", "reco.js"), "utf8");
    const shared = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "app", "lib", "countdown.js"),
      "utf8",
    );

    expect(shared).toContain("DEFAULT_COUNTDOWN_MINUTES = 60");
    expect(runtime).toContain("Number(copy.countdownMinutes) || 60");

    // Both step up to days past 24 hours — a week-long countdown read "130:37:21"
    // on a live storefront before they did.
    for (const source of [shared, runtime]) {
      expect(source).toContain("86400");
    }
    // The storefront takes the day letter from the locale file; the shared copy is
    // for the English admin and takes a parameter.
    expect(runtime).toContain("config().strings.countdownDays");
    expect(locales.recommendations.countdown_days).toBe("d");
    expect(shared).toContain('dayUnit = "d"');

    // And on the token, which is what the merchant types.
    expect(shared).toContain('COUNTDOWN_TOKEN = "{{timer}}"');
    expect(runtime).toContain('COUNTDOWN_TOKEN = "{{timer}}"');
  });

  test("the block renders the countdown too, not just the app embed", () => {
    /*
     * The block is the documented storefront path, so an offer's countdown cannot
     * be a feature of the embed alone — it would vanish the moment a merchant
     * placed the block. Liquid emits the bar with the settings on data attributes
     * and the clock empty; reco.js reads them back into the same shape it gets
     * from the embed's offer object.
     */
    expect(panel).toContain("data-reco-countdown");
    expect(panel).toContain("data-reco-countdown-mode");
    expect(panel).toContain("data-reco-countdown-minutes");
    expect(panel).toContain("data-reco-countdown-ends-at");
    expect(panel).toContain("data-reco-countdown-value");

    // Merchant copy going into markup — Liquid does not escape by default.
    expect(panel).toContain("timer_lead | escape");
    expect(panel).toContain("timer_trail | escape");
    // Split on the token, with the no-token case falling back to "clock last".
    expect(panel).toContain("split: '{{timer}}'");
    expect(panel).toContain("if timer_parts.size < 2");

    const runtime = readFileSync(join(EXTENSION, "assets", "reco.js"), "utf8");
    expect(runtime).toContain("function countdownFromBlock(block)");
  });

  test("an expired countdown stops the offer being rendered at all", () => {
    /*
     * Checked before injection on purpose: rendering and then hiding would flash
     * the offer and fire the serve beacon, billing a recommendation nobody saw.
     */
    const runtime = readFileSync(join(EXTENSION, "assets", "reco.js"), "utf8");
    const injection = runtime.slice(runtime.indexOf("function initEmbeddedOffer"));

    expect(injection.indexOf("countdownIsOver(")).toBeLessThan(injection.indexOf("buildBlock("));
    // 24 hours, then the cycle starts again — urgency that works on a page most
    // shoppers see once.
    expect(runtime).toContain("var COUNTDOWN_HIDE_MS = 24 * 60 * 60 * 1000");
  });

  test("the offer carousel steps, so it asks its column for one card", () => {
    /*
     * The concrete break: `.reco--slider` lays the track out as a flex row of cards each
     * `flex: 0 0 100%`, so its **max-content** is three cards wide — `overflow-x: auto`
     * caps what is painted, not what the layout is told is needed. A product page whose
     * media and info columns are flex items with `flex-basis: auto` sizes them from
     * content, so the info column demanded ~3× and the image shrank to pay for it.
     *
     * One card in flow at a time removes the multiplier at the root, and matches what the
     * admin preview has always done.
     */
    const runtime = readFileSync(join(EXTENSION, "assets", "reco.js"), "utf8");
    const css = readFileSync(join(EXTENSION, "assets", "reco.css"), "utf8");

    expect(css).toContain(".reco--offer .reco__track");
    expect(css).toContain("overflow-x: visible");
    expect(runtime).toContain("function setupOfferCarousel(block)");
    // The offer path must not fall through to the scrolling slider.
    expect(runtime).toContain('if (block.classList.contains("reco--offer"))');
    expect(runtime).toContain("card.hidden = at !== index");

    /*
     * And the stylesheet has to let `[hidden]` win. It is a UA rule with almost no
     * specificity, so `.reco--offer .reco-card { display: grid }` beat it and the carousel
     * rendered as a stack of three cards with "Product 1 of 3" underneath — the same trap
     * `.reco__nav[hidden]` already carries, one section later.
     *
     * jsdom cannot catch it: the tests assert `card.hidden`, the attribute, which was set
     * correctly the whole time. Only the cascade was wrong, so this is a source check.
     */
    expect(css).toContain(".reco--offer .reco-card[hidden]");

    /*
     * The step is animated, and the two halves have to agree on the duration: reco.js
     * sequences the swap with `STEP_MS` and the stylesheet transitions over the same
     * number. Reduced motion turns the transition off, and reco.js skips the delay with
     * it — a timeout without a transition is just lag.
     */
    expect(runtime).toContain("var STEP_MS = 160");
    expect(css).toContain("transform 160ms ease");
    expect(css).toContain('[data-reco-leaving="next"]');
    expect(css).toContain('[data-reco-entering="next"]');
    expect(css).toContain("prefers-reduced-motion: reduce");
    expect(runtime).toContain("prefers-reduced-motion: reduce");
    expect(css.indexOf(".reco--offer .reco-card {")).toBeLessThan(
      css.indexOf(".reco--offer .reco-card[hidden]"),
    );
  });

  test("the injected block never joins a horizontal row", () => {
    /*
     * A theme that lays quantity and Add to cart out as a flex row treats the injected
     * block as a third item: the row wraps, the quantity box takes its own line and the
     * button stretches across the next. The offer rendered correctly and rebuilt the
     * buy area doing it.
     *
     * A flex *column* is left alone — there a new item is a new row, which is the
     * intent — and the CSS carries a fallback for layouts this app has never seen.
     */
    const runtime = readFileSync(join(EXTENSION, "assets", "reco.js"), "utf8");
    const css = readFileSync(join(EXTENSION, "assets", "reco.css"), "utf8");

    /*
     * A form is the deterministic boundary and is tried first: no computed style to read,
     * no layout to guess at. The style-based climb is the fallback for themes that wrap
     * their buy buttons in no form at all, and a merchant's own selector overrules both.
     */
    expect(runtime).toContain("function insertionTarget(anchor, exact)");
    expect(runtime).toContain("if (exact) return anchor;");
    expect(runtime).toContain("anchor.closest('form[action*=\"/cart/add\"], product-form')");
    expect(runtime).toContain('direction === "row" || direction === "row-reverse"');
    // Bounded, or a fully flex-based theme walks to <body>.
    expect(runtime).toContain("depth < 3");
    expect(runtime).toContain("var target = insertionTarget(anchor, found.exact)");

    expect(css).toContain(".reco--embedded");
    expect(css).toContain("flex-basis: 100%");

    /*
     * And it must not *size* the column either. A product page whose media and info
     * columns are flex items with `flex-basis: auto` distributes width by content size,
     * so the offer's content made the info column grow and the product image shrink to
     * pay for it. Containment takes the block's contents out of that calculation; the
     * floor stops it collapsing to nothing in a column that holds only the widget.
     */
    /*
     * ⚠️ `contain: layout inline-size` was tried here and **hid the widget** on a real
     * theme. Taking an element's inline size out of layout depends on the parent chain in
     * ways this app cannot see from the admin, so it is pinned out. What is left only
     * lowers the block's *minimum* contribution: it can shrink a column's demand, and it
     * can never collapse the block.
     */
    expect(css).not.toMatch(/^\s*contain:/m);
    expect(css).toContain(".reco--embedded > * {");
    expect(css).toContain("overflow-wrap: anywhere");
  });

  test("the embed injects offers, and nothing else", () => {
    /*
     * The same metafield holds lists curated on the recommendations page, which have no
     * offer behind them. Injecting those made a widget appear on a product page the
     * moment the app embed was switched on, with the admin showing no offers at all —
     * not what enabling an embed asks for. Those lists still render wherever the
     * merchant *places* a block; that they chose.
     */
    const embed = readLiquid(join(BLOCKS, "app-embed.liquid"));
    const runtime = readFileSync(join(EXTENSION, "assets", "reco.js"), "utf8");

    expect(embed).toContain("assign offer_id = reco.offerId");
    expect(embed).toContain("if offer_id != blank");
    expect(runtime).toContain("if (!offer.offerId) return Promise.resolve(false)");
  });

  test("the embed matches shop-scope offers against the product in front of it", () => {
    /*
     * An "all products" or collections offer cannot be mirrored per product, so it
     * lives in one shop metafield and the **trigger is matched here** — which is
     * what makes "all products" include products added after the offer was
     * published.
     */
    const embed = readLiquid(join(BLOCKS, "app-embed.liquid"));

    expect(embed).toContain('shop.metafields["$app"].reco_offers.value.offers');
    // The product's own list wins: a merchant who named this product meant it.
    expect(embed.indexOf('product.metafields["$app"].reco_overrides.value')).toBeLessThan(
      embed.indexOf("reco_offers"),
    );
    /*
     * The precedence test is `offerId`, not "does this product have items".
     *
     * A list curated on the recommendations page has no offer behind it and is never
     * injected (§7.9) — but while the check was items-based it still *shadowed* the shop
     * list, so an "all products" offer went missing on exactly the products that already
     * had a curated list, and nothing rendered there at all.
     */
    expect(embed).toContain("if reco.offerId == blank");
    expect(embed).not.toContain("if reco.items == blank");

    // Trigger: all, or this product's collections by handle.
    expect(embed).toContain("candidate_offer.trigger.mode == 'all'");
    expect(embed).toContain("candidate_offer.trigger.collections contains product_collection.handle");

    // Exclusions are checked after the trigger and win over it.
    expect(embed).toContain("candidate_offer.exclude.products contains product_id_string");
    expect(embed).toContain("candidate_offer.exclude.collections contains product_collection.handle");

    // First match wins, and the list arrives oldest-first.
    expect(embed).toContain("break");
  });

  test("the embed does not write a mixed and/or chain", () => {
    /*
     * Liquid has no operator precedence and evaluates `a and b or c` right to left,
     * so that form says something other than it reads. The trigger-product skip was
     * written that way once; it is spelled out now.
     */
    const embed = readLiquid(join(BLOCKS, "app-embed.liquid"));
    expect(embed).not.toMatch(/\{%-?\s*if[^%]*\band\b[^%]*\bor\b/);
    expect(embed).toContain("assign include_candidate");
    expect(embed).toContain("assign renderable_offer");
  });

  test("an automated offer ships an intent instead of a list", () => {
    /*
     * Shopify supplies the products in the browser — the same request the theme
     * block's Related and Complementary sources make — so there is nothing for
     * Liquid to resolve and no stale copy of the list to ship.
     */
    const embed = readLiquid(join(BLOCKS, "app-embed.liquid"));
    const runtime = readFileSync(join(EXTENSION, "assets", "reco.js"), "utf8");

    expect(embed).toContain("if reco.source.mode == 'automated'");
    // Folded into one boolean, because a mixed and/or chain in Liquid reads
    // right-to-left — see the test below.
    expect(embed).toContain("assign renderable_offer");
    expect(embed).toContain("elsif automated");
    expect(embed).toContain("source: {%- if reco.source -%}");

    expect(runtime).toContain('offer.source.mode === "automated"');

    /*
     * And it says which silence it is. An automated offer that renders nothing looks
     * identical to a broken one, and the two causes need different actions: Shopify having
     * no data for the product, versus the request failing — which is what a
     * password-protected store does, answering with a 302 to /password that `fetch`
     * follows before `response.json()` throws on HTML.
     */
    expect(runtime).toContain("products for product");
    expect(runtime).toContain("the recommendations request failed for product");
    expect(runtime).toContain('block.setAttribute("data-reco-intent", offer.source.intent');
  });

  test("cart contents are only emitted when an offer asked for the filter", () => {
    // `cart` is readable in Liquid and nowhere else, but putting the shopper's cart
    // on every page for a filter nobody turned on is not free.
    const embed = readLiquid(join(BLOCKS, "app-embed.liquid"));
    const guard = embed.slice(embed.indexOf("window.EasyReco.cart") - 400, embed.indexOf("window.EasyReco.cart"));

    expect(guard).toContain("if reco.visibility.hideInCart");
    expect(embed).toContain("line.product_id");
  });

  test("the block carries the offer's visibility rules too", () => {
    /*
     * The same three settings apply wherever the offer renders, so reco.js reads
     * them off the block and applies them to whatever is in the track — cards
     * Liquid drew here, or cards the embed injected.
     */
    expect(panel).toContain("copy.visibility.hideInCart");
    expect(panel).toContain("copy.visibility.quantityPicker");

    const runtime = readFileSync(join(EXTENSION, "assets", "reco.js"), "utf8");
    expect(runtime).toContain("function applyVisibility(block)");
    // Before wire(), so a hidden card never reports an impression.
    expect(runtime.indexOf("function applyVisibility")).toBeLessThan(
      runtime.indexOf("function wire(block)"),
    );
  });

  test("an offer never ships an out-of-stock product", () => {
    /*
     * The Offer tab states it as a fact: "only offer items that are in stock will be
     * displayed on product pages". Both halves of the offer path honour it — Liquid
     * for an inlined list, reco.js for a fetched one — and a theme block does not,
     * because Sold out is the documented behaviour of its own settings.
     */
    const embed = readLiquid(join(BLOCKS, "app-embed.liquid"));
    const runtime = readFileSync(join(EXTENSION, "assets", "reco.js"), "utf8");

    expect(embed).toContain("candidate.available == false");
    expect(runtime).toContain('data-reco-in-stock-only');
    expect(runtime).toContain("inStockOnly && product.available === false");
    // Set on every injected offer rather than read from a setting.
    expect(runtime).toContain('block.setAttribute("data-reco-in-stock-only", "true")');
  });

  test("the embed passes the offer type through to the runtime", () => {
    /*
     * The type is what decides the injected layout — a carousel of rows for the
     * card-style offer types, a grid for the bundle ones — and the embed has no
     * block settings to read instead. Null when the metafield has none, which is
     * the case for a list curated on the recommendations page.
     */
    const embed = readLiquid(join(BLOCKS, "app-embed.liquid"));

    expect(embed).toContain("type: {%- if reco.type -%}{{ reco.type | json }}");

    // The injected arrows are built in JS, so their labels have to ride on the
    // embed's config — a block's Liquid is not on the page here.
    expect(embed).toContain("recommendations.previous");
    expect(embed).toContain("recommendations.next");
  });

  test("the offer carousel reuses the slider, it is not a second scroller", () => {
    /*
     * `reco--slider` is what brings the scroll-snap CSS and makes wire() call
     * setupSlider; `reco--offer` only turns each card into a row. A separate
     * carousel implementation for one caller is the thing being avoided.
     */
    const runtime = readFileSync(join(EXTENSION, "assets", "reco.js"), "utf8");
    const css = readFileSync(join(EXTENSION, "assets", "reco.css"), "utf8");

    expect(runtime).toContain('"reco--slider reco--offer"');
    expect(runtime).toContain("CAROUSEL_OFFER_TYPES");
    // One column per view is the carousel; the slider CSS resolves flex-basis
    // from the column count.
    expect(runtime).toContain('block.style.setProperty("--reco-columns-desktop", "1")');

    expect(css).toContain(".reco--offer .reco-card");
    expect(css).toContain(".reco__nav--header");
    // The injected block lands in a theme this app has never seen, so a 100%-wide
    // card with its own padding must not depend on the theme's box model.
    expect(css).toContain("box-sizing: border-box");
  });

  test("the slider arrows are drawn, and the two copies match", () => {
    /*
     * They were the `‹` and `›` text glyphs, which every theme font renders at a
     * different weight, size and baseline — thin and sitting high in most of them.
     * Liquid draws the block's nav and reco.js draws the injected offer's, so the
     * two paths have to agree on the shape or one storefront row gets a different
     * arrow from the next.
     */
    const runtime = readFileSync(join(EXTENSION, "assets", "reco.js"), "utf8");
    const css = readFileSync(join(EXTENSION, "assets", "reco.css"), "utf8");

    for (const path of ["M15 5 8 12l7 7", "M9 5l7 7-7 7"]) {
      expect(panel, `${path} missing from reco-panel.liquid`).toContain(path);
      expect(runtime, `${path} missing from reco.js`).toContain(path);
    }

    // No glyph left in either copy.
    expect(panel).not.toContain("&#8249;");
    expect(runtime).not.toContain("&#8249;");

    // currentColor is what lets the same icon sit on a white disc over
    // photography and bare beside a heading.
    expect(runtime).toContain('stroke="currentColor"');
    expect(css).toContain(".reco__nav-icon");
    // Centred by the button rather than by a font's line-height.
    expect(css).toContain("display: inline-flex");
  });

  test("the embed loads the stylesheet it will need", () => {
    // Blocks emit reco.css themselves; on the embed path there is no block, so
    // the injected container would be unstyled without this.
    const embed = readLiquid(join(BLOCKS, "app-embed.liquid"));
    expect(embed).toContain("'reco.css' | asset_url | stylesheet_tag");
  });

  test("a product is never offered as its own recommendation", () => {
    const embed = readLiquid(join(BLOCKS, "app-embed.liquid"));
    expect(embed).toContain("candidate.id != product.id");
  });

  test("an offer's copy overrides the block's own settings", () => {
    expect(panel).toContain("reco_overrides.value.copy");
    // Falls back rather than replacing: the setting is read first, then beaten.
    expect(panel).toContain("assign heading = block.settings.heading");
    expect(panel).toContain("if copy.title != blank");
    expect(panel).toContain("if copy.buttonText != blank");
  });

  test("only the custom source reads offer copy", () => {
    // Related and Complementary never touch the metafield, so copy from one
    // would be wording with no list behind it.
    const guard = panel.slice(panel.indexOf("assign copy = nil"));
    expect(guard).toContain("if mode == 'custom'");
  });

  test("the badge has no block setting to fall back to", () => {
    /*
     * A badge is something an offer says, not a property of where the block sits,
     * so there is deliberately no `badge` in either schema — only the metafield
     * can supply one.
     */
    expect(panel).toContain('class="reco__badge"');
    for (const file of blockFiles) {
      const settings = readSchema(file).settings ?? [];
      expect(
        settings.find((entry) => entry.id === "badge"),
        `${file} grew a badge setting`,
      ).toBeUndefined();
    }
  });

  test("the badge and heading are styled", () => {
    // The panel emits them unconditionally once an offer supplies either, so an
    // unstyled badge would be raw text next to the heading.
    const css = readFileSync(join(EXTENSION, "assets", "reco.css"), "utf8");
    expect(css).toContain(".reco__header");
    expect(css).toContain(".reco__badge");
  });

  test("the heading is a plain setting with a literal default", () => {
    // Deliberately not source-aware: Liquid cannot write a block setting, so a
    // heading that changed with the source left the editor's own input showing
    // a different string from the storefront.
    const heading = schema.settings.find((entry) => entry.id === "heading");
    expect(heading.default).toBe("You may also like");
    expect(source).toContain("assign heading = block.settings.heading");
    expect(source).not.toContain("heading_is_default");
  });

  test("no block ships a placeholder heading", () => {
    /*
     * Both card blocks shipped with `"default": "Heading"`, which is not a
     * default — it is the label leaking into the value. A merchant who added the
     * block got a literal <h2>Heading</h2> on their live product page, because
     * the panel renders the setting whenever it is non-blank.
     */
    for (const file of blockFiles) {
      const heading = (readSchema(file).settings ?? []).find(
        (entry) => entry.id === "heading",
      );
      if (!heading) continue;
      expect(heading.default, `${file} has no heading default`).toBeTruthy();
      expect(
        String(heading.default).trim().toLowerCase(),
        `${file} ships the label as its heading default`,
      ).not.toBe("heading");
    }
  });

  test("every client-rendering block carries the shop money format", () => {
    /*
     * reco.js formats prices for everything Liquid could not render, and its
     * only other source for the format is the app embed — which is optional,
     * and which every block is built to work without. Missing here, the fallback
     * is a hardcoded "$" on every price in a non-USD store, and in the bundle a
     * total in one currency under rows in another.
     */
    for (const markup of [panel, readLiquid(join(BLOCKS, UPSELL))]) {
      expect(markup).toContain("data-reco-money-format=");
      // strip_html because some stores still hold a <span class="money"> wrapper,
      // which would land in textContent as literal tags.
      expect(markup).toContain("shop.money_format | strip_html");
    }
  });

  test("every editor hint has a translation", () => {
    // A missing key renders the literal string "translation missing" in the
    // theme editor, which no test of the schema alone would catch.
    for (const key of [
      "popular.empty",
      "collection.empty",
      "collection.needs_collection",
      "recently_viewed.empty",
      "recommendations.needs_product",
      "complementary.empty",
      "related.empty",
    ]) {
      expect(lookupLocale(key), `${key} has no string`).toBeTruthy();
    }
  });

  test("every translation the block asks for exists", () => {
    // Catches a hint added to the Liquid without a matching locale entry, which
    // renders the literal words "translation missing" in the theme editor.
    for (const [, key] of source.matchAll(/'([a-z_]+\.[a-z_]+)'\s*\|\s*t\b/g)) {
      expect(lookupLocale(key), `${key} has no string`).toBeTruthy();
    }
  });

  test("neither collection-driven source renders empty on an untouched picker", () => {
    // A merchant who picks the source and nothing else still sees products.
    // Popular answers "no collection" with the whole catalogue; Collection
    // products answers it with the store's first collection, which is only
    // reachable by iterating — `collections` has no first/index accessor, and
    // Liquid cannot write the setting itself.
    expect(showcase).toContain("assign collection_source = collections.all");
    expect(showcase).toContain("for shop_collection in collections");
    // Landing on the catch-all would make the source identical to Popular.
    expect(showcase).toContain("shop_collection.handle != 'all'");

    // The hint is for a store with no collections at all, the one case the
    // fallback cannot cover.
    expect(panel).toContain("collection.needs_collection");
    expect(lookupLocale("collection.needs_collection")).toContain("no collections");
  });



  test("reads the override metafield through the reserved prefix", () => {
    // `metafields.app` resolves to nil and silently drops every override.
    expect(source).toContain('product.metafields["$app"].reco_overrides.value');
    expect(source).not.toContain("product.metafields.app.reco_overrides");
  });

  test("ships a card template only when the browser has to render", () => {
    expect(source).toContain("<template data-reco-card-template>");
    expect(source).toContain("assign client_rendered");
    expect(hasAttribute(source, "data-reco-mode", "recent")).toBe(true);
  });

  test("the app embed records the history the recently viewed source reads", () => {
    const embed = readLiquid(join(BLOCKS, "app-embed.liquid"));
    const script = readFileSync(join(EXTENSION, "assets", "reco.js"), "utf8");

    expect(embed).toContain("easy-reco:recently-viewed");
    expect(script).toContain("easy-reco:recently-viewed");
    expect(embed).toContain("template.name == 'product'");
  });
});

/*
 * The Upsell block — frequently bought together.
 *
 * A bundle, not a row of cards: several ticked lines, a running total, and one
 * /cart/add.js call. It earns its own block on markup grounds, which is the
 * structural test §7.3 settled for splits, and it shares the tracking runtime in
 * reco.js rather than shipping a second asset (CLAUDE.md 7.4).
 */
describe("the upsell block", () => {
  const source = readLiquid(join(BLOCKS, UPSELL));
  const row = readLiquid(join(SNIPPETS, "upsell-row.liquid"));
  const schema = readSchema(UPSELL);
  const runtime = readFileSync(join(EXTENSION, "assets", "reco.js"), "utf8");

  test("is named for what it does, not the category it sits in", () => {
    // It is a cross-sell bundle. "Upsell" means a better version of the same
    // product — an upgrade — which Shopify's `related` list cannot supply, so
    // the merchant-facing name must not claim it. `upsell` stays as the internal
    // identifier: filename, placement key, CSS prefix (CLAUDE.md 7.4).
    expect(schema.name).toBe("Bought Together");
    expect(schema.name.toLowerCase()).not.toContain("upsell");

    // The name is the 25-character-capped short form; the heading, which has no
    // cap, carries the full phrase and must still agree with it.
    const heading = schema.settings.find((entry) => entry.id === "heading");
    expect(heading.default).toBe("Frequently bought together");
    expect(heading.default.toLowerCase()).toContain(schema.name.toLowerCase());
  });

  test("is pinned to product templates", () => {
    // It bundles the product being viewed, so it cannot work anywhere else.
    expect(schema.enabled_on).toEqual({ templates: ["product"] });
  });

  test("reads the override metafield through the reserved prefix", () => {
    // `metafields.app` resolves to nil and silently drops every override.
    expect(source).toContain('product.metafields["$app"].reco_overrides.value');
    expect(source).not.toContain("product.metafields.app.reco_overrides");
  });

  test("bills like a recommendation", () => {
    // It has a source product and answers "what goes with this", which is the
    // line CLAUDE.md 7.1 draws between recommendation and merchandising — so it
    // must not carry the merchandising opt-out.
    expect(source).not.toContain('data-reco-serve="false"');
    expect(hasAttribute(source, "data-reco-placement", "upsell")).toBe(true);
    expect(runtime).toMatch(/type: "served"[\s\S]{0,160}placement: "upsell"/);
  });

  test("never attributes the shopper's own product to itself", () => {
    // The "This item" row is the source product. Marking it as a reco card
    // would book an impression, a click and an add_to_cart against the very
    // product whose page it sits on.
    expect(row).toContain("data-upsell-current");
    expect(row).toMatch(/if is_current[\s\S]{0,80}data-upsell-current/);
    // And its cart line carries no attribution properties.
    expect(runtime).toContain("properties: isCurrent");
  });

  test("offers a variant picker instead of guessing a variant", () => {
    // "Add the first variant" is how a shopper ends up with the wrong size in
    // their cart; skipping every multi-variant product would empty the block on
    // most stores. Both paths build a picker from the AVAILABLE variants only.
    expect(row).toContain("item.variants | where: 'available'");
    expect(row).toContain("data-upsell-variant");
    expect(runtime).toContain("variant.available");
    expect(runtime).toContain("if (sellable.length === 0) return;");
  });

  test("resolves the current product's variant at add time, not render time", () => {
    // Most themes rewrite ?variant= without firing popstate, so a value read at
    // render time goes stale the moment the shopper picks a different size.
    expect(runtime).toContain("function currentVariantId(");
    expect(runtime).toMatch(/searchParams\.get\("variant"\)/);
  });

  test("adds every ticked line in one cart call", () => {
    // Not a loop of single adds: each one would fire its own cart-updated event
    // and the theme would redraw the drawer once per product.
    const calls = runtime.match(/fetch\("\/cart\/add\.js"/g) ?? [];
    // One for the card blocks' per-card button, one for the bundle.
    expect(calls.length).toBe(2);
    expect(runtime).toContain("JSON.stringify({ items: items })");
  });

  test("counts one add_to_cart per recommended line", () => {
    // A three-product bundle is three add_to_carts, otherwise the funnel
    // under-reports every bundle as a single conversion.
    expect(runtime).toMatch(/attributed\.forEach\([\s\S]{0,300}type: "add_to_cart"/);
  });

  test("reports ticking a line as a click", () => {
    // There are no per-card buttons here, so the tick is the engagement signal;
    // without it the funnel would jump impression → add_to_cart with no click.
    expect(runtime).toContain("data-upsell-clicked");
    expect(runtime).toMatch(/type: "click"[\s\S]{0,160}placement: "upsell"/);
  });

  test("carries its own labels so it works without the app embed", () => {
    // The embed is optional; a block whose button says nothing until the embed
    // is enabled is a broken block.
    for (const attribute of [
      "data-upsell-add-one",
      "data-upsell-add-many",
      "data-upsell-add-none",
      "data-upsell-total-label",
    ]) {
      expect(source, `${attribute} is not emitted`).toContain(attribute);
    }
  });

  test("every count placeholder has a matching substitution", () => {
    // A label that keeps its [count] on screen is the visible symptom.
    for (const key of ["upsell.add_many", "upsell.total"]) {
      expect(lookupLocale(key), `${key} has no string`).toBeTruthy();
      expect(lookupLocale(key), `${key} has no [count]`).toContain("[count]");
    }
    expect(lookupLocale("upsell.add_one")).not.toContain("[count]");
    const substitutions = runtime.match(/replace\("\[count\]"/g) ?? [];
    expect(substitutions.length).toBe(2);
  });

  test("every translation the block asks for exists", () => {
    for (const [, key] of (source + row).matchAll(/'([a-z_]+\.[a-z_]+)'\s*\|\s*t\b/g)) {
      expect(lookupLocale(key), `${key} has no string`).toBeTruthy();
    }
  });

  test("does not render a lone This item row", () => {
    // A bundle of one, with a total and an "Add 1 item to cart" button, is not
    // an upsell — it is a second add-to-cart button on the product page.
    expect(runtime).toContain('if (!block.querySelector("[data-reco-card]")) block.remove();');
  });

  test("claims itself so the card runtime skips it", () => {
    // It carries data-reco-block for the shared tracking wiring, so without
    // this both init loops would wire the same block.
    expect(source).toContain("data-reco-block");
    expect(runtime).toMatch(/initUpsell\(\);/);
    expect(runtime).toContain('block.setAttribute("data-reco-ready", "true");');
  });
});
