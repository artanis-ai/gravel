package wizard

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// mount_hono.go: Hono auto-mount. Cleaner shape than Express
// because Hono natively speaks web-standard Request/Response and
// has `app.mount(path, fetchHandler)` that accepts our SDK's
// createGravelHandler return value directly — no bridging adapter
// needed, no Context-extraction wrappers.
//
// The patched line is:
//
//   app.mount(config.mountPath, createGravelHandler({ config }))
//
// imported from `@artanis-ai/gravel` (the main entry, web-standard
// handler), not `/node` (which wraps for Node's IncomingMessage and
// is for Express/Fastify/raw http).

// honoEntryCandidates are the conventional locations a Hono app
// lives. Hono is most common on Cloudflare Workers, Bun, Deno —
// projects that tend to put the entry in src/.
var honoEntryCandidates = []string{
	"index.ts", "index.js", "index.mjs", "index.mts",
	"src/index.ts", "src/index.js", "src/index.mjs", "src/index.mts",
	"app.ts", "app.js", "app.mjs", "app.mts",
	"src/app.ts", "src/app.js", "src/app.mjs", "src/app.mts",
	"server.ts", "server.js", "server.mjs", "server.mts",
	"src/server.ts", "src/server.js", "src/server.mjs", "src/server.mts",
	// Cloudflare Workers convention: src/worker.ts / worker.ts.
	"worker.ts", "src/worker.ts",
}

// honoDirSkip reuses expressDirSkip; the noise dirs are the same
// (node_modules, dist, build, .next, .turbo, etc.). Aliased for
// readability — if Hono ever grows its own list we change just one.
var honoDirSkip = expressDirSkip

// topLevelHonoCtorRE matches `<keyword> <name> = new Hono(...)` at
// column zero, with optional TypeScript type annotation between
// name and `=`, AND optional generic type parameter between `Hono`
// and `(` (e.g. `new Hono<{ Bindings: Env }>()` — the Cloudflare
// Workers idiom).
//
// Submatch order:
//   m[2..3]  variable name
var topLevelHonoCtorRE = regexp.MustCompile(`(?m)^(?:const|let|var)[ \t]+(\w+)(?:[ \t]*:[ \t]*[^=\n]+?)?[ \t]*=[ \t]*new[ \t]+Hono(?:[ \t]*<[^>]*>)?[ \t]*\(`)

// gravelHonoMountedRE is the idempotency check — `app.mount(...,
// createGravelHandler({ config }))` regardless of the app name.
var gravelHonoMountedRE = regexp.MustCompile(`\.mount\s*\([^)]*createGravelHandler\s*\(\s*\{\s*config\s*\}\s*\)`)

// mountHono is the Mount() dispatch's Hono entrypoint.
func mountHono(d Detection, mountPath string) (MountResult, error) {
	for _, rel := range honoEntryCandidates {
		if res, ok := tryPatchHonoEntry(d.CWD, rel, mountPath); ok {
			return res, nil
		}
	}
	for _, rel := range findHonoEntries(d.CWD) {
		if res, ok := tryPatchHonoEntry(d.CWD, rel, mountPath); ok {
			return res, nil
		}
	}
	return manual(honoInstructions(mountPath)), nil
}

// tryPatchHonoEntry mirrors tryPatchExpressEntry. The Hono variant
// is simpler because the framework speaks web-standard fetch
// natively — no CJS/ESM bridge logic needed (Hono ships TS-first;
// .cjs entries are vanishingly rare).
func tryPatchHonoEntry(cwd, rel, mountPath string) (MountResult, bool) {
	entryPath := filepath.Join(cwd, rel)
	original, err := os.ReadFile(entryPath)
	if err != nil {
		return MountResult{}, false
	}
	src := string(original)

	if gravelHonoMountedRE.MatchString(src) {
		return MountResult{Path: entryPath, Mode: MountUpdated}, true
	}
	if !topLevelHonoCtorRE.MatchString(src) {
		return MountResult{}, false
	}
	isESM := entryUsesESM(cwd, entryPath, src)
	patched := patchHonoEntryMain(src, isESM)
	if patched == src {
		return manual(honoInstructions(mountPath) + "\nTarget file: " + rel), true
	}
	if err := safeBackup(entryPath); err != nil {
		return MountResult{}, false
	}
	if err := os.WriteFile(entryPath, []byte(patched), 0o644); err != nil {
		return MountResult{}, false
	}
	return MountResult{Path: entryPath, Mode: MountUpdated}, true
}

