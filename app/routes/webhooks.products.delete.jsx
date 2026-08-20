import { authenticate } from "../shopify.server";
import { getShopByDomain } from "../models/shop.server";
import { deleteOverridesForProduct } from "../models/override.server";

/**
 * A product was deleted, so any override *for* it is now unreachable.
 *
 * Two different orphans are possible and only one is handled here:
 *
 *   - An override whose source product is gone. That is this handler. The rows
 *     are deleted, which also frees a slot against the plan's product
 *     allowance — otherwise a merchant on Free could be permanently held at ten
 *     by products that no longer exist.
 *   - A deleted product appearing *inside* someone else's override list. That
 *     one needs no webhook: `all_products[handle]` resolves to nil in Liquid and
 *     `nodes(ids:)` drops it server-side, so it simply stops rendering.
 *
 * The metafield is not cleaned up because it went with the product.
 */
export const action = async ({ request }) => {
  const { shop, payload, topic } = await authenticate.webhook(request);

  const productId = payload?.id;
  if (!productId) return new Response();

  const shopRecord = await getShopByDomain(shop);
  if (!shopRecord) return new Response();

  const { count } = await deleteOverridesForProduct(shopRecord.id, productId);

  if (count > 0) {
    console.log(
      `[easy-reco] ${topic} for ${shop}: removed ${count} override row(s) for product ${productId}`,
    );
  }

  return new Response();
};
