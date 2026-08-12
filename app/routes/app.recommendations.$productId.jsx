import { useCallback, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { ensureShop } from "../models/shop.server";
import {
  MAX_OVERRIDE_ITEMS,
  deleteOverride,
  getActiveOverride,
  markOverrideSynced,
  upsertOverride,
} from "../models/override.server";
import {
  deleteOverrideMetafield,
  syncOverrideMetafield,
} from "../lib/metafields.server";
import { getProduct } from "../lib/products.server";
import { getShopifyRecommendations } from "../lib/recommendations.server";
import { ensureStorefrontToken } from "../lib/storefront.server";
import { canUseOverrides } from "../lib/entitlements";
import { formatMoney } from "../lib/format";
import QuotaBanner from "../components/QuotaBanner";
import ProductThumb from "../components/ProductThumb";

export const loader = async ({ request, params }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const productId = params.productId;

  const product = await getProduct(admin, productId);
  if (!product) {
    throw new Response("Product not found", { status: 404 });
  }

  const override = await getActiveOverride({
    shopId: shop.id,
    productId,
    placement: "pdp",
  });

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
    currencyCode: shop.currencyCode ?? "USD",
    canOverride: canUseOverrides(shop.plan),
    maxItems: MAX_OVERRIDE_ITEMS,
  };
};

export const action = async ({ request, params }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const productId = params.productId;

  const formData = await request.formData();
  const intent = formData.get("intent");

  // Enforced here as well as in the UI — a hidden button is not a control.
  if (!canUseOverrides(shop.plan)) {
    return { ok: false, error: "Custom recommendations require a paid plan." };
  }

  if (intent === "reset") {
    await deleteOverride({ shopId: shop.id, productId, placement: "pdp" });
    await deleteOverride({ shopId: shop.id, productId, placement: "checkout" });
    await deleteOverride({ shopId: shop.id, productId, placement: "both" });

    try {
      await deleteOverrideMetafield(admin, productId);
    } catch (error) {
      // The row is gone either way; a stale metafield would keep showing the
      // old list on the storefront, so say so rather than claiming success.
      return { ok: true, reset: true, syncWarning: error.message };
    }

    return { ok: true, reset: true };
  }

  const product = await getProduct(admin, productId);
  if (!product) {
    return { ok: false, error: "Product not found." };
  }

  let items = [];
  try {
    items = JSON.parse(formData.get("items") ?? "[]");
  } catch {
    return { ok: false, error: "Could not read the selected products." };
  }

  if (items.length === 0) {
    return { ok: false, error: "Add at least one product, or reset to defaults." };
  }

  const placement = formData.get("placement") ?? "pdp";
  const enabled = formData.get("enabled") === "true";

  // Placement is part of the row's identity, so a change means the old row has
  // to go rather than leaving a duplicate behind.
  for (const existing of ["pdp", "checkout", "both"]) {
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
    maxItems,
  } = useLoaderData();
  const shopify = useAppBridge();
  const fetcher = useFetcher();

  const [items, setItems] = useState(() => override?.items ?? []);
  const [placement, setPlacement] = useState(override?.placement ?? "pdp");
  const [enabled, setEnabled] = useState(override?.enabled ?? true);

  const isSaving = fetcher.state !== "idle";
  const result = fetcher.data;

  const openPicker = useCallback(async () => {
    const selection = await shopify.resourcePicker({
      type: "product",
      multiple: maxItems,
      selectionIds: items.map((item) => ({
        id: `gid://shopify/Product/${item.id}`,
      })),
    });

    if (!selection) return;

    setItems(
      selection.slice(0, maxItems).map((node, index) => ({
        id: String(node.id).split("/").pop(),
        handle: node.handle ?? null,
        title: node.title ?? null,
        position: index,
      })),
    );
  }, [shopify, items, maxItems]);

  const move = (index, delta) => {
    const next = [...items];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setItems(next.map((item, position) => ({ ...item, position })));
  };

  const remove = (index) =>
    setItems(
      items.filter((_, i) => i !== index).map((item, position) => ({ ...item, position })),
    );

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
        intent: "save",
        items: JSON.stringify(items),
        placement,
        enabled: String(enabled),
      },
      { method: "POST" },
    );
  };

  const reset = () => {
    setItems([]);
    fetcher.submit({ intent: "reset" }, { method: "POST" });
  };

  return (
    <s-page heading={product.title}>
      <QuotaBanner />

      {result?.error && (
        <s-banner tone="critical" heading="Could not save">
          <s-paragraph>{result.error}</s-paragraph>
        </s-banner>
      )}
      {result?.syncWarning && (
        <s-banner tone="warning" heading="Saved, but not live yet">
          <s-paragraph>
            Your changes are stored but could not be published to the storefront:{" "}
            {result.syncWarning} Use “Re-sync recommendations” on the Settings
            page to try again.
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
              ? "This product now shows your custom recommendations."
              : "Saved. These are set to show in checkout only, so the product page keeps Shopify's recommendations."}
          </s-paragraph>
        </s-banner>
      )}
      {result?.reset && (
        <s-banner tone="success" heading="Reset to Shopify defaults" dismissible>
          <s-paragraph>
            Shopify&apos;s own recommendations are showing again.
          </s-paragraph>
        </s-banner>
      )}
      {!canOverride && (
        <s-banner tone="info" heading="Upgrade to customise">
          <s-paragraph>
            Custom recommendations are available on the Standard plan and above.
          </s-paragraph>
          <s-button href="/app/pricing" variant="primary">
            See plans
          </s-button>
        </s-banner>
      )}

      <s-section heading="Your recommendations">
        {items.length === 0 ? (
          <s-stack direction="block" gap="base">
            <s-paragraph color="subdued">
              This product currently shows Shopify&apos;s own recommendations.
              Pick your own to replace them.
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
                <s-table-header>Order</s-table-header>
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
                      <s-button-group gap="small">
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

      <s-section heading="What Shopify recommends">
        {defaultsError ? (
          <s-paragraph color="subdued">
            Could not load Shopify&apos;s recommendations right now.
          </s-paragraph>
        ) : shopifyDefaults.length === 0 ? (
          <s-paragraph color="subdued">
            Shopify has no recommendations for this product yet — they build up
            from order history.
          </s-paragraph>
        ) : (
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

          <s-button
            variant="primary"
            onClick={save}
            {...(isSaving ? { loading: true } : {})}
            {...(canOverride && items.length > 0 ? {} : { disabled: true })}
          >
            Save
          </s-button>

          {override && (
            <s-button variant="secondary" tone="critical" onClick={reset}>
              Reset to Shopify defaults
            </s-button>
          )}
        </s-stack>
      </s-section>
    </s-page>
  );
}
