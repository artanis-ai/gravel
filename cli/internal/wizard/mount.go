package wizard

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// MountMode discriminates what Mount actually did.
type MountMode string

const (
	MountCreated  MountMode = "created"
	MountUpdated  MountMode = "updated"
	MountManual   MountMode = "manual-instructions"
	MountSkipped  MountMode = "skipped"
)

// MountResult is the per-framework outcome of mounting the dashboard route.
type MountResult struct {
	Path         string    // filesystem path of the file written / target file (empty for manual modes)
	Mode         MountMode // how the wizard handled it
	Instructions string    // human-readable instructions for the user (only populated for MountManual)
}

// MountOptions toggles tracing-only side effects.
type MountOptions struct {
	WithTracingDeps bool
}

// Mount writes (or stages) the dashboard route file for the detected
// framework. Mirrors packages/sdk-ts/src/wizard/mount.ts's
// `mountDashboardRoute`.
//
// For App / Pages Router we write the route file directly. For
// Express / FastAPI / Django / generic stacks we return manual
// instructions — the AST-patcher for those frameworks is deferred
// behind the demo path and the v0 wizard prints copy-paste guidance
// (matching the existing TS behaviour).
func Mount(d Detection, mountPath string, opts MountOptions) (MountResult, error) {
	if mountPath == "" {
		mountPath = "/admin/ai"
	}
	switch d.Framework {
	case FrameworkNextAppRouter:
		return mountNextAppRouter(d, mountPath, opts)
	case FrameworkNextPagesRouter:
		return mountNextPagesRouter(d, mountPath, opts)
	case FrameworkFastAPI:
		// Auto-patches main.py / app.py / src/main.py / src/app.py /
		// app/main.py to add `gravel_route` import + include_router.
		// Falls back to instructions only when no FastAPI() ctor is
		// found in any of those files.
		return mountFastAPI(d, mountPath)
	case FrameworkDjango:
		// Auto-patches the project's root urls.py to insert the
		// gravel include as the FIRST entry of urlpatterns. Falls
		// back to instructions only when no settings.py-sibling
		// urls.py can be located.
		return mountDjango(d, mountPath)
	case FrameworkExpress:
		// Auto-patches index.js / server.js / app.js / src/*.{js,ts}
		// to add `gravelHandler` import + `app.use(...)`. Falls back
		// to instructions only when no `<name> = express()` ctor can
		// be located OR the ctor is inside a function/class body.
		return mountExpress(d, mountPath)
	case FrameworkHono:
		// Auto-patches index.ts / src/index.ts / worker.ts / etc. to
		// add `createGravelHandler` import + `app.mount(...)`. Uses
		// the main `@artanis-ai/gravel` entry (web-standard handler)
		// rather than `/node` because Hono natively speaks fetch.
		return mountHono(d, mountPath)
	case FrameworkFastify:
		// Auto-patches the Fastify entry to register
		// `gravelFastifyPlugin` (from @artanis-ai/gravel/fastify, a
		// dedicated SDK adapter that handles Fastify's prefix-
		// stripping correctly — see comments at the top of
		// mount_fastify.go).
		return mountFastify(d, mountPath)
	default:
		return manual(genericInstructions(mountPath)), nil
	}
}

// mountNextAppRouter writes `app/<segs>/[[...slug]]/route.ts` (or
// the src/ equivalent) with a force-dynamic export so Next doesn't
// cache stale manifest/sample/auth responses.
func mountNextAppRouter(d Detection, mountPath string, opts MountOptions) (MountResult, error) {
	segments := splitPath(mountPath)
	appSegments := strings.Split(string(d.NextAppDir), "/")
	parts := append([]string{}, appSegments...)
	parts = append(parts, segments...)
	parts = append(parts, "[[...slug]]")
	dir := filepath.Join(append([]string{d.CWD}, parts...)...)
	file := filepath.Join(dir, "route.ts")

	if pathExists(file) {
		if err := safeBackup(file); err != nil {
			return MountResult{}, err
		}
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return MountResult{}, err
	}

	// Same import-path logic as the TS reference. src/ projects often
	// have `@/*` mapped to `./src/*`, which would resolve
	// `@/gravel.config` to `./src/gravel.config` — but the wizard
	// writes the config at the project root. Use a relative path
	// instead in that case.
	configImport := "@/gravel.config"
	if d.NextAppDir == "src/app" {
		depth := len(segments) + 3 // src/app + segs + [[...slug]]
		configImport = strings.Repeat("../", depth) + "gravel.config"
	}

	body := fmt.Sprintf(`import { createGravelHandler } from '@artanis-ai/gravel/next'
import { config } from '%s'

// Force-dynamic so Next never caches a snapshot of the manifest /
// samples / auth state. The dashboard polls these endpoints; cached
// responses make new prompts (or freshly-written drafts) invisible
// until the dev server restarts.
export const dynamic = 'force-dynamic'

const handler = createGravelHandler({ config })

export const GET = handler
export const POST = handler
export const PUT = handler
export const DELETE = handler
`, configImport)

	if err := os.WriteFile(file, []byte(body), 0o644); err != nil {
		return MountResult{}, err
	}
	if opts.WithTracingDeps {
		if err := InstallNextTracingHooks(d.CWD, d.NextAppDir == "src/app"); err != nil {
			return MountResult{}, err
		}
	}
	return MountResult{Path: file, Mode: MountCreated}, nil
}

