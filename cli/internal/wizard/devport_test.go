package wizard

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/artanis-ai/gravel/cli/internal/stack"
)

// devport_test.go exercises GuessDevPort + its underlying regex
// extraction. The wizard uses the result to print a concrete
// http://localhost:PORT URL after Step 1; getting it wrong only
// confuses the user, but getting it RIGHT (matching `next dev -p
// 4001`) makes the install feel polished.

func TestExtractPortFlag_Shapes(t *testing.T) {
	cases := []struct {
		name   string
		script string
		want   int
	}{
		{"short-flag", "next dev -p 4000", 4000},
		{"long-flag-space", "next dev --port 4000", 4000},
		{"long-flag-eq", "vite --port=4000", 4000},
		{"port-env-prefix", "PORT=4000 next dev", 4000},
		{"port-env-not-leading", "echo hi && PORT=4321 next dev", 4321},
		{"no-flag", "next dev", 0},
		{"empty", "", 0},
		{"misleading-substring", "next dev --portfolio 8080", 0},
		{"flag-only-no-number", "next dev --port", 0},
		{"shortp-needs-space-after", "next dev-p4000", 0},
		{"multi-flag-takes-first", "PORT=3000 next dev --port 4000", 3000},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := extractPortFlag(tc.script); got != tc.want {
				t.Errorf("extractPortFlag(%q) = %d, want %d", tc.script, got, tc.want)
			}
		})
	}
}

func TestFrameworkDefaultPort(t *testing.T) {
	cases := []struct {
		f    Framework
		want int
	}{
		{FrameworkNextAppRouter, 3000},
		{FrameworkNextPagesRouter, 3000},
		{FrameworkExpress, 3000},
		{FrameworkFastify, 3000},
		{FrameworkHono, 3000},
		{FrameworkFastAPI, 8000},
		{FrameworkDjango, 8000},
		{FrameworkFlask, 5000},
		{FrameworkGenericNode, 0},
		{FrameworkGenericASGI, 0},
	}
	for _, tc := range cases {
		if got := frameworkDefaultPort(tc.f); got != tc.want {
			t.Errorf("frameworkDefaultPort(%s) = %d, want %d", tc.f, got, tc.want)
		}
	}
}

func TestGuessDevPort_ScriptOverridesFrameworkDefault(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "package.json"), []byte(`{
		"scripts": {"dev": "next dev -p 4001"},
		"dependencies": {"next": "15.0.0"}
	}`), 0o644); err != nil {
		t.Fatal(err)
	}
	d := Detection{Framework: FrameworkNextAppRouter, Language: stack.LanguageTS}
	if got := GuessDevPort(dir, d); got != 4001 {
		t.Errorf("GuessDevPort = %d, want 4001 (script wins over framework default)", got)
	}
}

func TestGuessDevPort_FallsBackToFrameworkDefault(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "package.json"), []byte(`{
		"scripts": {"dev": "next dev"},
		"dependencies": {"next": "15.0.0"}
	}`), 0o644); err != nil {
		t.Fatal(err)
	}
	d := Detection{Framework: FrameworkNextAppRouter, Language: stack.LanguageTS}
	if got := GuessDevPort(dir, d); got != 3000 {
		t.Errorf("GuessDevPort = %d, want 3000 (framework default)", got)
	}
}

func TestGuessDevPort_PythonReturnsFrameworkDefault(t *testing.T) {
	dir := t.TempDir() // no package.json → no script scan
	d := Detection{Framework: FrameworkFastAPI, Language: stack.LanguagePython}
	if got := GuessDevPort(dir, d); got != 8000 {
		t.Errorf("GuessDevPort = %d, want 8000", got)
	}
}

func TestGuessDevPort_NoFrameworkNoScript_Zero(t *testing.T) {
	dir := t.TempDir()
	d := Detection{Framework: FrameworkGenericNode, Language: stack.LanguageTS}
	if got := GuessDevPort(dir, d); got != 0 {
		t.Errorf("GuessDevPort = %d, want 0 (caller drops the host:port)", got)
	}
}

func TestGuessDevPort_PrefersDevOverStart(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "package.json"), []byte(`{
		"scripts": {"dev": "next dev -p 4001", "start": "next start -p 5000"}
	}`), 0o644); err != nil {
		t.Fatal(err)
	}
	d := Detection{Framework: FrameworkNextAppRouter, Language: stack.LanguageTS}
	if got := GuessDevPort(dir, d); got != 4001 {
		t.Errorf("GuessDevPort = %d, want 4001 (dev wins over start)", got)
	}
}

func TestGuessDevPort_MalformedPackageJson_FallsBack(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "package.json"), []byte(`not json {`), 0o644); err != nil {
		t.Fatal(err)
	}
	d := Detection{Framework: FrameworkNextAppRouter, Language: stack.LanguageTS}
	if got := GuessDevPort(dir, d); got != 3000 {
		t.Errorf("GuessDevPort = %d, want 3000 (graceful fallback on bad JSON)", got)
	}
}
