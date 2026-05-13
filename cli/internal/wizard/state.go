package wizard

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/artanis-ai/gravel/cli/internal/stack"
)

// InspectedState captures what's already wired up in the project,
// so re-runs of `gravel init` can say "Already done. Skipping." for
// idempotent operations instead of clobbering or asking again.
//
// Mirrors packages/sdk-ts/src/wizard/index.ts §inspectState.
type InspectedState struct {
	// MountExists: the dashboard route file already exists at the
	// detected mount location (e.g. app/admin/ai/[[...slug]]/route.ts).
	MountExists bool
	// MountFilePath: where the wizard checked for / would write the
	// mount file. Same path it'd write to if MountExists were false.
	MountFilePath string
	// EnvHasPassword: GRAVEL_ADMIN_PASSWORD is set in .env.local or .env.
	EnvHasPassword bool
	// EnvFileWithPassword: which file the password lives in (`.env.local`
	// or `.env`). Empty if not present in either.
	EnvFileWithPassword string
	// HookInstalled: a pre-commit hook running `gravel manifest --check`
	// is already in place (husky, pre-commit framework, or native).
	HookInstalled bool
	// ConfigExists: gravel.config.ts (or gravel_config.py) is already on disk.
	ConfigExists bool
	// InstrumentationExists: Next.js `instrumentation.ts` (or
	// `src/instrumentation.ts`) is already present. Used so the traces
	// pillar can skip re-writing it on a re-run instead of clobbering
	// user edits.
	InstrumentationExists bool
}

// InspectState reads the project root non-destructively and returns
// what's already there. Used by Step 1 to decide whether to skip the
// mount + password write entirely; used by Step 2 to decide whether
// to even ask about the hook.
func InspectState(cwd string, d Detection) InspectedState {
	s := InspectedState{
		MountFilePath: mountFilePathFor(d),
	}
	if s.MountFilePath != "" {
		s.MountExists = pathExists(filepath.Join(cwd, s.MountFilePath))
	}
	// For FastAPI/Django the mounter doesn't write its file to a
	// fixed location — it walks for the entry file and writes
	// adjacent to it (src/<pkg>/gravel_route.py, etc.). The hard-coded
	// `mountFilePathFor` check (project-root gravel_route.py) is
	// always false for src-layout projects, so the "Already wired up.
	// Skipping." message never fires on re-run.
	//
	// For these frameworks "mount exists" really means "the host's
	// entry file imports our router" — that's the source of truth the
	// patcher itself uses to decide whether a re-run is idempotent.
	// Mirror that signal here.
	if !s.MountExists {
		switch d.Framework {
		case FrameworkFastAPI:
			if ok, entryRel := fastAPIEntryHasGravelImport(cwd); ok {
				s.MountExists = true
				// Replace the hard-coded "gravel_route.py" with the
				// actual adjacent location, so the "Re-run with X
				// removed" hint points the user at the file that
				// genuinely exists.
				dir := filepath.Dir(entryRel)
				if dir == "" || dir == "." {
					s.MountFilePath = "gravel_route.py"
				} else {
					s.MountFilePath = filepath.ToSlash(filepath.Join(dir, "gravel_route.py"))
				}
			}
		case FrameworkDjango:
			s.MountExists = djangoURLsHasGravelInclude(cwd)
		}
	}

	for _, name := range []string{".env.local", ".env"} {
		body, err := os.ReadFile(filepath.Join(cwd, name))
		if err != nil {
			continue
		}
		if strings.Contains(string(body), "GRAVEL_ADMIN_PASSWORD=") {
			s.EnvHasPassword = true
			s.EnvFileWithPassword = name
			break
		}
	}

	s.HookInstalled = hookAlreadyInstalled(cwd)

	configName := "gravel.config.ts"
	if d.Language == stack.LanguagePython {
		configName = "gravel_config.py"
	}
	s.ConfigExists = pathExists(filepath.Join(cwd, configName))

	s.InstrumentationExists = pathExists(filepath.Join(cwd, "instrumentation.ts")) ||
		pathExists(filepath.Join(cwd, "src", "instrumentation.ts"))

	return s
}

// mountFilePathFor returns the relative path where the wizard
// writes the dashboard mount file for the host's framework. Empty
// for frameworks the wizard can't auto-mount (caller treats it as
// "no mount file to check").
func mountFilePathFor(d Detection) string {
	switch d.Framework {
	case FrameworkNextAppRouter:
		dir := "app"
		if d.NextAppDir == "src/app" {
			dir = "src/app"
		}
		return dir + "/admin/ai/[[...slug]]/route.ts"
	case FrameworkNextPagesRouter:
		return "pages/api/admin/ai/[[...slug]].ts"
	case FrameworkFastAPI:
		return "gravel_route.py"
	}
	return ""
}

// fastAPIEntryHasGravelImport scans the project for a Python file
// that contains the gravel_router import line the FastAPI patcher
// writes into the entry file. Returns (true, relPath-of-the-entry)
// on first match — caller stores the entry rel-path so the "Already
// wired up" message can reference the actual gravel_route.py
// location (which lives adjacent to the entry, not at project root
// for src-layout projects).
//
// Walks the same candidate list + tree search the patcher uses
// (see mount_python.go §mountFastAPI), so "already mounted" here
// agrees with what tryPatchFastAPIEntry treats as idempotent.
func fastAPIEntryHasGravelImport(cwd string) (bool, string) {
	checked := map[string]bool{}
	for _, rel := range fastAPIEntryCandidates {
		if entryContainsGravelImport(filepath.Join(cwd, rel)) {
			return true, rel
		}
		checked[rel] = true
	}
	for _, rel := range findFastAPIEntries(cwd) {
		if checked[rel] {
			continue
		}
		if entryContainsGravelImport(filepath.Join(cwd, rel)) {
			return true, rel
		}
	}
	return false, ""
}

// entryContainsGravelImport returns true if path contains either
// import form the patcher writes (absolute `gravel_route` for
// flat-layout, relative `.gravel_route` for src-layout packages).
func entryContainsGravelImport(path string) bool {
	body, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	src := string(body)
	return strings.Contains(src, "from gravel_route import router as gravel_router") ||
		strings.Contains(src, "from .gravel_route import router as gravel_router")
}

// djangoURLsHasGravelInclude scans the project for a urls.py that
// includes the gravel router. Mirrors what mountDjango treats as
// idempotent (`from artanis_gravel.django import gravel_urls`).
func djangoURLsHasGravelInclude(cwd string) bool {
	for _, file := range findDjangoRootURLs(cwd) {
		body, err := os.ReadFile(file)
		if err != nil {
			continue
		}
		if strings.Contains(string(body), "from artanis_gravel.django import gravel_urls") {
			return true
		}
	}
	return false
}

// hookAlreadyInstalled looks for the marker substring the hook
// installer writes (`gravel manifest`) in any of the three places
// the installer might've put it.
func hookAlreadyInstalled(cwd string) bool {
	for _, rel := range []string{
		".husky/pre-commit",
		".pre-commit-config.yaml",
		".git/hooks/pre-commit",
	} {
		body, err := os.ReadFile(filepath.Join(cwd, rel))
		if err == nil && strings.Contains(string(body), "gravel manifest") {
			return true
		}
	}
	return false
}
