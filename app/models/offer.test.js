import { afterAll, beforeEach, describe, expect, test } from "vitest";
import prisma from "../db.server";
import {
  DEFAULT_COUNTDOWN_MINUTES,
  DEFAULT_COUNTDOWN_TITLE,
  MAX_COUNTDOWN_MINUTES,
  clampCountdownMinutes,
} from "../lib/countdown";
import {
  MAX_ITEMS,
  MAX_TARGETS,
  isOfferLive,
  isShopScope,
  normalizeCollections,
  countOffers,
  deleteOffer,
  duplicateOffer,
  getOffer,
  listOffers,
  markDraft,
  markPublished,
  normalizeProducts,
  publishedTargetIds,
  saveOffer,
  validateForPublish,
  validateOffer,
} from "./offer.server";

const DOMAIN = "vitest-offer.myshopify.com";
let shopId;

const product = (id) => ({ id: String(id), handle: `p${id}`, title: `Product ${id}` });

const draft = (overrides = {}) => ({
  name: "Product page offer",
  placement: "PRODUCT_PAGE",
  offerType: "cross_sell",
  title: "You may also like",
  badge: "",
  buttonText: "Add",
  countdown: false,
  targets: [product(1)],
  items: [product(2)],
  ...overrides,
});

beforeEach(async () => {
  await prisma.shop.deleteMany({ where: { domain: DOMAIN } });
  const shop = await prisma.shop.create({ data: { domain: DOMAIN } });
  shopId = shop.id;
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { domain: DOMAIN } });
});

describe("normalizeProducts", () => {
  test("keeps order and stamps positions", () => {
    const result = normalizeProducts([product(3), product(1), product(2)]);
    expect(result.map((entry) => entry.id)).toEqual(["3", "1", "2"]);
    expect(result.map((entry) => entry.position)).toEqual([0, 1, 2]);
  });

  test("drops duplicates, keeping the first", () => {
    expect(normalizeProducts([product(1), product(1)])).toHaveLength(1);
  });

  test("drops ids that can never resolve", () => {
    // Shopify product ids are positive, so "" and "0" both mean the caller had
    // nothing real — letting one through writes an item the storefront cannot
    // resolve to anything.
    expect(normalizeProducts([{ id: "" }, { id: "0" }, { id: null }, product(1)])).toEqual([
      { id: "1", handle: "p1", title: "Product 1", position: 0 },
    ]);
  });

  test("caps at the limit it is given", () => {
    const many = Array.from({ length: 40 }, (_, i) => product(i + 1));
    expect(normalizeProducts(many)).toHaveLength(MAX_ITEMS);
    expect(normalizeProducts(many, MAX_TARGETS)).toHaveLength(40);
  });

  test("survives junk", () => {
    expect(normalizeProducts(null)).toEqual([]);
    expect(normalizeProducts("nope")).toEqual([]);
  });
});

describe("validation", () => {
  test("a draft needs only a name, placement and type", () => {
    expect(validateOffer(draft())).toEqual([]);
    expect(validateOffer(draft({ title: "", targets: [], items: [] }))).toEqual([]);
  });

  test("a draft still refuses an empty name or an unknown placement", () => {
    expect(validateOffer(draft({ name: "   " })).length).toBe(1);
    expect(validateOffer(draft({ placement: "CART_PAGE" })).length).toBe(1);
    expect(validateOffer(draft({ offerType: "nonsense" })).length).toBe(1);
  });

  /*
   * Publishing is stricter on purpose: a merchant who has picked products but not
   * written a title should be able to save and come back rather than lose the
   * products.
   */
  test("publishing needs targets, items and a title", () => {
    expect(validateForPublish(draft())).toEqual([]);
    expect(validateForPublish(draft({ targets: [] }))).toHaveLength(1);
    expect(validateForPublish(draft({ items: [] }))).toHaveLength(1);
    expect(validateForPublish(draft({ title: "" }))).toHaveLength(1);
  });

  test("reports every problem at once", () => {
    // The form shows them together; fixing three fields should not need three
    // round trips.
    expect(
      validateForPublish(draft({ name: "", title: "", targets: [], items: [] })),
    ).toHaveLength(4);
  });
});

