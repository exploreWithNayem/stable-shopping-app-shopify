import {
  deleteOverride,
  getOverridesForProducts,
  listOverridesForOffer,
  markOverrideSynced,
  upsertOverride,
} from "../models/override.server";
import {
  deleteOverrideMetafield,
  syncOverrideMetafield,
} from "./metafields.server";
import { isShopScope, markDraft, markPublished } from "../models/offer.server";
import { syncShopOffers } from "./shop-offers.server";

/**
 * Publishing an offer, and taking it back down.
 *
 * An offer is admin-side authoring; the storefront only ever reads the
 * `$app:reco_overrides` metafield (§3.1). So publishing means projecting the
 * offer onto the existing pipeline — one Override row per target product, then a
 * metafield sync each — and unpublishing means removing exactly what it wrote.
 * The theme block is untouched by all of this.
 *
 * Split out of models/offer.server.js because these need an authenticated
 * `admin` client, which a data-access module has no business holding.
 */

/**
 * Rewrite the shop offer list, whatever this offer's trigger is.
 *
 * Unconditional on purpose. The rebuild used to live only inside the shop-scope
 * branches, which left one whole class of stale storefront behind: an offer published
 * as **all products** and later switched to **specific products** took the per-product
 * path on republish, nothing rebuilt the shop list, and the offer stayed in it —
 * rendering on *every* product page while the admin showed a two-product offer. The
 * same hole swallowed unpublish and delete.
 *
 * It is one query and one metafield write, and it is idempotent: the list is always
 * rebuilt from what is published, so calling it when nothing shop-scope exists writes
 * an empty list, which is exactly what a store with no catalogue-wide offer needs.
 *
 * Failures are collected rather than thrown — the per-product work has already
 * happened and must not be lost.
 */
async function rebuildShopList({ admin, shopId, failures }) {
  try {
    await syncShopOffers({ admin, shopId });
  } catch (error) {
    failures.push({
      productId: "*",
      title: "Storefront offer list",
      message: error.message,
    });
  }
}

/**
 * Never throws. A metafield write can fail per product — a deleted product, a
 * throttled shop — and one failure must not roll back the rest or leave the
 * merchant with no idea which products are live. Each result is reported and
 * `syncedAt` is left null on the ones that failed, which is what the re-sync
 * repair action on Settings looks for.
 *
 * `previousTargets` makes a re-publish subtractive as well as additive. Editing a
 * live offer republishes it, and without the old list a product the merchant
 * dropped keeps its Override row and its metafield — so its page goes on
 * rendering an offer that no longer claims it, and nothing in the admin says so.
 * Omit it for a first publish; there is nothing to take away.
 */
