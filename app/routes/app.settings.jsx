import { useCallback, useState } from 'react';
import { useFetcher, useLoaderData } from 'react-router';
import { useAppBridge } from '@shopify/app-bridge-react';
import { authenticate } from '../shopify.server';
import { ensureShop } from '../models/shop.server';
import { countOverrides, listUnsyncedOverrides } from '../models/override.server';
import {
  deleteOverrideMetafield,
  readOverrideMetafield,
  syncAllOverrides,
} from '../lib/metafields.server';
import { deleteShopOffers, readShopOffers, syncShopOffers } from '../lib/shop-offers.server';
import {
  ensureMetafieldDefinitions,
  readDefinitionStatus,
} from '../lib/metafield-definitions.server';
import { formatNumber } from '../lib/format';
import QuotaBanner from '../components/QuotaBanner';

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  const [total, unsynced] = await Promise.all([
    countOverrides(shop.id),
    listUnsyncedOverrides(shop.id),
  ]);

  /*
   * What the storefront actually reads, asked of Shopify rather than derived from the
   * database. The two can disagree — a delete whose metafield write failed leaves an
   * offer live with nothing left in the admin to explain it — and when they disagree
   * it is always the metafield that is rendering. Never fatal: a diagnostic that takes
   * the settings page down with it is worse than no diagnostic.
   */
  let storefront = { present: false, offers: [], updatedAt: null, error: null };
  try {
    storefront = { ...(await readShopOffers(admin)), error: null };
  } catch (error) {
    storefront = { present: false, offers: [], updatedAt: null, error: error.message };
  }

  /*
   * Whether the storefront can *see* the metafields at all.
   *
   * The Admin API reads a metafield with no definition; **Liquid does not**. So the app
   * can report an offer as live while the storefront shows nothing — which is the exact
   * shape of "specific products works, all products does not": the product definition
   * was created by hand months ago, the shop one never was. Read every load, because a
   * merchant looks at this page precisely when the storefront is misbehaving.
   */
  let definitions = [];
  let definitionError = null;
  try {
    definitions = await readDefinitionStatus(admin);
  } catch (error) {
    definitionError = error.message;
  }

  return {
    overrideCount: total,
    unsyncedCount: unsynced.length,
    storefront,
    definitions,
    definitionError,
  };
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  const formData = await request.formData();
  const intent = String(formData.get('intent') ?? '');

  /*
   * Create whatever definition is missing, and **report** what happened. The
   * automatic run in the /app loader logs failures to the console, where a merchant
   * will never see them; this is the one that says so on screen.
   */
  if (intent === 'create-definitions') {
    try {
      const result = await ensureMetafieldDefinitions(admin, shop, { force: true });
      return {
        ok: result.errors.length === 0,
        definitionsCreated: result.created,
        definitionErrors: result.errors,
      };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  /*
   * Read one product's metafield. The diagnostic that ends "I deleted the offer and it
   * is still showing": if the value is there, that is what the shopper sees, whatever
   * the admin says.
   */
  if (intent === 'inspect') {
    const productId = String(formData.get('productId') ?? '').trim();
    if (!productId) return { ok: false, error: 'Choose a product to inspect.' };

    try {
      return {
        ok: true,
        inspected: { productId, ...(await readOverrideMetafield(admin, productId)) },
      };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  /* Delete it. Works whether or not a row ever existed — an orphan has none. */
  if (intent === 'clear-product') {
    const productId = String(formData.get('productId') ?? '').trim();
    if (!productId) return { ok: false, error: 'Choose a product to clear.' };

    try {
      await deleteOverrideMetafield(admin, productId);
      return { ok: true, cleared: 'product', productId };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  /*
   * Remove the shop offer list outright, rather than rewriting it from what is
   * published. For when it holds an offer that no longer exists anywhere in the admin
   * and there is nothing left to rebuild *from*.
   */
  if (intent === 'clear-shop-offers') {
    try {
      await deleteShopOffers(admin);
      return { ok: true, cleared: 'shop' };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  if (intent !== 'resync') {
    return { ok: false, error: 'Unknown action.' };
  }

  // Repairs everything, not just the drifted rows: this is the button someone
  // presses when the storefront looks wrong, and a row can be marked synced
  // while the metafield was removed on Shopify's side.
  const result = await syncAllOverrides({
    admin,
    shopId: shop.id,
    onlyUnsynced: false,
  });

  /*
   * The shop-scope offer list too — "all products" and collection triggers write
   * one shop metafield instead of a row per product (§7.8), so nothing in the
   * Override table represents them and the loop above cannot see them. Without
   * this, the only repair path for a failed shop-offer write would be to unpublish
   * and publish every offer by hand.
   *
   * Reported rather than thrown: a failure here must not lose the result of the
   * per-product repair that already succeeded.
   */
  let offerError = null;
  try {
    await syncShopOffers({ admin, shopId: shop.id });
  } catch (error) {
    offerError = error.message;
  }

  return {
    ok: result.errors.length === 0 && !offerError,
    ...result,
    errors: offerError ? [...result.errors, offerError] : result.errors,
  };
};

/**
 * Phase 13 adds widget defaults, the checkout toggle and tracking options. The
 * re-sync repair action landed early, in Phase 6, because a failed metafield
 * write leaves the storefront stale with no other way to fix it.
 */
export default function SettingsPage() {
  const { overrideCount, unsyncedCount, storefront, definitions, definitionError } =
    useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const result = fetcher.data;
  const isSyncing = fetcher.state !== 'idle';

  // The product currently being inspected, so the Clear button knows what to clear.
  const [picked, setPicked] = useState(null);
  const [pickError, setPickError] = useState(null);

  const pick = useCallback(async () => {
    setPickError(null);
    try {
      const selection = await shopify.resourcePicker({ type: 'product' });
      if (!selection || selection.length === 0) return;

      const product = {
        id: String(selection[0].id).split('/').pop(),
        title: selection[0].title ?? '',
      };
      setPicked(product);
      fetcher.submit({ intent: 'inspect', productId: product.id }, { method: 'POST' });
    } catch (failure) {
      setPickError(failure?.message || String(failure));
    }
  }, [shopify, fetcher]);

  return (
    <s-page heading="Settings">
      <QuotaBanner />

      {result?.errors?.length > 0 && (
        <s-banner tone="critical" heading="Some recommendations did not sync">
          <s-paragraph>{result.errors.join(' ')}</s-paragraph>
        </s-banner>
      )}
      {result?.ok && (
        <s-banner tone="success" heading="Recommendations re-synced" dismissible>
          <s-paragraph>
            {formatNumber(result.synced)} of {formatNumber(result.total)} pushed to your storefront.
          </s-paragraph>
        </s-banner>
      )}

      <s-section heading="Storefront sync">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Your custom recommendations are stored here and copied to each product so your theme can
            show them. If the storefront looks out of date, re-sync to push them again.
          </s-paragraph>

          <s-stack direction="inline" gap="small" alignItems="center">
            <s-text>Custom recommendations:</s-text>
            <s-badge tone="neutral">{formatNumber(overrideCount)}</s-badge>
            {unsyncedCount > 0 && (
              <s-badge tone="warning">{formatNumber(unsyncedCount)} not yet live</s-badge>
            )}
          </s-stack>

          <s-button
            variant={unsyncedCount > 0 ? 'primary' : 'secondary'}
            onClick={() => fetcher.submit({ intent: 'resync' }, { method: 'POST' })}
            {...(isSyncing ? { loading: true } : {})}
            {...(overrideCount === 0 ? { disabled: true } : {})}
          >
            Re-sync recommendations
          </s-button>
        </s-stack>
      </s-section>

      {/*
        Whether the storefront can read the app's data at all.

        First, because everything below it is meaningless when the answer is no: a
        definition is what makes a metafield visible to Liquid, and without one the app
        writes values nobody can read.
      */}
      <s-section heading="Storefront access">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Your theme can only read the app&rsquo;s data when these exist on your store. Without
            them the app saves normally and the storefront shows nothing.
          </s-paragraph>

          {definitionError && <s-text tone="critical">{definitionError}</s-text>}

          {definitions.map((definition) => (
            <s-stack
              key={`${definition.ownerType}-${definition.key}`}
              direction="inline"
              gap="small"
              alignItems="center"
            >
              <s-badge tone={definition.present ? 'success' : 'critical'}>
                {definition.present ? 'Ready' : 'Missing'}
              </s-badge>
              <s-text>
                {definition.ownerType === 'SHOP'
                  ? 'Catalogue-wide offers (all products, collections)'
                  : 'Per-product recommendations'}
              </s-text>
            </s-stack>
          ))}

          {definitions.some((definition) => !definition.present) && (
            <s-button
              variant="primary"
              onClick={() => fetcher.submit({ intent: 'create-definitions' }, { method: 'POST' })}
              {...(isSyncing ? { loading: true } : {})}
            >
              Set up storefront access
            </s-button>
          )}

          {result?.definitionsCreated?.length > 0 && (
            <s-text tone="success">
              {`Created ${result.definitionsCreated.join(', ')}. Reload a product page to confirm.`}
            </s-text>
          )}
          {result?.definitionErrors?.length > 0 && (
            <s-text tone="critical">{result.definitionErrors.join(' ')}</s-text>
          )}
        </s-stack>
      </s-section>

      {/*
        The diagnostic.

        Everything else on this page reasons from the database; this asks Shopify what
        the storefront is actually reading. The two can disagree — a delete whose
        metafield write failed leaves an offer live with nothing in the admin to explain
        it — and when they do, it is always the metafield that renders. Shopify offers no
        way to *find* products carrying an app metafield (searching by metafield needs a
        filterable definition, which a `json` type cannot be), so the merchant points at
        a product and the app reads it.
      */}
      <s-section heading="What the storefront is showing">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            If a product page shows recommendations you have already deleted, the data is still on
            Shopify. This reads it directly and clears it.
          </s-paragraph>

          <s-stack direction="block" gap="small-300">
            <s-text type="strong">Catalogue-wide offers</s-text>
            {storefront.error ? (
              <s-text tone="critical">{storefront.error}</s-text>
            ) : storefront.present ? (
              <>
                <s-text>
                  {`${formatNumber(storefront.offers.length)} offer${
                    storefront.offers.length === 1 ? '' : 's'
                  } live on every product page.`}
                </s-text>
                {storefront.offers.length > 0 && (
                  <s-text color="subdued">
                    {storefront.offers.map((offer) => offer.copy?.title || offer.id).join(', ')}
                  </s-text>
                )}
                <s-button
                  variant="secondary"
                  tone="critical"
                  onClick={() =>
                    fetcher.submit({ intent: 'clear-shop-offers' }, { method: 'POST' })
                  }
                  {...(isSyncing ? { loading: true } : {})}
                >
                  Clear the catalogue-wide offer list
                </s-button>
              </>
            ) : (
              <s-text color="subdued">Nothing — no catalogue-wide offer is live.</s-text>
            )}
          </s-stack>

          <s-divider />

          <s-stack direction="block" gap="small-300">
            <s-text type="strong">One product</s-text>
            <s-button variant="secondary" onClick={pick}>
              {picked ? 'Choose another product' : 'Choose a product'}
            </s-button>
            {pickError && <s-text tone="critical">{pickError}</s-text>}

            {result?.inspected && (
              <s-stack direction="block" gap="small-300">
                <s-text>
                  {result.inspected.present
                    ? `${result.inspected.title || picked?.title || 'This product'} is showing app data, saved ${result.inspected.updatedAt ?? 'at an unknown time'}.`
                    : `${result.inspected.title || picked?.title || 'This product'} has no app data — its page falls back to Shopify's own recommendations.`}
                </s-text>
                {result.inspected.present && (
                  <>
                    {/* The raw value, because a truncated summary is exactly what
                        hides the mismatch this section exists to show. */}
                    <s-text color="subdued">{result.inspected.raw}</s-text>
                    <s-button
                      variant="secondary"
                      tone="critical"
                      onClick={() =>
                        fetcher.submit(
                          { intent: 'clear-product', productId: result.inspected.productId },
                          { method: 'POST' },
                        )
                      }
                      {...(isSyncing ? { loading: true } : {})}
                    >
                      Clear this product&rsquo;s data
                    </s-button>
                  </>
                )}
              </s-stack>
            )}

            {result?.cleared && (
              <s-text tone="success">
                {result.cleared === 'shop'
                  ? 'Cleared. Reload the product page to confirm.'
                  : 'Cleared for that product. Reload its page to confirm.'}
              </s-text>
            )}
            {result?.error && <s-text tone="critical">{result.error}</s-text>}
          </s-stack>
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="Coming next">
        <s-paragraph color="subdued">
          Global widget defaults, checkout recommendations and tracking preferences will live here.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}
