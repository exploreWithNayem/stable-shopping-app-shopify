import { useCallback, useEffect, useMemo, useState } from 'react';
import { useFetcher, useLoaderData } from 'react-router';
import { SaveBar, useAppBridge } from '@shopify/app-bridge-react';
import { authenticate } from '../shopify.server';
import { ensureShop } from '../models/shop.server';
import {
  MAX_ITEMS,
  MAX_TARGETS,
  getOffer,
  publishedTargetIds,
  saveOffer,
  validateForPublish,
  validateOffer,
} from '../models/offer.server';
import { newlyOccupiedTargets, publishOffer, unpublishOffer } from '../lib/offers.server';
import { countOverriddenProducts } from '../models/override.server';
import { canAddOverride, overrideLimit } from '../lib/entitlements';
import { isUnlimited } from '../lib/plans';
import { formatNumber } from '../lib/format';
import Card from '../components/Card';
import PlacementThumb from '../components/PlacementThumb';

/**
 * One route, two screens, keyed on `?type=`.
 *
 *   /app/offers/new                              -> choose a placement type
 *   /app/offers/new?type=PRODUCT_PAGE            -> build a new offer
 *   /app/offers/new?type=PRODUCT_PAGE&id=<id>    -> edit that offer
 *
 * The placement is a query parameter rather than a path segment because it is a
 * *choice within* creating an offer, not a different resource: the back arrow and
 * the save belong to the same flow, and a merchant who changes their mind should
 * be able to return to the picker without unwinding a route.
 */

/* ---------------------------------------------------------------- placements */

/*
 * The five cards, their titles, copy and buttons are the merchant-facing design
 * as specified. Only Product page is a surface this app has built — it is the
 * Smart Recommendations / Bought Together theme blocks. Cart page, Pop-up and
 * Post purchase are not built, and this app has no "Essential" tier: its plans
 * are Free / Standard / Enterprise.
 *
 * The four unbuilt ones keep their buttons rather than being hidden or greyed
 * out, so the screen matches the design. What they must not do is navigate: a
 * button that lands on a route whose only job is to say "not implemented" is
 * worse than one that says so where it stands.
 */
const PLACEMENTS = [
  {
    id: 'product_page',
    type: 'PRODUCT_PAGE',
    diagram: 'product_page',
    title: 'Product page',
    description: 'Block on the product page below or above the "Add to Cart" button.',
    button: 'Select this placement type',
    available: true,
    href: '/app/offers/new?type=PRODUCT_PAGE',
  },
  {
    id: 'cart_page',
    type: 'CART_PAGE',
    diagram: 'cart_page',
    title: 'Cart page',
    badge: 'Essential plan',
    description: 'Add an offer block to cart page or cart drawer.',
    button: 'Select this placement type',
    available: false,
    waiting:
      'A cart-specific offer block is not built yet. The Product Showcase block can already go on your cart template if a best-sellers or collection row is enough.',
  },
  {
    id: 'popup',
    type: 'POPUP',
    diagram: 'popup',
    title: 'Pop-up',
    description: 'Show offer pop-up after customer adds product to the cart',
    button: 'Select this placement type',
    available: false,
    waiting:
      'Pop-ups are not built yet. Nothing in the app listens for add-to-cart on the storefront outside its own blocks.',
  },
  {
    id: 'post_purchase',
    type: 'POST_PURCHASE',
    diagram: 'post_purchase',
    title: 'Post purchase page',
    description: 'Add an upsell offer to the post-purchase page after the customer checks out.',
    button: 'Select this placement type',
    available: false,
    waiting:
      'Post-purchase offers are not built yet. They need a post-purchase checkout extension, which is separate from the checkout UI extension in Phase 12.',
  },
  {
    id: 'suggest',
    type: 'SUGGEST',
    diagram: 'suggest',
    title: 'Suggest new placement type',
    description: 'Let us know what other placement type you would like to use.',
    button: 'Suggest a new placement type',
    available: false,
    waiting:
      'There is nowhere for a suggestion to go yet - the app has no support inbox or feedback endpoint wired up.',
  },
];

/** Placement types a merchant may actually open the editor for. */
const BUILDABLE = PLACEMENTS.filter((placement) => placement.available).map(
  (placement) => placement.type,
);

