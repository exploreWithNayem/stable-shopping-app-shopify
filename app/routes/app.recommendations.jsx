import { useEffect, useRef } from "react";
import { Form, useLoaderData, useNavigation, useSearchParams, useSubmit } from "react-router";
import { authenticate } from "../shopify.server";
import { ensureShop } from "../models/shop.server";
import {
  countOverrides,
  getOverridesForProducts,
  listOverrides,
} from "../models/override.server";
import { getSourceProductMetrics } from "../models/event.server";
import {
  DEFAULT_SORT,
  PAGE_SIZE,
  SORT_KEYS,
  getProductsByIds,
  listProducts,
} from "../lib/products.server";
import { analyticsRetentionDays, canUseOverrides } from "../lib/entitlements";
import { addDays, startOfUtcDay } from "../lib/dates";
import { formatNumber, formatPercent, rate } from "../lib/format";
import QuotaBanner from "../components/QuotaBanner";
import EmptyState from "../components/EmptyState";
import ProductThumb from "../components/ProductThumb";

const SOURCES = ["all", "custom", "shopify"];
const STATUSES = ["any", "enabled", "disabled"];
const PLACEMENTS = ["any", "pdp", "checkout", "both"];

/** Sorting by our own metrics is only offered in custom mode — see below. */
const CUSTOM_SORTS = {
  updated: "Recently updated",
  served: "Most recommendations",
  clicks: "Most clicks",
};

/**
 * Metric sorting needs every override's numbers in memory. Overrides are
 * merchant-curated so this is small in practice; past the cap we sort by
 * recency instead and say so rather than silently sorting one page.
 */
const METRIC_SORT_CAP = 1000;

function pick(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  const url = new URL(request.url);
  const params = url.searchParams;
  const search = (params.get("q") ?? "").trim();
  const source = pick(params.get("source"), SOURCES, "all");
  const status = pick(params.get("status"), STATUSES, "any");
  const placement = pick(params.get("placement"), PLACEMENTS, "any");
  const page = Math.max(0, Number(params.get("page") ?? 0) || 0);

  const isCustomMode = source === "custom";
  const sort = isCustomMode
    ? pick(params.get("sort"), Object.keys(CUSTOM_SORTS), "updated")
    : pick(params.get("sort"), Object.keys(SORT_KEYS), DEFAULT_SORT);

  const windowDays = Math.min(30, analyticsRetentionDays(shop.plan));
  const from = addDays(startOfUtcDay(), -windowDays);

  let products = [];
  let pageInfo = { hasNextPage: false, hasPreviousPage: false };
  let overrides = [];
  let metricSortDowngraded = false;

  if (isCustomMode) {
    const total = await countOverrides(shop.id);
    const wantsMetricSort = sort === "served" || sort === "clicks";

    if (wantsMetricSort && total > METRIC_SORT_CAP) {
      metricSortDowngraded = true;
    }

    if (wantsMetricSort && !metricSortDowngraded) {
      // Rank every override, then page the ranked list.
      const all = await listOverrides({
        shopId: shop.id,
        search: search || undefined,
        placement: placement === "any" ? undefined : placement,
        enabled: status === "any" ? undefined : status === "enabled",
        take: METRIC_SORT_CAP,
      });
      const metrics = await getSourceProductMetrics(
        shop.id,
        all.map((o) => o.productId),
        { from },
      );
      const field = sort === "served" ? "served" : "clicks";
      all.sort(
        (a, b) =>
          (metrics.get(b.productId)?.[field] ?? 0) -
          (metrics.get(a.productId)?.[field] ?? 0),
      );
      overrides = all.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
      pageInfo = {
        hasNextPage: (page + 1) * PAGE_SIZE < all.length,
        hasPreviousPage: page > 0,
      };
    } else {
      overrides = await listOverrides({
        shopId: shop.id,
        search: search || undefined,
        placement: placement === "any" ? undefined : placement,
        enabled: status === "any" ? undefined : status === "enabled",
        take: PAGE_SIZE + 1,
        skip: page * PAGE_SIZE,
      });
      pageInfo = {
        hasNextPage: overrides.length > PAGE_SIZE,
        hasPreviousPage: page > 0,
      };
      overrides = overrides.slice(0, PAGE_SIZE);
    }

    products = await getProductsByIds(
      admin,
      overrides.map((o) => o.productId),
    );
  } else {
    const result = await listProducts(admin, {
      search,
      sort,
      after: params.get("after"),
      before: params.get("before"),
    });
    products = result.products;
    pageInfo = result.pageInfo;

    const map = await getOverridesForProducts(
      shop.id,
      products.map((p) => p.id),
    );
    overrides = [...map.values()];

    if (source === "shopify") {
      // Excluding here can leave a short page — Shopify pages the catalog, and
      // it does not know which products we have overrides for.
      const overridden = new Set(map.keys());
      products = products.filter((p) => !overridden.has(p.id));
    }
  }

  const overrideByProduct = Object.fromEntries(
    overrides.map((o) => [
      o.productId,
      { placement: o.placement, enabled: o.enabled, count: (o.items ?? []).length },
    ]),
  );

  const metrics = await getSourceProductMetrics(
    shop.id,
    products.map((p) => p.id),
    { from },
  );

  // Sort options are built here, not in the component: SORT_KEYS lives in a
  // .server module and must never be referenced from client code.
  const sortOptions = isCustomMode
    ? Object.entries(CUSTOM_SORTS).map(([value, label]) => ({ value, label }))
    : Object.entries(SORT_KEYS).map(([value, config]) => ({
        value,
        label: config.label,
      }));

  return {
    sortOptions,
    products: products.map((product) => ({
      ...product,
      override: overrideByProduct[product.id] ?? null,
      metrics: metrics.get(product.id) ?? {
        served: 0,
        impressions: 0,
        clicks: 0,
        addToCarts: 0,
      },
    })),
    pageInfo,
    filters: { search, source, status, placement, sort, page },
    isCustomMode,
    metricSortDowngraded,
    windowDays,
    canOverride: canUseOverrides(shop.plan),
  };
};

