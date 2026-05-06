/**
 * Default-password login. Only rendered when the lib's auth is in password
 * mode and the session cookie is missing/invalid.
 */
export function LoginPage() {
  // The SDK injects window.__GRAVEL_MOUNT_PATH__ into the shell HTML
  // (handler/routes.ts → rewriteShell). Fall back to '' (root mount).
  const mountPath = (window as unknown as { __GRAVEL_MOUNT_PATH__?: string }).__GRAVEL_MOUNT_PATH__ ?? ''
  return (
    <div className="min-h-screen flex items-center justify-center bg-cream">
      <div className="w-full max-w-sm bg-white rounded-2xl shadow-lg ring-1 ring-warm p-8">
        <div className="flex items-center gap-2 mb-6">
          <div className="h-7 w-7 rounded-lg bg-primary flex items-center justify-center">
            <span className="text-white text-xs font-bold">G</span>
          </div>
          <span className="font-display font-semibold">Sign in to Gravel</span>
        </div>
        <form
          method="POST"
          action={`${mountPath}/api/auth/login`}
          className="space-y-3"
        >
          <input
            type="password"
            name="password"
            placeholder="Admin password"
            required
            autoFocus
            className="w-full rounded-lg border border-warm px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
          <button
            type="submit"
            className="w-full rounded-lg bg-primary text-white font-medium py-2 hover:bg-primary-dark transition-colors"
          >
            Sign in
          </button>
        </form>
        <p className="mt-4 text-xs text-text-muted">
          From <code>GRAVEL_ADMIN_PASSWORD</code> in your .env.
        </p>
      </div>
    </div>
  )
}
