/**
 * Plain bordered surface used to build multi-column rows.
 *
 * `s-section` is the usual card, but sections cannot sit side by side inside a
 * grid, so dashboard rows compose from these instead. Written as a component
 * rather than a spread object because Polaris props are literal unions — a
 * spread widens them to `string` and stops type-checking.
 */
export default function Card({ children }) {
  return (
    <s-box
      padding="base"
      borderWidth="base"
      borderColor="subdued"
      borderRadius="base"
      background="base"
    >
      {children}
    </s-box>
  );
}
