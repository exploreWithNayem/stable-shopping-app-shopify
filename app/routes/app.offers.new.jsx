import { useState } from 'react';
import { useLoaderData } from 'react-router';
import { authenticate } from '../shopify.server';
import { ensureShop } from '../models/shop.server';
import { countOverriddenProducts } from '../models/override.server';
import { canAddOverride, overrideLimit } from '../lib/entitlements';
import { isUnlimited } from '../lib/plans';
import { formatNumber } from '../lib/format';
import Card from '../components/Card';
import PlacementThumb from '../components/PlacementThumb';

/**
 * "Choose placement type" — the step between Create offer and picking products.
 *
 * The six cards, their titles, copy and buttons are the merchant-facing design
 * as specified. Only the first is a surface this app has built: Product page is
 * the Smart Recommendations / Bought Together theme blocks. Cart page, Pop-up,
 * Post purchase and Checkout nudge are not built (Phase 12 onward), and this app
 * has no "Essential" tier — its plans are Free / Standard / Enterprise.
 *
 * Those five keep their buttons rather than being hidden or greyed out, so the
 * screen matches the design. What they must not do is navigate: a button that
 * lands on a route whose only job is to say "not implemented" is worse than one
 * that says so where it stands. Pressing one names the placement and what it is
 * waiting on, in a notice above the grid.
 *
 * When a placement does ship, move it to `available: true` with an `action`, and
 * `app/routes.test.js` will start checking its href resolves.
 */

const PLACEMENTS = [
  {
    id: 'product_page',
    diagram: 'product_page',
    title: 'Product page',
    description: 'Block on the product page below or above the "Add to Cart" button.',
    button: 'Select this placement type',
    available: true,
    href: '/app/recommendations',
  },
  {
    id: 'cart_page',
    diagram: 'cart_page',
    title: 'Cart page',
    badge: 'Essential plan',
    description: 'Add an offer block to cart page or cart drawer.',
    button: 'Select this placement type',
    available: false,
    // Product Showcase already goes on any template, the cart included — but it
    // is a merchandising row, not a per-product offer block, so it is not this.
    waiting: 'A cart-specific offer block is not built yet. The Product Showcase block can already go on your cart template if a best-sellers or collection row is enough.',
  },
  {
    id: 'popup',
    diagram: 'popup',
    title: 'Pop-up',
    description: 'Show offer pop-up after customer adds product to the cart',
    button: 'Select this placement type',
    available: false,
    waiting: 'Pop-ups are not built yet. Nothing in the app listens for add-to-cart on the storefront outside its own blocks.',
  },
  {
    id: 'post_purchase',
    diagram: 'post_purchase',
    title: 'Post purchase page',
    description: 'Add an upsell offer to the post-purchase page after the customer checks out.',
    button: 'Select this placement type',
    available: false,
    waiting: 'Post-purchase offers are not built yet. They need a post-purchase checkout extension, which is separate from the checkout UI extension in Phase 12.',
  },
  {
    id: 'suggest',
    diagram: 'suggest',
    title: 'Suggest new placement type',
    description: 'Let us know what other placement type you would like to use.',
    button: 'Suggest a new placement type',
    available: false,
    waiting: 'There is nowhere for a suggestion to go yet — the app has no support inbox or feedback endpoint wired up.',
  },
  {
    id: 'checkout_nudge',
    diagram: 'checkout_nudge',
    title: 'Checkout nudge',
    description: 'Remind customers to pick bundle or the add-on they skipped before they pay.',
    button: 'Get on Shopify App Store',
    available: false,
    overflow: true,
    waiting: 'Checkout surfaces are Phase 12, and this app has no App Store listing to link to yet.',
  },
];

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  // The allowance is the one thing that can stop this flow before it starts, so
  // it is answered here rather than after a placement has been chosen.
  const used = await countOverriddenProducts(shop.id);
  const limit = overrideLimit(shop.plan);

  return {
    used,
    limit: isUnlimited(limit) ? null : limit,
    canAdd: canAddOverride(shop.plan, used),
  };
};