export async function publishOffer({ admin, shopId, offer, previousTargets = [] }) {
  /*
   * A shop-scope offer ("all products", or a collections trigger) publishes to one
   * shop-owned metafield instead of a row per product — see
   * app/lib/shop-offers.server.js for why. It is marked published *first*, because
   * the metafield is rebuilt from whatever is published: writing it before the row
   * changes would leave the offer out of its own publish.
   */
  if (isShopScope(offer)) {
    /*
     * Anything the offer published per product before the trigger changed has to go.
     * A merchant switching "specific products" to "all products" leaves rows and
     * metafields behind on the products they had named, and those keep rendering the
     * *old* list — the product's own metafield wins over the shop list (§7.8) — while
     * still counting against the per-product plan allowance. Reported like any other
     * per-product failure rather than thrown.
     */
    const owned = await listOverridesForOffer(shopId, offer.id);
    const leftovers = [];

    for (const row of owned) {
      try {
        await deleteOverride({ shopId, productId: row.productId, placement: row.placement });
        await deleteOverrideMetafield(admin, row.productId);
      } catch (error) {
        leftovers.push({
          productId: String(row.productId),
          title: row.productTitle || String(row.productId),
          message: error.message,
        });
      }
    }

    const published = await markPublished(offer.id);

    try {
      await syncShopOffers({ admin, shopId });
    } catch (error) {
      /*
       * Rolled back, unlike the per-product path. There is one write here, not one
       * per product, so a failure means *nothing* is live — and an offer left
       * marked published with an unwritten metafield would claim to be showing on
       * every product page while showing on none.
       */
      await markDraft(offer.id);
      return {
        offer,
        synced: 0,
        total: 1,
        removed: 0,
        failures: [
          ...leftovers,
          { productId: "*", title: "Storefront offer list", message: error.message },
        ],
      };
    }

    return {
      offer: published,
      synced: 1,
      total: 1,
      // Every product page, which is not a number — the caller says so in words.
      everyProduct: true,
      removed: owned.length - leftovers.length,
      failures: leftovers,
    };
  }

  /*
   * Excluded products are dropped here, not just on the shop-scope path. A merchant
   * who names ten pages and then excludes one means nine — and because the dropped
   * ones fall out of `keeping` below, republishing after adding an exclusion also
   * removes the row and metafield the earlier publish left on that product.
   *
   * Excluded *collections* are not applied to this mode: knowing which collections
   * a target belongs to needs a query per product, and a merchant naming pages by
   * hand can simply not name them (§7.8).
   */
  const excluded = new Set((offer.excludeProducts ?? []).map((entry) => String(entry.id)));
  const targets = (offer.targets ?? []).filter((entry) => !excluded.has(String(entry.id)));
  const items = offer.items ?? [];
  const failures = [];
  let synced = 0;

  const keeping = new Set(targets.map((target) => String(target.id)));

  /*
   * What this offer owns *now*, not what the caller remembered. `previousTargets` is
   * still honoured — a caller that knows the old list is welcome to say so — but the
   * rows themselves are the authority: a row written by an earlier publish and since
   * dropped from the offer is only findable this way.
   */
  const owned = await listOverridesForOffer(shopId, offer.id);
  const dropped = new Map();

  for (const row of owned) {
    if (keeping.has(String(row.productId))) continue;
    dropped.set(String(row.productId), {
      id: row.productId,
      placement: row.placement,
      title: row.productTitle,
    });
  }
  for (const target of previousTargets ?? []) {
    const id = String(target.id);
    if (keeping.has(id) || dropped.has(id)) continue;
    dropped.set(id, { id, placement: "pdp", title: target.title });
  }

  let removed = 0;

  for (const target of dropped.values()) {
    try {
      await deleteOverride({ shopId, productId: target.id, placement: target.placement });
      await deleteOverrideMetafield(admin, target.id);
      removed += 1;
    } catch (error) {
      failures.push({
        productId: String(target.id),
        title: target.title ?? String(target.id),
        message: error.message,
      });
    }
  }

  for (const target of targets) {
    try {
      const override = await upsertOverride({
        shopId,
        productId: target.id,
        productTitle: target.title ?? "",
        productHandle: target.handle ?? "",
        // Product page offers are a PDP surface. Checkout placements would use
        // "checkout" here, which is why this is not hardcoded further down.
        placement: "pdp",
        items,
        enabled: true,
        // So a takedown can find this row later even if the offer's targets change.
        offerId: offer.id,
        // Projected onto the row so the metafield carries the offer's wording,
        // and so the Settings re-sync can rewrite it without the offer.
        presentation: {
          /*
           * The offer type, carried through so the app embed can lay the offer
           * out the way the editor previewed it (§7.6). A theme block ignores it
           * — its layout is a block setting — but the embed has no theme settings
           * to read, so the type is the only thing that can decide.
           */
          type: offer.offerType,
          title: offer.title,
          badge: offer.badge,
          buttonText: offer.buttonText,
          countdown: offer.countdown,
          countdownMode: offer.countdownMode,
          countdownMinutes: offer.countdownMinutes,
          countdownEndsAt: offer.countdownEndsAt,
          countdownTitle: offer.countdownTitle,
          /*
           * Storefront filtering, carried the same way the wording is: this row is
           * what the metafield is written from, so anything reco.js needs has to be
           * on it or the Settings re-sync would drop it.
           */
          hideInCart: offer.hideInCart,
          hideTriggerProduct: offer.hideTriggerProduct,
          showQuantityPicker: offer.showQuantityPicker,
          // Where the app embed injects it, when no theme block is present.
          anchor: { selector: offer.anchorSelector, position: offer.anchorPosition },
        },
      });

      await syncOverrideMetafield(admin, override);
      await markOverrideSynced(override.id);
      synced += 1;
    } catch (error) {
      failures.push({
        productId: String(target.id),
        title: target.title ?? String(target.id),
        message: error.message,
      });
    }
  }

  /*
   * The shop list too, even though this offer is per-product now: if it *was*
   * shop-scope before, it is still in that list, and nothing else would ever take it
   * out.
   */
  await rebuildShopList({ admin, shopId, failures });

  /*
   * Published when at least one product went live. A partial publish is still a
   * live offer, and calling it a draft would tell the merchant nothing is showing
   * when some of it is.
   */
  const published = synced > 0 ? await markPublished(offer.id) : offer;

  return { offer: published, synced, total: targets.length, removed, failures };
}