export default function RecommendationsPage() {
  const {
    products,
    pageInfo,
    filters,
    sortOptions,
    isCustomMode,
    metricSortDowngraded,
    windowDays,
    canOverride,
  } = useLoaderData();
  const [searchParams] = useSearchParams();
  const submit = useSubmit();
  const navigation = useNavigation();
  const formRef = useRef(null);
  const debounceRef = useRef(null);

  const isLoading = navigation.state === "loading";

  // Debounce the search box so typing does not fire a request per keystroke.
  useEffect(() => () => clearTimeout(debounceRef.current), []);

  const onSearchInput = () => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      if (formRef.current) submit(formRef.current, { replace: true });
    }, 300);
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

      {!canOverride && (
        <s-banner tone="info" heading="Custom recommendations are a paid feature">
          <s-paragraph>
            On the Free plan your product pages show Shopify&apos;s own
            recommendations. Upgrade to replace them with your own picks.
          </s-paragraph>
          <s-button href="/app/pricing" variant="primary">
            See plans
          </s-button>
        </s-banner>
      )}

      {metricSortDowngraded && (
        <s-banner tone="warning" heading="Sorted by recency instead">
          <s-paragraph>
            You have more than {formatNumber(METRIC_SORT_CAP)} custom
            recommendations, which is more than this page can rank by
            performance. Use the Analytics page for a full ranking.
          </s-paragraph>
        </s-banner>
      )}

      <s-section>
        <Form ref={formRef} method="get" replace>
          {/* Any filter change resets paging, so cursors are not carried over. */}
          <s-stack direction="block" gap="base">
            <s-search-field
              label="Search products"
              name="q"
              value={filters.search}
              placeholder="Search by product title"
              onInput={onSearchInput}
            />

            <s-stack direction="inline" gap="base" alignItems="end">
              <s-select
                label="Source"
                name="source"
                value={filters.source}
                onChange={(event) => submit(event.currentTarget.form, { replace: true })}
              >
                <s-option value="all">All products</s-option>
                <s-option value="custom">Custom only</s-option>
                <s-option value="shopify">Shopify defaults only</s-option>
              </s-select>

              <s-select
                label="Sort"
                name="sort"
                value={filters.sort}
                onChange={(event) => submit(event.currentTarget.form, { replace: true })}
              >
                {sortOptions.map((option) => (
                  <s-option key={option.value} value={option.value}>
                    {option.label}
                  </s-option>
                ))}
              </s-select>

              {isCustomMode && (
                <>
                  <s-select
                    label="Placement"
                    name="placement"
                    value={filters.placement}
                    onChange={(event) => submit(event.currentTarget.form, { replace: true })}
                  >
                    <s-option value="any">Any placement</s-option>
                    <s-option value="pdp">Product page</s-option>
                    <s-option value="checkout">Checkout</s-option>
                    <s-option value="both">Both</s-option>
                  </s-select>

                  <s-select
                    label="Status"
                    name="status"
                    value={filters.status}
                    onChange={(event) => submit(event.currentTarget.form, { replace: true })}
                  >
                    <s-option value="any">Any status</s-option>
                    <s-option value="enabled">Enabled</s-option>
                    <s-option value="disabled">Disabled</s-option>
                  </s-select>
                </>
              )}

              <s-button type="submit" variant="secondary">
                Apply
              </s-button>
            </s-stack>
          </s-stack>
        </Form>
      </s-section>

      <s-section>
        {products.length === 0 ? (
          <EmptyState
            heading={
              filters.search
                ? "No products match that search"
                : isCustomMode
                  ? "No custom recommendations yet"
                  : "No products found"
            }
            description={
              isCustomMode
                ? "Pick a product from the All products view to replace what Shopify recommends on its page."
                : "Products from your catalogue will appear here."
            }
            action={
              isCustomMode
                ? { label: "Browse all products", href: "/app/recommendations?source=all" }
                : null
            }
          />
        ) : (
          <>
            <s-paragraph color="subdued">
              Metrics cover the last {windowDays} days.
            </s-paragraph>

            <s-table variant="auto" {...(isLoading ? { loading: true } : {})}>
              <s-table-header-row>
                <s-table-header listSlot="primary">Product</s-table-header>
                <s-table-header listSlot="kicker">Source</s-table-header>
                <s-table-header format="numeric">Recommendations</s-table-header>
                <s-table-header format="numeric">Impressions</s-table-header>
                <s-table-header format="numeric">Clicks</s-table-header>
                <s-table-header format="numeric">CTR</s-table-header>
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
                      {product.override ? (
                        <s-badge tone={product.override.enabled ? "success" : "neutral"}>
                          {product.override.enabled
                            ? `Custom (${product.override.count})`
                            : "Custom, off"}
                        </s-badge>
                      ) : (
                        <s-badge tone="neutral">Shopify</s-badge>
                      )}
                    </s-table-cell>

                    <s-table-cell>{formatNumber(product.metrics.served)}</s-table-cell>
                    <s-table-cell>{formatNumber(product.metrics.impressions)}</s-table-cell>
                    <s-table-cell>{formatNumber(product.metrics.clicks)}</s-table-cell>
                    <s-table-cell>
                      {formatPercent(
                        rate(product.metrics.clicks, product.metrics.impressions),
                      )}
                    </s-table-cell>

                    <s-table-cell>
                      <s-link href={`/app/recommendations/${product.id}`}>
                        {product.override ? "Edit" : "Customise"}
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
