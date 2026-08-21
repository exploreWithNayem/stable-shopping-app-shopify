import { useCallback, useEffect, useRef, useState } from 'react';
import { useFetcher, useLoaderData } from 'react-router';
import { useAppBridge } from '@shopify/app-bridge-react';
import { authenticate } from '../shopify.server';
import { ensureShop } from '../models/shop.server';
import {
  MAX_OVERRIDE_ITEMS,
  countOverriddenProducts,
  deleteOverride,
  getActiveOverride,
  hasOverrideForProduct,
  markOverrideSynced,
  upsertOverride,
} from '../models/override.server';
import { deleteOverrideMetafield, syncOverrideMetafield } from '../lib/metafields.server';
import { getProduct, listProducts } from '../lib/products.server';
import { getShopifyRecommendations } from '../lib/recommendations.server';
import { ensureStorefrontToken } from '../lib/storefront.server';
import { canAddOverride, overrideLimit } from '../lib/entitlements';
import { isUnlimited } from '../lib/plans';
import { formatMoney } from '../lib/format';
import QuotaBanner from '../components/QuotaBanner';
import ProductThumb from '../components/ProductThumb';

/** Id the App Bridge save bar is addressed by. */
const SAVE_BAR_ID = 'override-save-bar';

export const loader = async ({ request, params }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const productId = params.productId;

  const product = await getProduct(admin, productId);
  if (!product) {
    throw new Response('Product not found', { status: 404 });
  }

  const override = await getActiveOverride({
    shopId: shop.id,
    productId,
    placement: 'pdp',
  });

  // A product that is already overridden is always editable — the allowance only
  // gates adding a new one.
  const [overrideCount, alreadyOverridden] = await Promise.all([
    countOverriddenProducts(shop.id),
    hasOverrideForProduct(shop.id, productId),
  ]);
  const limit = overrideLimit(shop.plan);

  // Shown as a starting point so the merchant can see what they are replacing.
  // Provisioning happens here because this is an admin context — the storefront
  // proxy can only read an already-stored token.
  let shopifyDefaults = [];
  let defaultsError = null;
  try {
    await ensureStorefrontToken(admin, shop);
    const refreshed = await ensureShop(session.shop);
    shopifyDefaults = await getShopifyRecommendations({
      shop: refreshed,
      productId,
      limit: MAX_OVERRIDE_ITEMS,
    });
  } catch (error) {
    defaultsError = error.message;
  }

  return {
    product,
    override: override
      ? {
          items: override.items ?? [],
          placement: override.placement,
          enabled: override.enabled,
          syncedAt: override.syncedAt?.toISOString() ?? null,
        }
      : null,
    shopifyDefaults,
    defaultsError,
    currencyCode: shop.currencyCode ?? 'USD',
    canOverride: alreadyOverridden || canAddOverride(shop.plan, overrideCount),
    alreadyOverridden,
    overrideCount,
    // Unlimited serialises as null — loaders are JSON-encoded (CLAUDE.md §10).
    overrideLimit: isUnlimited(limit) ? null : limit,
    maxItems: MAX_OVERRIDE_ITEMS,
  };
};

