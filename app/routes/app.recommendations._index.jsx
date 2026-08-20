import { useEffect, useRef, useState } from 'react';
import {
  useFetcher,
  useLoaderData,
  useNavigate,
  useNavigation,
  useSearchParams,
} from 'react-router';
import { authenticate } from '../shopify.server';
import { ensureShop } from '../models/shop.server';
import {
  MAX_OVERRIDE_ITEMS,
  countOverriddenProducts,
  getOverridesForProducts,
  getProductOverrides,
  hasOverrideForProduct,
  listOverrides,
  markOverrideSynced,
  upsertOverride,
} from '../models/override.server';
import {
  PAGE_SIZE,
  getProduct,
  getProductsByIds,
  listProducts,
} from '../lib/products.server';
import { syncOverrideMetafield } from '../lib/metafields.server';
import { canAddOverride, overrideLimit } from '../lib/entitlements';
import { isUnlimited } from '../lib/plans';
import { formatNumber } from '../lib/format';
import QuotaBanner from '../components/QuotaBanner';
import EmptyState from '../components/EmptyState';
import ProductThumb from '../components/ProductThumb';
import ComplementaryCell from '../components/ComplementaryCell';

const SOURCES = ['all', 'custom', 'shopify'];

/*
 * Ordering is fixed to most-recent-first, and there is no Sort control
 * (2026-08-20). The page had picked up three rounds of sort options that each
 * outlived their reason: the metric sorts ("Most recommendations", "Most clicks")
 * ranked by numbers the table no longer displays and cost a full override scan
 * plus a raw-event aggregation per page load; the title sorts were only added so
 * the control would not be left with a single option. Recent-first is what a
 * merchant curating lists actually wants — the product they just touched is at
 * the top — and ranking by performance belongs on /app/analytics, which shows
 * the numbers it sorts by.
 *
 * The two modes reach it differently: catalogue mode passes Shopify's
 * UPDATED_AT sort key, custom mode orders the Override table by its own
 * updatedAt, which is when the merchant last edited the list rather than when
 * Shopify last touched the product.
 */
const CATALOG_SORT = 'updated';
const CUSTOM_ORDER_BY = { updatedAt: 'desc' };

/**
 * Thumbnails shown per row before collapsing into "+N".
 *
 * A row can hold up to MAX_OVERRIDE_ITEMS (12), and 12 chips in a table cell is
 * unreadable. It also bounds the image lookup: one page is 25 rows, so this is
 * at most 100 ids in a single nodes(ids:) call rather than 300.
 */
const MAX_CHIPS = 4;