/* -------------------------------------------------------------------- loader */

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  const params = new URL(request.url).searchParams;

  // An unknown or unbuilt type falls back to the picker rather than erroring:
  // the parameter comes from a URL a merchant can edit or bookmark.
  const requested = params.get('type');
  const type = BUILDABLE.includes(requested) ? requested : null;

  const id = params.get('id');
  // Scoped to the shop, so an id from someone else's store resolves to nothing.
  const offer = type && id ? await getOffer(shop.id, id) : null;

  // The allowance is the one thing that can stop this flow before it starts, so
  // it is answered here rather than after a placement has been chosen.
  const used = await countOverriddenProducts(shop.id);
  const limit = overrideLimit(shop.plan);

  return {
    type,
    offer,
    used,
    limit: isUnlimited(limit) ? null : limit,
    canAdd: canAddOverride(shop.plan, used),
    maxItems: MAX_ITEMS,
    maxTargets: MAX_TARGETS,
  };
};

/* -------------------------------------------------------------------- action */

/** Read the offer out of a form body. Products arrive as JSON strings. */
function readOffer(formData) {
  const json = (key) => {
    try {
      return JSON.parse(formData.get(key) ?? '[]');
    } catch {
      return null;
    }
  };

  return {
    id: formData.get('id') || null,
    name: formData.get('name') ?? '',
    placement: formData.get('placement') ?? '',
    offerType: formData.get('offerType') ?? '',
    title: formData.get('title') ?? '',
    badge: formData.get('badge') ?? '',
    buttonText: formData.get('buttonText') ?? '',
    countdown: formData.get('countdown') === 'true',
    anchorSelector: formData.get('anchorSelector') ?? '',
    anchorPosition: formData.get('anchorPosition') ?? 'after',
    targets: json('targets'),
    items: json('items'),
  };
}

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  const formData = await request.formData();
  const intent = String(formData.get('intent') ?? '');

  /* Taking an offer down is never gated: it is how a merchant at their product
     allowance frees slots. */
  if (intent === 'unpublish') {
    const offer = await getOffer(shop.id, formData.get('id'));
    if (!offer) return { ok: false, error: 'That offer no longer exists.' };

    const result = await unpublishOffer({ admin, shopId: shop.id, offer });
    return {
      ok: result.failures.length === 0,
      offer: result.offer,
      unpublished: true,
      removed: result.removed,
      failures: result.failures,
    };
  }

  if (intent !== 'save' && intent !== 'publish') {
    return { ok: false, error: 'Unknown action.' };
  }

  const input = readOffer(formData);

  if (input.targets === null || input.items === null) {
    return { ok: false, error: 'Could not read the selected products.' };
  }

  /*
   * Draft and publish are validated differently on purpose. A merchant who has
   * picked products but not written a title should be able to save and come back,
   * so only publishing demands a complete offer.
   */
  const errors = intent === 'publish' ? validateForPublish(input) : validateOffer(input);
  if (errors.length > 0) return { ok: false, errors };

  const saved = await saveOffer(shop.id, input);
  if (!saved) return { ok: false, error: 'That offer no longer exists.' };

  if (intent === 'save') return { ok: true, offer: saved, saved: true };

  /*
   * Enforced here as well as in the UI. Only targets nobody has published yet
   * count: re-publishing, or adding a product another offer already covers,
   * occupies no new slot.
   */
  const occupied = await publishedTargetIds(shop.id, { excludeOfferId: saved.id });
  const newTargets = newlyOccupiedTargets(saved, occupied);
  const alreadyUsed = await countOverriddenProducts(shop.id);
  const limit = overrideLimit(shop.plan);

  if (!isUnlimited(limit) && newTargets.length > 0 && alreadyUsed + newTargets.length > limit) {
    return {
      ok: false,
      offer: saved,
      limitReached: true,
      error: `Publishing this offer needs ${formatNumber(newTargets.length)} more product${
        newTargets.length === 1 ? '' : 's'
      }, and your plan covers ${formatNumber(limit)} in total with ${formatNumber(
        alreadyUsed,
      )} in use. Remove some, or upgrade for unlimited.`,
    };
  }

  const result = await publishOffer({ admin, shopId: shop.id, offer: saved });

  return {
    ok: result.failures.length === 0,
    offer: result.offer,
    published: true,
    synced: result.synced,
    total: result.total,
    failures: result.failures,
  };
};