func findHonoEntries(cwd string) []string {
	var matches []string
	root := filepath.Clean(cwd)
	_ = filepath.WalkDir(root, func(path string, dirent os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if dirent.IsDir() {
			if path == root {
				return nil
			}
			if honoDirSkip[dirent.Name()] || strings.HasPrefix(dirent.Name(), ".") {
				return filepath.SkipDir
			}
			rel, _ := filepath.Rel(root, path)
			if depth := strings.Count(rel, string(filepath.Separator)); depth >= 6 {
				return filepath.SkipDir
			}
			return nil
		}
		ext := filepath.Ext(dirent.Name())
		if ext != ".js" && ext != ".ts" && ext != ".mjs" && ext != ".cjs" && ext != ".mts" && ext != ".cts" && ext != ".tsx" {
			return nil
		}
		if strings.HasSuffix(dirent.Name(), ".d.ts") {
			return nil
		}
		body, err := os.ReadFile(path)
		if err != nil {
			return nil
		}
		if !topLevelHonoCtorRE.Match(body) {
			return nil
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return nil
		}
		matches = append(matches, filepath.ToSlash(rel))
		return nil
	})
	sort.SliceStable(matches, func(i, j int) bool {
		di := strings.Count(matches[i], "/")
		dj := strings.Count(matches[j], "/")
		if di != dj {
			return di < dj
		}
		return matches[i] < matches[j]
	})
	return matches
}

// patchHonoEntryMain inserts the gravel imports + `<app>.mount(...)`
// call. Same paren-balanced scan as the Express patcher; refuses
// to patch if the ctor is inside a function/class body (column-zero
// invariant enforced by topLevelHonoCtorRE).
func patchHonoEntryMain(source string, isESM bool) string {
	m := topLevelHonoCtorRE.FindStringSubmatchIndex(source)
	if m == nil {
		return source
	}
	appName := source[m[2]:m[3]]
	openParenPos := m[1] - 1
	closeParenPos := matchClosingParen(source, openParenPos)
	if closeParenPos < 0 {
		return source
	}

	imports := buildHonoImports(isESM)
	withImports := source
	if isESM {
		withImports = insertAfterLastImport(source, imports)
	} else {
		withImports = insertAfterLastRequire(source, imports)
	}
	shift := len(withImports) - len(source)
	closeParenPos += shift

	lineEnd := strings.IndexByte(withImports[closeParenPos:], '\n')
	var insertAt int
	if lineEnd < 0 {
		insertAt = len(withImports)
	} else {
		insertAt = closeParenPos + lineEnd
	}
	mountLine := fmt.Sprintf("\n%s.mount(config.mountPath, createGravelHandler({ config }))\n", appName)
	return withImports[:insertAt] + mountLine + withImports[insertAt+1:]
}

// buildHonoImports returns the import block to inject. Note that
// Hono uses `@artanis-ai/gravel` (main entry, web-standard handler),
// not `/node` — the SDK's createGravelHandler returns a fetch-style
// `(req: Request) => Promise<Response>` which is exactly what
// Hono's `.mount()` expects.
func buildHonoImports(isESM bool) string {
	if isESM {
		return "import { createGravelHandler } from '@artanis-ai/gravel'\n" +
			"import { config } from './gravel.config'\n"
	}
	return "const { createGravelHandler } = require('@artanis-ai/gravel')\n" +
		"const { config } = require('./gravel.config')\n"
}

// honoInstructions is what we surface when no entry can be found
// (rare for Hono — entries are conventionally at index.ts).
func honoInstructions(mountPath string) string {
	return fmt.Sprintf(`Hono projects: mount the handler on your app.

import { createGravelHandler } from '@artanis-ai/gravel'
import { config } from './gravel.config'

app.mount(config.mountPath, createGravelHandler({ config }))

(CommonJS: replace imports with require() of the same modules. Note
that Hono itself ships ESM-first; check that your runtime supports
ESM before falling back.)

If you'd rather hardcode the path: app.mount('%s', createGravelHandler({ config })).
`, mountPath)
}
