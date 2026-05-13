package wizard

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// mount_express.go: Express auto-mount. Parallels mount_python.go's
// FastAPI patcher in structure and rigor — same two-phase search
// (fast hard-coded candidate list + tree-walk fallback), same
// column-zero / refuses-inside-function-body invariants, same
// idempotency check on re-runs.
//
// The patched line is:
//
//   app.use(config.mountPath, gravelHandler({ config }))
//
// using `config.mountPath` so the prefix follows whatever the user
// configured in their gravel.config.ts (no double-source-of-truth
// for the mount path).

// expressEntryCandidates is the search order the patcher tries
// before walking the tree. Covers `npm init` defaults
// (`index.js`/`index.ts`), the convention of `server.js`/`server.ts`
// most express tutorials use, and the `src/` variants.
var expressEntryCandidates = []string{
	"index.js", "index.ts", "index.mjs", "index.cjs",
	"server.js", "server.ts", "server.mjs", "server.cjs",
	"app.js", "app.ts", "app.mjs", "app.cjs",
	"src/index.js", "src/index.ts", "src/index.mjs", "src/index.cjs",
	"src/server.js", "src/server.ts", "src/server.mjs", "src/server.cjs",
	"src/app.js", "src/app.ts", "src/app.mjs", "src/app.cjs",
}

// expressDirSkip mirrors fastAPIDirSkip but tuned for Node trees:
// node_modules and build outputs (dist/build/out/.next/.nuxt/.turbo)
// are walked-past wholesale.
var expressDirSkip = map[string]bool{
	"node_modules":  true,
	".git":          true,
	".next":         true,
	".nuxt":         true,
	".turbo":        true,
	".vercel":       true,
	".svelte-kit":   true,
	"dist":          true,
	"build":         true,
	"out":           true,
	"coverage":      true,
	".cache":        true,
}

// topLevelExpressCtorRE locates a module-level `<name> = express()`
// binding. Same requirements as topLevelCtorRE for FastAPI:
//   * Column zero (no leading whitespace). Indentation = inside a
//     function/class body = wrong scope to insert middleware.
//   * Optional TypeScript type annotation between name and `=`:
//     `const app: Application = express()` or `const app: express.Application = express()`.
//   * Optional `const` / `let` / `var` keyword before the name.
//
// Submatch order (in m[]):
//   m[0..1]  full match
//   m[2..3]  variable name (e.g. "app", "application")
var topLevelExpressCtorRE = regexp.MustCompile(`(?m)^(?:const|let|var)[ \t]+(\w+)(?:[ \t]*:[ \t]*[^=\n]+?)?[ \t]*=[ \t]*express[ \t]*\(`)

// gravelMountPatchedRE checks whether the entry already contains the
// gravel mount call. Used for idempotency on re-runs: re-running the
// wizard against an already-installed project must not double-patch.
var gravelMountPatchedRE = regexp.MustCompile(`gravelHandler\s*\(\s*\{\s*config\s*\}\s*\)`)

// mountExpress patches the user's Express entry file to add the
// gravel mount, mirroring mountFastAPI's two-phase search.
//
// Returns MountResult{Mode: MountManual} only when no entry file
// with a top-level `<name> = express()` declaration can be found
// anywhere, OR when the scanner refuses to patch what it found
// (factory function, nested in a class, etc.).
func mountExpress(d Detection, mountPath string) (MountResult, error) {
	for _, rel := range expressEntryCandidates {
		if res, ok := tryPatchExpressEntry(d.CWD, rel, mountPath); ok {
			return res, nil
		}
	}
	for _, rel := range findExpressEntries(d.CWD) {
		if res, ok := tryPatchExpressEntry(d.CWD, rel, mountPath); ok {
			return res, nil
		}
	}
	return manual(expressInstructions(mountPath)), nil
}

// tryPatchExpressEntry reads a candidate file, checks for an Express
// app declaration, and applies the patcher if one is present.
// Returns (result, true) on a successful patch or idempotent
// re-detection; (zero, false) when the file isn't a real Express
// entry so the caller can try the next candidate.
func tryPatchExpressEntry(cwd, rel, mountPath string) (MountResult, bool) {
	entryPath := filepath.Join(cwd, rel)
	original, err := os.ReadFile(entryPath)
	if err != nil {
		return MountResult{}, false
	}
	src := string(original)

	// Idempotent: leave already-patched entries alone.
	if gravelMountPatchedRE.MatchString(src) {
		return MountResult{Path: entryPath, Mode: MountUpdated}, true
	}

	// Must contain a top-level `const app = express()` binding.
	if !topLevelExpressCtorRE.MatchString(src) {
		return MountResult{}, false
	}

	isESM := entryUsesESM(cwd, entryPath, src)
	patched := patchExpressEntryMain(src, mountPath, isESM)
	if patched == src {
		// Top-level ctor was located but the patcher refused
		// (unbalanced parens, etc.). Surface this specific file in
		// the manual instructions so the user knows where to look.
		return manual(expressInstructions(mountPath) + "\nTarget file: " + rel), true
	}
	if err := safeBackup(entryPath); err != nil {
		return MountResult{}, false
	}
	if err := os.WriteFile(entryPath, []byte(patched), 0o644); err != nil {
		return MountResult{}, false
	}
	return MountResult{Path: entryPath, Mode: MountUpdated}, true
}

