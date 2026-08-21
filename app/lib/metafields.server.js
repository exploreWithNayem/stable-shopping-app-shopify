import {
  listUnsyncedOverrides,
  listOverrides,
  markOverrideSynced,
} from "../models/override.server";

/**
 * Mirrors overrides into the product's app-reserved metafield.
 *
 * Prisma is the source of truth; this metafield is what the theme actually
 * reads, so the storefront shows nothing custom until a sync lands. Every
 * override write must be followed by a sync, then markOverrideSynced() —
 * `syncedAt: null` is the drift signal the repair action looks for.
 */

export const METAFIELD_NAMESPACE = "$app";
export const METAFIELD_KEY = "reco_overrides";
export const METAFIELD_TYPE = "json";

/** metafieldsSet accepts at most 25 metafields per call. */
export const METAFIELDS_SET_BATCH = 25;

const SET_MUTATION = `#graphql
  mutation SetRecoOverrides($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        id
        key
        namespace
      }
      userErrors {
        field
        message
        code
      }
    }
  }`;

const DELETE_MUTATION = `#graphql
  mutation DeleteRecoOverrides($metafields: [MetafieldIdentifierInput!]!) {
    metafieldsDelete(metafields: $metafields) {
      deletedMetafields {
        key
        namespace
        ownerId
      }
      userErrors {
        field
        message
      }
    }
  }`;

function toProductGid(id) {
  const value = String(id ?? "");
  return value.startsWith("gid://") ? value : `gid://shopify/Product/${value}`;
}

/**
 * Whether this override should be visible on the storefront product page.
 *
 * The metafield is read by the PDP block only, so a checkout-only override must
 * *not* be published — its products are served through the app proxy instead.
 * A disabled override is likewise removed so the PDP falls back to Shopify.
 */
export function shouldPublishToStorefront(override) {
  if (!override?.enabled) return false;
  if (!Array.isArray(override.items) || override.items.length === 0) return false;
  return override.placement === "pdp" || override.placement === "both";
}

/**
 * The JSON payload Liquid reads.
 *
 * `v: 2` adds `copy` — the wording an offer supplies. It is omitted entirely
 * when there is none, so a row created straight from the recommendations page
 * produces the same shape as before and the theme block's own settings still
 * win. Liquid treats a missing `copy` as nil, so **v1 metafields written before
 * this keep working untouched** — no backfill, no migration of live data.
 *
 * Ids stay strings to match how they are stored, so nothing has to agree on
 * number formatting.
 */
export const METAFIELD_VERSION = 2;

/**
 * The countdown's own settings, with anything that says nothing left out.
 *
 * A null duration or an empty title is noise on a public metafield: reco.js
 * already has defaults for both, and every key here has to be read by hand on the
 * other side.
 */
function countdownCopy(presentation) {
  const minutes = Number(presentation.countdownMinutes);
  const endsAt = presentation.countdownEndsAt
    ? new Date(presentation.countdownEndsAt)
    : null;
  const title = String(presentation.countdownTitle ?? "").trim();

  return {
    countdownMode: presentation.countdownMode === "date" ? "date" : "fixed",
    ...(Number.isFinite(minutes) && minutes > 0 ? { countdownMinutes: minutes } : {}),
    // ISO, because Date.parse handles it everywhere — unlike the shop-local
    // formats Liquid would otherwise hand the browser.
    ...(endsAt && !Number.isNaN(endsAt.getTime())
      ? { countdownEndsAt: endsAt.toISOString() }
      : {}),
    ...(title ? { countdownTitle: title } : {}),
  };
}

