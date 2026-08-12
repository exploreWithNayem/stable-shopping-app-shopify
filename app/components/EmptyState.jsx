/**
 * Centred "nothing here yet" state with a clear next step.
 *
 * Used both for genuinely empty resources and for filtered views that return
 * no matches — pass a different heading/action for each so the merchant can
 * tell the two apart.
 */
export default function EmptyState({
  heading,
  description,
  action = null,
  secondaryAction = null,
}) {
  return (
    <s-box padding="large-100">
      <s-stack direction="block" gap="base" alignItems="center">
        <s-heading>{heading}</s-heading>

        {description && <s-paragraph color="subdued">{description}</s-paragraph>}

        {(action || secondaryAction) && (
          <s-button-group gap="base">
            {action && (
              <s-button variant="primary" href={action.href} onClick={action.onClick}>
                {action.label}
              </s-button>
            )}
            {secondaryAction && (
              <s-button
                variant="secondary"
                href={secondaryAction.href}
                onClick={secondaryAction.onClick}
              >
                {secondaryAction.label}
              </s-button>
            )}
          </s-button-group>
        )}
      </s-stack>
    </s-box>
  );
}