/* ------------------------------------------------------------------ elements */

/** The page title row: back arrow, heading, and anything trailing it. */
function PageHeading({ back, children, trailing = null }) {
  return (
    <s-stack
      direction="inline"
      gap="small-300"
      alignItems="center"
      justifyContent="space-between"
      paddingBlockEnd="base"
    >
      <s-stack direction="inline" gap="small-300" alignItems="center">
        <s-button variant="tertiary" icon="arrow-left" href={back} accessibilityLabel="Go back" />
        {/*
          A plain <h1>, not `s-heading`.

          `s-heading` exposes no size prop - Polaris derives heading size from
          section nesting, and this one sits at page level with nothing to nest
          under. Setting `style={{ fontSize }}` on it does nothing either: the
          element sets its own font-size inside its shadow DOM, so a host-level
          value never reaches the text.

          1.25rem is the admin's own page-title scale. `margin: 0` removes the
          browser's default h1 margin, which would otherwise push the content
          down.
        */}
        <h1 style={{ fontSize: '1.25rem', lineHeight: 1.3, fontWeight: 650, margin: 0 }}>
          {children}
        </h1>
      </s-stack>
      {trailing}
    </s-stack>
  );
}

/**
 * A product list the merchant edits with the App Bridge picker.
 *
 * The picker is admin-hosted, so when it fails to open there is nothing this app
 * can do about it — the failure is surfaced rather than left as an unhandled
 * rejection in the console.
 */
function ProductList({ label, help, products, max, onChange, exclude = [] }) {
  const shopify = useAppBridge();
  const [error, setError] = useState(null);

  const open = useCallback(async () => {
    setError(null);
    try {
      const selection = await shopify.resourcePicker({
        type: 'product',
        multiple: max,
        // Omitted rather than passed empty: the picker validates every entry and
        // there is nothing to preselect on a first run.
        ...(products.length > 0
          ? {
              selectionIds: products.map((product) => ({
                id: `gid://shopify/Product/${product.id}`,
              })),
            }
          : {}),
      });

      if (!selection) return;

      const excluded = new Set(exclude.map(String));
      const picked = selection
        .map((node) => ({
          id: String(node.id).split('/').pop(),
          handle: node.handle ?? null,
          title: node.title ?? null,
        }))
        // A product is never a recommendation for itself.
        .filter((product) => !excluded.has(product.id));

      onChange(picked.slice(0, max));
    } catch (failure) {
      setError(failure?.message || String(failure));
    }
  }, [shopify, products, max, onChange, exclude]);

  return (
    <s-stack direction="block" gap="small-300">
      <s-text type="strong">{label}</s-text>
      {help && <s-text color="subdued">{help}</s-text>}

      {products.length === 0 ? (
        <s-text color="subdued">Nothing chosen yet.</s-text>
      ) : (
        <s-stack direction="block" gap="small-500">
          {products.map((product) => (
            <s-stack
              key={product.id}
              direction="inline"
              gap="small-300"
              alignItems="center"
              justifyContent="space-between"
            >
              <s-stack direction="inline" gap="small-300" alignItems="center">
                <s-thumbnail size="small" alt="" />
                <s-text>{product.title || `Product ${product.id}`}</s-text>
              </s-stack>
              <s-button
                variant="tertiary"
                tone="critical"
                onClick={() => onChange(products.filter((entry) => entry.id !== product.id))}
              >
                Remove
              </s-button>
            </s-stack>
          ))}
        </s-stack>
      )}

      {error && <s-text tone="critical">{error}</s-text>}

      <s-button variant="secondary" onClick={open}>
        {products.length > 0 ? 'Edit products' : 'Choose products'}
      </s-button>
    </s-stack>
  );
}

/* ------------------------------------------------------------ offer editor */

const OFFER_TYPES = [
  { value: 'cross_sell', label: 'Cross-sell' },
  { value: 'volume_discount', label: 'Volume discount' },
  { value: 'frequently_bought_together', label: 'Frequently bought together' },
  { value: 'product_add_on', label: 'Product add-on' },
];

const TABS = [
  { id: 'content', label: 'Content' },
  { id: 'offer', label: 'Offer' },
  { id: 'design', label: 'Design' },
  { id: 'placement', label: 'Placement' },
];