// mountNextPagesRouter writes pages/api/<segs>/[[...slug]].ts and
// patches next.config to rewrite `<mountPath>/*` to `/api<mountPath>/*`
// so the user-facing URL stays at `mountPath` while the route file
// lives under pages/api/ (which it must, otherwise Next bundles it
// for the client and webpack chokes on the SDK's transitive fs/db
// requires).
func mountNextPagesRouter(d Detection, mountPath string, opts MountOptions) (MountResult, error) {
	segments := splitPath(mountPath)
	// Route must live under pages/api/ so Next doesn't bundle it for
	// the client (which breaks on the SDK's transitive `fs` /
	// `better-sqlite3` requires).
	parts := append([]string{"pages", "api"}, segments...)
	dir := filepath.Join(append([]string{d.CWD}, parts...)...)
	file := filepath.Join(dir, "[[...slug]].ts")
	if pathExists(file) {
		if err := safeBackup(file); err != nil {
			return MountResult{}, err
		}
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return MountResult{}, err
	}
	depth := len(segments) + 2 // pages/api + segs
	configImport := strings.Repeat("../", depth) + "gravel.config"
	body := fmt.Sprintf(`import { createGravelHandler } from '@artanis-ai/gravel/next-pages'
import { config } from '%s'

export default createGravelHandler({ config })
`, configImport)
	if err := os.WriteFile(file, []byte(body), 0o644); err != nil {
		return MountResult{}, err
	}
	if err := EnsureNextPagesRewrite(d.CWD, mountPath); err != nil {
		return MountResult{}, err
	}
	if opts.WithTracingDeps {
		// Pages projects with src/ layout still keep `pages/` at the
		// root by convention; the helper probes both candidate paths
		// internally so passing srcLayout=false is correct here.
		if err := InstallNextTracingHooks(d.CWD, false); err != nil {
			return MountResult{}, err
		}
	}
	return MountResult{Path: file, Mode: MountCreated}, nil
}

// safeBackup preserves any existing user content at `path` before the
// wizard overwrites it.
//
//	* If the file is inside a git working tree (we walk up looking for
//	  a `.git` dir), git is the safety net: we skip the .bak entirely.
//	  The user can `git diff` / `git checkout --` if they want to undo,
//	  and there's no .gravel.bak clutter polluting the working tree.
//	* If there's no git repo, we rename to `<path>.gravel.bak` so an
//	  accidental overwrite is recoverable. Up to three prior versions
//	  are kept (`.gravel.bak`, `.gravel.bak.2`, `.gravel.bak.3`); beyond
//	  that the user is on their own.
//
// Callers must invoke safeBackup BEFORE writing the new content,
// always.
func safeBackup(path string) error {
	if isInsideGitWorkTree(path) {
		// Git already has the file; no .bak needed. The new write will
		// land on top of the tracked file and `git diff` shows the
		// change. Avoids littering working trees with .gravel.bak files
		// that users then have to add to .gitignore or delete.
		return nil
	}
	bak := path + ".gravel.bak"
	for i := 2; pathExists(bak) && i <= 4; i++ {
		bak = fmt.Sprintf("%s.gravel.bak.%d", path, i)
	}
	return os.Rename(path, bak)
}

// isInsideGitWorkTree walks up from path looking for a `.git`
// directory (or `.git` file, for git worktrees). Returns true at the
// first hit. Stops at the filesystem root.
//
// We don't shell out to `git` for this: a thousand-line wizard
// shouldn't fork a subprocess just to ask a yes/no question, and
// `git` may not be on PATH in some CI environments.
func isInsideGitWorkTree(path string) bool {
	dir := path
	// Resolve to an absolute path so `..` walks terminate predictably.
	if abs, err := filepath.Abs(dir); err == nil {
		dir = abs
	}
	// Climb from the file's parent dir up to root.
	dir = filepath.Dir(dir)
	for {
		if pathExists(filepath.Join(dir, ".git")) {
			return true
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return false
		}
		dir = parent
	}
}

// splitPath trims a leading slash and returns non-empty segments.
func splitPath(p string) []string {
	p = strings.TrimPrefix(p, "/")
	if p == "" {
		return nil
	}
	out := []string{}
	for _, s := range strings.Split(p, "/") {
		if s != "" {
			out = append(out, s)
		}
	}
	return out
}

func manual(instructions string) MountResult {
	return MountResult{Mode: MountManual, Instructions: instructions}
}

// --- per-framework instruction templates --------------------------------------

func fastapiInstructions(mountPath string) string {
	return fmt.Sprintf(`FastAPI projects: import the Gravel router in your app entry.

from artanis_gravel.fastapi import create_gravel_router
from gravel_config import config

app.include_router(create_gravel_router(config), prefix='%s')
`, mountPath)
}

func djangoInstructions(mountPath string) string {
	return fmt.Sprintf(`Django projects: add the Gravel URL handler to your urls.py.

from artanis_gravel.django import gravel_urls
from gravel_config import config

urlpatterns = [
    *gravel_urls(config, prefix='%s'),
    # …your existing patterns
]
`, mountPath)
}

func expressInstructions(mountPath string) string {
	return fmt.Sprintf(`Express projects: mount the handler on your app.

import { gravelHandler } from '@artanis-ai/gravel/node'
import { config } from './gravel.config'

app.use('%s', gravelHandler({ config }))

(CommonJS: replace the imports with require() of the same modules.)
`, mountPath)
}

func genericInstructions(mountPath string) string {
	return fmt.Sprintf(`Generic Node/server: import @artanis-ai/gravel/node, pass your config,
and mount the returned handler at %s. See https://gravel.artanis.ai/docs/integration
for examples.
`, mountPath)
}