describe("trigger and offer source", () => {
  test("only a named-products trigger needs targets", async () => {
    /*
     * "All products" and a collections trigger are answered by the trigger itself.
     * Demanding a target list there would make both modes impossible to publish.
     */
    const named = draft({ triggerMode: "products", targets: [] });
    expect(validateForPublish(named)).toHaveLength(1);

    expect(validateForPublish(draft({ triggerMode: "all", targets: [] }))).toEqual([]);
    expect(
      validateForPublish(
        draft({ triggerMode: "collections", targets: [], triggerCollections: [{ handle: "sale" }] }),
      ),
    ).toEqual([]);
  });

  test("a collections trigger needs a collection, or it shows nowhere", () => {
    const errors = validateForPublish(draft({ triggerMode: "collections", targets: [] }));
    expect(errors.join(" ")).toContain("collection");
  });

  test("automated recommendations need no item list", async () => {
    // Shopify supplies it on the storefront, which is the whole point of the mode.
    expect(validateForPublish(draft({ offerSource: "automated", items: [] }))).toEqual([]);
    expect(validateForPublish(draft({ offerSource: "specific", items: [] }))).toHaveLength(1);
  });

  test("an omitted trigger mode is validated as the stored default", () => {
    // A form that does not name the field means "products", the column default —
    // validating the raw value would skip a check the saved row then needs.
    expect(validateForPublish(draft({ targets: [] }))).toHaveLength(1);
  });

  test("isShopScope is what routes the publish", async () => {
    expect(isShopScope({ triggerMode: "all" })).toBe(true);
    expect(isShopScope({ triggerMode: "collections" })).toBe(true);
    expect(isShopScope({ triggerMode: "products" })).toBe(false);
    expect(isShopScope(null)).toBe(false);
  });

  test("collections are stored by handle, deduped, and blanks dropped", () => {
    // The handle is what Liquid compares `product.collections` to; a collection
    // without one could never match, so it is dropped rather than saved and ignored.
    const list = normalizeCollections([
      { id: "1", handle: "summer", title: "Summer" },
      { id: "2", handle: "summer", title: "Summer again" },
      { id: "3", handle: "", title: "No handle" },
      { id: "4", handle: " sale ", title: "Sale" },
    ]);

    expect(list.map((entry) => entry.handle)).toEqual(["summer", "sale"]);
  });

  test("saving keeps the trigger, source and visibility", async () => {
    const saved = await saveOffer(
      shopId,
      draft({
        triggerMode: "collections",
        triggerCollections: [{ id: "1", handle: "summer", title: "Summer" }],
        excludeProducts: [product(9)],
        excludeCollections: [{ id: "2", handle: "clearance" }],
        offerSource: "automated",
        offerIntent: "complementary",
        hideInCart: true,
        showQuantityPicker: true,
      }),
    );

    expect(saved).toMatchObject({
      triggerMode: "collections",
      offerSource: "automated",
      offerIntent: "complementary",
      hideInCart: true,
      showQuantityPicker: true,
      // Untouched by the form, so it keeps the column default.
      hideTriggerProduct: true,
      discountType: "none",
    });
    expect(saved.triggerCollections).toEqual([{ id: "1", handle: "summer", title: "Summer" }]);
    expect(saved.excludeCollections[0].handle).toBe("clearance");
  });

  test("an unknown trigger, source or intent falls back rather than saving", async () => {
    const saved = await saveOffer(
      shopId,
      draft({ triggerMode: "everywhere", offerSource: "magic", offerIntent: "vibes" }),
    );

    expect(saved).toMatchObject({
      triggerMode: "products",
      offerSource: "specific",
      offerIntent: "related",
    });
  });

  test("hideTriggerProduct defaults to true, not to Boolean(undefined)", async () => {
    /*
     * `Boolean(undefined)` is false, and this flag defaults to **true** — a product
     * has never been offered as its own recommendation. An input that simply does
     * not mention the field used to flip it.
     */
    expect((await saveOffer(shopId, draft())).hideTriggerProduct).toBe(true);
    expect(
      (await saveOffer(shopId, draft({ hideTriggerProduct: false }))).hideTriggerProduct,
    ).toBe(false);
  });
});