export function buildMetafieldValue(
  items,
  { now = new Date(), presentation = null, offerId = null } = {},
) {
  const copy = presentation
    ? {
        title: presentation.title ?? "",
        badge: presentation.badge ?? "",
        buttonText: presentation.buttonText ?? "",
        countdown: Boolean(presentation.countdown),
        /*
         * The countdown's own settings, and only when it is on: reco.js reads
         * `countdown` first, so shipping a duration for a switched-off timer is
         * payload that can only mislead. `countdownEndsAt` is an ISO string —
         * Date.parse handles it in every browser, unlike the shop-local formats
         * Liquid would produce.
         */
        ...(presentation.countdown ? countdownCopy(presentation) : {}),
        /*
         * Storefront filtering, in the metafield because reco.js is what applies
         * it — on both paths. `hideTrigger` defaults to true: a product has never
         * been offered as its own recommendation, and a v1 metafield with no
         * visibility must keep behaving that way.
         */
        visibility: {
          hideInCart: Boolean(presentation.hideInCart),
          hideTrigger: presentation.hideTriggerProduct !== false,
          quantityPicker: Boolean(presentation.showQuantityPicker),
        },
      }
    : null;

  /*
   * The offer type, which decides how the app embed lays the offer out — a
   * carousel of rows for the card-style types, a grid for the bundle ones (§7.6).
   * Another optional v2 key, like `render`: omitted for a list curated on the
   * recommendations page, which has no type and takes the block's own layout.
   */
  const type = String(presentation?.type ?? "").trim() || null;

  /*
   * Where the app embed injects the offer when no theme block is on the page.
   * Omitted unless the merchant set a selector — reco.js has a fallback chain
   * that covers Dawn-family themes, and an empty selector here would read as
   * "match nothing" rather than "use the default".
   */
  const anchor = presentation?.anchor?.selector
    ? {
        selector: presentation.anchor.selector,
        position: presentation.anchor.position === "before" ? "before" : "after",
      }
    : null;

  return JSON.stringify({
    v: METAFIELD_VERSION,
    updatedAt: now.toISOString(),
    /*
     * Which offer wrote this, when one did. The storefront sends it back to
     * `/apps/easy-reco/offer` to ask whether that offer is still live — a mirror
     * cannot answer that about itself. Absent for a list curated on the
     * recommendations page: there is no offer behind it, so there is nothing to
     * confirm and the list renders on its own authority.
     */
    ...(offerId ? { offerId } : {}),
    ...(type ? { type } : {}),
    ...(copy ? { copy } : {}),
    ...(anchor ? { render: anchor } : {}),
    items: (items ?? []).map((item) => ({
      id: String(item.id),
      handle: item.handle ?? null,
    })),
  });
}

function metafieldInput(override, options = {}) {
  return {
    ownerId: toProductGid(override.productId),
    namespace: METAFIELD_NAMESPACE,
    key: METAFIELD_KEY,
    type: METAFIELD_TYPE,
    value: buildMetafieldValue(override.items, {
      ...options,
      // From the row, like the copy: the Settings re-sync has no offer in hand.
      offerId: override.offerId ?? null,
      // Taken from the row, not the caller: the re-sync repair action has no
      // offer in hand, and reading it here is what keeps a repair lossless.
      presentation: override.presentation ?? null,
    }),
  };
}

function identifierInput(productId) {
  return {
    ownerId: toProductGid(productId),
    namespace: METAFIELD_NAMESPACE,
    key: METAFIELD_KEY,
  };
}

function assertNoUserErrors(payload, label) {
  const errors = payload?.userErrors ?? [];
  if (errors.length > 0) {
    throw new Error(
      `${label} failed: ${errors.map((e) => e.message).join(", ")}`,
    );
  }
}

/** Write the metafields for a batch of overrides (max 25). */
async function setBatch(admin, overrides, options) {
  const response = await admin.graphql(SET_MUTATION, {
    variables: { metafields: overrides.map((o) => metafieldInput(o, options)) },
  });
  const body = await response.json();
  assertNoUserErrors(body?.data?.metafieldsSet, "metafieldsSet");
  return body?.data?.metafieldsSet?.metafields ?? [];
}

