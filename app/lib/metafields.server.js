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

/** The JSON payload Liquid reads. Ids stay strings to match how we store them. */
export function buildMetafieldValue(items, { now = new Date() } = {}) {
  return JSON.stringify({
    v: 1,
    updatedAt: now.toISOString(),
    items: (items ?? []).map((item) => ({
      id: String(item.id),
      handle: item.handle ?? null,
    })),
  });
}

function metafieldInput(override, options) {
  return {
    ownerId: toProductGid(override.productId),
    namespace: METAFIELD_NAMESPACE,
    key: METAFIELD_KEY,
    type: METAFIELD_TYPE,
    value: buildMetafieldValue(override.items, options),
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
