import { useCallback, useEffect, useMemo, useState } from 'react';
import { useFetcher, useLoaderData, useNavigate } from 'react-router';
import { SaveBar, useAppBridge } from '@shopify/app-bridge-react';
import { authenticate } from '../shopify.server';
import { ensureShop } from '../models/shop.server';
import {
  MAX_ITEMS,
  MAX_TARGETS,
  deleteOffer,
  duplicateOffer,
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
import { getProductsByIds } from '../lib/products.server';
import { formatMoney, formatNumber } from '../lib/format';
import { OFFER_TYPE_KEYS, OFFER_TYPE_LABELS } from '../lib/offer-labels';
/*
 * From the client-safe lib, never from `offer.server`. These are rendered in the
 * component below, and a route component that imports a `.server` module drags it
 * into the client bundle — which fails `npm run build` and nothing else.
 */
import {
  COUNTDOWN_TOKEN,
  DEFAULT_COUNTDOWN_MINUTES,
  DEFAULT_COUNTDOWN_TITLE,
  DEFAULT_END_TIME,
  HOUR_OPTIONS,
  MAX_COUNTDOWN_MINUTES,
  MERIDIEMS,
  MINUTE_OPTIONS,
  MIN_COUNTDOWN_MINUTES,
  formatClockTime,
  formatDayLabel,
  formatDuration,
  pad2,
  readTime,
  splitCountdownTitle,
  writeTime,
} from '../lib/countdown';
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

/**
 * Fill in what the stored lists do not carry.
 *
 * An offer stores `{ id, handle, title, position }` per product — enough to
 * publish, since the storefront resolves everything else from the product itself.
 * The preview and the product rows want the image and the price too, so those are
 * fetched once per load rather than stored: a product's image or price changing
 * must not need every offer that mentions it to be re-saved.
 *
 * One `nodes(ids:)` call covers both lists. A product that has since been deleted
 * simply comes back without details and keeps its stored title.
 */
async function hydrateProducts(admin, offer) {
  if (!offer) return null;

  const lists = [offer.targets ?? [], offer.items ?? []];
  const ids = [...new Set(lists.flat().map((entry) => String(entry.id)))];
  if (ids.length === 0) return offer;

  let details = new Map();
  try {
    const products = await getProductsByIds(admin, ids);
    details = new Map(products.map((product) => [product.id, product]));
  } catch {
    // The editor is still usable without images — a failed hydrate must not
    // turn "open my offer" into an error page.
    return offer;
  }

  const merge = (list) =>
    list.map((entry) => {
      const product = details.get(String(entry.id));
      if (!product) return entry;

      return {
        ...entry,
        title: entry.title || product.title,
        handle: entry.handle || product.handle,
        image: product.image,
        imageAlt: product.imageAlt,
        price: product.price,
        currencyCode: product.currencyCode,
      };
    });

  return { ...offer, targets: merge(offer.targets ?? []), items: merge(offer.items ?? []) };
}

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
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
    offer: await hydrateProducts(admin, offer),
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
    countdownMode: formData.get('countdownMode') ?? 'fixed',
    countdownMinutes: formData.get('countdownMinutes') ?? DEFAULT_COUNTDOWN_MINUTES,
    /*
     * A local "YYYY-MM-DDTHH:mm" from the two controls, which `new Date()` reads
     * in the browser's own zone — the merchant's, which is the one they meant.
     */
    countdownEndsAt: formData.get('countdownEndsAt') || null,
    countdownTitle: formData.get('countdownTitle') ?? '',
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

  /*
   * Duplicating never touches the storefront: the copy is a draft (see
   * duplicateOffer), so this needs no admin client and no allowance check —
   * a draft occupies no product slot until it is published.
   */
  if (intent === 'duplicate') {
    const copy = await duplicateOffer(shop.id, formData.get('id'));
    if (!copy) return { ok: false, error: 'That offer no longer exists.' };

    /*
     * The URL has to change, not just the state: `?id=` is what the editor opens
     * from, and leaving it pointed at the original while the form holds the copy
     * would make the back button and a refresh disagree with the screen.
     */
    return {
      ok: true,
      duplicated: true,
      redirectTo: `/app/offers/new?type=${copy.placement}&id=${copy.id}`,
    };
  }

  /*
   * Delete takes the offer off the storefront first.
   *
   * Deleting the row alone would leave the Override rows and their metafields
   * behind, and the theme block reads the metafield (§3.1) — so the products
   * would keep showing an offer that no longer exists anywhere in the admin, with
   * nothing left to unpublish it with.
   */
  if (intent === 'delete') {
    const offer = await getOffer(shop.id, formData.get('id'));
    if (!offer) return { ok: false, error: 'That offer no longer exists.' };

    const takedown =
      offer.status === 'published'
        ? await unpublishOffer({ admin, shopId: shop.id, offer })
        : { failures: [] };

    /*
     * A metafield that would not delete is reported, but the offer still goes:
     * refusing to delete would leave the merchant with a row they cannot remove,
     * and the Settings re-sync is what repairs a stuck metafield.
     */
    await deleteOffer(shop.id, offer.id);

    const failures = takedown.failures;

    return {
      ok: failures.length === 0,
      deleted: true,
      failures,
      /*
       * Only a clean takedown leaves the page. With failures there is something
       * the merchant has to be told — a product whose metafield is still live —
       * and a redirect would take the banner saying so with it.
       */
      redirectTo: failures.length === 0 ? '/app' : null,
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
   * Whether this save changes something shoppers can already see.
   *
   * Read *before* the write, because it decides both how the input is validated
   * and whether the storefront has to be rewritten — and it needs the row's old
   * target list to clean up products the offer no longer covers.
   */
  const before = input.id ? await getOffer(shop.id, input.id) : null;
  const live = before?.status === 'published';

  /*
   * Draft and publish are validated differently on purpose. A merchant who has
   * picked products but not written a title should be able to save and come back,
   * so only publishing demands a complete offer — and so does saving an offer that
   * is already live, because that save goes straight to the storefront.
   */
  const errors =
    intent === 'publish' || live ? validateForPublish(input) : validateOffer(input);
  if (errors.length > 0) return { ok: false, errors, live };

  const saved = await saveOffer(shop.id, input);
  if (!saved) return { ok: false, error: 'That offer no longer exists.' };

  // A draft save stops here: nothing of it is on the storefront to update.
  if (intent === 'save' && !live) return { ok: true, offer: saved, saved: true };

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

  /*
   * `previousTargets` is what makes a re-publish subtractive as well as additive:
   * a product dropped from the offer has to lose its Override row and metafield,
   * or its page keeps rendering the offer with nothing in the admin still
   * claiming it does.
   */
  const result = await publishOffer({
    admin,
    shopId: shop.id,
    offer: saved,
    previousTargets: before?.targets ?? [],
  });

  return {
    ok: result.failures.length === 0,
    offer: result.offer,
    published: true,
    // A save on a live offer updated the storefront rather than making it live,
    // which is a different sentence for the merchant to read.
    updated: intent === 'save',
    synced: result.synced,
    total: result.total,
    removed: result.removed,
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
 * The picker's cheapest price, whichever shape it hands back.
 *
 * The resource picker returns product resources shaped like the Storefront/Admin
 * product rather than a documented DTO, so both the variant list and the price
 * range are tried before giving up. A missing price is a missing price — the
 * preview shows no line rather than a zero.
 */
function priceOf(node) {
  const candidates = [
    node?.priceRangeV2?.minVariantPrice?.amount,
    node?.priceRange?.minVariantPrice?.amount,
    ...(node?.variants ?? []).map((variant) => variant?.price),
  ];

  for (const value of candidates) {
    const amount = Number(value);
    if (Number.isFinite(amount)) return amount;
  }
  return null;
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
          /*
           * The image and price are read straight off the picker's own result so
           * the preview updates the moment products are chosen, with no round
           * trip. They are display-only: `normalizeProducts` on the server keeps
           * id/handle/title/position and drops the rest, and the loader
           * re-hydrates them on the next open — a product whose price changes
           * must not need every offer that mentions it to be re-saved.
           */
          image: node.images?.[0]?.originalSrc ?? node.images?.[0]?.url ?? null,
          imageAlt: node.images?.[0]?.altText ?? node.title ?? '',
          price: priceOf(node),
          currencyCode: node.priceRangeV2?.minVariantPrice?.currencyCode ?? null,
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
                <s-thumbnail
                  size="small"
                  {...(product.image ? { src: product.image } : {})}
                  alt={product.imageAlt ?? ''}
                />
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

/*
 * Built from the shared label map rather than restated here — the Home offer list
 * draws the same names in its "Offer type" column, and the model validates
 * against the same keys.
 */
const OFFER_TYPES = OFFER_TYPE_KEYS.map((value) => ({
  value,
  label: OFFER_TYPE_LABELS[value],
}));

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
    countdownMode: offer?.countdownMode ?? 'fixed',
    // A string, because that is what the number field puts back into state — one
    // type in, one type out, and `sameForm` compares them as numbers.
    countdownMinutes: String(offer?.countdownMinutes ?? DEFAULT_COUNTDOWN_MINUTES),
    // Held as the form's own local string, not the ISO the loader sends, so the
    // two controls and the dirty check compare the same thing the merchant sees.
    countdownEndsAt: toLocalInput(offer?.countdownEndsAt),
    countdownTitle: offer?.countdownTitle ?? DEFAULT_COUNTDOWN_TITLE,
    anchorSelector: offer?.anchorSelector ?? '',
    anchorPosition: offer?.anchorPosition ?? 'after',
    targets: offer?.targets ?? [],
    items: offer?.items ?? [],
  };
}

/**
 * An ISO timestamp as the value a date + time pair holds: `YYYY-MM-DDTHH:mm`, in
 * the browser's own zone.
 *
 * Deliberately local rather than UTC. A merchant setting "ends 1 Sep, 18:00"
 * means six in the evening where they are, and the stored instant is computed from
 * that by `new Date()` on the way back in.
 */
function toLocalInput(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  const pad = (part) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

/** Today, as the stored value's date half. */
function todayLocal() {
  return toLocalInput(Date.now()).slice(0, 10);
}

/** The fields an offer actually stores per product. */
const storedProduct = (product) => ({
  id: product.id,
  handle: product.handle ?? null,
  title: product.title ?? null,
});

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
    a.countdownMode === b.countdownMode &&
    Number(a.countdownMinutes) === Number(b.countdownMinutes) &&
    a.countdownEndsAt === b.countdownEndsAt &&
    a.countdownTitle === b.countdownTitle &&
    a.anchorSelector === b.anchorSelector &&
    a.anchorPosition === b.anchorPosition &&
    ids(a.targets) === ids(b.targets) &&
    ids(a.items) === ids(b.items)
  );
}

function OfferEditor({ type, offer, maxItems, maxTargets }) {
  const fetcher = useFetcher();
  const navigate = useNavigate();
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
  const [countdownMode, setCountdownMode] = useState(initial.countdownMode);
  const [countdownMinutes, setCountdownMinutes] = useState(initial.countdownMinutes);
  const [countdownEndsAt, setCountdownEndsAt] = useState(initial.countdownEndsAt);
  const [countdownTitle, setCountdownTitle] = useState(initial.countdownTitle);
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
    countdownMode,
    countdownMinutes,
    countdownEndsAt,
    countdownTitle,
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
    setCountdownMode(values.countdownMode);
    setCountdownMinutes(values.countdownMinutes);
    setCountdownEndsAt(values.countdownEndsAt);
    setCountdownTitle(values.countdownTitle);
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

  /*
   * Delete and duplicate change which offer the URL points at, so they are the
   * two actions that navigate. Duplicating lands on the copy — the merchant
   * pressed it to work on the copy, not to be told one exists — and a clean
   * delete goes back to the list, since the offer this route was editing is gone.
   */
  useEffect(() => {
    if (!result?.redirectTo) return;
    navigate(result.redirectTo);
  }, [result, navigate]);

  const submit = (intent) => {
    /*
     * Delete and duplicate act on the stored row, not on what is on screen, so
     * they send nothing but the id — posting the form body would imply the copy
     * or the takedown used the unsaved edits, which it does not.
     */
    if (intent === 'delete' || intent === 'duplicate') {
      fetcher.submit({ intent, ...(id ? { id } : {}) }, { method: 'POST' });
      return;
    }

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
        countdownMode,
        countdownMinutes: String(countdownMinutes),
        countdownEndsAt,
        countdownTitle,
        anchorSelector,
        anchorPosition,
        /*
         * Stripped back to what is stored. The lists carry an image and a price
         * for the preview, and posting those would send a few KB of CDN URLs the
         * server drops on arrival (`normalizeProducts`) — and imply they are part
         * of the offer, which they are not: they are re-read on every load.
         */
        targets: JSON.stringify(targets.map(storedProduct)),
        items: JSON.stringify(items.map(storedProduct)),
      },
      { method: 'POST' },
    );
  };

  /*
   * The stored value is one local "YYYY-MM-DDTHH:mm" string, but the design shows
   * two controls, so it is split for rendering and reassembled on change. The
   * time falls back to the end of the day: a deadline a merchant has not set a
   * time for means "that day", not "that morning".
   */
  const endDate = countdownEndsAt.slice(0, 10);
  const endTime = countdownEndsAt.slice(11) || DEFAULT_END_TIME;

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
            {/*
              Delete and Duplicate only exist once there is a stored row to act
              on — before the first save there is nothing to copy or remove, and
              the form itself is the draft.
            */}
            {id && (
              <>
                <s-button
                  variant="secondary"
                  tone="critical"
                  commandFor="offer-delete-modal"
                  command="--show"
                  {...(busy ? { disabled: true } : {})}
                >
                  Delete
                </s-button>
                {/*
                  Disabled while the save bar is up: the copy is made from the
                  stored row, so duplicating mid-edit would silently drop the
                  changes the merchant is looking at.
                */}
                <s-button
                  variant="secondary"
                  onClick={() => submit('duplicate')}
                  {...(busy || dirty ? { disabled: true } : {})}
                >
                  Duplicate
                </s-button>
              </>
            )}
            {/*
              Saving a *new* offer needs a button of its own: the contextual save
              bar only appears once something is dirty, and a first-time visitor
              who has changed nothing still has to be able to store the defaults.
              Once the row exists, the save bar is the place to save from.
            */}
            {!id && (
              <s-button
                variant="secondary"
                onClick={() => submit('save')}
                {...(busy ? { loading: true } : {})}
              >
                Save draft
              </s-button>
            )}
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

      {/*
        Deleting is irreversible and takes products off the storefront with it, so
        it asks first. The confirm button lives in the modal body rather than an
        action slot: the slot names differ between hosts, and a confirmation that
        renders in the wrong place is worse than one that renders plainly.
      */}
      {id && (
        <s-modal id="offer-delete-modal" heading="Delete this offer?">
          <s-stack direction="block" gap="base">
            <s-paragraph>
              {published
                ? `This removes the offer from ${formatNumber(targets.length)} product page${
                    targets.length === 1 ? '' : 's'
                  } and deletes it. Those pages fall back to Shopify’s own recommendations.`
                : 'This deletes the offer. It is not published, so nothing changes on your storefront.'}
            </s-paragraph>
            <s-stack direction="inline" gap="small-300">
              <s-button
                variant="primary"
                tone="critical"
                onClick={() => submit('delete')}
                commandFor="offer-delete-modal"
                command="--hide"
                {...(busy ? { loading: true } : {})}
              >
                Delete offer
              </s-button>
              <s-button variant="secondary" commandFor="offer-delete-modal" command="--hide">
                Cancel
              </s-button>
            </s-stack>
          </s-stack>
        </s-modal>
      )}

      {/*
        Only reachable when the takedown left something behind — a clean delete
        redirects to the offer list, so there is nothing to render here.
      */}
      {result?.deleted && result.failures?.length > 0 && (
        <s-banner tone="warning" heading="Offer deleted, but some products may still show it">
          <s-paragraph>
            {formatNumber(result.failures.length)} product
            {result.failures.length === 1 ? '' : 's'} kept the published list. Re-sync from Settings
            to clear them.
          </s-paragraph>
          <s-button variant="secondary" href="/app/settings">
            Re-sync
          </s-button>
        </s-banner>
      )}

      {result?.errors?.length > 0 && (
        <s-banner
          tone="critical"
          heading={
            /*
              A live offer is validated as a publish, because saving it *is* a
              publish — so the heading has to say saving, or it reads as a
              complaint about a button the merchant did not press.
            */
            result.live ? 'Fix these before saving a live offer' : 'Fix these before publishing'
          }
        >
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

      {/*
        Publishing and saving a live offer land here alike — both rewrote the
        storefront — but they are different sentences. "Draft saved" on an offer
        shoppers can already see is the wrong answer, and it was the bug: a save
        changed nothing on the product page and said so in the language of a draft.
      */}
      {result?.published && (
        <s-banner
          tone={result.failures?.length > 0 ? 'warning' : 'success'}
          heading={
            result.failures?.length > 0
              ? result.updated
                ? 'Saved, but some products still show the old version'
                : 'Published, but some products did not go live'
              : result.updated
                ? 'Changes are live'
                : 'Offer published'
          }
          dismissible
        >
          <s-paragraph>
            {formatNumber(result.synced)} of {formatNumber(result.total)} product page
            {result.total === 1 ? '' : 's'}{' '}
            {result.updated ? 'now show the new version' : 'now show this offer'}.
            {result.removed > 0
              ? ` Removed from ${formatNumber(result.removed)} product page${
                  result.removed === 1 ? '' : 's'
                } you took out of the offer.`
              : ''}
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

                {countdown && (
                  <s-stack direction="block" gap="base">
                    <CountdownModeToggle value={countdownMode} onChange={setCountdownMode} />

                    {countdownMode === 'fixed' ? (
                      <s-stack direction="block" gap="small-300">
                        {/*
                          Label hidden rather than dropped, so a screen reader still
                          knows what the number means.

                          ⚠️ No `icon` here, though the design shows a clock and
                          `NumberFieldProps` looks like it inherits one: the React
                          wrapper omits `FieldDecorationProps`' icon, and the Polaris
                          validator rejects it — *"Property 'icon' does not exist"*.
                          `s-select` does take one, which is why the time half has
                          its clock and this does not.
                        */}
                        <s-number-field
                          label="Countdown length"
                          labelAccessibilityVisibility="exclusive"
                          name="countdownMinutes"
                          suffix="min"
                          min={MIN_COUNTDOWN_MINUTES}
                          max={MAX_COUNTDOWN_MINUTES}
                          step={1}
                          inputMode="numeric"
                          value={String(countdownMinutes)}
                          onInput={(event) => setCountdownMinutes(event.currentTarget.value)}
                        />
                        <s-text color="subdued">
                          The offer will disappear for 24 hours after the countdown ends
                        </s-text>
                      </s-stack>
                    ) : (
                      <s-stack direction="block" gap="small-300">
                        {/*
                          Date and time side by side, as one deadline reads.

                          Two controls because Polaris has a date field and no time
                          field; half-hour slots are as fine as a deadline needs to
                          be. Their labels are hidden rather than absent
                          (`labelAccessibilityVisibility="exclusive"`) — the design
                          shows none, and a screen reader still needs to know which
                          half is which.
                        */}
                        {/*
                          A grid, not an inline stack: Polaris fields fill their
                          container, so in a stack the select took the whole row and
                          pushed the date onto its own line. Two `1fr` columns give
                          the two halves the design shows.
                        */}
                        <s-grid gridTemplateColumns="1fr 1fr" gap="small-300" alignItems="center">
                          {/*
                            The date is a button that opens `s-date-picker` in a
                            popover, not an `s-date-field`.

                            The field is full width and takes no icon —
                            `s-date-field`'s props omit `FieldDecorationProps`
                            entirely, so there is no supported way to put a
                            calendar in it. A button does take one, and it reads as
                            the pill the design shows, with the chosen date as its
                            label.
                          */}
                          <s-button
                            icon="calendar"
                            inlineSize="fill"
                            commandFor="countdown-end-date"
                            command="--show"
                            accessibilityLabel="Choose the countdown end date"
                          >
                            {formatDayLabel(endDate)}
                          </s-button>

                          {/*
                            The time matches the date: a pill that opens a picker in
                            a popover, not a dropdown. An `s-select` was a native
                            menu of half-hour slots beside a calendar — two
                            different interactions for the two halves of one
                            deadline, and no way to say 6:04.
                          */}
                          <s-button
                            icon="clock"
                            inlineSize="fill"
                            commandFor="countdown-end-time"
                            command="--show"
                            accessibilityLabel="Choose the countdown end time"
                          >
                            {formatClockTime(endTime)}
                          </s-button>
                        </s-grid>

                        {/*
                          Outside the grid: a popover is an overlay, but it is still
                          a DOM child — inside the grid it would claim a third cell
                          and knock the two halves out of alignment.
                        */}
                        <s-popover id="countdown-end-date">
                          <s-date-picker
                            type="single"
                            value={endDate}
                            onChange={(event) =>
                              setCountdownEndsAt(`${event.currentTarget.value}T${endTime}`)
                            }
                          />
                        </s-popover>

                        <s-popover id="countdown-end-time">
                          <TimePicker
                            value={endTime}
                            onChange={(next) =>
                              setCountdownEndsAt(`${endDate || todayLocal()}T${next}`)
                            }
                          />
                        </s-popover>
                        <s-text color="subdued">Timer that ends at the specific date</s-text>
                      </s-stack>
                    )}

                    <s-text-field
                      label="Title"
                      name="countdownTitle"
                      value={countdownTitle}
                      details={`Use ${COUNTDOWN_TOKEN} where you want the countdown to appear.`}
                      onInput={(event) => setCountdownTitle(event.currentTarget.value)}
                    />
                  </s-stack>
                )}

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
          <OfferPreview
            offerType={offerType}
            title={title}
            badge={badge}
            buttonText={buttonText}
            countdown={countdown}
            countdownMode={countdownMode}
            countdownMinutes={countdownMinutes}
            countdownEndsAt={countdownEndsAt}
            countdownTitle={countdownTitle}
            items={items}
            placementTitle={placement?.title}
          />
        </s-grid>
      </s-query-container>
    </s-page>
  );
}

/* ---------------------------------------------------------------- preview */

/**
 * Offer types whose storefront surface shows one product at a time.
 *
 * Cross-sell and product add-on are a row of cards the shopper scrolls through,
 * so the preview steps through them the same way. Frequently bought together is
 * a stacked bundle with a running total, and a volume discount is a list of
 * quantity tiers — neither is a carousel, so both keep the stacked preview.
 */
const CAROUSEL_TYPES = new Set(['cross_sell', 'product_add_on']);

/** What a card falls back to before any product has been picked. */
const PLACEHOLDER = { id: 'placeholder', title: 'Recommended product' };

/**
 * Hour, minute and AM/PM as three scrolling columns.
 *
 * Built here rather than reached for: Polaris has `s-date-picker` and no time
 * picker, and a select of fixed slots next to a calendar made the two halves of one
 * deadline behave differently — and could not say 6:04 at all.
 *
 * `s-scroll-box` is the only Polaris element that scrolls; a box's `overflow`
 * accepts nothing but `hidden` and `visible`. The selected cell is
 * `background="strong"` from the same token set the mode toggle uses, so there is
 * no hardcoded colour here either.
 */
function TimePicker({ value, onChange }) {
  const current = readTime(value);

  const column = (label, items, selected, format, toPatch) => (
    <s-scroll-box maxBlockSize="240px" accessibilityLabel={label}>
      <s-stack direction="block" gap="small-500">
        {items.map((item) => (
          <s-clickable
            key={item}
            padding="small-400"
            borderRadius="base"
            background={item === selected ? 'strong' : 'transparent'}
            onClick={() => onChange(writeTime({ ...current, ...toPatch(item) }))}
            accessibilityLabel={`${label}: ${format(item)}`}
          >
            <s-stack direction="inline" justifyContent="center">
              <s-text type={item === selected ? 'strong' : 'generic'}>{format(item)}</s-text>
            </s-stack>
          </s-clickable>
        ))}
      </s-stack>
    </s-scroll-box>
  );

  return (
    <s-box padding="small-300">
      <s-grid gridTemplateColumns="1fr 1fr 1fr" gap="small-300">
        {column('Hour', HOUR_OPTIONS, current.hour12, pad2, (hour12) => ({ hour12 }))}
        {column('Minute', MINUTE_OPTIONS, current.minute, pad2, (minute) => ({ minute }))}
        {/*
          Not scrolled — two items need no scroller, and giving them one leaves an
          empty half-column beside the other two.
        */}
        <s-stack direction="block" gap="small-500">
          {MERIDIEMS.map((meridiem) => (
            <s-clickable
              key={meridiem}
              padding="small-400"
              borderRadius="base"
              background={meridiem === current.meridiem ? 'strong' : 'transparent'}
              onClick={() => onChange(writeTime({ ...current, meridiem }))}
              accessibilityLabel={`Set ${meridiem}`}
            >
              <s-stack direction="inline" justifyContent="center">
                <s-text type={meridiem === current.meridiem ? 'strong' : 'generic'}>
                  {meridiem}
                </s-text>
              </s-stack>
            </s-clickable>
          ))}
        </s-stack>
      </s-grid>
    </s-box>
  );
}

/**
 * Fixed | Custom end date, as one joined control.
 *
 * Built from `s-box` + `s-clickable` rather than buttons, because neither of the
 * two routes through Polaris's own components gets there:
 *
 *   - `s-button-group gap="none"` is *documented* as the segmented control and
 *     renders an **empty box** — its props are `ActionSlots`, so plain children
 *     land in no slot and never display.
 *   - Two `s-button`s in a grid do render, but a button carries its own chrome:
 *     the selected half showed as a bordered white button and the other as bare
 *     text, which reads as one button and one label rather than a control.
 *
 * `s-clickable` takes `background`, so the selected half is `subdued` against
 * `transparent` inside one bordered, rounded box — Polaris tokens throughout, no
 * hardcoded colour, which is what keeps this native to the admin.
 *
 * `overflow="hidden"` is what makes the corners look like one pill: without it the
 * selected half's square background paints over the box's rounded corner.
 */
function CountdownModeToggle({ value, onChange }) {
  const modes = [
    { key: 'fixed', label: 'Fixed' },
    { key: 'date', label: 'Custom end date' },
  ];

  return (
    <s-box border="base" borderRadius="base" overflow="hidden">
      <s-grid gridTemplateColumns="1fr 1fr" gap="none">
        {modes.map((mode) => (
          <s-clickable
            key={mode.key}
            padding="small-300 base"
            background={value === mode.key ? 'subdued' : 'transparent'}
            onClick={() => onChange(mode.key)}
            accessibilityLabel={`Countdown ends: ${mode.label}`}
          >
            {/* The stack is what centres the label; a clickable has no alignment
                props of its own. */}
            <s-stack direction="inline" justifyContent="center">
              <s-text type={value === mode.key ? 'strong' : 'generic'}>{mode.label}</s-text>
            </s-stack>
          </s-clickable>
        ))}
      </s-grid>
    </s-box>
  );
}

/**
 * The countdown, ticking, exactly as reco.js renders it.
 *
 * Fixed mode counts from the moment the preview mounts, which is what a shopper's
 * first view does; date mode counts to the merchant's deadline, so a date already
 * gone shows the offer as hidden rather than a frozen 00:00.
 */
function CountdownPreview({ mode, minutes, endsAt, title }) {
  const deadline = useMemo(() => {
    if (mode === 'date') {
      const at = endsAt ? new Date(endsAt).getTime() : NaN;
      return Number.isNaN(at) ? null : at;
    }
    const length = Number(minutes);
    return Date.now() + (Number.isFinite(length) ? length : DEFAULT_COUNTDOWN_MINUTES) * 60000;
    // Restarts when the merchant changes the length, which is what makes the
    // field feel connected to the preview.
  }, [mode, minutes, endsAt]);

  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  if (!deadline) {
    return (
      <Card>
        <s-text color="subdued">Pick the date and time this countdown ends.</s-text>
      </Card>
    );
  }

  const left = deadline - now;

  if (left <= 0) {
    return (
      <Card>
        <s-text color="subdued">
          That deadline has passed, so the offer would not show on the storefront.
        </s-text>
      </Card>
    );
  }

  // Same split as reco.js: no token means the clock goes after the merchant's
  // sentence rather than nowhere.
  const { lead, trail } = splitCountdownTitle(title || DEFAULT_COUNTDOWN_TITLE);

  return (
    <Card>
      <s-stack direction="inline" gap="small-500" justifyContent="center" alignItems="center">
        <s-text>{lead}</s-text>
        <s-text type="strong" fontVariantNumeric="tabular-nums">
          {formatDuration(left)}
        </s-text>
        <s-text>{trail}</s-text>
      </s-stack>
    </Card>
  );
}

function OfferPreview({
  offerType,
  title,
  badge,
  buttonText,
  countdown,
  countdownMode,
  countdownMinutes,
  countdownEndsAt,
  countdownTitle,
  items,
  placementTitle,
}) {
  const products = items.length > 0 ? items : [PLACEHOLDER];
  const carousel = CAROUSEL_TYPES.has(offerType);

  const [slide, setSlide] = useState(0);

  /*
   * Clamped on read rather than reset in an effect: removing products on the
   * Offer tab can leave the index past the end, and an effect would render one
   * frame of an empty carousel before correcting itself.
   */
  const index = Math.min(slide, products.length - 1);
  const shown = carousel ? [products[index]] : products;

  const step = (delta) => setSlide(Math.min(Math.max(index + delta, 0), products.length - 1));

  return (
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

        {/*
          Real controls, not decoration: they step the preview the way the
          storefront slider steps the row. Hidden entirely for the stacked offer
          types — arrows over a list that does not scroll misrepresent the block.
          Disabled at the ends rather than wrapping, so the merchant can tell how
          many products they have from the controls alone.
        */}
        {carousel && (
          <s-stack direction="inline" gap="small-300" alignItems="center">
            <s-button
              variant="tertiary"
              icon="chevron-left"
              accessibilityLabel="Previous product"
              onClick={() => step(-1)}
              {...(index === 0 ? { disabled: true } : {})}
            />
            <s-button
              variant="tertiary"
              icon="chevron-right"
              accessibilityLabel="Next product"
              onClick={() => step(1)}
              {...(index >= products.length - 1 ? { disabled: true } : {})}
            />
          </s-stack>
        )}
      </s-stack>

      {/* Above the cards, where the storefront puts it. */}
      {countdown && (
        <CountdownPreview
          mode={countdownMode}
          minutes={countdownMinutes}
          endsAt={countdownEndsAt}
          title={countdownTitle}
        />
      )}

      {shown.map((product) => (
        <Card key={product.id}>
          <s-stack
            direction="inline"
            gap="base"
            alignItems="center"
            justifyContent="space-between"
          >
            <s-stack direction="inline" gap="base" alignItems="center">
              <s-thumbnail
                size="large"
                {...(product.image ? { src: product.image } : {})}
                alt={product.imageAlt ?? ''}
              />
              <s-stack direction="block" gap="small-500">
                <s-text type="strong">{product.title || `Product ${product.id}`}</s-text>
                {/*
                  Only a real price is shown. An invented one reads as the offer's
                  own pricing, and this block never changes a price — it
                  recommends products at whatever they already cost.
                */}
                {typeof product.price === 'number' && (
                  <s-text color="subdued">
                    {formatMoney(product.price, product.currencyCode)}
                  </s-text>
                )}
              </s-stack>
            </s-stack>
            <s-button variant="primary" icon="plus">
              {buttonText || 'Add'}
            </s-button>
          </s-stack>
        </Card>
      ))}

      {carousel && products.length > 1 && (
        <s-text color="subdued">{`Product ${index + 1} of ${products.length}`}</s-text>
      )}



      <s-paragraph color="subdued">
        Preview of the {(placementTitle ?? 'product page').toLowerCase()} block. It follows the
        fields on the left, not your theme&rsquo;s styling.
      </s-paragraph>
    </s-stack>
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