export const action = async ({ request, params }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const productId = params.productId;

  const formData = await request.formData();
  const intent = formData.get('intent');

  // Catalogue search for the in-page product list. Kept server-side so choosing
  // products never depends on the App Bridge picker opening.
  if (intent === 'search') {
    const query = String(formData.get('query') ?? '').trim();
    const { products } = await listProducts(admin, {
      search: query,
      pageSize: 10,
    });

    return {
      ok: true,
      search: true,
      // The source product is never a valid recommendation for itself.
      results: products.filter((candidate) => candidate.id !== String(productId)),
    };
  }

  // Removing an override is never gated — a merchant over the limit has to be
  // able to free a slot up.
  if (intent === 'reset') {
    await deleteOverride({ shopId: shop.id, productId, placement: 'pdp' });
    await deleteOverride({ shopId: shop.id, productId, placement: 'checkout' });
    await deleteOverride({ shopId: shop.id, productId, placement: 'both' });

    try {
      await deleteOverrideMetafield(admin, productId);
    } catch (error) {
      // The row is gone either way; a stale metafield would keep showing the
      // old list on the storefront, so say so rather than claiming success.
      return { ok: true, reset: true, syncWarning: error.message };
    }

    return { ok: true, reset: true };
  }

  // Enforced here as well as in the UI — a disabled button is not a control.
  // Editing an existing override occupies no new slot, so only new ones count.
  if (!(await hasOverrideForProduct(shop.id, productId))) {
    const overrideCount = await countOverriddenProducts(shop.id);
    if (!canAddOverride(shop.plan, overrideCount)) {
      return {
        ok: false,
        limitReached: true,
        error: `Your plan covers custom recommendations on ${overrideLimit(shop.plan)} products, and all of them are in use. Remove one, or upgrade for unlimited.`,
      };
    }
  }

  const product = await getProduct(admin, productId);
  if (!product) {
    return { ok: false, error: 'Product not found.' };
  }

  let items = [];
  try {
    items = JSON.parse(formData.get('items') ?? '[]');
  } catch {
    return { ok: false, error: 'Could not read the selected products.' };
  }

  if (items.length === 0) {
    return { ok: false, error: 'Add at least one product, or reset to defaults.' };
  }

  const placement = formData.get('placement') ?? 'pdp';
  const enabled = formData.get('enabled') === 'true';

  // Placement is part of the row's identity, so a change means the old row has
  // to go rather than leaving a duplicate behind.
  for (const existing of ['pdp', 'checkout', 'both']) {
    if (existing !== placement) {
      await deleteOverride({ shopId: shop.id, productId, placement: existing });
    }
  }

  const saved = await upsertOverride({
    shopId: shop.id,
    productId,
    productTitle: product.title,
    productHandle: product.handle,
    placement,
    items,
    enabled,
  });

  // The row is saved regardless; only a successful sync makes it live on the
  // storefront, so a failure is reported rather than swallowed. syncedAt stays
  // null, which is what the repair action on Settings looks for.
  try {
    const { published } = await syncOverrideMetafield(admin, saved);
    await markOverrideSynced(saved.id);
    return { ok: true, saved: true, published };
  } catch (error) {
    return { ok: true, saved: true, syncWarning: error.message };
  }
};

