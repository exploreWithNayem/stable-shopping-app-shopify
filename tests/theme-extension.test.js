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

describe("two blocks, five sources", () => {
  // Markup assertions have to see the shared panel, which is where it lives.
  const panel = readLiquid(PANEL);
  const source = readLiquid(join(BLOCKS, RECOMMENDATIONS)) + panel;
  const showcase = readLiquid(join(BLOCKS, SHOWCASE)) + panel;
  const schema = readSchema(RECOMMENDATIONS);
  const showcaseSchema = readSchema(SHOWCASE);
  const setting = schema.settings.find((entry) => entry.id === "source");

  test("the five sources are split across exactly two blocks", () => {
    expect(blockFiles.sort()).toEqual(
      ["app-embed.liquid", RECOMMENDATIONS, SHOWCASE].sort(),
    );
  });

  test("the recommendation block offers Custom and Related, defaulting to custom", () => {
    expect(setting.type).toBe("select");
    expect(setting.options.map((option) => option.value)).toEqual(["custom", "related"]);
    expect(setting.default).toBe("custom");
  });

  test("the showcase block offers the three merchandising sources", () => {
    const split = showcaseSchema.settings.find((entry) => entry.id === "source");
    expect(split.options.map((option) => option.value)).toEqual([
      "popular",
      "collection",
      "recently_viewed",
    ]);
    expect(split.default).toBe("popular");

    // No source appears in both blocks, and between them they cover all five.
    const all = [
      ...setting.options.map((o) => o.value),
      ...split.options.map((o) => o.value),
    ];
    expect(new Set(all).size).toBe(5);
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
    const differsByDesign = new Set(["source", "limit"]);

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

  test("every placement the block emits is one the server keeps", () => {
    // An unlisted placement is coerced to "pdp" in normalizeEvent, which would
    // fold a merchandising row into a product's recommendation metrics and let
    // the serve dedupe swallow a second recommendation row on the same page.
    const model = readFileSync(
      join(EXTENSION, "..", "..", "app", "models", "event.server.js"),
      "utf8",
    );
    const known = model.match(/PLACEMENTS = \[([\s\S]*?)\]/)[1].match(/"([a-z_]+)"/g);

    for (const [, placement] of source.matchAll(
      /data-reco-placement=["']([a-z_]+)["']/g,
    )) {
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

  test("the heading is a plain setting with a literal default", () => {
    // Deliberately not source-aware: Liquid cannot write a block setting, so a
    // heading that changed with the source left the editor's own input showing
    // a different string from the storefront.
    const heading = schema.settings.find((entry) => entry.id === "heading");
    expect(heading.default).toBe("Heading");
    expect(source).toContain("assign heading = block.settings.heading");
    expect(source).not.toContain("heading_is_default");
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
