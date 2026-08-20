/**
 * Wireframe illustration for a placement card.
 *
 * Inline SVG rather than image assets: six small diagrams would otherwise mean
 * six files to keep in step with the admin's light and dark themes. The page
 * furniture is drawn in `currentColor` at low opacity and the block being placed
 * at high opacity, so each diagram inherits the admin's text colour and needs no
 * theme handling. The one exception is the Checkout nudge card, whose whole
 * subject is a red warning — that keeps a literal red.
 *
 * Purely decorative: the card's heading and description carry the meaning, so
 * these are hidden from assistive tech rather than given labels that repeat it.
 */

const W = 280;
const H = 176;

/** Page furniture — context, not the offer. */
const Muted = ({ x, y, w, h, r = 3, o = 0.13 }) => (
  <rect x={x} y={y} width={w} height={h} rx={r} fill="currentColor" opacity={o} />
);

/** The block being placed. */
const Solid = ({ x, y, w, h, r = 3 }) => (
  <rect x={x} y={y} width={w} height={h} rx={r} fill="currentColor" opacity="0.92" />
);

const Frame = ({ children }) => (
  <svg
    viewBox={`0 0 ${W} ${H}`}
    width="100%"
    role="presentation"
    aria-hidden="true"
    style={{ display: 'block' }}
  >
    <rect x="0" y="0" width={W} height={H} rx="8" fill="currentColor" opacity="0.05" />
    {children}
  </svg>
);

/*
 * The product page behind three of the diagrams: a wide gallery on the left, a
 * title and detail lines on the right, then a row of thumbnails underneath.
 *
 * The right column starts at RIGHT_X and every element in it shares that edge,
 * including the offer block, so the column reads as one stack rather than three
 * things that happen to be near each other.
 */
const RIGHT_X = 176;
const RIGHT_W = 90;

const productPage = (
  <>
    <Muted x={14} y={14} w={150} h={88} r={4} />
    <Muted x={RIGHT_X} y={30} w={RIGHT_W} h={9} />
    <Muted x={RIGHT_X} y={46} w={52} h={9} />
    <Muted x={RIGHT_X} y={64} w={RIGHT_W} h={18} r={4} />
  </>
);

/* Thumbnails along the bottom left, caption lines under the offer block. */
const productFooter = (
  <>
    <Muted x={14} y={116} w={32} h={30} r={4} />
    <Muted x={50} y={116} w={32} h={30} r={4} />
    <Muted x={86} y={116} w={32} h={30} r={4} />
    <Muted x={122} y={116} w={32} h={30} r={4} />
    <Muted x={RIGHT_X} y={140} w={24} h={7} />
    <Muted x={206} y={140} w={24} h={7} />
    <Muted x={236} y={140} w={24} h={7} />
  </>
);

const DIAGRAMS = {
  /* Product page — the offer block sits in the right column, below the product
     details and above their caption lines. */
  product_page: (
    <Frame>
      {productPage}
      <Solid x={RIGHT_X} y={92} w={RIGHT_W} h={40} r={4} />
      {productFooter}
    </Frame>
  ),

  /* Cart page — a full-width offer bar above the cart. */
  cart_page: (
    <Frame>
      <Muted x={20} y={20} w={44} h={9} />
      <Muted x={182} y={20} w={22} h={9} />
      <Muted x={210} y={20} w={22} h={9} />
      <Muted x={238} y={20} w={22} h={9} />
      <Solid x={20} y={42} w={240} h={26} r={4} />
      {/* Cart glyph, drawn rather than an icon font so it scales with the box. */}
      <g fill="currentColor" opacity="0.13">
        <path d="M112 92h10l14 44h60l14-32h-78" stroke="currentColor" strokeWidth="7" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="146" cy="150" r="8" />
        <circle cx="188" cy="150" r="8" />
      </g>
    </Frame>
  ),

  /* Pop-up — a panel centred over the product page.
     x is (W - w) / 2 so it stays centred if the viewBox changes, and its bottom
     edge stops at the thumbnail row rather than covering it. */
  popup: (
    <Frame>
      {productPage}
      {productFooter}
      <Solid x={(W - 116) / 2} y={36} w={116} h={86} r={6} />
    </Frame>
  ),

  /* Post purchase — an upsell below the order confirmation. */
  post_purchase: (
    <Frame>
      <Muted x={44} y={22} w={92} h={9} />
      <Muted x={44} y={38} w={56} h={9} />
      <Solid x={20} y={56} w={240} h={16} r={3} />
      <Muted x={20} y={84} w={26} h={26} r={4} />
      <Muted x={54} y={84} w={92} h={60} r={4} />
      <Muted x={160} y={86} w={78} h={8} />
      <Muted x={160} y={100} w={56} h={8} />
      <Solid x={172} y={118} w={88} h={20} r={3} />
      <Muted x={20} y={118} w={26} h={26} r={4} />
    </Frame>
  ),

  /* Suggest — a question mark, since there is nothing to draw yet. */
  suggest: (
    <Frame>
      <text
        x={W / 2}
        y={H / 2 + 30}
        textAnchor="middle"
        fill="currentColor"
        opacity="0.16"
        style={{ font: '700 88px system-ui, sans-serif' }}
      >
        ?
      </text>
    </Frame>
  ),

  /* Checkout nudge — a cart line with a red "you skipped this" warning. */
  checkout_nudge: (
    <Frame>
      <rect x={20} y={36} width={44} height={44} rx="8" fill="#F0868E" opacity="0.85" />
      <circle cx="66" cy="34" r="11" fill="currentColor" opacity="0.9" />
      <text
        x="66"
        y="38"
        textAnchor="middle"
        fill="#fff"
        style={{ font: '700 12px system-ui, sans-serif' }}
      >
        2
      </text>
      <Muted x={80} y={46} w={104} h={8} />
      <Muted x={80} y={62} w={64} h={8} />
      <Muted x={210} y={54} w={50} h={8} />
      <rect x={20} y={104} width={240} height={30} rx="6" fill="#F0868E" opacity="0.22" />
      <circle cx="40" cy="119" r="7" fill="#C7383F" opacity="0.75" />
      <text
        x="40"
        y="123"
        textAnchor="middle"
        fill="#fff"
        style={{ font: '700 9px system-ui, sans-serif' }}
      >
        !
      </text>
      <text
        x="56"
        y="123"
        fill="#8E2A30"
        style={{ font: '500 11px system-ui, sans-serif' }}
      >
        You didn&rsquo;t pick add-on in cart
      </text>
    </Frame>
  ),
};

export default function PlacementThumb({ diagram }) {
  return DIAGRAMS[diagram] ?? DIAGRAMS.product_page;
}
