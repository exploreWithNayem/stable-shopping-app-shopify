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

  test("the recommendations block loads its own assets", () => {
    const schema = readSchema("recommendations.liquid");
    const source = readLiquid(join(BLOCKS, "recommendations.liquid"));

    // The stylesheet is pulled in explicitly, not declared in the schema:
    // Shopify does not reliably serve a block's declared assets when several
    // blocks from one extension are on the same page, which rendered the block
    // as unstyled markup. Asserted so nobody "tidies" it back into the schema.
    expect(schema.stylesheet).toBeUndefined();
    expect(source).toContain("'reco.css' | asset_url | stylesheet_tag");
    expect(schema.javascript).toBe("reco.js");
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

describe("the one block, three sources", () => {
  const file = "recommendations.liquid";
  const source = readLiquid(join(BLOCKS, file));
  const schema = readSchema(file);
  const setting = schema.settings.find((entry) => entry.id === "source");

  test("is the only block besides the app embed", () => {
    // A single block is the whole point: three separate ones made merchants
    // pick before they understood the difference.
    expect(blockFiles.sort()).toEqual(["app-embed.liquid", "recommendations.liquid"]);
  });

  test("offers all three sources, defaulting to custom", () => {
    expect(setting.type).toBe("select");
    expect(setting.options.map((option) => option.value)).toEqual([
      "custom",
      "popular",
      "recently_viewed",
    ]);
    // Existing placements keep behaving as they did.
    expect(setting.default).toBe("custom");
  });

  test("source-specific settings are scoped", () => {
    const by = (id) => schema.settings.find((entry) => entry.id === id);

    expect(by("intent").visible_if).toContain("'custom'");
    expect(by("sort_by").visible_if).toContain("'popular'");
    expect(by("hide_sold_out").visible_if).toContain("'popular'");
    expect(by("exclude_current").visible_if).toContain("'recently_viewed'");

    // `visible_if` on a resource input is rejected outright at deploy:
    //   settings: with id="collection" 'visible_if' is not a valid attribute
    // so that one is scoped by its info text instead.
    expect(by("collection").visible_if).toBeUndefined();
    expect(by("collection").info).toContain("Popular products");
  });

  test("only the custom source costs quota", () => {
    // Popular and Recently viewed render on every visit; billing those as
    // recommendations would burn a Free plan in an afternoon (CLAUDE.md 3.3).
    expect(hasAttribute(source, "data-reco-serve", "false")).toBe(true);

    for (const placement of ["pdp", "popular", "recently_viewed"]) {
      expect(
        hasAttribute(source, "data-reco-placement", placement),
        `missing placement ${placement}`,
      ).toBe(true);
    }
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
      "recently_viewed.empty",
      "recommendations.needs_product",
    ]) {
      expect(lookupLocale(key), `${key} has no string`).toBeTruthy();
    }
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