function pick(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  const url = new URL(request.url);
  const params = url.searchParams;
  const search = (params.get('q') ?? '').trim();
  const source = pick(params.get('source'), SOURCES, 'all');
  const page = Math.max(0, Number(params.get('page') ?? 0) || 0);

  const isCustomMode = source === 'custom';

  let products = [];
  let pageInfo = { hasNextPage: false, hasPreviousPage: false };
  let overrides = [];

  if (isCustomMode) {
    // One extra row is fetched to answer hasNextPage without a second count.
    overrides = await listOverrides({
      shopId: shop.id,
      search: search || undefined,
      // No placement or status filter: both controls were removed on
      // 2026-08-20. listOverrides still accepts them for other callers.
      orderBy: CUSTOM_ORDER_BY,
      take: PAGE_SIZE + 1,
      skip: page * PAGE_SIZE,
    });
    pageInfo = {
      hasNextPage: overrides.length > PAGE_SIZE,
      hasPreviousPage: page > 0,
    };
    overrides = overrides.slice(0, PAGE_SIZE);

    products = await getProductsByIds(
      admin,
      overrides.map((o) => o.productId),
    );
  } else {
    const result = await listProducts(admin, {
      search,
      sort: CATALOG_SORT,
      after: params.get('after'),
      before: params.get('before'),
    });
    products = result.products;
    pageInfo = result.pageInfo;

    const map = await getOverridesForProducts(
      shop.id,
      products.map((p) => p.id),
    );
    overrides = [...map.values()];

    if (source === 'shopify') {
      // Excluding here can leave a short page — Shopify pages the catalog, and
      // it does not know which products we have overrides for.
      const overridden = new Set(map.keys());
      products = products.filter((p) => !overridden.has(p.id));
    }
  }

  /*
   * The stored items hold id/handle/title but no image — the picker never gave
   * us one and the metafield does not need it. So the thumbnails are hydrated
   * here, in one call for the whole page, and only for the chips that will
   * actually be drawn.
   */
  // Only for rows that survive to the page. In "Shopify defaults only" mode the
  // overridden products were just filtered out, and fetching images for rows
  // nobody will see is a wasted Admin call on every page load.
  const visibleIds = new Set(products.map((p) => p.id));

  const chipIds = [
    ...new Set(
      overrides
        .filter((o) => visibleIds.has(o.productId))
        .flatMap((o) =>
          (o.items ?? []).slice(0, MAX_CHIPS).map((item) => String(item.id)),
        ),
    ),
  ];

  const chipImages = new Map(
    (chipIds.length > 0 ? await getProductsByIds(admin, chipIds) : []).map((p) => [
      p.id,
      { title: p.title, image: p.image, imageAlt: p.imageAlt },
    ]),
  );

  const overrideByProduct = Object.fromEntries(
    overrides.map((o) => {
      const items = o.items ?? [];
      return [
        o.productId,
        {
          placement: o.placement,
          enabled: o.enabled,
          count: items.length,
          // Everything the inline picker needs to reopen preselected.
          items: items.map((item) => ({
            id: String(item.id),
            handle: item.handle ?? null,
            title: item.title ?? null,
          })),
          chips: items.slice(0, MAX_CHIPS).map((item) => {
            const hydrated = chipImages.get(String(item.id));
            return {
              id: String(item.id),
              // A deleted or unpublished product resolves to nothing; keep the
              // stored title so the chip is still identifiable.
              title: hydrated?.title ?? item.title ?? "Unavailable product",
              image: hydrated?.image ?? null,
              imageAlt: hydrated?.imageAlt ?? item.title ?? "",
              missing: !hydrated,
            };
          }),
          overflow: Math.max(0, items.length - MAX_CHIPS),
        },
      ];
    }),
  );

  // Counted per product, not per row: the plan allowance is "how many products
  // carry custom recommendations".
  const overrideCount = await countOverriddenProducts(shop.id);
  const limit = overrideLimit(shop.plan);

  return {
    products: products.map((product) => ({
      ...product,
      override: overrideByProduct[product.id] ?? null,
    })),
    pageInfo,
    filters: { search, source, page },
    isCustomMode,
    overrideCount,
    // Unlimited serialises as null — loaders are JSON-encoded (CLAUDE.md §10).
    overrideLimit: isUnlimited(limit) ? null : limit,
    canAddOverride: canAddOverride(shop.plan, overrideCount),
    maxItems: MAX_OVERRIDE_ITEMS,
  };
};

/**
 * Inline editing of a product's complementary list, straight from the table.
 *
 * The full editor at /app/recommendations/:productId still owns placement, the
 * enable toggle, reordering, the Shopify-defaults preview and clearing a list
 * ("Reset to Shopify defaults"). This action only ever changes *which products*
 * are in the list, which is the one thing worth doing without leaving the page.
 *
 * Nothing here can empty a list, so nothing here can strand a merchant who has
 * used their whole product allowance: reset is in the editor and is never gated,
 * which is how a slot gets freed.
 *
 * Two rules it must not break:
 *   - Placement is left exactly as it was. A product can hold a `pdp` row and a
 *     `checkout` row, so assuming `pdp` here would write a second row beside an
 *     existing one instead of editing it.
 *   - The plan allowance is enforced server-side, as everywhere else. Editing a
 *     product that already has a list takes no new slot; adding the first list
 *     to a new product does.
 */