export default function ChoosePlacement() {
  const { used, limit, canAdd } = useLoaderData();
  const [pending, setPending] = useState(null);

  return (
    <s-page heading="Choose Offer Placement">
      {/*
        The heading is repeated here, in the content column, rather than left to
        `s-page heading` alone — that one is hoisted into the Shopify admin's own
        header strip (the same place `primary-action` goes), which left this space
        above the cards empty. The back arrow belongs with it: it is the way out
        of a flow that has no other exit.
      */}
      <s-stack
        direction="inline"
        gap="small-300"
        alignItems="center"
        paddingBlockEnd="base"
      >
        <s-button
          variant="tertiary"
          icon="arrow-left"
          href="/app"
          accessibilityLabel="Back to home"
        />
        {/*
          A plain <h1>, not `s-heading`.

          `s-heading` exposes no size prop — Polaris derives heading size from
          section nesting, and this one sits at page level with nothing to nest
          under. Setting `style={{ fontSize }}` on it does nothing either: the
          element sets its own font-size inside its shadow DOM, so a host-level
          value never reaches the text. It rendered at card-title size whatever
          was passed.

          So the size is applied to an element that will actually take it.
          1.25rem is the admin's own page-title scale — a step up from the card
          headings without shouting over the grid. The font family and colour
          still come from the admin, and `margin: 0` removes the browser's
          default h1 margin, which would otherwise push the card grid down.
        */}
        <h1
          style={{
            fontSize: '1.25rem',
            lineHeight: 1.3,
            fontWeight: 650,
            margin: 0,
          }}
        >
          Choose Offer Placement
        </h1>
      </s-stack>

      {limit !== null && !canAdd && (
        <s-banner
          tone="warning"
          heading={`You have used all ${formatNumber(limit)} products your plan covers`}
        >
          <s-paragraph>
            You can still edit the offers you already have. To add another product, reset one to
            Shopify&rsquo;s defaults or upgrade for unlimited. {formatNumber(used)} in use.
          </s-paragraph>
          <s-button href="/app/pricing" variant="primary">
            See plans
          </s-button>
        </s-banner>
      )}

      {pending && (
        <s-banner tone="info" heading={`${pending.title} is not available yet`} dismissible>
          <s-paragraph>{pending.waiting}</s-paragraph>
          <s-button variant="secondary" href="/app/recommendations">
            Use the product page instead
          </s-button>
        </s-banner>
      )}

      <s-section>
        <s-query-container>
          <s-grid
            gap="base"
            alignItems="start"
            /* One container query plus a fallback — the same shape as the
               pricing page's three-card grid. A value carrying two @container
               clauses is not parsed and silently collapses to the `1fr`
               fallback, which is why this was rendering as a single column. */
            gridTemplateColumns="@container (inline-size > 720px) 1fr 1fr 1fr, 1fr"
          >
            {PLACEMENTS.map((placement) => (
              <Card key={placement.id}>
                <s-stack direction="block" gap="base">
                  <PlacementThumb diagram={placement.diagram} />

                  <s-stack direction="inline" gap="small-300" alignItems="center">
                    <s-heading>{placement.title}</s-heading>
                    {placement.badge && <s-badge tone="info">{placement.badge}</s-badge>}
                  </s-stack>

                  <s-paragraph color="subdued">{placement.description}</s-paragraph>

                  {placement.available ? (
                    <s-button variant="secondary" href={placement.href}>
                      {placement.button}
                    </s-button>
                  ) : placement.overflow ? (
                    /* The one card in the design with an overflow control beside
                       its button. It has no menu items to show in this app, so it
                       reports the same notice rather than opening an empty menu. */
                    <s-stack direction="inline" gap="small-300" alignItems="center">
                      <s-button variant="secondary" onClick={() => setPending(placement)}>
                        {placement.button}
                      </s-button>
                      <s-button
                        variant="secondary"
                        icon="menu-horizontal"
                        accessibilityLabel={`More options for ${placement.title}`}
                        onClick={() => setPending(placement)}
                      />
                    </s-stack>
                  ) : (
                    <s-button variant="secondary" onClick={() => setPending(placement)}>
                      {placement.button}
                    </s-button>
                  )}
                </s-stack>
              </Card>
            ))}
          </s-grid>
        </s-query-container>
      </s-section>
    </s-page>
  );
}
