package wizard

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// next_config.go ports the Next.js config + instrumentation patchers
// from packages/sdk-ts/src/wizard/mount.ts (ensureNextPagesRewrite,
// ensureNextServerExternalPackages, ensureNextInstrumentation).
//
// All three are regex-based, idempotent, and prefer "splice into the
// existing file" over "scribble a new one". When they can't safely
// splice (the user's config is non-trivial), they write a sibling
// `.gravel.<suffix>.suggestion.txt` and continue, matching the TS
// behaviour byte-for-byte.

// nextConfigCandidates lists the order we probe for the host's
// Next.js config. Mirrors the TS reference order.
var nextConfigCandidates = []string{
	"next.config.ts",
	"next.config.mjs",
	"next.config.js",
}

// findNextConfig returns the first existing config path + its body,
// or ("", "") if none of the candidates exist.
func findNextConfig(cwd string) (string, string) {
	for _, name := range nextConfigCandidates {
		path := filepath.Join(cwd, name)
		body, err := os.ReadFile(path)
		if err == nil {
			return path, string(body)
		}
	}
	return "", ""
}

// EnsureNextPagesRewrite patches next.config to rewrite
// <mountPath>/*  ->  /api<mountPath>/* so the Pages Router route file
// (which MUST live under pages/api/ to keep webpack from bundling it
// for the client) answers at the user-visible URL.
//
// Idempotent: if a `destination: '/api<mountPath>/:path*'` line already
// exists in the config, return without touching anything.
func EnsureNextPagesRewrite(cwd, mountPath string) error {
	target, body := findNextConfig(cwd)
	dest := "/api" + mountPath

	// Already patched?
	if target != "" && strings.Contains(body, fmt.Sprintf("destination: '%s/:path*'", dest)) {
		return nil
	}

	block := fmt.Sprintf(`
  async rewrites() {
    return [
      // Pages Router mount: file lives at `+"`"+`pages/api%s/[[...slug]].ts`+"`"+`
      // (must be under /api/ so Next doesn't bundle it for the client).
      // This rewrite keeps the user-facing URL at `+"`"+`%s`+"`"+`.
      { source: '%s', destination: '%s' },
      { source: '%s/:path*', destination: '%s/:path*' },
    ]
  },`, mountPath, mountPath, mountPath, dest, mountPath, dest)

	if target == "" {
		// No next.config — write a minimal one.
		path := filepath.Join(cwd, "next.config.mjs")
		body := fmt.Sprintf("const config = {%s\n}\nexport default config\n", block)
		return os.WriteFile(path, []byte(body), 0o644)
	}

	// Empty default export: splice cleanly.
	emptyExportRE := regexp.MustCompile(`export default\s*\{\s*\}`)
	if emptyExportRE.MatchString(body) {
		patched := emptyExportRE.ReplaceAllString(body, fmt.Sprintf("export default {%s\n}", block))
		if err := safeBackup(target); err != nil {
			return err
		}
		return os.WriteFile(target, []byte(patched), 0o644)
	}

	// Populated default export: try to splice inside its body. The
	// externals patcher (running just after this) writes its own block
	// into the same `export default {…}`, so by the time we reach
	// here the file usually has a populated default. Match
	// `export default {<body>\n}` and splice before the closing brace.
	populatedExportRE := regexp.MustCompile(`(?s)export default\s*\{(.*?)\n\}`)
	if m := populatedExportRE.FindStringSubmatchIndex(body); m != nil {
		inner := body[m[2]:m[3]]
		patched := body[:m[0]] +
			"export default {" + inner + block + "\n}" +
			body[m[1]:]
		if err := safeBackup(target); err != nil {
			return err
		}
		return os.WriteFile(target, []byte(patched), 0o644)
	}

	// Anything else: emit a sibling suggestion. Matches the TS
	// fallback so users see the same message regardless of which CLI
	// version they were on.
	suggestion := fmt.Sprintf(`Add this to your Next.js config so the dashboard answers at the
URL you configured (the actual route file lives under `+"`"+`pages/api/`+"`"+`
to keep webpack from bundling it for the client):%s

`, block)
	return os.WriteFile(target+".gravel.next-config.rewrites.suggestion.txt", []byte(suggestion), 0o644)
}

