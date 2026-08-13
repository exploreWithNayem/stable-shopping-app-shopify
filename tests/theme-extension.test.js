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
    expect(schema.stylesheet).toBe("reco.css");
    expect(schema.javascript).toBe("reco.js");
  });

  // all_products allows 20 lookups per page; the override list has to stay
  // clear of that ceiling.
  test("the product limit stays under the all_products lookup cap", () => {
    const limit = readSchema("recommendations.liquid").settings.find(
      (setting) => setting.id === "limit",
    );
    expect(limit.max).toBeLessThanOrEqual(12);
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

describe("popular products block", () => {
  const source = readLiquid(join(BLOCKS, "popular-products.liquid"));
  const schema = readSchema("popular-products.liquid");

  test("loads its own assets", () => {
    expect(schema.stylesheet).toBe("reco.css");
    expect(schema.javascript).toBe("reco.js");
  });

  // The whole point of this block: unlike recommendations.liquid it is not
  // pinned to the product template, so a merchant can place it anywhere.
  test("is not restricted to one template", () => {
    expect(schema.enabled_on).toBeUndefined();
    expect(schema.disabled_on).toBeUndefined();
  });

  // Merchandising, not a recommendation — see CLAUDE.md §3.3. A home page row
  // firing `served` would burn a Free plan's monthly quota in an afternoon.
  test("opts out of the serve beacon so it costs no quota", () => {
    expect(source).toContain('data-reco-serve="false"');
    expect(source).toContain('data-reco-placement="popular"');
  });

  // It renders in Liquid from a collection, so the JS fallback fetch (which
  // needs a source product) must never run for it.
  test("declares itself server-rendered", () => {
    expect(source).toContain('data-reco-server-rendered="true"');
  });

  // reco-card.liquid reads these off `block.settings` directly, so a missing id
  // silently renders a card with the feature switched off.
  test("defines every setting the shared card snippet reads", () => {
    const cardSource = readLiquid(join(SNIPPETS, "reco-card.liquid"));
    const used = new Set(
      [...cardSource.matchAll(/block\.settings\.([a-z0-9_]+)/g)].map(([, id]) => id),
    );
    const defined = new Set((schema.settings ?? []).map((setting) => setting.id));

    expect([...used].filter((id) => !defined.has(id))).toEqual([]);
  });

  test("sort options the Liquid does not handle cannot be selected", () => {
    const handled = ["best_selling", "newest", "price_asc", "price_desc", "title"];
    const sort = schema.settings.find((setting) => setting.id === "sort_by");

    expect(sort.options.map((option) => option.value).sort()).toEqual([...handled].sort());
  });
});

describe("translations", () => {
  const liquidFiles = [
    ...blockFiles.map((file) => join(BLOCKS, file)),
    ...readdirSync(SNIPPETS)
      .filter((name) => name.endsWith(".liquid"))
      .map((file) => join(SNIPPETS, file)),
  ];

  test("every translated key exists in en.default.json", () => {
    const missing = [];

    for (const path of liquidFiles) {
      const source = readLiquid(path);
      const matches = source.matchAll(/'([a-z0-9_]+(?:\.[a-z0-9_]+)+)'\s*\|\s*t\b/g);

      for (const [, key] of matches) {
        if (typeof lookupLocale(key) !== "string") missing.push(`${key} (${path})`);
      }
    }

    expect(missing).toEqual([]);
  });

  // `x | default: 'key' | t` pipes the merchant's own text through the
  // translation filter, which renders "translation missing" instead of it.
  test("no translation filter is chained onto a default", () => {
    const offenders = [];

    for (const path of liquidFiles) {
      const source = readLiquid(path);
      if (/\|\s*default:\s*'[^']+'\s*\|\s*t\b/.test(source)) offenders.push(path);
    }

    expect(offenders).toEqual([]);
  });
});
