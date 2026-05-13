/**
 * Tiny inline spinner for "this button is doing something" feedback.
 *
 * Default size matches the line-height of a button label (h-3.5 = 14px)
 * so it sits cleanly next to text without nudging the baseline. Inherits
 * `currentColor` so it tints to whatever the surrounding text/button
 * uses — no separate prop needed.
 *
 * Used wherever a button kicks off an async action that takes >100ms.
 * The mere existence of the spinner is the click feedback; pair with
 * `disabled` so a second click can't fire while the first is in flight.
 */
export function Spinner({
  className = '',
  label = 'Loading',
}: {
  className?: string
  /** Screen-reader text. Not visible. */
  label?: string
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      className={`h-3.5 w-3.5 animate-spin ${className}`}
      aria-hidden="true"
      role="img"
    >
      <title>{label}</title>
      <circle
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="3"
        opacity="0.25"
      />
      <path
        d="M22 12a10 10 0 0 1-10 10"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  )
}