/** Remove the metafields for a batch of products (max 25). */
async function deleteBatch(admin, productIds) {
  const response = await admin.graphql(DELETE_MUTATION, {
    variables: { metafields: productIds.map(identifierInput) },
  });
  const body = await response.json();
  assertNoUserErrors(body?.data?.metafieldsDelete, "metafieldsDelete");
  return body?.data?.metafieldsDelete?.deletedMetafields ?? [];
}

const READ_QUERY = `#graphql
  query RecoReadOverrideMetafield($id: ID!, $namespace: String!, $key: String!) {
    product(id: $id) {
      id
      title
      metafield(namespace: $namespace, key: $key) {
        id
        updatedAt
        value
      }
    }
  }`;

/**
 * What one product's metafield actually holds, straight from Shopify.
 *
 * The database is not the answer to "why is this product page showing an offer": a
 * row and its metafield can disagree, and when they do it is the metafield that
 * renders. A row deleted without its metafield — a takedown that missed it, a failed
 * delete — leaves an orphan that nothing in the admin can explain and no query can
 * find, because Shopify cannot search products by an unfilterable app metafield.
 */
export async function readOverrideMetafield(admin, productId) {
  const response = await admin.graphql(READ_QUERY, {
    variables: {
      id: toProductGid(productId),
      namespace: METAFIELD_NAMESPACE,
      key: METAFIELD_KEY,
    },
  });

  const body = await response.json();
  const product = body?.data?.product ?? null;
  const metafield = product?.metafield ?? null;

  return {
    found: Boolean(product),
    title: product?.title ?? null,
    present: Boolean(metafield),
    updatedAt: metafield?.updatedAt ?? null,
    raw: metafield?.value ?? null,
  };
}

export function deleteOverrideMetafield(admin, productId) {
  return deleteBatch(admin, [productId]);
}

/**
 * Bring one override's metafield in line with the stored row — writing it when
 * it should be live on the PDP, removing it otherwise. Throws on failure so the
 * caller can tell the merchant the save has not reached the storefront yet.
 */
export async function syncOverrideMetafield(admin, override, options = {}) {
  if (shouldPublishToStorefront(override)) {
    await setBatch(admin, [override], options);
    return { published: true };
  }

  await deleteOverrideMetafield(admin, override.productId);
  return { published: false };
}

/**
 * Repair drift across a whole shop.
 *
 * Reads rows whose metafield is unknown or stale (`syncedAt: null`), pushes
 * them in batches of 25, and marks each one synced. Returns a per-batch report
 * rather than throwing, so one bad batch does not abandon the rest.
 */
export async function syncAllOverrides({ admin, shopId, onlyUnsynced = true }) {
  const overrides = onlyUnsynced
    ? await listUnsyncedOverrides(shopId)
    : await listOverrides({ shopId, take: 1000 });

  const toPublish = overrides.filter(shouldPublishToStorefront);
  const toRemove = overrides.filter((o) => !shouldPublishToStorefront(o));

  let synced = 0;
  const errors = [];

  for (let i = 0; i < toPublish.length; i += METAFIELDS_SET_BATCH) {
    const batch = toPublish.slice(i, i + METAFIELDS_SET_BATCH);
    try {
      await setBatch(admin, batch);
      await Promise.all(batch.map((o) => markOverrideSynced(o.id)));
      synced += batch.length;
    } catch (error) {
      errors.push(error.message);
    }
  }

  for (let i = 0; i < toRemove.length; i += METAFIELDS_SET_BATCH) {
    const batch = toRemove.slice(i, i + METAFIELDS_SET_BATCH);
    try {
      await deleteBatch(
        admin,
        batch.map((o) => o.productId),
      );
      await Promise.all(batch.map((o) => markOverrideSynced(o.id)));
      synced += batch.length;
    } catch (error) {
      errors.push(error.message);
    }
  }

  return { total: overrides.length, synced, errors };
}
