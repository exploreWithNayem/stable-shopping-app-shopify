import prisma from "../db.server";
import { isShopScope } from "../models/offer.server";
import { METAFIELD_NAMESPACE } from "./metafields.server";

/**
 * The shop-scope offer mirror.
 *
 * An offer whose trigger is "all products" or "products in specific collections"
 * cannot be published the way a named-products offer is. That path writes one
 * `$app:reco_overrides` metafield **per product** (§3.1), which on a real catalogue
 * would be thousands of writes — and every one of them would count against the
 * per-product plan allowance (§5), so a Free merchant's first "All products"
 * publish would exhaust their whole allowance and still not cover the catalogue.
 *
 * So these offers go somewhere else: one **shop-owned** metafield holding every
 * shop-scope offer, which the app embed reads on any product page and matches
 * against the product in front of it. The trigger is evaluated on the storefront
 * rather than expanded in the admin, which is what makes "all products" mean all
 * products — including ones added after the offer was published.
 *
 * The whole list is rebuilt on every write rather than patched. It is small (a
 * shop has a handful of offers), the alternative needs read-modify-write against a
 * metafield two publishes can race on, and a rebuild makes unpublish and delete
 * fall out for free — an offer that is no longer published simply is not in the
 * list any more.
 */

export const SHOP_OFFERS_KEY = "reco_offers";
export const SHOP_OFFERS_VERSION = 1;

const SHOP_QUERY = `#graphql
  query RecoShopId {
    shop {
      id
    }
  }`;

const SET_MUTATION = `#graphql
  mutation RecoSetShopOffers($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        id
      }
      userErrors {
        field
        message
      }
    }
  }`;

/**
 * The Shop GID, which `metafieldsSet` needs as an owner.
 *
 * Fetched rather than derived: a shop's GID is not something the session carries,
 * and there is no reliable way to build one from the domain.
 */
async function shopGid(admin) {
  const response = await admin.graphql(SHOP_QUERY);
  const body = await response.json();
  const id = body?.data?.shop?.id;

  if (!id) throw new Error("Could not read the shop id for the offer metafield.");
  return id;
}

/**
 * One published offer, in the shape the storefront needs and no larger.
 *
 * Deliberately not the row: the metafield is public, and a merchant's internal
 * offer name, target counts and timestamps are their business. What ships is what
 * Liquid matches on and what reco.js draws.
 */
export function projectOffer(offer) {
  const automated = offer.offerSource === "automated";

  return {
    id: offer.id,
    type: offer.offerType,
    trigger: {
      mode: offer.triggerMode,
      // Handles, because that is what Liquid can compare `product.collections` to
      // without a lookup per page.
      collections: (offer.triggerCollections ?? []).map((entry) => entry.handle),
    },
    exclude: {
      products: (offer.excludeProducts ?? []).map((entry) => String(entry.id)),
      collections: (offer.excludeCollections ?? []).map((entry) => entry.handle),
    },
    source: {
      mode: offer.offerSource,
      // Only meaningful when automated; sent anyway so reco.js never has to guess.
      intent: offer.offerIntent,
    },
    /*
     * An automated offer carries no items on purpose. Shopify supplies the list on
     * the storefront, and shipping a stale copy of it would be worse than shipping
     * none.
     */
    items: automated
      ? []
      : (offer.items ?? []).map((item) => ({
          id: String(item.id),
          handle: item.handle ?? null,
        })),
    visibility: {
      hideInCart: Boolean(offer.hideInCart),
      hideTrigger: Boolean(offer.hideTriggerProduct),
      quantityPicker: Boolean(offer.showQuantityPicker),
    },
    copy: {
      title: offer.title ?? "",
      badge: offer.badge ?? "",
      buttonText: offer.buttonText ?? "",
      countdown: Boolean(offer.countdown),
      ...(offer.countdown
        ? {
            countdownMode: offer.countdownMode === "date" ? "date" : "fixed",
            countdownMinutes: Number(offer.countdownMinutes) || null,
            countdownEndsAt: offer.countdownEndsAt
              ? new Date(offer.countdownEndsAt).toISOString()
              : null,
            countdownTitle: offer.countdownTitle ?? "",
          }
        : {}),
    },
    ...(offer.anchorSelector
      ? {
          render: {
            selector: offer.anchorSelector,
            position: offer.anchorPosition === "before" ? "before" : "after",
          },
        }
      : {}),
  };
}

export function buildShopOffersValue(offers, { now = new Date() } = {}) {
  return JSON.stringify({
    v: SHOP_OFFERS_VERSION,
    updatedAt: now.toISOString(),
    offers: offers.map(projectOffer),
  });
}

/** Every shop-scope offer that is currently live, oldest first for stable order. */
export function listShopScopeOffers(shopId) {
  return prisma.offer.findMany({
    where: {
      shopId,
      status: "published",
      triggerMode: { in: ["all", "collections"] },
    },
    /*
     * Oldest first, because the embed renders the **first** match: the offer a
     * merchant set up earliest keeps its pages when a later, broader one is added.
     * The alternative — newest wins — would let one "All products" offer silently
     * take over every page a specific collection offer was covering.
     */
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

/**
 * Rewrite the shop metafield from whatever is published now.
 *
 * Throws on failure, like `syncOverrideMetafield`, so the caller can tell the
 * merchant the publish has not reached the storefront.
 */
export async function syncShopOffers({ admin, shopId, now = new Date() }) {
  const offers = await listShopScopeOffers(shopId);
  const ownerId = await shopGid(admin);

  const response = await admin.graphql(SET_MUTATION, {
    variables: {
      metafields: [
        {
          ownerId,
          namespace: METAFIELD_NAMESPACE,
          key: SHOP_OFFERS_KEY,
          type: "json",
          value: buildShopOffersValue(offers, { now }),
        },
      ],
    },
  });

  const body = await response.json();
  const errors = body?.data?.metafieldsSet?.userErrors ?? [];
  if (errors.length > 0) {
    throw new Error(errors.map((error) => error.message).join(", "));
  }

  return { count: offers.length };
}

/** Whether this offer publishes to the shop metafield rather than to products. */
export { isShopScope };