/** The editable fields of an offer, defaulted for a brand new one. */
function formValues(offer) {
  return {
    offerType: offer?.offerType ?? 'cross_sell',
    name: offer?.name ?? 'Product page offer',
    title: offer?.title ?? 'You may also like',
    badge: offer?.badge ?? '',
    buttonText: offer?.buttonText ?? 'Add',
    countdown: Boolean(offer?.countdown),
    anchorSelector: offer?.anchorSelector ?? '',
    anchorPosition: offer?.anchorPosition ?? 'after',
    targets: offer?.targets ?? [],
    items: offer?.items ?? [],
  };
}

/**
 * Whether two form states differ.
 *
 * Product lists compare by id in order, not by deep equality: the stored rows
 * carry a `position` and a `title` that the picker does not always return, so a
 * structural compare reported changes the merchant had not made — and a save bar
 * that will not go away is worse than none.
 */
function sameForm(a, b) {
  const ids = (list) => list.map((entry) => String(entry.id)).join(',');

  return (
    a.offerType === b.offerType &&
    a.name === b.name &&
    a.title === b.title &&
    a.badge === b.badge &&
    a.buttonText === b.buttonText &&
    a.countdown === b.countdown &&
    a.anchorSelector === b.anchorSelector &&
    a.anchorPosition === b.anchorPosition &&
    ids(a.targets) === ids(b.targets) &&
    ids(a.items) === ids(b.items)
  );
}

