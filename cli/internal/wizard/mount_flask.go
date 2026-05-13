package wizard

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// mount_flask.go: Flask auto-mount. The patched line is exactly one
// call: `mount_on_flask(app, config)`. The SDK does everything else
// via the artanis_gravel.flask module (which bridges to the FastAPI
// dashboard via asgiref+Werkzeug — see python/gravel/src/artanis_gravel/flask.py).
//
// Host footprint is intentionally tiny: 2 import lines + 1 call =
// 3 lines of injected code, identical across every Flask project
// regardless of layout. The patcher inserts them after the
// `app = Flask(__name__)` ctor.

// flaskEntryCandidates is the search order before tree-walking.
// Flask projects conventionally have the entry at the project root
// as `app.py` (the Flask docs' default) or `wsgi.py` (production
// deployment convention). The `src/` variants cover modern packaged
// projects.
var flaskEntryCandidates = []string{
	"app.py",
	"wsgi.py",
	"server.py",
	"main.py",
	"src/app.py",
	"src/wsgi.py",
	"src/server.py",
	"src/main.py",
}

// flaskDirSkip mirrors fastAPIDirSkip; same Python ecosystem noise.
var flaskDirSkip = fastAPIDirSkip

// topLevelFlaskCtorRE matches `<name> = Flask(...)` at column zero.
// Same column-zero invariant as the FastAPI patcher — refuses to
// patch inside function/class bodies because that's the Flask
// application-factory pattern and our `mount_on_flask` call needs
// to run against the module-level app.
//
// Submatch order:
//   m[2..3]  variable name (typically "app" or "application")
var topLevelFlaskCtorRE = regexp.MustCompile(`(?m)^(\w+)(?:[ \t]*:[ \t]*[^=\n]+?)?[ \t]*=[ \t]*Flask[ \t]*\(`)

// gravelFlaskMountedRE is the idempotency check — `mount_on_flask(`
// with `app` or any other variable name as the first arg.
var gravelFlaskMountedRE = regexp.MustCompile(`mount_on_flask\s*\(`)

func mountFlask(d Detection, mountPath string) (MountResult, error) {
	for _, rel := range flaskEntryCandidates {
		if res, ok := tryPatchFlaskEntry(d.CWD, rel, mountPath); ok {
			return res, nil
		}
	}
	for _, rel := range findFlaskEntries(d.CWD) {
		if res, ok := tryPatchFlaskEntry(d.CWD, rel, mountPath); ok {
			return res, nil
		}
	}
	return manual(flaskInstructions(mountPath)), nil
}

func tryPatchFlaskEntry(cwd, rel, mountPath string) (MountResult, bool) {
	entryPath := filepath.Join(cwd, rel)
	original, err := os.ReadFile(entryPath)
	if err != nil {
		return MountResult{}, false
	}
	src := string(original)

	if gravelFlaskMountedRE.MatchString(src) {
		return MountResult{Path: entryPath, Mode: MountUpdated}, true
	}
	if !topLevelFlaskCtorRE.MatchString(src) {
		return MountResult{}, false
	}
	patched := patchFlaskEntryMain(src)
	if patched == src {
		return manual(flaskInstructions(mountPath) + "\nTarget file: " + rel), true
	}
	if err := safeBackup(entryPath); err != nil {
		return MountResult{}, false
	}
	if err := os.WriteFile(entryPath, []byte(patched), 0o644); err != nil {
		return MountResult{}, false
	}
	return MountResult{Path: entryPath, Mode: MountUpdated}, true
}

func findFlaskEntries(cwd string) []string {
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
			if flaskDirSkip[dirent.Name()] || strings.HasPrefix(dirent.Name(), ".") {
				return filepath.SkipDir
			}
			rel, _ := filepath.Rel(root, path)
			if depth := strings.Count(rel, string(filepath.Separator)); depth >= 6 {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(dirent.Name(), ".py") {
			return nil
		}
		body, err := os.ReadFile(path)
		if err != nil {
			return nil
		}
		if !topLevelFlaskCtorRE.Match(body) {
			return nil
		}
		// Filter false positives: `Flask(...)` could also be class
		// `class Flask:` or `from flask import Flask` etc. The regex
		// matches `<name> = Flask(`, which excludes those. But a
		// `Flask = Flask()` aliasing wouldn't make sense, and the
		// regex requires `Flask` to appear after the `=`. Should be
		// tight enough.
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

// patchFlaskEntryMain inserts the gravel imports + mount_on_flask
// call. Same column-zero-only invariant as the JS patchers.
func patchFlaskEntryMain(source string) string {
	m := topLevelFlaskCtorRE.FindStringSubmatchIndex(source)
	if m == nil {
		return source
	}
	appName := source[m[2]:m[3]]
	openParenPos := m[1] - 1
	closeParenPos := matchClosingParen(source, openParenPos)
	if closeParenPos < 0 {
		return source
	}

	// Insert imports immediately AFTER the last `from ... import ...`
	// or `import ...` line we can find, so they sit alongside the
	// user's other imports rather than at the top of the file (which
	// would land them before module-level constants and dataclasses).
	imports := "from artanis_gravel.flask import mount_on_flask\n" +
		"from gravel_config import config\n"
	withImports := insertAfterLastPyImport(source, imports)
	shift := len(withImports) - len(source)
	closeParenPos += shift

	// Insert the mount call on the line after the Flask() ctor's
	// closing paren.
	lineEnd := strings.IndexByte(withImports[closeParenPos:], '\n')
	var insertAt int
	if lineEnd < 0 {
		insertAt = len(withImports)
	} else {
		insertAt = closeParenPos + lineEnd
	}
	mountLine := fmt.Sprintf("\nmount_on_flask(%s, config)\n", appName)
	return withImports[:insertAt] + mountLine + withImports[insertAt+1:]
}

// insertAfterLastPyImport places text immediately after the last
// `from X import Y` / `import X` line in source. If none are found,
// prepends at the top. Used by the Flask patcher; lives here rather
// than in mount_python.go because the FastAPI patcher has its own
// `from fastapi import ...`-scoped variant.
func insertAfterLastPyImport(source, text string) string {
	importRE := regexp.MustCompile(`(?m)^(?:from\s+\S+\s+import\s+[^\n]+|import\s+[^\n]+)\n`)
	locs := importRE.FindAllStringIndex(source, -1)
	if len(locs) == 0 {
		return text + source
	}
	last := locs[len(locs)-1]
	return source[:last[1]] + text + source[last[1]:]
}

func flaskInstructions(mountPath string) string {
	return fmt.Sprintf(`Flask projects: mount the gravel dashboard on your app.

from artanis_gravel.flask import mount_on_flask
from gravel_config import config

mount_on_flask(app, config)

The mount_on_flask call goes immediately after `+"`app = Flask(__name__)`"+`
(or wherever your app instance is assigned). It wraps the Flask app's
wsgi_app to dispatch %s/* to the gravel dashboard.

Requires the [flask] extra:
    uv add 'artanis-gravel[flask]'
or:
    pip install 'artanis-gravel[flask]'
`, mountPath)
}
