package wizard

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/artanis-ai/gravel/cli/internal/stack"
)

// We don't run the real `pnpm` / `uv` here — there's no way to verify
// network installs in-process without standing up a registry. Instead
// we test the decisions:
//   - Right package name per language
//   - Right argv per package manager
//   - "Already present" detection across the manifest shapes we care
//     about (package.json with deps, package.json with devDeps,
//     pyproject.toml PEP 621, pyproject.toml Poetry)
//   - "Skipped, no manifest" when there's no package.json / pyproject.toml
//
// The "actually runs pnpm add" path is covered by the publish pipeline's
// end-to-end smoke (npx @artanis-ai/gravel init against a real fixture
// project), not in-process tests.

// --- package name + command shape ------------------------------------------

func TestGravelPackageName(t *testing.T) {
	if got := gravelPackageName(stack.LanguageTS); got != "@artanis-ai/gravel" {
		t.Errorf("ts: got %q", got)
	}
	if got := gravelPackageName(stack.LanguagePython); got != "artanis-gravel" {
		t.Errorf("py: got %q", got)
	}
}

func TestBuildAddCommand(t *testing.T) {
	cases := []struct {
		pm   stack.PackageManager
		pkg  string
		want []string
	}{
		{stack.PackageManagerPNPM, "@artanis-ai/gravel", []string{"pnpm", "add", "@artanis-ai/gravel"}},
		{stack.PackageManagerYarn, "@artanis-ai/gravel", []string{"yarn", "add", "@artanis-ai/gravel"}},
		{stack.PackageManagerBun, "@artanis-ai/gravel", []string{"bun", "add", "@artanis-ai/gravel"}},
		{stack.PackageManagerNPM, "@artanis-ai/gravel", []string{"npm", "install", "@artanis-ai/gravel"}},
		{stack.PackageManagerUV, "artanis-gravel", []string{"uv", "add", "artanis-gravel"}},
		{stack.PackageManagerPoetry, "artanis-gravel", []string{"poetry", "add", "artanis-gravel"}},
		{stack.PackageManagerPipenv, "artanis-gravel", []string{"pipenv", "install", "artanis-gravel"}},
		{stack.PackageManagerPip, "artanis-gravel", []string{"pip", "install", "artanis-gravel"}},
		// Unknown manager falls back to pnpm; the user will see the
		// printed command and can retype with the right tool.
		{stack.PackageManager("rye"), "artanis-gravel", []string{"pnpm", "add", "artanis-gravel"}},
	}
	for _, tc := range cases {
		t.Run(string(tc.pm), func(t *testing.T) {
			got := buildAddCommand(tc.pm, tc.pkg)
			if strings.Join(got, " ") != strings.Join(tc.want, " ") {
				t.Errorf("got %v, want %v", got, tc.want)
			}
		})
	}
}

// --- already-declared detection --------------------------------------------

func TestAlreadyDeclares_PackageJSON(t *testing.T) {
	dir := t.TempDir()
	cases := []struct {
		name     string
		manifest string
		want     bool
	}{
		{
			"in dependencies",
			`{"dependencies": {"@artanis-ai/gravel": "^0.4.0"}}`,
			true,
		},
		{
			"in devDependencies",
			`{"devDependencies": {"@artanis-ai/gravel": "0.4.0"}}`,
			true,
		},
		{
			"absent",
			`{"dependencies": {"next": "15.0.0"}}`,
			false,
		},
		{
			"absent — empty deps blocks",
			`{"dependencies": {}, "devDependencies": {}}`,
			false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(dir, "package.json")
			if err := os.WriteFile(path, []byte(tc.manifest), 0o644); err != nil {
				t.Fatal(err)
			}
			got, err := alreadyDeclares(path, "@artanis-ai/gravel", stack.LanguageTS)
			if err != nil {
				t.Fatalf("alreadyDeclares: %v", err)
			}
			if got != tc.want {
				t.Errorf("got %v, want %v", got, tc.want)
			}
		})
	}
}

