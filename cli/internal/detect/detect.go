// Package detect figures out what kind of host we're sitting inside,
// purely from files in cwd. No network, no system probes — the
// wizard's output should be identical for two checkouts of the same
// repo, regardless of the developer's machine.
//
// The lockfile precedence here MUST stay byte-for-byte identical to
// the TS handler's `internal/handler/host-stack.ts` so the dashboard's
// `/api/version` endpoint and `gravel doctor` agree on which package
// manager the user has.
package detect

import (
	"os"
	"path/filepath"

	"github.com/artanis-ai/gravel/cli/internal/stack"
)

// HostStack inspects `cwd` and returns the detected language + package
// manager. Falls back to (TS, npm) when nothing's present — the most
// common shape and the one whose upgrade command does the least harm
// if accidentally shown to a user with no lockfile.
func HostStack(cwd string) stack.Stack {
	exists := func(rel string) bool {
		_, err := os.Stat(filepath.Join(cwd, rel))
		return err == nil
	}

	// Python-side detection wins if any Python lockfile or pyproject
	// is present. (Same heuristic as host-stack.ts:
	// pyproject-without-lockfile only fires when package.json is
	// absent, so a tooling repo that ships pyproject for linting
	// but is JS-primary stays on the TS branch.)
	switch {
	case exists("uv.lock"):
		return stack.Stack{Language: stack.LanguagePython, PackageManager: stack.PackageManagerUV}
	case exists("poetry.lock"):
		return stack.Stack{Language: stack.LanguagePython, PackageManager: stack.PackageManagerPoetry}
	case exists("Pipfile.lock"):
		return stack.Stack{Language: stack.LanguagePython, PackageManager: stack.PackageManagerPipenv}
	}
	if !exists("package.json") {
		if exists("pyproject.toml") || exists("requirements.txt") || exists("setup.py") {
			return stack.Stack{Language: stack.LanguagePython, PackageManager: stack.PackageManagerPip}
		}
	}

	// TS family. Same precedence as the wizard.
	switch {
	case exists("pnpm-lock.yaml"):
		return stack.Stack{Language: stack.LanguageTS, PackageManager: stack.PackageManagerPNPM}
	case exists("yarn.lock"):
		return stack.Stack{Language: stack.LanguageTS, PackageManager: stack.PackageManagerYarn}
	case exists("bun.lock"), exists("bun.lockb"):
		return stack.Stack{Language: stack.LanguageTS, PackageManager: stack.PackageManagerBun}
	}
	// package-lock.json OR no lockfile in a JS repo: npm.
	return stack.Stack{Language: stack.LanguageTS, PackageManager: stack.PackageManagerNPM}
}