/**
 * Remove what publishOffer wrote.
 *
 * Deletes the Override row *and* the metafield for each target: leaving the
 * metafield behind would keep the old list rendering on the product page, which
 * is the failure mode §3.1 calls out.
 */
export async function unpublishOffer({ admin, shopId, offer }) {
  const failures = [];
  let removed = 0;

  /*
   * Symmetric with the publish: the row goes to draft first, then the metafield is
   * rebuilt from what is left — so this offer drops out of the list without needing
   * to be found and removed from it.
   */
  if (isShopScope(offer)) {
    const drafted = await markDraft(offer.id);

    try {
      await syncShopOffers({ admin, shopId });
    } catch (error) {
      /*
       * Not rolled back, deliberately. The offer is *meant* to be off; a stale
       * metafield keeps it rendering, which is the §3.1 failure mode — so this is
       * reported for the Settings re-sync rather than quietly restored to
       * published, which would tell the merchant it is live when they just took it
       * down.
       */
      failures.push({
        productId: "*",
        title: "Storefront offer list",
        message: error.message,
      });
    }

    return { offer: drafted, removed: failures.length === 0 ? 1 : 0, failures };
  }

  /*
   * Every row this offer owns, plus whatever it currently targets.
   *
   * Targets alone were not enough: a merchant who edited a published offer's product
   * list, or switched its trigger, left rows and metafields behind that nothing could
   * find afterwards — and those pages went on rendering the offer with no way in the
   * admin to stop them. That is the "I deleted the offer and it is still showing" bug.
   */
  const owned = await listOverridesForOffer(shopId, offer.id);
  const takedown = new Map();

  for (const row of owned) {
    takedown.set(String(row.productId), {
      id: row.productId,
      placement: row.placement,
      title: row.productTitle,
    });
  }

  /*
   * The offer's current targets as well, but only where the row is this offer's, is
   * unowned, or is gone entirely:
   *
   *   - unowned covers every row written before `offerId` existed, and rows a publish
   *     wrote when the column was still null. Those look exactly like a legacy row
   *     from this offer, and leaving them is the bug being fixed.
   *   - gone entirely still deletes the *metafield*, which is the repair for an
   *     orphan: a metafield with no row is invisible to the Settings re-sync and
   *     would render forever.
   *   - a row owned by a **different** offer is left alone, row and metafield. That
   *     offer is live there, and taking this one down must not take its list with it.
   */
  const rows = await getOverridesForProducts(
    shopId,
    (offer.targets ?? []).map((target) => String(target.id)),
  );

  for (const target of offer.targets ?? []) {
    const id = String(target.id);
    if (takedown.has(id)) continue;

    const row = rows.get(id);
    if (row && row.offerId && row.offerId !== offer.id) continue;

    takedown.set(id, { id, placement: row?.placement ?? "pdp", title: target.title });
  }

  for (const target of takedown.values()) {
    try {
      await deleteOverride({ shopId, productId: target.id, placement: target.placement });
      await deleteOverrideMetafield(admin, target.id);
      removed += 1;
    } catch (error) {
      failures.push({
        productId: String(target.id),
        title: target.title ?? String(target.id),
        message: error.message,
      });
    }
  }

  /*
   * Same reason as the publish path: a trigger switch leaves the offer in the shop
   * list, and taking it down has to take it out of there as well.
   */
  const drafted = await markDraft(offer.id);
  await rebuildShopList({ admin, shopId, failures });

  return { offer: drafted, removed, failures };
}

/**
 * Products a publish would newly occupy against the plan's product allowance.
 *
 * Only targets nobody has published yet count: re-publishing an offer, or adding
 * a product a second offer already covers, takes no new slot — the same rule the
 * override editor uses (§5).
 */
export function newlyOccupiedTargets(offer, alreadyPublishedIds) {
  const seen = new Set();
  // Excluded products are never published, so they cost no slot — counting them
  // would refuse a publish over pages the offer will not appear on.
  const excluded = new Set((offer.excludeProducts ?? []).map((entry) => String(entry.id)));

  return (offer.targets ?? []).filter((target) => {
    const id = String(target.id);
    if (excluded.has(id) || alreadyPublishedIds.has(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}