// findExpressEntries walks the project tree for any JS/TS file that
// declares a top-level `<name> = express()`. Returns relative paths
// sorted by directory depth ascending so a root-level entry wins
// over a deep nested one. Skips obvious noise (node_modules,
// dist/build/out, .next/.turbo/etc.) and caps depth at 6.
func findExpressEntries(cwd string) []string {
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
			if expressDirSkip[dirent.Name()] || strings.HasPrefix(dirent.Name(), ".") {
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
		// Skip type-declaration files (`*.d.ts`); they can't contain
		// runnable express() ctors.
		if strings.HasSuffix(dirent.Name(), ".d.ts") {
			return nil
		}
		body, err := os.ReadFile(path)
		if err != nil {
			return nil
		}
		if !topLevelExpressCtorRE.Match(body) {
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

// entryUsesESM returns true when the entry should be patched with
// `import` syntax rather than `require()`. Detection order:
//   1. File extension: `.mts`/`.mjs`/`.ts`/`.tsx` → ESM
//                       `.cts`/`.cjs`            → CJS
//   2. For `.js` (ambiguous): check the package.json containing this
//      file for `"type": "module"`.
//   3. Fallback: presence of any top-level `import ` statement in the
//      file (TS without `"type": "module"` still emits import syntax).
//   4. Default: CJS — the safer assumption for stock `npm init`
//      projects.
func entryUsesESM(cwd, entryPath, src string) bool {
	ext := filepath.Ext(entryPath)
	switch ext {
	case ".mts", ".mjs", ".ts", ".tsx":
		return true
	case ".cts", ".cjs":
		return false
	}
	// .js — ambiguous. Walk up looking for the owning package.json.
	dir := filepath.Dir(entryPath)
	for i := 0; i < 6; i++ {
		body, err := os.ReadFile(filepath.Join(dir, "package.json"))
		if err == nil {
			var pkg struct {
				Type string `json:"type"`
			}
			if json.Unmarshal(body, &pkg) == nil {
				if pkg.Type == "module" {
					return true
				}
				if pkg.Type == "commonjs" {
					return false
				}
				// Type unset — fall through to content heuristic.
				break
			}
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	// Content heuristic: presence of a top-level `import ` statement
	// strongly implies ESM (CJS would use require). Match at column 0
	// to avoid `import` inside a string literal or comment.
	if regexp.MustCompile(`(?m)^import\s+`).MatchString(src) {
		return true
	}
	return false
}

// patchExpressEntryMain inserts the gravel mount into the user's
// Express entry source. Returns the source unchanged when the
// scanner refuses (paren imbalance, factory pattern, etc.).
//
// Insertion strategy:
//   1. Add the gravel-handler import / require at the top of the
//      imports section. Heuristic: insert after the last
//      `import .../require(...)` line we can find; if none, prepend.
//   2. Add the gravel-config import next to the handler import (same
//      mechanism).
//   3. Insert `<app>.use(config.mountPath, gravelHandler({ config }))`
//      on the line directly after the `<name> = express()` ctor.
//
// Tested in mount_express_test.go: single-line ctor, multi-line ctor,
// typed ctors (`const app: Application = express()`), let / var,
// idempotency, factory-function refusal, class-body refusal, ESM vs
// CJS emission, candidate-order tie-breaking.
func patchExpressEntryMain(source, mountPath string, isESM bool) string {
	// Locate the `<name> = express(` opener at column 0.
	m := topLevelExpressCtorRE.FindStringSubmatchIndex(source)
	if m == nil {
		return source
	}
	appName := source[m[2]:m[3]]
	// m[1] is one past the opening '(' of `express(`; back up one to
	// land on the paren itself.
	openParenPos := m[1] - 1
	closeParenPos := matchClosingParen(source, openParenPos)
	if closeParenPos < 0 {
		return source
	}

	// --- imports/requires --------------------------------------------
	imports := buildExpressImports(isESM)
	withImports := source
	if isESM {
		withImports = insertAfterLastImport(source, imports)
	} else {
		withImports = insertAfterLastRequire(source, imports)
	}
	// The ctor offsets are computed from the ORIGINAL source. After
	// inserting imports they shift by len(prepended). Recompute.
	shift := len(withImports) - len(source)
	closeParenPos += shift

	// --- include line ------------------------------------------------
	lineEnd := strings.IndexByte(withImports[closeParenPos:], '\n')
	var insertAt int
	if lineEnd < 0 {
		insertAt = len(withImports)
	} else {
		insertAt = closeParenPos + lineEnd
	}
	mountLine := fmt.Sprintf("\n%s.use(config.mountPath, gravelHandler({ config }))\n", appName)
	return withImports[:insertAt] + mountLine + withImports[insertAt+1:]
}

func buildExpressImports(isESM bool) string {
	if isESM {
		return "import { gravelHandler } from '@artanis-ai/gravel/node'\n" +
			"import { config } from './gravel.config'\n"
	}
	return "const { gravelHandler } = require('@artanis-ai/gravel/node')\n" +
		"const { config } = require('./gravel.config')\n"
}

// insertAfterLastImport places `text` immediately after the LAST
// top-level `import ` line in source. If no import line is found,
// prepends. Preserves the source verbatim otherwise.
func insertAfterLastImport(source, text string) string {
	importRE := regexp.MustCompile(`(?m)^import[^\n]*\n`)
	locs := importRE.FindAllStringIndex(source, -1)
	if len(locs) == 0 {
		return text + source
	}
	last := locs[len(locs)-1]
	return source[:last[1]] + text + source[last[1]:]
}

// insertAfterLastRequire places `text` immediately after the LAST
// top-level `... = require(...)` line in source.
func insertAfterLastRequire(source, text string) string {
	requireRE := regexp.MustCompile(`(?m)^(?:const|let|var)[^\n]*=\s*require\([^)]*\)[^\n]*\n`)
	locs := requireRE.FindAllStringIndex(source, -1)
	if len(locs) == 0 {
		return text + source
	}
	last := locs[len(locs)-1]
	return source[:last[1]] + text + source[last[1]:]
}