function OfferEditor({ type, offer, maxItems, maxTargets }) {
  const fetcher = useFetcher();
  const [tab, setTab] = useState('content');

  const initial = useMemo(() => formValues(offer), [offer]);

  // Seeded from the loaded offer so ?id= opens an editable copy of it.
  const [id, setId] = useState(offer?.id ?? null);
  const [offerType, setOfferType] = useState(initial.offerType);
  const [name, setName] = useState(initial.name);
  const [title, setTitle] = useState(initial.title);
  const [badge, setBadge] = useState(initial.badge);
  const [buttonText, setButtonText] = useState(initial.buttonText);
  const [countdown, setCountdown] = useState(initial.countdown);
  const [anchorSelector, setAnchorSelector] = useState(initial.anchorSelector);
  const [anchorPosition, setAnchorPosition] = useState(initial.anchorPosition);
  const [targets, setTargets] = useState(initial.targets);
  const [items, setItems] = useState(initial.items);
  const [status, setStatus] = useState(offer?.status ?? 'draft');

  /*
   * What "saved" currently means. Compared against the live form to decide
   * whether the admin's contextual save bar is showing, and reset from whatever
   * the action returns — the persisted row is the authority on that, not the
   * values we happened to send.
   */
  const [baseline, setBaseline] = useState(initial);

  const current = {
    offerType,
    name,
    title,
    badge,
    buttonText,
    countdown,
    anchorSelector,
    anchorPosition,
    targets,
    items,
  };
  const dirty = !sameForm(current, baseline);

  const restore = (values) => {
    setOfferType(values.offerType);
    setName(values.name);
    setTitle(values.title);
    setBadge(values.badge);
    setButtonText(values.buttonText);
    setCountdown(values.countdown);
    setAnchorSelector(values.anchorSelector);
    setAnchorPosition(values.anchorPosition);
    setTargets(values.targets);
    setItems(values.items);
  };

  const result = fetcher.data;
  const busy = fetcher.state !== 'idle';

  /*
   * A first save creates the row, so the id only exists afterwards. Holding it
   * in state means the next save updates that row instead of creating a second
   * one — without this, every press of Save left another draft behind.
   */
  useEffect(() => {
    if (!result?.offer) return;
    setId(result.offer.id);
    setStatus(result.offer.status);
    // Clears the save bar: the form now matches what is stored.
    setBaseline(formValues(result.offer));
  }, [result]);

  const submit = (intent) => {
    fetcher.submit(
      {
        intent,
        ...(id ? { id } : {}),
        placement: type,
        offerType,
        name,
        title,
        badge,
        buttonText,
        countdown: String(countdown),
        anchorSelector,
        anchorPosition,
        targets: JSON.stringify(targets),
        items: JSON.stringify(items),
      },
      { method: 'POST' },
    );
  };

  const placement = PLACEMENTS.find((entry) => entry.type === type);
  const published = status === 'published';

  return (
    <s-page heading="New offer">
      {/*
        The admin's contextual save bar. It renders in Shopify's own top bar, not
        in the page, which is why unsaved changes belong here rather than in a
        banner of our own — a merchant already knows to look there.

        Plain <button> elements on purpose: this is an App Bridge element, not a
        Polaris one, and it looks for `variant="primary"` to decide which button
        is the confirming one.

        Discard restores the baseline rather than reloading the route: a reload
        would also throw away the tab the merchant is on and any result banner.
      */}
      <SaveBar id="offer-save-bar" open={dirty}>
        <button variant="primary" onClick={() => submit('save')} disabled={busy}>
          Save
        </button>
        <button onClick={() => restore(baseline)} disabled={busy}>
          Discard
        </button>
      </SaveBar>

      <PageHeading
        back="/app/offers/new"
        trailing={
          <s-stack direction="inline" gap="small-300" alignItems="center">
            <s-button
              variant="secondary"
              onClick={() => submit('save')}
              {...(busy ? { loading: true } : {})}
            >
              Save draft
            </s-button>
            <s-button
              variant="primary"
              onClick={() => submit(published ? 'unpublish' : 'publish')}
              {...(busy ? { loading: true } : {})}
            >
              {published ? 'Unpublish' : 'Publish'}
            </s-button>
          </s-stack>
        }
      >
        <s-stack direction="inline" gap="small-300" alignItems="center">
          <span>{id ? name || 'Offer' : 'New offer'}</span>
          <s-badge tone={published ? 'success' : 'neutral'}>
            {published ? 'Published' : 'Not published'}
          </s-badge>
        </s-stack>
      </PageHeading>

      {result?.errors?.length > 0 && (
        <s-banner tone="critical" heading="Fix these before publishing">
          <s-unordered-list>
            {result.errors.map((message) => (
              <s-list-item key={message}>{message}</s-list-item>
            ))}
          </s-unordered-list>
        </s-banner>
      )}

      {result?.error && (
        <s-banner tone="critical" heading="That did not work">
          <s-paragraph>{result.error}</s-paragraph>
          {result.limitReached && (
            <s-button variant="primary" href="/app/pricing">
              See plans
            </s-button>
          )}
        </s-banner>
      )}

      {result?.saved && (
        <s-banner tone="success" heading="Draft saved" dismissible>
          <s-paragraph>
            Nothing is live yet — publish when you are ready for shoppers to see it.
          </s-paragraph>
        </s-banner>
      )}

      {result?.published && (
        <s-banner
          tone={result.failures?.length > 0 ? 'warning' : 'success'}
          heading={
            result.failures?.length > 0
              ? 'Published, but some products did not go live'
              : 'Offer published'
          }
          dismissible
        >
          <s-paragraph>
            {formatNumber(result.synced)} of {formatNumber(result.total)} product page
            {result.total === 1 ? '' : 's'} now show this offer.
            {result.failures?.length > 0 ? ' Re-sync from Settings to try the rest again.' : ''}
          </s-paragraph>
          {result.failures?.length > 0 && (
            <s-button variant="secondary" href="/app/settings">
              Re-sync
            </s-button>
          )}
        </s-banner>
      )}

      {result?.unpublished && (
        <s-banner tone="info" heading="Offer taken down" dismissible>
          <s-paragraph>
            Removed from {formatNumber(result.removed)} product page
            {result.removed === 1 ? '' : 's'}. Those pages fall back to Shopify&rsquo;s own
            recommendations.
          </s-paragraph>
        </s-banner>
      )}

      {/* Tabs. Polaris ships no tab component, so this is a button row: the
          active one is filled, the rest are quiet. */}
      <s-stack direction="inline" gap="small-300" paddingBlockEnd="base">
        {TABS.map((entry) => (
          <s-button
            key={entry.id}
            variant={tab === entry.id ? 'secondary' : 'tertiary'}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
          </s-button>
        ))}
      </s-stack>

      <s-query-container>
        <s-grid
          gap="base"
          alignItems="start"
          gridTemplateColumns="@container (inline-size > 720px) 2fr 3fr, 1fr"
        >
          {/* ------------------------------------------------------- form */}
          <Card>
            {tab === 'content' && (
              <s-stack direction="block" gap="base">
                <s-choice-list
                  label="Offer type"
                  name="offerType"
                  values={[offerType]}
                  onChange={(event) => setOfferType(event.currentTarget.values?.[0] ?? offerType)}
                >
                  {OFFER_TYPES.map((entry) => (
                    <s-choice key={entry.value} value={entry.value}>
                      {entry.label}
                    </s-choice>
                  ))}
                </s-choice-list>

                <s-text-field
                  label="Offer name"
                  labelAccessibilityVisibility="exclusive"
                  name="name"
                  value={name}
                  details="Only visible to you. For your own internal reference."
                  onInput={(event) => setName(event.currentTarget.value)}
                />

                <s-divider />
                <s-heading>Content</s-heading>

                <s-text-field
                  label="Title"
                  name="title"
                  value={title}
                  onInput={(event) => setTitle(event.currentTarget.value)}
                />
                <s-text-field
                  label="Badge"
                  name="badge"
                  value={badge}
                  placeholder="e.g. Limited offer"
                  onInput={(event) => setBadge(event.currentTarget.value)}
                />
                <s-text-field
                  label="Button text"
                  name="buttonText"
                  value={buttonText}
                  onInput={(event) => setButtonText(event.currentTarget.value)}
                />

                <s-divider />
                <s-checkbox
                  name="countdown"
                  label="Countdown timer"
                  {...(countdown ? { checked: true } : {})}
                  onChange={(event) => setCountdown(Boolean(event.currentTarget.checked))}
                />

                <s-divider />
                <s-button variant="secondary" onClick={() => setTab('offer')}>
                  Continue to offer
                </s-button>
              </s-stack>
            )}

            {tab === 'offer' && (
              <s-stack direction="block" gap="base">
                <ProductList
                  label="Show this offer on"
                  help={`The product pages the block appears on. Up to ${maxTargets}.`}
                  products={targets}
                  max={maxTargets}
                  onChange={setTargets}
                />

                <s-divider />

                <ProductList
                  label="Recommend these products"
                  help={`What shoppers are offered. Up to ${maxItems}, the limit Liquid can resolve on one page.`}
                  products={items}
                  max={maxItems}
                  onChange={setItems}
                  exclude={targets.map((target) => target.id)}
                />

                <s-divider />
                <s-button variant="secondary" onClick={() => setTab('design')}>
                  Continue to design
                </s-button>
              </s-stack>
            )}

            {tab === 'design' && (
              <s-stack direction="block" gap="base">
                <s-heading>Design</s-heading>
                <s-paragraph>
                  Your Title, Badge and Button text above are published with the offer and override
                  the block&rsquo;s own wording on the product page.
                </s-paragraph>
                <s-paragraph color="subdued">
                  Layout, columns, image shape, colours and button style are still theme block
                  settings — they live in your theme editor so they can follow your theme&rsquo;s
                  styling. Open the block on a product template to change them.
                </s-paragraph>
                <s-button variant="secondary" onClick={() => setTab('placement')}>
                  Continue to placement
                </s-button>
              </s-stack>
            )}

            {tab === 'placement' && (
              <s-stack direction="block" gap="base">
                <s-heading>Placement</s-heading>
                <s-stack direction="inline" gap="small-300" alignItems="center">
                  <s-text type="strong">{placement?.title}</s-text>
                  <s-badge tone="info">{type}</s-badge>
                </s-stack>
                <s-paragraph color="subdued">
                  With the app embed enabled, published offers appear on their product pages on
                  their own — no theme block needed. If you have placed the Smart Recommendations
                  block on a product template, that block wins and these settings are ignored.
                </s-paragraph>

                <s-divider />

                <s-heading>Where it appears</s-heading>
                <s-paragraph color="subdued">
                  Leave this empty and the offer goes just below the Add to cart button. It fits
                  most themes; set your own CSS selector if yours is unusual.
                </s-paragraph>

                <s-text-field
                  label="CSS selector"
                  name="anchorSelector"
                  value={anchorSelector}
                  placeholder=".product-form__buttons"
                  details="If this matches nothing, the built-in positions are tried instead — the offer still shows."
                  onInput={(event) => setAnchorSelector(event.currentTarget.value)}
                />

                <s-select
                  label="Position"
                  name="anchorPosition"
                  value={anchorPosition}
                  onChange={(event) => setAnchorPosition(event.currentTarget.value)}
                >
                  <s-option value="after">Below it</s-option>
                  <s-option value="before">Above it</s-option>
                </s-select>

                <s-divider />
                <s-button variant="secondary" onClick={() => setTab('content')}>
                  Back to content
                </s-button>
              </s-stack>
            )}
          </Card>

          {/* ---------------------------------------------------- preview */}
          <s-stack direction="block" gap="base">
            <s-stack
              direction="inline"
              gap="small-300"
              alignItems="center"
              justifyContent="space-between"
            >
              <s-stack direction="inline" gap="small-300" alignItems="center">
                <s-heading>{title || 'Untitled offer'}</s-heading>
                {badge && <s-badge tone="info">{badge}</s-badge>}
              </s-stack>
              {/* Decorative: the storefront block's slider arrows. */}
              <s-stack direction="inline" gap="small-300" alignItems="center">
                <s-button
                  variant="tertiary"
                  icon="chevron-left"
                  accessibilityLabel="Previous"
                  disabled
                />
                <s-button
                  variant="tertiary"
                  icon="chevron-right"
                  accessibilityLabel="Next"
                  disabled
                />
              </s-stack>
            </s-stack>

            {(items.length > 0 ? items : [{ id: 'preview', title: 'Recommended product #1' }]).map(
              (product) => (
                <Card key={product.id}>
                  <s-stack
                    direction="inline"
                    gap="base"
                    alignItems="center"
                    justifyContent="space-between"
                  >
                    <s-stack direction="inline" gap="base" alignItems="center">
                      <s-thumbnail size="large" alt="" />
                      <s-stack direction="block" gap="small-500">
                        <s-text type="strong">{product.title || `Product ${product.id}`}</s-text>
                        <s-text color="subdued">White color</s-text>
                        <s-text>$30.00</s-text>
                      </s-stack>
                    </s-stack>
                    <s-button variant="primary">{buttonText || 'Add'}</s-button>
                  </s-stack>
                </Card>
              ),
            )}

            {countdown && (
              <Card>
                <s-text color="subdued">Countdown timer shows here on the storefront.</s-text>
              </Card>
            )}

            <s-paragraph color="subdued">
              Preview of the {placement?.title.toLowerCase()} block. It follows the fields on the
              left, not your theme&rsquo;s styling.
            </s-paragraph>
          </s-stack>
        </s-grid>
      </s-query-container>
    </s-page>
  );
}

