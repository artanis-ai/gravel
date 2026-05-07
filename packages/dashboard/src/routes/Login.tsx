/**
 * Default-password login. Only rendered when the lib's auth is in
 * password mode and the session cookie is missing/invalid.
 *
 * UX intent: the dashboard is embedded inside the host app and the
 * person logging in is a domain expert (clinician, lawyer, etc.), not
 * a developer. We deliberately keep the page neutral — no Gravel
 * branding, no mention of `.env` or admin credentials. If the host
 * configured `productName`, we surface that as the heading; otherwise
 * just "Sign in". Anyone who needs the password should ask whoever
 * shared the link with them.
 */
declare global {
  interface Window {
    __GRAVEL_MOUNT_PATH__?: string
    __GRAVEL_PRODUCT_NAME__?: string
  }
}

export function LoginPage() {
  const mountPath = window.__GRAVEL_MOUNT_PATH__ ?? ''
  const productName = window.__GRAVEL_PRODUCT_NAME__?.trim() || ''
  return (
    <div className="min-h-screen flex items-center justify-center bg-cream">
      <div className="w-full max-w-sm bg-white rounded-2xl shadow-lg ring-1 ring-warm p-8">
        <div className="flex justify-center mb-5 text-text-mid">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="4" y="11" width="16" height="10" rx="2" />
            <path d="M8 11V8a4 4 0 0 1 8 0v3" />
          </svg>
        </div>
        {productName ? (
          <h1 className="font-display font-semibold text-lg text-center mb-5">{productName}</h1>
        ) : null}
        <form
          method="POST"
          action={`${mountPath}/api/auth/login`}
          className="space-y-3"
        >
          <input
            type="password"
            name="password"
            placeholder="Password"
            required
            autoFocus
            className="w-full rounded-lg border border-warm px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            aria-label="Password"
          />
          <button
            type="submit"
            className="w-full rounded-lg bg-primary text-white font-medium py-2 hover:bg-primary-dark transition-colors"
          >
            Sign in
          </button>
        </form>
      </div>
    </div>
  )
}
