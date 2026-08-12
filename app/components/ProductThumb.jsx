/**
 * Product image plus title, the repeated cell in the recommendations and
 * top-products tables.
 *
 * `image` is optional: products without one still need to line up with their
 * neighbours, and s-thumbnail renders a placeholder when src is empty.
 */
export default function ProductThumb({
  title,
  image = null,
  subtitle = null,
  href = null,
}) {
  const label = (
    <s-stack direction="block" gap="none">
      {href ? <s-link href={href}>{title}</s-link> : <s-text>{title}</s-text>}
      {subtitle && <s-text color="subdued">{subtitle}</s-text>}
    </s-stack>
  );

  return (
    <s-stack direction="inline" gap="small" alignItems="center">
      <s-thumbnail src={image ?? undefined} alt={title ?? ""} size="small" />
      {label}
    </s-stack>
  );
}
