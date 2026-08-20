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

describe("two blocks, five sources", () => {
  // Markup assertions have to see the shared panel, which is where it lives.
  const panel = readLiquid(PANEL);
  const source = readLiquid(join(BLOCKS, RECOMMENDATIONS)) + panel;
  const showcase = readLiquid(join(BLOCKS, SHOWCASE)) + panel;
  const schema = readSchema(RECOMMENDATIONS);
  const showcaseSchema = readSchema(SHOWCASE);
  const setting = schema.settings.find((entry) => entry.id === "source");

  test("the five sources are split across exactly two blocks", () => {
    // Upsell is a third block but not a sixth source — it is the same Custom
    // list in bundle form, so it does not belong to this split (CLAUDE.md 7.4).
    expect(blockFiles.sort()).toEqual(
      ["app-embed.liquid", RECOMMENDATIONS, SHOWCASE, UPSELL].sort(),
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
