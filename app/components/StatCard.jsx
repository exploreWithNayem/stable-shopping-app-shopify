import { formatNumber } from '../lib/format';

/**
 * Responsive container for a row of StatCards.
 *
 * Three rules, each of which broke this silently at some point:
 *
 * 1. `@container` values only resolve inside a containment context, so the
 *    s-query-container wrapper is required.
 * 2. Responsive values are comma-separated, so a track list may not contain a
 *    comma — `repeat(4, 1fr)` splits mid-function and voids the query.
 * 3. One `@container` clause plus a fallback, which is the only form the docs
 *    demonstrate. A chain of three never matched.
 *
 * `columns` is the wide-container count; below the breakpoint everything
 * stacks.
 */
export function StatCardGrid({ children, columns = 4, minWidth = 700 }) {
  const wide = Array.from({ length: columns }, () => '1fr').join(' ');

  return (
    <s-query-container>
      <s-grid
        gap="base"
        gridTemplateColumns={`@container (inline-size > ${minWidth}px) ${wide}, 1fr`}
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
