/**
 * Two-series area/line chart, drawn as inline SVG.
 *
 * Deliberately not a chart library: this renders one shape per series from a
 * fixed-length daily array, and a charting dependency for that would outweigh
 * the whole widget.
 *
 * The viewBox keeps its aspect ratio (`xMidYMid meet`) rather than stretching.
 * `preserveAspectRatio="none"` distorts a 2px stroke into a wedge when the
 * container is wider than it is tall, which is what made the earlier version
 * look hand-drawn.
 */

const WIDTH = 720;
const HEIGHT = 220;
const PAD_X = 8;
const PAD_TOP = 16;
const PAD_BOTTOM = 24;

const COLORS = ['#3b6ef5', '#c2820a'];

/** Round a max up to something a human would pick for an axis label. */
function niceMax(value) {
  if (value <= 5) return 5;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / magnitude) * magnitude;
}

function toPoints(values, max) {
  const span = Math.max(values.length - 1, 1);
  const plotWidth = WIDTH - PAD_X * 2;
  const plotHeight = HEIGHT - PAD_TOP - PAD_BOTTOM;
  return values.map((value, index) => {
    const x = PAD_X + (index / span) * plotWidth;
    // SVG y grows downward, so a larger value sits closer to the top.
    const y = PAD_TOP + plotHeight - (value / max) * plotHeight;
    return [x, y];
  });
}

function toLine(points) {
  return points
    .map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`)
    .join(' ');
}

function shortDate(iso) {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

export default function TrendChart({ series, seriesKeys, labels }) {
  const peak = Math.max(0, ...series.flatMap((point) => seriesKeys.map((key) => point[key] ?? 0)));
  // A flat zero series would divide by zero and pin the line to the floor.
  const max = niceMax(Math.max(peak, 1));

  const baseline = HEIGHT - PAD_BOTTOM;
  const midline = PAD_TOP + (baseline - PAD_TOP) / 2;

  return (
    <s-stack direction="block" gap="small">
      <s-stack direction="inline" gap="base" alignItems="center">
        {seriesKeys.map((key, index) => (
          <s-stack key={key} direction="inline" gap="small-300" alignItems="center">
            <svg width="10" height="10" aria-hidden="true">
              <rect width="10" height="10" rx="5" fill={COLORS[index]} />
            </svg>
            <s-text color="subdued">{labels[index]}</s-text>
          </s-stack>
        ))}
        <s-text color="subdued">{`Peak ${peak}`}</s-text>
      </s-stack>

      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="xMidYMid meet"
        style={{ inlineSize: '100%', blockSize: 'auto' }}
        role="img"
        aria-label={`${labels.join(' and ')} over ${series.length} days, peaking at ${peak}.`}
      >
        {/* Scale reference: without them the shape has no magnitude at all. */}
        <line
          x1={PAD_X}
          y1={PAD_TOP}
          x2={WIDTH - PAD_X}
          y2={PAD_TOP}
          stroke="currentColor"
          strokeOpacity="0.12"
          strokeDasharray="4 4"
        />
        <line
          x1={PAD_X}
          y1={midline}
          x2={WIDTH - PAD_X}
          y2={midline}
          stroke="currentColor"
          strokeOpacity="0.12"
          strokeDasharray="4 4"
        />
        <line
          x1={PAD_X}
          y1={baseline}
          x2={WIDTH - PAD_X}
          y2={baseline}
          stroke="currentColor"
          strokeOpacity="0.25"
        />

        <text x={PAD_X} y={PAD_TOP - 5} fontSize="11" fill="currentColor" fillOpacity="0.55">
          {max}
        </text>

        {seriesKeys.map((key, index) => {
          const points = toPoints(
            series.map((point) => point[key] ?? 0),
            max,
          );
          const line = toLine(points);
          const area = `${line} L${WIDTH - PAD_X} ${baseline} L${PAD_X} ${baseline} Z`;
          return (
            <g key={key}>
              {index === 0 && <path d={area} fill={COLORS[index]} opacity="0.1" />}
              <path
                d={line}
                fill="none"
                stroke={COLORS[index]}
                strokeWidth="2"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            </g>
          );
        })}

        {series.length > 1 && (
          <>
            <text x={PAD_X} y={HEIGHT - 6} fontSize="11" fill="currentColor" fillOpacity="0.55">
              {shortDate(series[0].date)}
            </text>
            <text
              x={WIDTH - PAD_X}
              y={HEIGHT - 6}
              fontSize="11"
              textAnchor="end"
              fill="currentColor"
              fillOpacity="0.55"
            >
              {shortDate(series[series.length - 1].date)}
            </text>
          </>
        )}
      </svg>
    </s-stack>
  );
}
