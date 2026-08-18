import { formatNumber } from '../lib/format';

/**
 * Responsive container for a row of StatCards.
 *
 * The s-query-container wrapper is load-bearing, not decoration: `@container`
 * values only resolve inside a containment context, and without one every
 * query silently fails and the grid falls through to its last value — one
 * full-width column at any window size. That is what made a 2000px window
 * render six stacked boxes.
 */
export function StatCardGrid({ children }) {
  return (
    <s-query-container>
      <s-grid
        gap="base"
        gridTemplateColumns={
          '@container (inline-size > 1040px) repeat(4, 1fr), ' +
          '@container (inline-size > 760px) repeat(3, 1fr), ' +
          '@container (inline-size > 380px) repeat(2, 1fr), ' +
          '1fr'
        }
      >
        {children}
      </s-grid>
    </s-query-container>
  );
}

function deltaTone(delta) {
  if (delta > 0) return 'success';
  if (delta < 0) return 'critical';
  return 'neutral';
}

/**
 * A single headline metric with an optional period-over-period change.
 *
 * `delta` is a percentage change; pass null when there is no comparable
 * previous period rather than showing a misleading 0%.
 */
export default function StatCard({ label, value, delta = null, caption = null }) {
  const showDelta = delta !== null && Number.isFinite(delta);

  return (
    <s-box
      padding="base"
      borderWidth="base"
      borderColor="subdued"
      borderRadius="base"
      background="base"
    >
      <s-stack direction="block" gap="small-100">
        <s-text color="subdued">{label}</s-text>

        <s-stack direction="inline" gap="small" alignItems="center">
          {/* tabular-nums keeps the digits from jittering as values update */}
          <s-text fontVariantNumeric="tabular-nums">
            <s-heading>{typeof value === 'number' ? formatNumber(value) : value}</s-heading>
          </s-text>

          {showDelta && (
            <s-badge
              tone={deltaTone(delta)}
              icon={delta > 0 ? 'arrow-up' : delta < 0 ? 'arrow-down' : undefined}
            >
              {`${Math.abs(delta).toFixed(1)}%`}
            </s-badge>
          )}
        </s-stack>

        {caption && <s-text color="subdued">{caption}</s-text>}
      </s-stack>
    </s-box>
  );
}