func TestAlreadyDeclares_PyProject(t *testing.T) {
	dir := t.TempDir()
	cases := []struct {
		name     string
		manifest string
		want     bool
	}{
		{
			"PEP 621 list",
			`[project]
name = "app"
dependencies = ["fastapi", "artanis-gravel>=0.4.0", "openai"]
`,
			true,
		},
		{
			"Poetry table",
			`[tool.poetry.dependencies]
python = "^3.10"
artanis-gravel = "^0.4.0"
`,
			true,
		},
		{
			"uv inline shorthand (treated as TOML key)",
			`[project]
dependencies = []
[tool.uv.sources]
artanis-gravel = { workspace = true }
`,
			true,
		},
		{
			"absent",
			`[project]
name = "app"
dependencies = ["fastapi"]
`,
			false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(dir, "pyproject.toml")
			if err := os.WriteFile(path, []byte(tc.manifest), 0o644); err != nil {
				t.Fatal(err)
			}
			got, err := alreadyDeclares(path, "artanis-gravel", stack.LanguagePython)
			if err != nil {
				t.Fatalf("alreadyDeclares: %v", err)
			}
			if got != tc.want {
				t.Errorf("got %v, want %v", got, tc.want)
			}
		})
	}
}

// --- EnsureSDKInstalled end-to-end ------------------------------------------

func TestEnsureSDKInstalled_SkippedNoManifest(t *testing.T) {
	dir := t.TempDir()
	d := Detection{
		CWD:            dir,
		Language:       stack.LanguageTS,
		PackageManager: stack.PackageManagerPNPM,
	}
	got := EnsureSDKInstalled(context.Background(), d)
	if got.Kind != SDKSkippedNoManifest {
		t.Errorf("Kind = %s, want %s", got.Kind, SDKSkippedNoManifest)
	}
	if got.Package != "@artanis-ai/gravel" {
		t.Errorf("Package = %q", got.Package)
	}
	// Command must be a real, copy-pasteable line.
	if !strings.Contains(got.Command, "pnpm add @artanis-ai/gravel") {
		t.Errorf("Command = %q", got.Command)
	}
}

func TestEnsureSDKInstalled_AlreadyPresent(t *testing.T) {
	dir := t.TempDir()
	manifest := `{"name":"app","dependencies":{"@artanis-ai/gravel":"^0.4.0"}}`
	if err := os.WriteFile(filepath.Join(dir, "package.json"), []byte(manifest), 0o644); err != nil {
		t.Fatal(err)
	}
	d := Detection{
		CWD:            dir,
		Language:       stack.LanguageTS,
		PackageManager: stack.PackageManagerPNPM,
	}
	got := EnsureSDKInstalled(context.Background(), d)
	if got.Kind != SDKAlreadyPresent {
		t.Errorf("Kind = %s, want %s", got.Kind, SDKAlreadyPresent)
	}
}

func TestEnsureSDKInstalled_PythonAlreadyPresent(t *testing.T) {
	dir := t.TempDir()
	manifest := `[project]
dependencies = ["fastapi", "artanis-gravel>=0.4.0"]
`
	if err := os.WriteFile(filepath.Join(dir, "pyproject.toml"), []byte(manifest), 0o644); err != nil {
		t.Fatal(err)
	}
	d := Detection{
		CWD:            dir,
		Language:       stack.LanguagePython,
		PackageManager: stack.PackageManagerUV,
	}
	got := EnsureSDKInstalled(context.Background(), d)
	if got.Kind != SDKAlreadyPresent {
		t.Errorf("Kind = %s, want %s", got.Kind, SDKAlreadyPresent)
	}
	if got.Package != "artanis-gravel" {
		t.Errorf("Package = %q", got.Package)
	}
}

func TestEnsureSDKInstalled_FailedWhenPMUnavailable(t *testing.T) {
	// Use a package manager binary name that definitely doesn't exist
	// on the runner. We construct the Detection by hand to pin the PM.
	dir := t.TempDir()
	// Manifest present but missing the SDK → wizard will try to run
	// the add command, which will fail because "rye" isn't available
	// (and even if it were, the fallback maps "rye" → pnpm, which we
	// can't guarantee on every CI runner either).
	manifest := `{"name":"app","dependencies":{}}`
	if err := os.WriteFile(filepath.Join(dir, "package.json"), []byte(manifest), 0o644); err != nil {
		t.Fatal(err)
	}
	// Hack the PATH so no real package manager resolves. The wrapper
	// will get ENOENT from exec, which surfaces as SDKFailed.
	t.Setenv("PATH", "/nonexistent")
	d := Detection{
		CWD:            dir,
		Language:       stack.LanguageTS,
		PackageManager: stack.PackageManagerPNPM,
	}
	got := EnsureSDKInstalled(context.Background(), d)
	if got.Kind != SDKFailed {
		t.Errorf("Kind = %s, want %s", got.Kind, SDKFailed)
	}
	if !strings.Contains(got.Command, "pnpm add @artanis-ai/gravel") {
		t.Errorf("Command shape unexpected: %q", got.Command)
	}
}