export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  const formData = await request.formData();
  const intent = String(formData.get('intent') ?? '');
  const productId = String(formData.get('productId') ?? '').trim();

  if (!productId) return { ok: false, error: 'No product given.' };

  if (intent !== 'save') return { ok: false, error: 'Unknown action.' };

  let items = [];
  try {
    items = JSON.parse(formData.get('items') ?? '[]');
  } catch {
    return { ok: false, error: 'Could not read the selected products.' };
  }

  if (!Array.isArray(items) || items.length === 0) {
    return {
      ok: false,
      productId,
      error:
        'Pick at least one product. To empty a list, open the product and choose "Reset to Shopify defaults".',
    };
  }

  const existing = await getProductOverrides(shop.id, productId);

  if (existing.length === 0 && !(await hasOverrideForProduct(shop.id, productId))) {
    const overrideCount = await countOverriddenProducts(shop.id);
    if (!canAddOverride(shop.plan, overrideCount)) {
      return {
        ok: false,
        productId,
        limitReached: true,
        error: `Your plan covers complementary products on ${overrideLimit(shop.plan)} products, and all of them are in use. Open a product and choose "Reset to Shopify defaults" to free a slot, or upgrade for unlimited.`,
      };
    }
  }

  const product = await getProduct(admin, productId);
  if (!product) return { ok: false, productId, error: 'Product not found.' };

  const saved = await upsertOverride({
    shopId: shop.id,
    productId,
    productTitle: product.title,
    productHandle: product.handle,
    // Keep whatever the row already had; only the full editor changes it.
    placement: existing[0]?.placement ?? 'pdp',
    items,
    enabled: existing[0]?.enabled ?? true,
  });

  // Saved either way — only a successful sync makes it live, so a failure is
  // reported rather than swallowed. syncedAt stays null for the repair action.
  try {
    const { published } = await syncOverrideMetafield(admin, saved);
    await markOverrideSynced(saved.id);
    return { ok: true, productId, saved: true, published };
  } catch (error) {
    return { ok: true, productId, saved: true, syncWarning: error.message };
  }
};