describe("isOfferLive", () => {
  /*
   * The storefront's authoritative check. A metafield is a mirror the app writes, and
   * a mirror cannot say whether the offer it mirrors still exists — so the storefront
   * proposes an offer id and this answers whether it is live for that product.
   */
  test("a published offer covering the product is live", async () => {
    const offer = await saveOffer(shopId, draft({ triggerMode: "products", targets: [product(1)] }));
    await markPublished(offer.id);

    expect(await isOfferLive(shopId, offer.id, "1")).toBe(true);
  });

  test("a draft is not live", async () => {
    const offer = await saveOffer(shopId, draft({ triggerMode: "products", targets: [product(1)] }));
    expect(await isOfferLive(shopId, offer.id, "1")).toBe(false);
  });

  test("a deleted offer is not live", async () => {
    // The whole point: this is what a stale metafield keeps rendering.
    const offer = await saveOffer(shopId, draft());
    await markPublished(offer.id);
    await deleteOffer(shopId, offer.id);

    expect(await isOfferLive(shopId, offer.id, "1")).toBe(false);
  });

  test("another shop's offer is not live here", async () => {
    const offer = await saveOffer(shopId, draft({ triggerMode: "products", targets: [product(1)] }));
    await markPublished(offer.id);

    expect(await isOfferLive("not-a-shop", offer.id, "1")).toBe(false);
  });

  test("a named-products offer covers named products only", async () => {
    const offer = await saveOffer(shopId, draft({ triggerMode: "products", targets: [product(1)] }));
    await markPublished(offer.id);

    expect(await isOfferLive(shopId, offer.id, "2")).toBe(false);
    // No product to check means coverage cannot be vouched for either way.
    expect(await isOfferLive(shopId, offer.id, null)).toBe(false);
  });

  test("an all-products offer covers any product, including one it never named", async () => {
    const offer = await saveOffer(shopId, draft({ triggerMode: "all", targets: [] }));
    await markPublished(offer.id);

    expect(await isOfferLive(shopId, offer.id, "99")).toBe(true);
  });

  test("a collections offer trusts the match Liquid already made", async () => {
    /*
     * Re-checking would mean an Admin API call per page view, and `product.collections`
     * is free in Liquid. What the mirror cannot be trusted about is whether the offer
     * is still published — which is what this answers.
     */
    const offer = await saveOffer(
      shopId,
      draft({ triggerMode: "collections", targets: [], triggerCollections: [{ handle: "sale" }] }),
    );
    await markPublished(offer.id);

    expect(await isOfferLive(shopId, offer.id, "99")).toBe(true);
  });

  test("an excluded product is never covered, whatever the trigger says", async () => {
    const offer = await saveOffer(
      shopId,
      draft({ triggerMode: "all", targets: [], excludeProducts: [product(7)] }),
    );
    await markPublished(offer.id);

    expect(await isOfferLive(shopId, offer.id, "7")).toBe(false);
    expect(await isOfferLive(shopId, offer.id, "8")).toBe(true);
  });
});

