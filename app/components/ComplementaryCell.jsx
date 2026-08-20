import { useCallback, useState } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";

/**
 * One row's complementary products, shown as thumbnails and editable in place.
 *
 * Why inline rather than only in the editor: picking which products go with
 * which is the job merchants do dozens of times in a row, and a round trip to
 * /app/recommendations/:productId and back for each one is the slow part. The
 * editor still owns everything else — placement, the enable toggle, reordering,
 * the Shopify-defaults preview — so this deliberately changes only the list.
 *
 * The list is stored in the app's own `$app:reco_overrides` metafield, not
 * Shopify's `shopify--discovery--product_recommendation.complementary_products`:
 * `shopify--` is a Shopify-controlled reserved prefix that apps may not write,
 * so a merchant's picks here are rendered by this app's theme block rather than
 * by Shopify's own complementary recommendations.
 *
 * Props:
 *   productId  - the product the list belongs to
 *   chips      - [{ id, title, image, imageAlt, missing }] already capped
 *   items      - the full stored list, for preselecting the picker
 *   overflow   - how many items the chips do not show
 *   maxItems   - the metafield's ceiling (12; see MAX_OVERRIDE_ITEMS)
 *   canAdd     - false when the plan's product allowance is used up
 *   busy       - true while this row's save is in flight
 *   onSave     - (productId, items) => void
 *   onError    - (message) => void
 */
export default function ComplementaryCell({
  productId,
  chips = [],
  items = [],
  overflow = 0,
  maxItems = 12,
  canAdd = true,
  busy = false,
  onSave,
  onError,
}) {
  const shopify = useAppBridge();
  const [opening, setOpening] = useState(false);

  const hasList = items.length > 0;
  // Editing an existing list occupies no new slot, so only a first list is gated.
  const blocked = !hasList && !canAdd;

  const openPicker = useCallback(async () => {
    if (blocked) return;
    setOpening(true);

    try {
      const selection = await shopify.resourcePicker({
        type: "product",
        multiple: maxItems,
        // Omitted rather than passed empty: the picker validates every entry and
        // there is nothing to preselect on a first run.
        ...(hasList
          ? {
              selectionIds: items.map((item) => ({
                id: `gid://shopify/Product/${item.id}`,
              })),
            }
          : {}),
      });

      // Dismissed. Not an error, and not an instruction to empty the list.
      if (!selection) return;

      const picked = selection
        .map((node) => String(node.id).split("/").pop())
        // A product is never a complementary product for itself.
        .filter((id) => id !== String(productId));

      if (picked.length === 0) {
        onError?.(
          "That selection was only the product itself, which cannot be its own complementary product.",
        );
        return;
      }

      onSave?.(
        productId,
        selection
          .filter((node) => String(node.id).split("/").pop() !== String(productId))
          .slice(0, maxItems)
          .map((node, index) => ({
            id: String(node.id).split("/").pop(),
            handle: node.handle ?? null,
            title: node.title ?? null,
            position: index,
          })),
      );
    } catch (error) {
      // The picker is admin-hosted, so a failure to open is not something this
      // app can retry — surfacing it beats an unhandled rejection in the console.
      onError?.(error?.message || String(error));
    } finally {
      setOpening(false);
    }
  }, [blocked, shopify, maxItems, hasList, items, productId, onSave, onError]);

  const label = hasList ? "Edit" : "Add products";
  const loading = busy || opening;

  return (
    <s-stack direction="inline" gap="small-300" alignItems="center">
      {chips.map((chip) => (
        <s-thumbnail
          key={chip.id}
          src={chip.image ?? undefined}
          alt={chip.imageAlt || chip.title}
          size="small"
          // A picked product that has since been deleted or unpublished still
          // occupies a slot in the list, so it is shown rather than skipped.
          {...(chip.missing ? { title: `${chip.title} — no longer available` } : {})}
        />
      ))}

      {overflow > 0 && <s-text color="subdued">{`+${overflow}`}</s-text>}

      <s-button
        variant="tertiary"
        onClick={openPicker}
        {...(loading ? { loading: true } : {})}
        {...(blocked ? { disabled: true } : {})}
        accessibilityLabel={
          hasList
            ? `Edit complementary products for this product`
            : `Add complementary products for this product`
        }
      >
        {blocked ? "Limit reached" : label}
      </s-button>
    </s-stack>
  );
}
