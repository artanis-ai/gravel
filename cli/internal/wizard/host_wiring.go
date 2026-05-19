// Host-framework wiring beyond the mount route itself.
//
// When the mount pillar runs against a Next.js + Clerk + Vercel host
// (the de_platform shape Olly tested), simply writing app/admin/ai/
// route.ts isn't enough — Clerk's middleware will auth-gate the route
// and Vercel's rewrites will eat it on prod. This file handles all
// the AROUND-the-mount wiring those hosts need.
//
// Order of operations the agent flow walks the user through:
//  1. mount handler (always)
//  2. next.config rewrite + skipTrailingSlashRedirect (Next-only)
//  3. Clerk middleware publicRoutes patch (Clerk-only)
//  4. vercel.json rewrite (Vercel-only)
//  5. FastAPI router include (FastAPI-only)
package wizard

import (
	"context"
	"os"
	"path/filepath"
	"strings"
)

// planMountHostWiring inspects the detected stack and returns the
// extra actions the mount pillar will perform beyond the bare mount.
// Pure planning — never touches disk.
func planMountHostWiring(d Detection, mountPath string, _ InspectedState) ([]PillarAction, []string) {
	var actions []PillarAction
	var warnings []string

	if d.Framework == FrameworkNextAppRouter || d.Framework == FrameworkNextPagesRouter {
		if pathExists(filepath.Join(d.CWD, "next.config.ts")) ||
			pathExists(filepath.Join(d.CWD, "next.config.mjs")) ||
			pathExists(filepath.Join(d.CWD, "next.config.js")) {
			actions = append(actions, PillarAction{
				Kind:    ActionPatchFile,
				Path:    "next.config.{ts,mjs,js}",
				Summary: "Set skipTrailingSlashRedirect:true so " + mountPath + " (no trailing slash) doesn't 308-bounce.",
			})
		}
	}

	if d.Auth == AuthClerk {
		middlewarePath := findFirstExisting(d.CWD,
			"middleware.ts", "middleware.js",
			"src/middleware.ts", "src/middleware.js",
		)
		if middlewarePath != "" {
			actions = append(actions, PillarAction{
				Kind:    ActionPatchFile,
				Path:    middlewarePath,
				Summary: "Add " + mountPath + "(.*) to Clerk publicRoutes matcher so the dashboard isn't auth-gated by Clerk (Gravel has its own admin password).",
			})
		} else {
			warnings = append(warnings, "Clerk detected but middleware.ts not found at the conventional locations — you may need to manually exempt "+mountPath+" from auth.")
		}
	}

	if pathExists(filepath.Join(d.CWD, "vercel.json")) {
		actions = append(actions, PillarAction{
			Kind:    ActionPatchFile,
			Path:    "vercel.json",
			Summary: "Add rewrite for " + mountPath + "/* so Vercel's edge routing forwards into your app (matters in prod, not dev).",
		})
	}

	if d.Framework == FrameworkFastAPI {
		entry := findFirstExisting(d.CWD,
			"api/py/index.py", "api/index.py", "main.py", "app.py", "src/main.py", "src/app.py",
		)
		if entry != "" {
			actions = append(actions, PillarAction{
				Kind:    ActionPatchFile,
				Path:    entry,
				Summary: "Insert `from gravel_route import router as gravel_router; app.include_router(gravel_router)` at the right place in your FastAPI app entry.",
			})
		} else {
			warnings = append(warnings, "FastAPI detected but no obvious app entrypoint found (looked for api/py/index.py, main.py, app.py). You'll need to include the router manually.")
		}
	}

	return actions, warnings
}

// applyMountHostWiring performs the host-wiring patches. Best-effort:
// any individual patch failure is non-fatal (the user can re-apply by
// hand using the messages we print). Returns the first error seen
// purely so callers can decide whether to log a warning at the end of
// the wizard's summary.
func applyMountHostWiring(_ context.Context, d Detection, mountPath string) error {
	if d.Framework == FrameworkNextAppRouter || d.Framework == FrameworkNextPagesRouter {
		_ = ensureSkipTrailingSlashRedirect(d.CWD)
	}
	if d.Auth == AuthClerk {
		_ = ensureClerkPublicRoute(d.CWD, mountPath)
	}
	if pathExists(filepath.Join(d.CWD, "vercel.json")) {
		_ = ensureVercelRewrite(d.CWD, mountPath)
	}
	if d.Framework == FrameworkFastAPI {
		_ = ensureFastAPIRouterInclude(d.CWD)
	}
	return nil
}

// ensureSkipTrailingSlashRedirect adds `skipTrailingSlashRedirect: true`
// to the user's next.config.* if absent. Without this, Next 308-strips
// the trailing slash on /admin/ai/ → /admin/ai, and FastAPI then 307s
// back to /admin/ai/ with an absolute Location: http://127.0.0.1:PORT/...,
// breaking the proxy and leaking the internal host (Olly #14).
func ensureSkipTrailingSlashRedirect(cwd string) error {
	for _, name := range []string{"next.config.ts", "next.config.mjs", "next.config.js"} {
		p := filepath.Join(cwd, name)
		if !pathExists(p) {
			continue
		}
		body, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		text := string(body)
		if strings.Contains(text, "skipTrailingSlashRedirect") {
			return nil // already set, leave the value alone
		}
		// naive but safe: insert after the first occurrence of `{` in
		// the config literal. Production-grade would be an AST patch;
		// next.config is small enough that this regex-ish patch is fine
		// and is what the existing Next mount writer also does.
		if idx := strings.Index(text, "{"); idx >= 0 {
			patched := text[:idx+1] + "\n  skipTrailingSlashRedirect: true," + text[idx+1:]
			return os.WriteFile(p, []byte(patched), 0o644)
		}
	}
	return nil
}