export default function RecommendationsPage() {
  const {
    products,
    pageInfo,
    filters,
    isCustomMode,
    overrideCount,
    overrideLimit: limit,
    canAddOverride: canAdd,
    maxItems,
  } = useLoaderData();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  /*
   * One fetcher for every row rather than one per row: only a single picker can
   * be open at a time, so the saves cannot overlap. `inline.formData` tells us
   * which product is mid-save, which is what drives the row's spinner.
   */
  const inline = useFetcher();
  const [inlineError, setInlineError] = useState(null);
  const navigation = useNavigation();
  const debounceRef = useRef(null);

  const isLoading = navigation.state === 'loading';

  const savingProductId =
    inline.state !== 'idle' ? String(inline.formData?.get('productId') ?? '') : null;

  const saveComplementary = (productId, items) => {
    setInlineError(null);
    inline.submit(
      { intent: 'save', productId, items: JSON.stringify(items) },
      { method: 'POST' },
    );
  };

  // The action reports its own failures; the picker reports failing to open.
  const actionError = inline.data?.ok === false ? inline.data.error : null;
  const syncWarning = inline.data?.syncWarning ?? null;

  // Debounce the search box so typing does not fire a request per keystroke.
  useEffect(() => () => clearTimeout(debounceRef.current), []);

  /**
   * Polaris web components are not form-associated, so `new FormData(form)`
   * comes back without their values. Submitting a `<Form method="get">` sent an
   * empty query string, which dropped every filter and silently reset the list
   * to its defaults — the Sort control looked applied but never was. Read the
   * value off the control and build the URL directly instead.
   */
  const applyFilter = (changes) => {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === '') next.delete(key);
      else next.set(key, String(value));
    }
    // Any filter change invalidates the cursor and the offset it paged from.
    next.delete('after');
    next.delete('before');
    next.delete('page');
    navigate(`/app/recommendations?${next.toString()}`, { replace: true });
  };

  const onSearchInput = (event) => {
    // Captured now: currentTarget is cleared before the timeout runs.
    const value = event.currentTarget.value ?? '';
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => applyFilter({ q: value }), 300);
  };

  const pageLink = (changes) => {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) next.delete(key);
      else next.set(key, String(value));
    }
    return `/app/recommendations?${next.toString()}`;
  };

  return (
    <s-page heading="Recommendations">
      <QuotaBanner />

      {/* Only limited plans get a banner — on an unlimited plan there is
          nothing to report. */}
      {limit !== null && (
        <s-banner
          tone={canAdd ? 'info' : 'warning'}
          heading={
            canAdd
              ? `${formatNumber(overrideCount)} of ${formatNumber(limit)} custom recommendations used`
              : `You have used all ${formatNumber(limit)} custom recommendations`
          }
        >
          <s-paragraph>
            {canAdd
              ? `Your plan covers custom recommendations on ${formatNumber(limit)} products — the rest keep Shopify's own. Upgrade for unlimited.`
              : "Reset a product to Shopify's defaults to free a slot, or upgrade to customise as many products as you like."}
          </s-paragraph>
          <s-button href="/app/pricing" variant={canAdd ? 'secondary' : 'primary'}>
            See plans
          </s-button>
        </s-banner>
      )}

      {/* Inline editing has no page of its own to report on, so its outcome
          surfaces here. The picker is admin-hosted: when it fails to open there
          is nothing this app can do about it, which is worth saying rather than
          leaving in the console. */}
      {(inlineError || actionError) && (
        <s-banner tone="critical" heading="Could not save complementary products">
          <s-paragraph>{inlineError || actionError}</s-paragraph>
        </s-banner>
      )}

      {/* Saved to the database but not mirrored to the product metafield, so the
          storefront still shows the old list. Settings has the repair action. */}
      {syncWarning && (
        <s-banner tone="warning" heading="Saved, but not live on your storefront yet">
          <s-paragraph>{syncWarning}</s-paragraph>
          <s-button href="/app/settings" variant="secondary">
            Re-sync
          </s-button>
        </s-banner>
      )}

      <s-section>
        <s-stack direction="block" gap="base">
          <s-search-field
            label="Search products"
            name="q"
            value={filters.search}
            placeholder="Search by product title"
            onInput={onSearchInput}
          />

          <s-select
            label="Source"
            name="source"
            value={filters.source}
            onChange={(event) => applyFilter({ source: event.currentTarget.value })}
          >
            <s-option value="all">All products</s-option>
            <s-option value="custom">Custom only</s-option>
            <s-option value="shopify">Shopify defaults only</s-option>
          </s-select>
        </s-stack>
      </s-section>

      <s-section>
        {products.length === 0 ? (
          <EmptyState
            heading={
              filters.search
                ? 'No products match that search'
                : isCustomMode
                  ? 'No custom recommendations yet'
                  : 'No products found'
            }
            description={
              isCustomMode
                ? 'Pick a product from the All products view to replace what Shopify recommends on its page.'
                : 'Products from your catalogue will appear here.'
            }
            action={
              isCustomMode
                ? { label: 'Browse all products', href: '/app/recommendations?source=all' }
                : null
            }
          />
        ) : (
          <>
            <s-paragraph color="subdued">
              This page manages which products go together. Performance figures live on the{' '}
              <s-link href="/app/analytics">Analytics</s-link> page.
            </s-paragraph>

            <s-table variant="auto" {...(isLoading ? { loading: true } : {})}>
              <s-table-header-row>
                <s-table-header listSlot="primary">Product</s-table-header>
                <s-table-header>Complementary products</s-table-header>
                <s-table-header listSlot="kicker">Source</s-table-header>
                <s-table-header>Actions</s-table-header>
              </s-table-header-row>

              <s-table-body>
                {products.map((product) => (
                  <s-table-row key={product.id}>
                    <s-table-cell>
                      <ProductThumb
                        title={product.title}
                        image={product.image}
                        href={`/app/recommendations/${product.id}`}
                      />
                    </s-table-cell>

                    <s-table-cell>
                      <ComplementaryCell
                        productId={product.id}
                        chips={product.override?.chips ?? []}
                        items={product.override?.items ?? []}
                        overflow={product.override?.overflow ?? 0}
                        maxItems={maxItems}
                        canAdd={canAdd}
                        busy={savingProductId === product.id}
                        onSave={saveComplementary}
                        onError={setInlineError}
                      />
                    </s-table-cell>

                    <s-table-cell>
                      {product.override ? (
                        <s-badge tone={product.override.enabled ? 'success' : 'neutral'}>
                          {product.override.enabled
                            ? `Custom (${product.override.count})`
                            : 'Custom, off'}
                        </s-badge>
                      ) : (
                        <s-badge tone="neutral">Shopify</s-badge>
                      )}
                    </s-table-cell>

                    <s-table-cell>
                      <s-link href={`/app/recommendations/${product.id}`}>
                        {product.override ? 'Edit' : 'Customise'}
                      </s-link>
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>

            <s-stack direction="inline" gap="base" justifyContent="center">
              <s-button
                variant="secondary"
                href={
                  isCustomMode
                    ? pageLink({ page: Math.max(0, filters.page - 1) })
                    : pageLink({ before: pageInfo.startCursor, after: null })
                }
                {...(pageInfo.hasPreviousPage ? {} : { disabled: true })}
              >
                Previous
              </s-button>
              <s-button
                variant="secondary"
                href={
                  isCustomMode
                    ? pageLink({ page: filters.page + 1 })
                    : pageLink({ after: pageInfo.endCursor, before: null })
                }
                {...(pageInfo.hasNextPage ? {} : { disabled: true })}
              >
                Next
              </s-button>
            </s-stack>
          </>
        )}
      </s-section>
    </s-page>
  );
}