// EnsureNextServerExternalPackages adds `@artanis-ai/gravel`, `pg`,
// and `better-sqlite3` to `serverExternalPackages` (Next 15) plus a
// webpack `externals` block for Pages Router. Without this, dashboard
// requests on hosts with `pg` or `better-sqlite3` in their dep tree
// 500 with "Module not found".
//
// Idempotent: if the package names already appear in the config body,
// return without touching anything.
//
// Mirrors packages/sdk-ts/src/wizard/mount.ts §ensureNextServerExternalPackages
// including the exact externals function shape (UNSHIFT a matcher
// that returns `commonjs <request>` for our packages so it runs
// before Next's default externals function, which webpack iterates
// left-to-right).
func EnsureNextServerExternalPackages(cwd string) error {
	target, body := findNextConfig(cwd)

	required := []string{"@artanis-ai/gravel", "pg", "better-sqlite3"}

	block := `
  serverExternalPackages: ['@artanis-ai/gravel', 'pg', 'better-sqlite3'],
  webpack: (cfg, { isServer }) => {
    if (isServer) {
      const externalize = (request) =>
        request === 'better-sqlite3' ||
        request === 'pg' ||
        request === 'fs' ||
        request === 'crypto' ||
        request === 'path' ||
        request.startsWith('@artanis-ai/gravel')
      // UNSHIFT (not push) so our matcher runs BEFORE Next's default
      // externals function. Pages Router otherwise bundles
      // better-sqlite3 -> 'fs' and bombs with "Module not found: 'fs'"
      // at compile time.
      const existing = Array.isArray(cfg.externals) ? cfg.externals : [cfg.externals].filter(Boolean)
      cfg.externals = [
        ({ request }, callback) => {
          if (request && externalize(request)) {
            return callback(null, 'commonjs ' + request)
          }
          callback()
        },
        ...existing,
      ]
    }
    return cfg
  },`

	// Already patched? Heuristic: webpack externals + every required
	// pkg name present somewhere in the file.
	if target != "" &&
		strings.Contains(body, "@artanis-ai/gravel") &&
		strings.Contains(body, "externals") &&
		allRequiredPresent(body, required) {
		return nil
	}

	if target == "" {
		path := filepath.Join(cwd, "next.config.mjs")
		body := fmt.Sprintf(`// Added by Gravel wizard. Keeps Next.js's webpack from trying to
// bundle gravel's native peer deps (pg, better-sqlite3) into the
// server bundle. `+"`"+`serverExternalPackages`+"`"+` covers App Router server
// code; the `+"`"+`webpack`+"`"+` externals block covers Pages Router API
// routes (which are still bundled by webpack).
const config = {%s
}
export default config
`, block)
		return os.WriteFile(path, []byte(body), 0o644)
	}

	emptyExportRE := regexp.MustCompile(`export default\s*\{\s*\}`)
	if emptyExportRE.MatchString(body) {
		patched := emptyExportRE.ReplaceAllString(body, fmt.Sprintf("export default {%s\n}", block))
		if err := safeBackup(target); err != nil {
			return err
		}
		return os.WriteFile(target, []byte(patched), 0o644)
	}

	// Populated config: don't risk corrupting it. Emit a sibling
	// .suggestion.txt with the exact snippet to paste.
	suggestion := fmt.Sprintf(`Add this to your Next.js config's exported object so the gravel
dashboard route doesn't 500 with "Module not found":%s

If you only use App Router, the `+"`"+`serverExternalPackages`+"`"+` line alone
is enough. The `+"`"+`webpack`+"`"+` block additionally keeps Pages Router API
routes from bundling the native peer deps.
`, block)
	return os.WriteFile(target+".gravel.next-config.suggestion.txt", []byte(suggestion), 0o644)
}

func allRequiredPresent(body string, required []string) bool {
	for _, pkg := range required {
		if !strings.Contains(body, "'"+pkg+"'") && !strings.Contains(body, `"`+pkg+`"`) {
			return false
		}
	}
	return true
}