describe("rows written before the trigger columns existed", () => {
  /*
   * The Json columns are nullable and carry **no** `@default`, and this is why:
   * `Json @default("[]")` generates `DEFAULT []` on SQLite — unquoted, where
   * `[...]` is identifier-quoting syntax — so every row that predated the migration
   * got an **empty string**, and `prisma.offer.findMany()` died on the whole table
   * with "Inconsistent column data: EOF while parsing a value at line 1 column 0".
   * The home page could not load.
   *
   * Null is a value Prisma can read. These check that a row with nothing in those
   * columns still works everywhere they are read.
   */
  async function legacyRow(name) {
    const created = await saveOffer(shopId, draft({ name }));
    await prisma.$executeRawUnsafe(
      `UPDATE "Offer" SET "triggerCollections" = NULL, "excludeProducts" = NULL,
       "excludeCollections" = NULL WHERE id = ?`,
      created.id,
    );
    return created.id;
  }

  test("listing the offers does not blow up on them", async () => {
    const id = await legacyRow("Legacy offer");

    const listed = await listOffers(shopId);
    expect(listed.map((entry) => entry.id)).toContain(id);
    expect(listed.find((entry) => entry.id === id).triggerCollections).toBeNull();
  });

  test("duplicating one produces real empty lists", async () => {
    // `?? []` on the read, so the copy is well-formed even when the original had
    // nothing in those columns.
    const id = await legacyRow("Legacy offer");
    const copy = await duplicateOffer(shopId, id);

    expect(copy.triggerCollections).toEqual([]);
    expect(copy.excludeProducts).toEqual([]);
    expect(copy.excludeCollections).toEqual([]);
  });

  test("saving one fills them in", async () => {
    const id = await legacyRow("Legacy offer");
    const saved = await saveOffer(shopId, draft({ id, name: "Legacy offer" }));

    expect(saved.triggerCollections).toEqual([]);
  });
});

describe("countdown", () => {
  test("minutes are clamped, never rejected", () => {
    /*
     * The field is a number input: a merchant who types 0 or 100000 means "very
     * short" or "very long", not "refuse my save". One minute is the shortest
     * countdown that can be read.
     */
    expect(clampCountdownMinutes(0)).toBe(1);
    expect(clampCountdownMinutes(-5)).toBe(1);
    expect(clampCountdownMinutes(999999)).toBe(MAX_COUNTDOWN_MINUTES);
    expect(clampCountdownMinutes(45)).toBe(45);
    expect(clampCountdownMinutes("30")).toBe(30);
    // Nothing usable at all falls back to the default rather than to zero.
    expect(clampCountdownMinutes("")).toBe(DEFAULT_COUNTDOWN_MINUTES);
    expect(clampCountdownMinutes(undefined)).toBe(DEFAULT_COUNTDOWN_MINUTES);
  });

  test("saving keeps the countdown settings, defaulted", async () => {
    const offer = await saveOffer(shopId, draft({ countdown: true }));

    expect(offer).toMatchObject({
      countdown: true,
      countdownMode: "fixed",
      countdownMinutes: DEFAULT_COUNTDOWN_MINUTES,
      countdownTitle: DEFAULT_COUNTDOWN_TITLE,
    });
    expect(offer.countdownEndsAt).toBeNull();
  });

  test("an unknown mode falls back to fixed and a blank title to the default", async () => {
    // The values come from a form, so neither is trusted; a countdown with no
    // wording would render a bare clock with nothing explaining it.
    const offer = await saveOffer(
      shopId,
      draft({ countdown: true, countdownMode: "whenever", countdownTitle: "   " }),
    );

    expect(offer.countdownMode).toBe("fixed");
    expect(offer.countdownTitle).toBe(DEFAULT_COUNTDOWN_TITLE);
  });

  test("a date-mode countdown stores the instant, and unparseable input is null", async () => {
    const at = await saveOffer(
      shopId,
      draft({ countdown: true, countdownMode: "date", countdownEndsAt: "2026-09-01T18:00" }),
    );
    expect(at.countdownEndsAt).toBeInstanceOf(Date);

    const junk = await saveOffer(
      shopId,
      draft({
        id: at.id,
        countdown: true,
        countdownMode: "date",
        countdownEndsAt: "not a date",
      }),
    );
    expect(junk.countdownEndsAt).toBeNull();
  });

  test("publishing a date-mode countdown needs a date", () => {
    /*
     * Without one the storefront would render no timer and hide the offer instead
     * — the worst of both. A duration needs no such check: minutes are clamped.
     */
    const base = draft({ countdown: true, countdownMode: "date" });

    expect(validateForPublish(base).join(" ")).toContain("date and time");
    expect(validateForPublish({ ...base, countdownEndsAt: "2026-09-01T18:00" })).toEqual([]);
    expect(validateForPublish({ ...base, countdownMode: "fixed" })).toEqual([]);
    // Switched off, the mode is nobody's business.
    expect(validateForPublish({ ...base, countdown: false })).toEqual([]);
  });
});

