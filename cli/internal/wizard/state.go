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
