package wizard

import (
	"os"
	"path/filepath"
	"testing"
)

// --- EnsureNextPagesRewrite -------------------------------------------------

func TestEnsureNextPagesRewrite_NoExistingConfig(t *testing.T) {
	dir := t.TempDir()
	if err := EnsureNextPagesRewrite(dir, "/admin/ai"); err != nil {
		t.Fatal(err)
	}
	body := readFileT(t, filepath.Join(dir, "next.config.mjs"))
	mustContain(t, body, "destination: '/api/admin/ai'")
	mustContain(t, body, "destination: '/api/admin/ai/:path*'")
}

func TestEnsureNextPagesRewrite_EmptyDefaultExport(t *testing.T) {
	dir := t.TempDir()
	src := "export default {}\n"
	if err := os.WriteFile(filepath.Join(dir, "next.config.mjs"), []byte(src), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := EnsureNextPagesRewrite(dir, "/admin/ai"); err != nil {
		t.Fatal(err)
	}
	body := readFileT(t, filepath.Join(dir, "next.config.mjs"))
	mustContain(t, body, "destination: '/api/admin/ai/:path*'")
	mustContain(t, body, "async rewrites()")
}

func TestEnsureNextPagesRewrite_PopulatedDefaultExport(t *testing.T) {
	dir := t.TempDir()
	src := `export default {
  reactStrictMode: true,
}
`
	if err := os.WriteFile(filepath.Join(dir, "next.config.mjs"), []byte(src), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := EnsureNextPagesRewrite(dir, "/admin/ai"); err != nil {
		t.Fatal(err)
	}
	body := readFileT(t, filepath.Join(dir, "next.config.mjs"))
	mustContain(t, body, "reactStrictMode: true")
	mustContain(t, body, "destination: '/api/admin/ai/:path*'")
}

func TestEnsureNextPagesRewrite_Idempotent(t *testing.T) {
	dir := t.TempDir()
	if err := EnsureNextPagesRewrite(dir, "/admin/ai"); err != nil {
		t.Fatal(err)
	}
	first := readFileT(t, filepath.Join(dir, "next.config.mjs"))
	if err := EnsureNextPagesRewrite(dir, "/admin/ai"); err != nil {
		t.Fatal(err)
	}
	second := readFileT(t, filepath.Join(dir, "next.config.mjs"))
	if first != second {
		t.Errorf("re-run mutated file:\n---first---\n%s\n---second---\n%s", first, second)
	}
}

// --- EnsureNextServerExternalPackages ---------------------------------------

func TestEnsureNextServerExternalPackages_NoConfig(t *testing.T) {
	dir := t.TempDir()
	if err := EnsureNextServerExternalPackages(dir); err != nil {
		t.Fatal(err)
	}
	body := readFileT(t, filepath.Join(dir, "next.config.mjs"))
	mustContain(t, body, "serverExternalPackages: ['@artanis-ai/gravel', 'pg', 'better-sqlite3']")
	mustContain(t, body, "webpack:")
	mustContain(t, body, "externalize")
}

func TestEnsureNextServerExternalPackages_EmptyExport(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "next.config.mjs"), []byte("export default {}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := EnsureNextServerExternalPackages(dir); err != nil {
		t.Fatal(err)
	}
	body := readFileT(t, filepath.Join(dir, "next.config.mjs"))
	mustContain(t, body, "serverExternalPackages")
	mustContain(t, body, "@artanis-ai/gravel")
}

func TestEnsureNextServerExternalPackages_PopulatedSuggestion(t *testing.T) {
	dir := t.TempDir()
	src := `export default {
  reactStrictMode: true,
  experimental: { typedRoutes: true },
}
`
	target := filepath.Join(dir, "next.config.mjs")
	if err := os.WriteFile(target, []byte(src), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := EnsureNextServerExternalPackages(dir); err != nil {
		t.Fatal(err)
	}
	// Original untouched.
	body := readFileT(t, target)
	mustContain(t, body, "reactStrictMode: true")
	mustNotContain(t, body, "@artanis-ai/gravel")
	// Suggestion sibling written.
	suggestion := readFileT(t, target+".gravel.next-config.suggestion.txt")
	mustContain(t, suggestion, "serverExternalPackages")
}

func TestEnsureNextServerExternalPackages_Idempotent(t *testing.T) {
	dir := t.TempDir()
	if err := EnsureNextServerExternalPackages(dir); err != nil {
		t.Fatal(err)
	}
	first := readFileT(t, filepath.Join(dir, "next.config.mjs"))
	if err := EnsureNextServerExternalPackages(dir); err != nil {
		t.Fatal(err)
	}
	second := readFileT(t, filepath.Join(dir, "next.config.mjs"))
	if first != second {
		t.Errorf("re-run mutated file:\n%s\n vs \n%s", first, second)
	}
}

// --- EnsureNextInstrumentation ----------------------------------------------

func TestEnsureNextInstrumentation_FreshWrite(t *testing.T) {
	dir := t.TempDir()
	if err := EnsureNextInstrumentation(dir, false); err != nil {
		t.Fatal(err)
	}
	body := readFileT(t, filepath.Join(dir, "instrumentation.ts"))
	mustContain(t, body, "@artanis-ai/gravel/auto")
	mustContain(t, body, "setGravelTracingConfig")
	mustContain(t, body, "NEXT_RUNTIME !== 'nodejs'")
	mustContain(t, body, "import('./gravel.config')")
}

func TestEnsureNextInstrumentation_SrcLayout(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := EnsureNextInstrumentation(dir, true); err != nil {
		t.Fatal(err)
	}
	body := readFileT(t, filepath.Join(dir, "src", "instrumentation.ts"))
	mustContain(t, body, "import('../gravel.config')")
}

func TestEnsureNextInstrumentation_ExistingRegisterEmitsSuggestion(t *testing.T) {
	dir := t.TempDir()
	src := `export async function register() {
  console.log("user instrumentation")
}
`
	target := filepath.Join(dir, "instrumentation.ts")
	if err := os.WriteFile(target, []byte(src), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := EnsureNextInstrumentation(dir, false); err != nil {
		t.Fatal(err)
	}
	body := readFileT(t, target)
	mustContain(t, body, "user instrumentation")
	mustNotContain(t, body, "@artanis-ai/gravel/auto")
	suggestion := readFileT(t, target+".gravel.instrumentation.suggestion.txt")
	mustContain(t, suggestion, "@artanis-ai/gravel/auto")
	mustContain(t, suggestion, "setGravelTracingConfig")
}

func TestEnsureNextInstrumentation_Idempotent(t *testing.T) {
	dir := t.TempDir()
	if err := EnsureNextInstrumentation(dir, false); err != nil {
		t.Fatal(err)
	}
	first := readFileT(t, filepath.Join(dir, "instrumentation.ts"))
	if err := EnsureNextInstrumentation(dir, false); err != nil {
		t.Fatal(err)
	}
	second := readFileT(t, filepath.Join(dir, "instrumentation.ts"))
	if first != second {
		t.Errorf("re-run mutated file:\n%s\n vs \n%s", first, second)
	}
}

// --- helper -----------------------------------------------------------------

func readFileT(t *testing.T, p string) string {
	t.Helper()
	body, err := os.ReadFile(p)
	if err != nil {
		t.Fatalf("read %s: %v", p, err)
	}
	return string(body)
}