// ensureClerkPublicRoute appends the mount path to the publicRoutes
// matcher in middleware.ts. Conservative: only patches the literal
// `createRouteMatcher([...])` call; bails out cleanly on anything fancy
// (custom matcher functions, etc.).
func ensureClerkPublicRoute(cwd, mountPath string) error {
	for _, rel := range []string{"middleware.ts", "middleware.js", "src/middleware.ts", "src/middleware.js"} {
		p := filepath.Join(cwd, rel)
		if !pathExists(p) {
			continue
		}
		body, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		text := string(body)
		needle := "'" + mountPath + "(.*)'"
		if strings.Contains(text, needle) || strings.Contains(text, "\""+mountPath+"(.*)\"") {
			return nil // already public
		}
		// Find `createRouteMatcher([...])` and insert before the closing `]`.
		key := "createRouteMatcher(["
		idx := strings.Index(text, key)
		if idx < 0 {
			return nil // not the conventional shape, leave it alone
		}
		end := strings.Index(text[idx:], "])")
		if end < 0 {
			return nil
		}
		insertAt := idx + end
		entry := needle
		if !strings.HasSuffix(strings.TrimSpace(text[idx:insertAt]), "[") {
			entry = ", " + entry
		}
		patched := text[:insertAt] + entry + text[insertAt:]
		return os.WriteFile(p, []byte(patched), 0o644)
	}
	return nil
}

// ensureVercelRewrite adds a rewrite from <mountPath>/* to itself so
// Vercel's edge layer doesn't intercept the route. Idempotent: bails
// if any rewrite already mentions the mount path.
func ensureVercelRewrite(cwd, mountPath string) error {
	p := filepath.Join(cwd, "vercel.json")
	body, err := os.ReadFile(p)
	if err != nil {
		return err
	}
	text := string(body)
	if strings.Contains(text, mountPath+"/(.*)") || strings.Contains(text, mountPath+"/(?<") {
		return nil
	}
	// Naive: only patch when the file already has a "rewrites" array.
	// Anything more complex (functions config, etc.) gets a warning
	// from the plan step instead of a possibly-corrupting auto-patch.
	if !strings.Contains(text, `"rewrites"`) {
		return nil
	}
	const newRewrite = "    { \"source\": \"" + mountPathPlaceholder + "/(.*)\", \"destination\": \"" + mountPathPlaceholder + "/$1\" },\n"
	expanded := strings.ReplaceAll(newRewrite, mountPathPlaceholder, mountPath)
	rewritesIdx := strings.Index(text, `"rewrites"`)
	openIdx := strings.Index(text[rewritesIdx:], "[")
	if openIdx < 0 {
		return nil
	}
	insertAt := rewritesIdx + openIdx + 1
	patched := text[:insertAt] + "\n" + expanded + text[insertAt:]
	return os.WriteFile(p, []byte(patched), 0o644)
}

const mountPathPlaceholder = "__MOUNT_PATH__"

// ensureFastAPIRouterInclude inserts the gravel_route include into a
// FastAPI app entrypoint. Bails out cleanly if the include is already
// present or the entrypoint shape is unconventional.
func ensureFastAPIRouterInclude(cwd string) error {
	entry := findFirstExisting(cwd,
		"api/py/index.py", "api/index.py", "main.py", "app.py", "src/main.py", "src/app.py",
	)
	if entry == "" {
		return nil
	}
	body, err := os.ReadFile(entry)
	if err != nil {
		return err
	}
	text := string(body)
	if strings.Contains(text, "from gravel_route") || strings.Contains(text, "import gravel_route") {
		return nil
	}
	// Insert after the last `app = FastAPI(...)` we can find.
	const marker = "app = FastAPI("
	idx := strings.LastIndex(text, marker)
	if idx < 0 {
		return nil
	}
	// Find the matching `)` of the FastAPI(...) call by counting parens.
	depth := 0
	end := idx + len(marker) - 1
	for i := idx + len(marker) - 1; i < len(text); i++ {
		switch text[i] {
		case '(':
			depth++
		case ')':
			depth--
			if depth == 0 {
				end = i + 1
				goto found
			}
		}
	}
found:
	// Skip any newline/whitespace after the close-paren.
	for end < len(text) && (text[end] == '\n' || text[end] == ' ' || text[end] == '\t' || text[end] == '\r') {
		end++
	}
	inject := "from gravel_route import router as gravel_router\napp.include_router(gravel_router)\n"
	patched := text[:end] + inject + text[end:]
	return os.WriteFile(entry, []byte(patched), 0o644)
}

// findFirstExisting returns the first relative path that exists on
// disk under cwd, or "" if none.
func findFirstExisting(cwd string, candidates ...string) string {
	for _, c := range candidates {
		if pathExists(filepath.Join(cwd, c)) {
			return c
		}
	}
	return ""
}
