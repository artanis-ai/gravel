package detect

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/artanis-ai/gravel/cli/internal/stack"
)

// sandbox creates a fresh temp dir with the named files touched (zero
// content). Returns the dir path. Caller does NOT need to clean up —
// t.TempDir() removes it automatically when the test exits.
func sandbox(t *testing.T, files ...string) string {
	t.Helper()
	dir := t.TempDir()
	for _, f := range files {
		full := filepath.Join(dir, f)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		if err := os.WriteFile(full, nil, 0o644); err != nil {
			t.Fatalf("write %s: %v", f, err)
		}
	}
	return dir
}

func TestHostStack_TS(t *testing.T) {
	cases := []struct {
		name  string
		files []string
		want  stack.Stack
	}{
		{"pnpm-lock", []string{"pnpm-lock.yaml"}, stack.Stack{Language: stack.LanguageTS, PackageManager: stack.PackageManagerPNPM}},
		{"yarn-lock", []string{"yarn.lock"}, stack.Stack{Language: stack.LanguageTS, PackageManager: stack.PackageManagerYarn}},
		{"bun.lock", []string{"bun.lock"}, stack.Stack{Language: stack.LanguageTS, PackageManager: stack.PackageManagerBun}},
		{"bun.lockb (legacy)", []string{"bun.lockb"}, stack.Stack{Language: stack.LanguageTS, PackageManager: stack.PackageManagerBun}},
		{"package.json only", []string{"package.json"}, stack.Stack{Language: stack.LanguageTS, PackageManager: stack.PackageManagerNPM}},
		{"empty cwd", nil, stack.Stack{Language: stack.LanguageTS, PackageManager: stack.PackageManagerNPM}},
		{"pnpm beats stray package-lock", []string{"pnpm-lock.yaml", "package-lock.json"}, stack.Stack{Language: stack.LanguageTS, PackageManager: stack.PackageManagerPNPM}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := HostStack(sandbox(t, tc.files...))
			if got != tc.want {
				t.Errorf("got %+v, want %+v", got, tc.want)
			}
		})
	}
}

func TestHostStack_Python(t *testing.T) {
	cases := []struct {
		name  string
		files []string
		want  stack.Stack
	}{
		{"uv.lock", []string{"uv.lock"}, stack.Stack{Language: stack.LanguagePython, PackageManager: stack.PackageManagerUV}},
		{"poetry.lock", []string{"poetry.lock"}, stack.Stack{Language: stack.LanguagePython, PackageManager: stack.PackageManagerPoetry}},
		{"Pipfile.lock", []string{"Pipfile.lock"}, stack.Stack{Language: stack.LanguagePython, PackageManager: stack.PackageManagerPipenv}},
		{"pyproject.toml only", []string{"pyproject.toml"}, stack.Stack{Language: stack.LanguagePython, PackageManager: stack.PackageManagerPip}},
		{"requirements.txt only", []string{"requirements.txt"}, stack.Stack{Language: stack.LanguagePython, PackageManager: stack.PackageManagerPip}},
		{"uv beats stray package.json (python-primary)", []string{"uv.lock", "package.json"}, stack.Stack{Language: stack.LanguagePython, PackageManager: stack.PackageManagerUV}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := HostStack(sandbox(t, tc.files...))
			if got != tc.want {
				t.Errorf("got %+v, want %+v", got, tc.want)
			}
		})
	}
}

func TestHostStack_PolyglotEdgeCase(t *testing.T) {
	// pyproject.toml AND package.json together → JS-primary (tooling
	// repo that happens to ship a pyproject for linting). Documented
	// in the host-stack design note + matches the TS handler.
	dir := sandbox(t, "pyproject.toml", "package.json")
	got := HostStack(dir)
	want := stack.Stack{Language: stack.LanguageTS, PackageManager: stack.PackageManagerNPM}
	if got != want {
		t.Errorf("got %+v, want %+v", got, want)
	}
}
