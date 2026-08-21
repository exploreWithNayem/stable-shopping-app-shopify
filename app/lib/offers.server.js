import {
  deleteOverride,
  markOverrideSynced,
  upsertOverride,
} from "../models/override.server";
import {
  deleteOverrideMetafield,
  syncOverrideMetafield,
} from "./metafields.server";
import { markDraft, markPublished } from "../models/offer.server";

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
  const targets = offer.targets ?? [];
  const items = offer.items ?? [];
  const failures = [];
  let synced = 0;

  const keeping = new Set(targets.map((target) => String(target.id)));
  const dropped = (previousTargets ?? []).filter(
    (target) => !keeping.has(String(target.id)),
  );
  let removed = 0;

  for (const target of dropped) {
    try {
      await deleteOverride({ shopId, productId: target.id, placement: "pdp" });
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

  for (const target of offer.targets ?? []) {
    try {
      await deleteOverride({ shopId, productId: target.id, placement: "pdp" });
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

  return { offer: await markDraft(offer.id), removed, failures };
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

  return (offer.targets ?? []).filter((target) => {
    const id = String(target.id);
    if (alreadyPublishedIds.has(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}