describe("saveOffer", () => {
  test("creates a draft, never a published offer", () => {
    // Publishing has storefront side effects, so a plain save must not make
    // anything live.
    return saveOffer(shopId, draft()).then((offer) => {
      expect(offer.status).toBe("draft");
      expect(offer.publishedAt).toBeNull();
    });
  });

  test("updates in place when given an id", async () => {
    const first = await saveOffer(shopId, draft());
    const second = await saveOffer(shopId, draft({ id: first.id, name: "Renamed" }));

    expect(second.id).toBe(first.id);
    expect(second.name).toBe("Renamed");
    expect(await countOffers(shopId)).toBe(1);
  });

  test("keeps the status through a save", async () => {
    const created = await saveOffer(shopId, draft());
    await markPublished(created.id);

    const saved = await saveOffer(shopId, draft({ id: created.id, name: "Edited" }));
    expect(saved.status).toBe("published");
  });

  test("refuses an id belonging to another shop", async () => {
    const other = await prisma.shop.create({
      data: { domain: "vitest-offer-other.myshopify.com" },
    });
    const theirs = await saveOffer(other.id, draft({ name: "Theirs" }));

    // An id arriving in a form field is not proof of ownership.
    expect(await saveOffer(shopId, draft({ id: theirs.id, name: "Stolen" }))).toBeNull();
    expect((await getOffer(other.id, theirs.id)).name).toBe("Theirs");

    await prisma.shop.delete({ where: { id: other.id } });
  });

  test("normalises and defaults on the way in", async () => {
    const offer = await saveOffer(
      shopId,
      draft({ name: "  Spaced  ", buttonText: "  ", items: [product(2), product(2)] }),
    );

    expect(offer.name).toBe("Spaced");
    expect(offer.buttonText).toBe("Add");
    expect(offer.items).toHaveLength(1);
  });
});

describe("publishedTargetIds", () => {
  test("collects the products live offers occupy", async () => {
    const a = await saveOffer(shopId, draft({ targets: [product(1), product(2)] }));
    const b = await saveOffer(shopId, draft({ targets: [product(2), product(3)] }));
    await markPublished(a.id);
    await markPublished(b.id);

    // Deduped across offers: two offers on the same product still cost one.
    expect([...(await publishedTargetIds(shopId))].sort()).toEqual(["1", "2", "3"]);
  });

  test("ignores drafts", async () => {
    await saveOffer(shopId, draft({ targets: [product(9)] }));
    expect(await publishedTargetIds(shopId)).toEqual(new Set());
  });

  test("can exclude the offer being republished", async () => {
    const offer = await saveOffer(shopId, draft({ targets: [product(1)] }));
    await markPublished(offer.id);

    // Re-publishing occupies no new slot, so its own targets must not count.
    expect(await publishedTargetIds(shopId, { excludeOfferId: offer.id })).toEqual(new Set());
  });
});