export default function OverrideEditor() {
  const {
    product,
    override,
    shopifyDefaults,
    defaultsError,
    currencyCode,
    canOverride,
    alreadyOverridden,
    overrideCount,
    overrideLimit: limit,
    maxItems,
  } = useLoaderData();
  const shopify = useAppBridge();
  const fetcher = useFetcher();
  const searchFetcher = useFetcher();

  const [items, setItems] = useState(() => override?.items ?? []);
  const [placement, setPlacement] = useState(override?.placement ?? 'pdp');
  const [enabled, setEnabled] = useState(override?.enabled ?? true);
  const [query, setQuery] = useState('');
  const searchDebounceRef = useRef(null);
  const [pickerError, setPickerError] = useState(null);

  const isSaving = fetcher.state !== 'idle';
  const result = fetcher.data;

  /**
   * Unsaved changes drive the admin's contextual save bar (App Bridge), not an
   * inline button. Dirtiness is derived from the loader's copy of the override
   * rather than held in state: a successful save revalidates, the two sides
   * match again, and the bar dismisses itself. Nothing to keep in sync.
   */
  const savedItemIds = (override?.items ?? []).map((item) => String(item.id)).join(',');
  const currentItemIds = items.map((item) => String(item.id)).join(',');
  const isDirty =
    currentItemIds !== savedItemIds ||
    placement !== (override?.placement ?? 'pdp') ||
    enabled !== (override?.enabled ?? true);

  const canSave = canOverride && items.length > 0;

  /**
   * One badge answers the question the page exists to answer: is this product
   * showing my list or Shopify's? `syncedAt` is what separates "saved" from
   * "actually rendering", so an unsynced override reads as a warning rather
   * than a success.
   */
  const status = !override
    ? { label: 'Shopify defaults', tone: 'neutral' }
    : !override.enabled
      ? { label: 'Disabled', tone: 'neutral' }
      : override.syncedAt
        ? { label: 'Live on storefront', tone: 'success' }
        : { label: 'Not synced yet', tone: 'warning' };

  useEffect(() => {
    if (!shopify?.saveBar) return;
    if (isDirty) shopify.saveBar.show(SAVE_BAR_ID);
    else shopify.saveBar.hide(SAVE_BAR_ID);
  }, [isDirty, shopify]);

  const discard = () => {
    setItems(override?.items ?? []);
    setPlacement(override?.placement ?? 'pdp');
    setEnabled(override?.enabled ?? true);
  };
  const isSearching = searchFetcher.state !== 'idle';
  const searchResults = searchFetcher.data?.results ?? [];

  const openPicker = useCallback(async () => {
    setPickerError(null);

    // The picker is hosted by the admin, so it only works in the embedded app.
    // Without this check a missing API is an unhandled rejection in the console
    // and a button that appears to do nothing.
    if (typeof shopify?.resourcePicker !== 'function') {
      setPickerError(
        'The product picker is not available on this page. Search for products below instead.',
      );
      return;
    }

    try {
      const selection = await shopify.resourcePicker({
        type: 'product',
        multiple: maxItems,
        // Omitted rather than passed empty: the picker validates every entry,
        // and there is nothing to preselect on a first run.
        ...(items.length > 0
          ? {
              selectionIds: items.map((item) => ({
                id: `gid://shopify/Product/${item.id}`,
              })),
            }
          : {}),
      });

      if (!selection) return;

      setItems(
        selection.slice(0, maxItems).map((node, index) => ({
          id: String(node.id).split('/').pop(),
          handle: node.handle ?? null,
          title: node.title ?? null,
          position: index,
        })),
      );
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('[easy-reco] resourcePicker failed', error);
      setPickerError(error?.message || String(error));
    }
  }, [shopify, items, maxItems]);

  /**
   * Search as the merchant types. Debounced so a word costs one request rather
   * than one per keystroke, and skipped entirely when the field is empty or the
   * plan has no slot left — there would be nothing to add the results to.
   */
  const runSearch = useCallback(
    (value) => {
      const term = value.trim();
      if (!term || !canOverride) return;
      searchFetcher.submit({ intent: 'search', query: term }, { method: 'POST' });
    },
    [canOverride, searchFetcher],
  );

  const onSearchInput = (event) => {
    // Read now: currentTarget is cleared before the timeout fires.
    const value = event.currentTarget.value ?? '';
    setQuery(value);
    clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => runSearch(value), 300);
  };

  useEffect(() => () => clearTimeout(searchDebounceRef.current), []);

  const isChosen = (id) => items.some((item) => item.id === String(id));

  const addItem = (product) => {
    if (items.length >= maxItems || isChosen(product.id)) return;
    setItems([
      ...items,
      {
        id: String(product.id),
        handle: product.handle ?? null,
        title: product.title ?? null,
        position: items.length,
      },
    ]);
  };

  const move = (index, delta) => {
    const next = [...items];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setItems(next.map((item, position) => ({ ...item, position })));
  };

  const remove = (index) =>
    setItems(items.filter((_, i) => i !== index).map((item, position) => ({ ...item, position })));

  const useShopifyDefaults = () =>
    setItems(
      shopifyDefaults.slice(0, maxItems).map((node, position) => ({
        id: node.id,
        handle: node.handle,
        title: node.title,
        position,
      })),
    );

  const save = () => {
    fetcher.submit(
      {
        intent: 'save',
        items: JSON.stringify(items),
        placement,
        enabled: String(enabled),
      },
      { method: 'POST' },
    );
  };

  const reset = () => {
    setItems([]);
    fetcher.submit({ intent: 'reset' }, { method: 'POST' });
  };

  return (
    <s-page heading={product.title}>
      <ui-save-bar id={SAVE_BAR_ID}>
        <button
          variant="primary"
          onClick={save}
          {...(isSaving ? { loading: '' } : {})}
          {...(canSave ? {} : { disabled: true })}
        >
          Save
        </button>
        <button onClick={discard}>Discard</button>
      </ui-save-bar>

      <QuotaBanner />

      {result?.error && (
        <s-banner tone="critical" heading="Could not save">
          <s-paragraph>{result.error}</s-paragraph>
        </s-banner>
      )}
      {result?.syncWarning && (
        <s-banner tone="warning" heading="Saved, but not live yet">
          <s-paragraph>
            Your changes are stored but could not be published to the storefront:{' '}
            {result.syncWarning} Use “Re-sync recommendations” on the Settings page to try again.
          </s-paragraph>
          <s-button href="/app/settings" variant="primary">
            Go to Settings
          </s-button>
        </s-banner>
      )}
      {result?.saved && !result?.syncWarning && (
        <s-banner tone="success" heading="Recommendations saved" dismissible>
          <s-paragraph>
            {result.published
              ? 'This product now shows your custom recommendations.'
              : "Saved. These are set to show in checkout only, so the product page keeps Shopify's recommendations."}
          </s-paragraph>
        </s-banner>
      )}
      {result?.reset && (
        <s-banner tone="success" heading="Reset to Shopify defaults" dismissible>
          <s-paragraph>Shopify&apos;s own recommendations are showing again.</s-paragraph>
        </s-banner>
      )}
      {!canOverride && (
        <s-banner tone="warning" heading={`You have used all ${limit} custom recommendations`}>
          <s-paragraph>
            Your plan covers custom recommendations on {limit} products. Reset one of those products
            to Shopify&apos;s defaults to free a slot, or upgrade for unlimited.
          </s-paragraph>
          <s-button href="/app/pricing" variant="primary">
            See plans
          </s-button>
        </s-banner>
      )}

      {pickerError && (
        <s-banner tone="warning" heading="The product picker did not open">
          <s-paragraph>{pickerError}</s-paragraph>
        </s-banner>
      )}

      {/* The page heading lives in the admin title bar, far from the content.
          Repeat the product here, with the status badge, so both "which
          product" and "what is it doing right now" are answered above the fold. */}
      <s-section>
        <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
          <s-stack direction="inline" gap="base" alignItems="center">
            <s-thumbnail
              src={product.image ?? undefined}
              alt={product.imageAlt ?? product.title}
              size="large"
            />
            <s-stack direction="block" gap="none">
              <s-heading>{product.title}</s-heading>
              <s-link href={`shopify://admin/products/${product.id}`}>View product</s-link>
            </s-stack>
          </s-stack>

          <s-badge tone={status.tone} size="large">
            {status.label}
          </s-badge>
        </s-stack>
      </s-section>

      <s-section heading="Your recommendations">
        {items.length === 0 ? (
          <s-stack direction="block" gap="base">
            <s-paragraph color="subdued">
              This product currently shows Shopify&apos;s own recommendations. Pick your own to
              replace them.
            </s-paragraph>
            <s-stack direction="inline" gap="base">
              <s-button
                variant="primary"
                onClick={openPicker}
                {...(canOverride ? {} : { disabled: true })}
              >
                Select products
              </s-button>
              {shopifyDefaults.length > 0 && (
                <s-button
                  variant="secondary"
                  onClick={useShopifyDefaults}
                  {...(canOverride ? {} : { disabled: true })}
                >
                  Start from Shopify&apos;s list
                </s-button>
              )}
            </s-stack>
          </s-stack>
        ) : (
          <s-stack direction="block" gap="base">
            <s-table variant="auto">
              <s-table-header-row>
                <s-table-header listSlot="kicker">#</s-table-header>
                <s-table-header listSlot="primary">Product</s-table-header>
                <s-table-header>Reorder</s-table-header>
                <s-table-header>Remove</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {items.map((item, index) => (
                  <s-table-row key={item.id}>
                    <s-table-cell>{index + 1}</s-table-cell>
                    <s-table-cell>
                      <ProductThumb title={item.title ?? `Product ${item.id}`} />
                    </s-table-cell>
                    <s-table-cell>
                      <s-button-group gap="base">
                        <s-button
                          variant="tertiary"
                          icon="arrow-up"
                          accessibilityLabel={`Move ${item.title} up`}
                          onClick={() => move(index, -1)}
                          {...(index === 0 ? { disabled: true } : {})}
                        />
                        <s-button
                          variant="tertiary"
                          icon="arrow-down"
                          accessibilityLabel={`Move ${item.title} down`}
                          onClick={() => move(index, 1)}
                          {...(index === items.length - 1 ? { disabled: true } : {})}
                        />
                      </s-button-group>
                    </s-table-cell>
                    <s-table-cell>
                      <s-button
                        variant="tertiary"
                        tone="critical"
                        icon="delete"
                        accessibilityLabel={`Remove ${item.title}`}
                        onClick={() => remove(index)}
                      />
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>

            <s-stack direction="inline" gap="base">
              <s-button variant="secondary" onClick={openPicker}>
                Change selection
              </s-button>
              <s-text color="subdued">
                {items.length} of {maxItems} slots used
              </s-text>
            </s-stack>
          </s-stack>
        )}
      </s-section>

      {/* Searching the catalogue here needs nothing from App Bridge, so picking
          products keeps working even when the hosted picker does not open. */}
      <s-section heading="Add products by search">
        <s-stack direction="block" gap="base">
          <s-search-field
            label="Search your products"
            labelAccessibilityVisibility="exclusive"
            placeholder="Search by product title"
            value={query}
            onInput={onSearchInput}
            onChange={onSearchInput}
          />

          {isSearching && <s-text color="subdued">Searching…</s-text>}

          {query.trim() && searchFetcher.data?.search && searchResults.length === 0 && (
            <s-paragraph color="subdued">No products matched that search.</s-paragraph>
          )}

          {query.trim() &&
            searchResults.map((product) => (
              <s-stack
                key={product.id}
                direction="inline"
                gap="base"
                alignItems="center"
                justifyContent="space-between"
              >
                <ProductThumb title={product.title} image={product.image} />
                <s-button
                  variant="secondary"
                  onClick={() => addItem(product)}
                  {...(isChosen(product.id) || items.length >= maxItems || !canOverride
                    ? { disabled: true }
                    : {})}
                >
                  {isChosen(product.id) ? 'Added' : 'Add'}
                </s-button>
              </s-stack>
            ))}
        </s-stack>
      </s-section>

      <s-section heading="What Shopify recommends">
        {defaultsError ? (
          <s-paragraph color="subdued">
            Could not load Shopify&apos;s recommendations right now.
          </s-paragraph>
        ) : shopifyDefaults.length === 0 ? (
          <s-paragraph color="subdued">
            Shopify has no recommendations for this product yet — they build up from order history.
          </s-paragraph>
        ) : (
          <s-stack direction="block" gap="base">
            <s-stack direction="block" gap="small">
              {shopifyDefaults.map((node) => (
                <ProductThumb
                  key={node.id}
                  title={node.title}
                  image={node.image}
                  subtitle={formatMoney(node.price, node.currencyCode ?? currencyCode)}
                />
              ))}
            </s-stack>

            <s-button
              variant="secondary"
              onClick={useShopifyDefaults}
              {...(canOverride ? {} : { disabled: true })}
            >
              Use this list as a starting point
            </s-button>
          </s-stack>
        )}
      </s-section>

      <s-section slot="aside" heading="Settings">
        <s-stack direction="block" gap="base">
          <s-select
            label="Show on"
            name="placement"
            value={placement}
            onChange={(event) => setPlacement(event.currentTarget.value)}
          >
            <s-option value="pdp">Product page</s-option>
            <s-option value="checkout">Checkout</s-option>
            <s-option value="both">Product page and checkout</s-option>
          </s-select>

          <s-switch
            label="Enabled"
            name="enabled"
            {...(enabled ? { checked: true } : {})}
            onChange={(event) => setEnabled(Boolean(event.currentTarget.checked))}
          />

          {limit !== null && (
            <>
              <s-divider />
              <s-text color="subdued">
                {overrideCount} of {limit} products on your plan have custom recommendations
                {alreadyOverridden ? ', including this one.' : '.'}
              </s-text>
            </>
          )}

          {/*
            Always offered, even with no override row on this product.
            
            It used to be `{override && ...}`, which put the one repair for a
            **leftover metafield** behind the existence of the row that was supposed
            to own it. A product whose row is gone but whose `$app:reco_overrides`
            metafield survived — a deleted offer whose takedown missed it, a failed
            metafield delete — kept rendering recommendations forever, and this button
            was the only thing that could clear it. The action already deletes the
            metafield unconditionally; only the button was conditional.
          */}
          <s-divider />
          <s-stack direction="block" gap="small-300">
            <s-button variant="secondary" tone="critical" onClick={reset}>
              Reset to Shopify defaults
            </s-button>
            <s-text color="subdued">
              {override
                ? 'Removes the custom list and its storefront data, so this product page falls back to Shopify’s own recommendations.'
                : 'This product has no custom list. Use this if its product page is still showing an offer you deleted — it clears the leftover storefront data.'}
            </s-text>
          </s-stack>
        </s-stack>
      </s-section>
    </s-page>
  );
}
