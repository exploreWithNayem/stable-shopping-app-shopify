import { useFetcher, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { ensureShop } from "../models/shop.server";
import { countOverrides, listUnsyncedOverrides } from "../models/override.server";
import { syncAllOverrides } from "../lib/metafields.server";
import { syncShopOffers } from "../lib/shop-offers.server";
import { formatNumber } from "../lib/format";
import QuotaBanner from "../components/QuotaBanner";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  const [total, unsynced] = await Promise.all([
    countOverrides(shop.id),
    listUnsyncedOverrides(shop.id),
  ]);

  return {
    overrideCount: total,
    unsyncedCount: unsynced.length,
  };
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  const formData = await request.formData();
  if (formData.get("intent") !== "resync") {
    return { ok: false, error: "Unknown action." };
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
  const { overrideCount, unsyncedCount } = useLoaderData();
  const fetcher = useFetcher();
  const result = fetcher.data;
  const isSyncing = fetcher.state !== "idle";

  return (
    <s-page heading="Settings">
      <QuotaBanner />

      {result?.errors?.length > 0 && (
        <s-banner tone="critical" heading="Some recommendations did not sync">
          <s-paragraph>{result.errors.join(" ")}</s-paragraph>
        </s-banner>
      )}
      {result?.ok && (
        <s-banner tone="success" heading="Recommendations re-synced" dismissible>
          <s-paragraph>
            {formatNumber(result.synced)} of {formatNumber(result.total)} pushed
            to your storefront.
          </s-paragraph>
        </s-banner>
      )}

      <s-section heading="Storefront sync">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Your custom recommendations are stored here and copied to each
            product so your theme can show them. If the storefront looks out of
            date, re-sync to push them again.
          </s-paragraph>

          <s-stack direction="inline" gap="small" alignItems="center">
            <s-text>Custom recommendations:</s-text>
            <s-badge tone="neutral">{formatNumber(overrideCount)}</s-badge>
            {unsyncedCount > 0 && (
              <s-badge tone="warning">
                {formatNumber(unsyncedCount)} not yet live
              </s-badge>
            )}
          </s-stack>

          <s-button
            variant={unsyncedCount > 0 ? "primary" : "secondary"}
            onClick={() => fetcher.submit({ intent: "resync" }, { method: "POST" })}
            {...(isSyncing ? { loading: true } : {})}
            {...(overrideCount === 0 ? { disabled: true } : {})}
          >
            Re-sync recommendations
          </s-button>
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="Coming next">
        <s-paragraph color="subdued">
          Global widget defaults, checkout recommendations and tracking
          preferences will live here.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}
