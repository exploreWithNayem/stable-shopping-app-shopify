/**
 * Thin horizontal fill bar.
 *
 * Polaris App Home has no progress primitive, so this composes one from two
 * boxes. `background` only accepts transparent/subdued/base/strong, so the fill
 * is `strong` on a `subdued` track rather than a tone colour — which keeps it
 * looking like part of the admin instead of a borrowed widget.
 *
 * Decorative on purpose: every caller states the same numbers in adjacent text,
 * so there is nothing here for a screen reader to announce twice.
 */
export default function MeterBar({ value, max }) {
  // Rounded to a whole number so the size reads as `${number}%`: SizeUnits does
  // not accept the string a toFixed() would produce.
  const percent = max > 0 ? Math.round(Math.min(Math.max(value / max, 0), 1) * 100) : 0;

  return (
    <s-box background="subdued" borderRadius="large" minBlockSize="6px">
      <s-box
        background="strong"
        borderRadius="large"
        minBlockSize="6px"
        inlineSize={`${percent}%`}
      />
    </s-box>
  );
}