// EnsureNextInstrumentation writes a Next.js `instrumentation.ts`
// that imports `@artanis-ai/gravel/auto` (installing the OpenAI /
// Anthropic / LangChain / fetch monkey-patches) and hands the
// resolved config to `setGravelTracingConfig` so the FIRST LLM call
// has a DB to land in.
//
// Idempotent:
//   - existing file imports @artanis-ai/gravel/auto + setGravelTracingConfig => no-op
//   - existing file has a register() but no gravel hook => write sibling .suggestion.txt
//   - no existing file => write a fresh one
func EnsureNextInstrumentation(cwd string, srcLayout bool) error {
	var candidates []string
	if srcLayout {
		candidates = []string{
			filepath.Join(cwd, "src", "instrumentation.ts"),
			filepath.Join(cwd, "instrumentation.ts"),
			filepath.Join(cwd, "src", "instrumentation.js"),
			filepath.Join(cwd, "instrumentation.js"),
		}
	} else {
		candidates = []string{
			filepath.Join(cwd, "instrumentation.ts"),
			filepath.Join(cwd, "src", "instrumentation.ts"),
			filepath.Join(cwd, "instrumentation.js"),
			filepath.Join(cwd, "src", "instrumentation.js"),
		}
	}

	var existing, existingBody string
	for _, p := range candidates {
		body, err := os.ReadFile(p)
		if err == nil {
			existing = p
			existingBody = string(body)
			break
		}
	}

	if existing != "" &&
		strings.Contains(existingBody, "@artanis-ai/gravel/auto") &&
		strings.Contains(existingBody, "setGravelTracingConfig") {
		return nil
	}

	configImport := "./gravel.config"
	if srcLayout {
		configImport = "../gravel.config"
	}

	body := fmt.Sprintf(`// Added by Gravel wizard. Next.js calls register() once on server
// startup; the canonical place to bootstrap server-side instrumentation.
// We import `+"`"+`@artanis-ai/gravel/auto`+"`"+` so the SDK's monkey-patches for
// OpenAI / Anthropic / LangChain / Vercel AI / raw fetch install
// before any LLM call fires, then we hand the resolved config to
// setGravelTracingConfig so traces have a DB to land in straight away
// (without this, the first LLM call before any /admin/ai/* request
// gets dropped because the handler hasn't initialised the DB yet).
//
// /* webpackIgnore: true */ keeps webpack from bundling the heavy SDK
// chunks into the edge runtime when the host has middleware (which
// forces instrumentation to compile for both runtimes). The runtime
// guard above ensures these imports only fire on the node runtime.
//
// See https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  await import(/* webpackIgnore: true */ '@artanis-ai/gravel/auto')
  const [{ setGravelTracingConfig, resolveConfig }, { config }] = await Promise.all([
    import(/* webpackIgnore: true */ '@artanis-ai/gravel'),
    import('%s'),
  ])
  setGravelTracingConfig(resolveConfig(config))
}
`, configImport)

	registerRE := regexp.MustCompile(`\bregister\s*\(`)
	if existing != "" && registerRE.MatchString(existingBody) {
		// Hand-written instrumentation: don't risk corrupting it.
		suggestion := fmt.Sprintf(`// Add this inside your existing register() function so gravel's
// auto-patches install on Next.js server boot AND the tracer has a
// DB to write to before the first request:

if (process.env.NEXT_RUNTIME === 'nodejs') {
  await import(/* webpackIgnore: true */ '@artanis-ai/gravel/auto')
  const [{ setGravelTracingConfig, resolveConfig }, { config }] = await Promise.all([
    import(/* webpackIgnore: true */ '@artanis-ai/gravel'),
    import('%s'),
  ])
  setGravelTracingConfig(resolveConfig(config))
}
`, configImport)
		return os.WriteFile(existing+".gravel.instrumentation.suggestion.txt", []byte(suggestion), 0o644)
	}

	target := candidates[0]
	if existing != "" {
		target = existing
		if err := safeBackup(existing); err != nil {
			return err
		}
	}
	return os.WriteFile(target, []byte(body), 0o644)
}

// InstallNextTracingHooks runs both ensureServerExternalPackages and
// ensureNextInstrumentation in the same order the TS wizard uses.
// Exposed as a single call so init can light up tracing in one step
// (the externals patch + instrumentation file have to land together
// to avoid an intermediate state where instrumentation tries to
// import the SDK but webpack can't resolve it yet).
func InstallNextTracingHooks(cwd string, srcLayout bool) error {
	if err := EnsureNextServerExternalPackages(cwd); err != nil {
		return err
	}
	return EnsureNextInstrumentation(cwd, srcLayout)
}
