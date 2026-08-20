import { afterAll, beforeEach, describe, expect, test } from "vitest";
import prisma from "../db.server";
import {
  MAX_ITEMS,
  MAX_TARGETS,
  countOffers,
  deleteOffer,
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
