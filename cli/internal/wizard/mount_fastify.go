package wizard

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// mount_fastify.go: Fastify auto-mount. Uses a dedicated SDK adapter
// (`@artanis-ai/gravel/fastify` → `gravelFastifyPlugin`) rather than
// the generic /node adapter Express uses.
//
// Why a dedicated adapter:
//   * Fastify's `register(plugin, { prefix })` strips the prefix from
//     `request.url` but NOT `request.raw.url`. The /node adapter uses
//     `request.raw.url`, so URLs would arrive with the prefix still
//     attached and the SDK handler would 404 every route.
//   * The SDK's gravelFastifyPlugin builds a fetch Request from
//     `request.url` (correctly stripped), bypassing the IncomingMessage
//     bridge entirely.
//
// The patched line is:
//
//   fastify.register(gravelFastifyPlugin(config), { prefix: config.mountPath })
//
// Plugin registration order matters in Fastify (plugins are processed
// in registration order before `listen()` is called), so we insert
// directly after the `const fastify = Fastify()` line and before any
// existing user middleware / route registrations.

// fastifyEntryCandidates is the search order before tree-walking.
// Fastify projects conventionally have the entry at the root or
// under src/.
var fastifyEntryCandidates = []string{
	"index.js", "index.ts", "index.mjs", "index.cjs", "index.mts",
	"server.js", "server.ts", "server.mjs", "server.cjs", "server.mts",
	"app.js", "app.ts", "app.mjs", "app.cjs", "app.mts",
	"src/index.js", "src/index.ts", "src/index.mjs", "src/index.cjs", "src/index.mts",
	"src/server.js", "src/server.ts", "src/server.mjs", "src/server.cjs", "src/server.mts",
	"src/app.js", "src/app.ts", "src/app.mjs", "src/app.cjs", "src/app.mts",
}

// fastifyDirSkip reuses expressDirSkip (same Node ecosystem noise).
var fastifyDirSkip = expressDirSkip

// topLevelFastifyCtorRE matches `<keyword> <name> = Fastify(...)` or
// `<keyword> <name> = fastify(...)` at column zero. Both casings are
// common: `Fastify` for the default-import convention (which is
// what fastify.io's docs use), `fastify` for the named-import alias.
//
// Optional type annotation handles `const fastify: FastifyInstance = Fastify()`.
//
// Submatch order: m[2..3] = variable name.
var topLevelFastifyCtorRE = regexp.MustCompile(`(?m)^(?:const|let|var)[ \t]+(\w+)(?:[ \t]*:[ \t]*[^=\n]+?)?[ \t]*=[ \t]*[Ff]astify[ \t]*\(`)

// gravelFastifyPluginRE matches the registered-plugin line we emit
// — used for idempotency on re-runs.
var gravelFastifyPluginRE = regexp.MustCompile(`\.register\s*\(\s*gravelFastifyPlugin\s*\(`)

// mountFastify is the Mount() dispatch's Fastify entrypoint.
func mountFastify(d Detection, mountPath string) (MountResult, error) {
	for _, rel := range fastifyEntryCandidates {
		if res, ok := tryPatchFastifyEntry(d.CWD, rel, mountPath); ok {
			return res, nil
		}
	}
	for _, rel := range findFastifyEntries(d.CWD) {
		if res, ok := tryPatchFastifyEntry(d.CWD, rel, mountPath); ok {
			return res, nil
		}
	}
	return manual(fastifyInstructions(mountPath)), nil
}

func tryPatchFastifyEntry(cwd, rel, mountPath string) (MountResult, bool) {
	entryPath := filepath.Join(cwd, rel)
	original, err := os.ReadFile(entryPath)
	if err != nil {
		return MountResult{}, false
	}
	src := string(original)

	if gravelFastifyPluginRE.MatchString(src) {
		return MountResult{Path: entryPath, Mode: MountUpdated}, true
	}
	if !topLevelFastifyCtorRE.MatchString(src) {
		return MountResult{}, false
	}
	isESM := entryUsesESM(cwd, entryPath, src)
	patched := patchFastifyEntryMain(src, isESM)
	if patched == src {
		return manual(fastifyInstructions(mountPath) + "\nTarget file: " + rel), true
	}
	if err := safeBackup(entryPath); err != nil {
		return MountResult{}, false
	}
	if err := os.WriteFile(entryPath, []byte(patched), 0o644); err != nil {
		return MountResult{}, false
	}
	return MountResult{Path: entryPath, Mode: MountUpdated}, true
}

func findFastifyEntries(cwd string) []string {
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
			if fastifyDirSkip[dirent.Name()] || strings.HasPrefix(dirent.Name(), ".") {
				return filepath.SkipDir
			}
			rel, _ := filepath.Rel(root, path)
			if depth := strings.Count(rel, string(filepath.Separator)); depth >= 6 {
				return filepath.SkipDir
			}
			return nil
		}
		ext := filepath.Ext(dirent.Name())
		if ext != ".js" && ext != ".ts" && ext != ".mjs" && ext != ".cjs" && ext != ".mts" && ext != ".cts" {
			return nil
		}
		if strings.HasSuffix(dirent.Name(), ".d.ts") {
			return nil
		}
		body, err := os.ReadFile(path)
		if err != nil {
			return nil
		}
		if !topLevelFastifyCtorRE.Match(body) {
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

// patchFastifyEntryMain inserts the gravel imports + plugin register
// call. Same column-zero-only invariant as Express/Hono.
func patchFastifyEntryMain(source string, isESM bool) string {
	m := topLevelFastifyCtorRE.FindStringSubmatchIndex(source)
	if m == nil {
		return source
	}
	appName := source[m[2]:m[3]]
	openParenPos := m[1] - 1
	closeParenPos := matchClosingParen(source, openParenPos)
	if closeParenPos < 0 {
		return source
	}

	imports := buildFastifyImports(isESM)
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
	registerLine := fmt.Sprintf(
		"\n%s.register(gravelFastifyPlugin(config), { prefix: config.mountPath })\n",
		appName,
	)
	return withImports[:insertAt] + registerLine + withImports[insertAt+1:]
}

func buildFastifyImports(isESM bool) string {
	if isESM {
		return "import { gravelFastifyPlugin } from '@artanis-ai/gravel/fastify'\n" +
			"import { config } from './gravel.config'\n"
	}
	return "const { gravelFastifyPlugin } = require('@artanis-ai/gravel/fastify')\n" +
		"const { config } = require('./gravel.config')\n"
}

func fastifyInstructions(mountPath string) string {
	return fmt.Sprintf(`Fastify projects: mount the plugin on your fastify instance.

import { gravelFastifyPlugin } from '@artanis-ai/gravel/fastify'
import { config } from './gravel.config'

fastify.register(gravelFastifyPlugin(config), { prefix: config.mountPath })

(CommonJS: replace imports with require() of the same modules. Register
the plugin BEFORE fastify.listen() — Fastify processes registrations
in order during bootstrap.)

If you'd rather hardcode the path: { prefix: '%s' }.
`, mountPath)
}