describe("status and deletion", () => {
  test("markDraft clears the publish timestamp", async () => {
    const offer = await saveOffer(shopId, draft());
    await markPublished(offer.id);
    const back = await markDraft(offer.id);

    expect(back.status).toBe("draft");
    expect(back.publishedAt).toBeNull();
  });

  test("deleteOffer is scoped to the shop", async () => {
    const offer = await saveOffer(shopId, draft());
    expect(await deleteOffer("not-a-shop", offer.id)).toBeNull();
    expect(await deleteOffer(shopId, offer.id)).toMatchObject({ id: offer.id });
    expect(await countOffers(shopId)).toBe(0);
  });

  test("duplicateOffer copies the products but never the published status", async () => {
    /*
     * Publishing writes an Override row and a metafield per target, so a copy
     * that arrived published would overwrite the original's storefront output on
     * every product the two share — and nobody asked for that by pressing
     * Duplicate.
     */
    const offer = await saveOffer(
      shopId,
      draft({ name: "Summer bundle", badge: "Limited", countdown: true }),
    );
    await markPublished(offer.id);

    const copy = await duplicateOffer(shopId, offer.id);

    expect(copy.id).not.toBe(offer.id);
    expect(copy.status).toBe("draft");
    expect(copy.publishedAt).toBeNull();
    expect(copy.name).toBe("Summer bundle copy");
    expect(copy).toMatchObject({
      placement: offer.placement,
      offerType: offer.offerType,
      title: offer.title,
      badge: "Limited",
      buttonText: offer.buttonText,
      countdown: true,
    });
    // The products come along — re-picking them by hand is the work being saved.
    expect(copy.items).toEqual(offer.items);
    expect(copy.targets).toEqual(offer.targets);

    // The original is untouched, still live.
    expect(await getOffer(shopId, offer.id)).toMatchObject({ status: "published" });
    expect(await countOffers(shopId)).toBe(2);
  });

  test("duplicateOffer is scoped to the shop", async () => {
    // An id in a form field is not proof of ownership.
    const offer = await saveOffer(shopId, draft());
    expect(await duplicateOffer("not-a-shop", offer.id)).toBeNull();
    expect(await countOffers(shopId)).toBe(1);
  });

  test("listOffers is newest-edited first", async () => {
    /*
     * updatedAt is set explicitly rather than raced against the clock: three
     * saves land inside one millisecond, and the original version of this test
     * failed intermittently because `updatedAt` alone is not a total order. That
     * flake was real — listOffers now carries an `id` tiebreaker so paging is
     * stable — but the ordering it is meant to assert needs distinct timestamps.
     */
    const first = await saveOffer(shopId, draft({ name: "First" }));
    const second = await saveOffer(shopId, draft({ name: "Second" }));

    await prisma.offer.update({
      where: { id: second.id },
      data: { updatedAt: new Date("2026-08-01T00:00:00Z") },
    });
    await prisma.offer.update({
      where: { id: first.id },
      data: { name: "First again", updatedAt: new Date("2026-08-02T00:00:00Z") },
    });

    expect((await listOffers(shopId)).map((offer) => offer.name)).toEqual([
      "First again",
      "Second",
    ]);
  });

  test("listOffers breaks a timestamp tie deterministically", async () => {
    // Same instant on purpose: without a tiebreaker the order is undefined and a
    // row can appear on two pages or none.
    const stamp = new Date("2026-08-03T00:00:00Z");
    const a = await saveOffer(shopId, draft({ name: "A" }));
    const b = await saveOffer(shopId, draft({ name: "B" }));
    for (const id of [a.id, b.id]) {
      await prisma.offer.update({ where: { id }, data: { updatedAt: stamp } });
    }

    const runs = await Promise.all([listOffers(shopId), listOffers(shopId), listOffers(shopId)]);
    const orders = runs.map((run) => run.map((offer) => offer.id).join(","));
    expect(new Set(orders).size).toBe(1);
  });
});