/* --------------------------------------------------------- placement picker */

function PlacementPicker({ used, limit, canAdd }) {
  const [pending, setPending] = useState(null);

  return (
    <s-page heading="Choose Offer Placement">
      <PageHeading back="/app">Choose Offer Placement</PageHeading>

      {limit !== null && !canAdd && (
        <s-banner
          tone="warning"
          heading={`You have used all ${formatNumber(limit)} products your plan covers`}
        >
          <s-paragraph>
            You can still edit the offers you already have. To add another product, take one down or
            upgrade for unlimited. {formatNumber(used)} in use.
          </s-paragraph>
          <s-button href="/app/pricing" variant="primary">
            See plans
          </s-button>
        </s-banner>
      )}

      {pending && (
        <s-banner tone="info" heading={`${pending.title} is not available yet`} dismissible>
          <s-paragraph>{pending.waiting}</s-paragraph>
          <s-button variant="secondary" href="/app/offers/new?type=PRODUCT_PAGE">
            Use the product page instead
          </s-button>
        </s-banner>
      )}

      {/*
        No `s-section` around the grid. A section draws its own white rounded
        surface, which put a second card behind the cards - the grid reads as a
        set of tiles on the page background, and each tile already has its own
        border and background from `Card`.
      */}
      <s-query-container>
        <s-grid
          gap="base"
          alignItems="start"
          /* One container query plus a fallback - the same shape as the pricing
             page's three-card grid. A value carrying two @container clauses is
             not parsed and silently collapses to the `1fr` fallback, which is
             why this once rendered as a single column. */
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
    </s-page>
  );
}

export default function NewOffer() {
  const { type, offer, used, limit, canAdd, maxItems, maxTargets } = useLoaderData();

  return type ? (
    <OfferEditor type={type} offer={offer} maxItems={maxItems} maxTargets={maxTargets} />
  ) : (
    <PlacementPicker used={used} limit={limit} canAdd={canAdd} />
  );
}
