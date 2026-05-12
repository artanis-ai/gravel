package wizard

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/artanis-ai/gravel/cli/internal/manifest"
	"github.com/artanis-ai/gravel/cli/internal/stack"
)

// --- Detect -----------------------------------------------------------------

func TestDetect_NextAppRouterClerk(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"package.json": `{
			"dependencies": {
				"next": "15.0.0",
				"@clerk/nextjs": "6.0.0",
				"openai": "5.0.0"
			}
		}`,
		"pnpm-lock.yaml": "",
		"app/page.tsx":   "",
		".env.local":     "DATABASE_URL=postgres://localhost/db\n",
	})
	d := Detect(dir)
	if d.Language != stack.LanguageTS {
		t.Errorf("Language = %q", d.Language)
	}
	if d.PackageManager != stack.PackageManagerPNPM {
		t.Errorf("PackageManager = %q", d.PackageManager)
	}
	if d.Framework != FrameworkNextAppRouter {
		t.Errorf("Framework = %q", d.Framework)
	}
	if d.NextAppDir != "app" {
		t.Errorf("NextAppDir = %q, want app", d.NextAppDir)
	}
	if d.Auth != AuthClerk {
		t.Errorf("Auth = %q", d.Auth)
	}
	if d.DBDriver != DBPostgres {
		t.Errorf("DBDriver = %q", d.DBDriver)
	}
	if d.DBEnvVar != "DATABASE_URL" {
		t.Errorf("DBEnvVar = %q", d.DBEnvVar)
	}
	if !contains(d.LLMLibs, LLMOpenAI) {
		t.Errorf("expected OpenAI in LLMLibs, got %v", d.LLMLibs)
	}
}

func TestDetect_NextSrcLayout(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"package.json":    `{"dependencies":{"next":"15.0.0"}}`,
		"src/app/page.tsx": "",
	})
	d := Detect(dir)
	if d.NextAppDir != "src/app" {
		t.Errorf("NextAppDir = %q, want src/app", d.NextAppDir)
	}
	if d.Framework != FrameworkNextAppRouter {
		t.Errorf("Framework = %q", d.Framework)
	}
}

func TestDetect_NextBothRouters(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"package.json":   `{"dependencies":{"next":"15.0.0"}}`,
		"app/page.tsx":   "",
		"pages/index.ts": "",
	})
	d := Detect(dir)
	if !d.NextHasBothRouters {
		t.Errorf("expected NextHasBothRouters=true")
	}
}

func TestDetect_FastAPI(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"pyproject.toml": `[project]
name = "app"
dependencies = ["fastapi", "openai", "sqlalchemy"]
`,
		"uv.lock": "",
		".env":    "DATABASE_URL=postgres://localhost/db\n",
	})
	d := Detect(dir)
	if d.Language != stack.LanguagePython {
		t.Errorf("Language = %q", d.Language)
	}
	if d.Framework != FrameworkFastAPI {
		t.Errorf("Framework = %q", d.Framework)
	}
	if d.PackageManager != stack.PackageManagerUV {
		t.Errorf("PackageManager = %q", d.PackageManager)
	}
	if !contains(d.LLMLibs, LLMOpenAI) {
		t.Errorf("expected OpenAI, got %v", d.LLMLibs)
	}
}

// --- Config -----------------------------------------------------------------

func TestGenerateConfig_TSClerkWithDB(t *testing.T) {
	dir := t.TempDir()
	d := Detection{
		CWD:      dir,
		Language: stack.LanguageTS,
		Auth:     AuthClerk,
		DBEnvVar: "DATABASE_URL",
	}
	path, err := GenerateConfig(d, ConfigOptions{MountPath: "/admin/ai", WithDatabase: true})
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(path) != "gravel.config.ts" {
		t.Errorf("expected gravel.config.ts, got %s", path)
	}
	body, _ := os.ReadFile(path)
	got := string(body)
	mustContain(t, got, "import { defineConfig } from '@artanis-ai/gravel/define'")
	mustContain(t, got, "import { auth } from '@clerk/nextjs/server'")
	mustContain(t, got, "mountPath: '/admin/ai'")
	mustContain(t, got, "url: process.env.DATABASE_URL!")
	mustContain(t, got, "const { userId, sessionClaims } = await auth()")
	mustNotContain(t, got, "defaultPassword")
}

func TestGenerateConfig_TSNoAuth(t *testing.T) {
	dir := t.TempDir()
	d := Detection{
		CWD:      dir,
		Language: stack.LanguageTS,
		Auth:     AuthUnknown,
	}
	path, _ := GenerateConfig(d, ConfigOptions{MountPath: "/admin/ai", WithDatabase: false})
	body, _ := os.ReadFile(path)
	got := string(body)
	mustContain(t, got, "defaultPassword: process.env.GRAVEL_ADMIN_PASSWORD!")
	mustNotContain(t, got, "database:")
	mustNotContain(t, got, "import { auth }")
}

func TestGenerateConfig_TSNextAuthMissingHelper(t *testing.T) {
	// next-auth detected but no @/auth helper file present: must
	// demote to password-only template, NOT emit a broken import.
	dir := t.TempDir()
	d := Detection{
		CWD:      dir,
		Language: stack.LanguageTS,
		Auth:     AuthNextAuth,
	}
	path, _ := GenerateConfig(d, ConfigOptions{MountPath: "/admin/ai"})
	body, _ := os.ReadFile(path)
	got := string(body)
	mustContain(t, got, "defaultPassword: process.env.GRAVEL_ADMIN_PASSWORD!")
	mustNotContain(t, got, "import { auth as nextAuth }")
}

func TestGenerateConfig_PythonDjango(t *testing.T) {
	dir := t.TempDir()
	d := Detection{
		CWD:      dir,
		Language: stack.LanguagePython,
		Auth:     AuthDjango,
		DBEnvVar: "DATABASE_URL",
	}
	path, _ := GenerateConfig(d, ConfigOptions{MountPath: "/admin/ai", WithDatabase: true})
	if filepath.Base(path) != "gravel_config.py" {
		t.Errorf("expected gravel_config.py, got %s", path)
	}
	body, _ := os.ReadFile(path)
	got := string(body)
	mustContain(t, got, "from artanis_gravel import GravelConfig, GravelUser")
	mustContain(t, got, "'is_authenticated'")
	mustContain(t, got, "mount_path='/admin/ai'")
}

// --- Mount ------------------------------------------------------------------

func TestMount_NextAppRouter(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"package.json": `{"dependencies":{"next":"15.0.0"}}`,
		"app/page.tsx": "",
	})
	d := Detect(dir)
	res, err := Mount(d, "/admin/ai", MountOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if res.Mode != MountCreated {
		t.Errorf("Mode = %s", res.Mode)
	}
	wantPath := filepath.Join(dir, "app", "admin", "ai", "[[...slug]]", "route.ts")
	if res.Path != wantPath {
		t.Errorf("Path = %s, want %s", res.Path, wantPath)
	}
	body, _ := os.ReadFile(res.Path)
	got := string(body)
	mustContain(t, got, "import { createGravelHandler } from '@artanis-ai/gravel/next'")
	mustContain(t, got, "import { config } from '@/gravel.config'")
	mustContain(t, got, "export const dynamic = 'force-dynamic'")
	mustContain(t, got, "export const GET = handler")
}

func TestMount_NextAppRouter_SrcLayoutRelativeImport(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"package.json":     `{"dependencies":{"next":"15.0.0"}}`,
		"src/app/page.tsx": "",
	})
	d := Detect(dir)
	res, _ := Mount(d, "/admin/ai", MountOptions{})
	body, _ := os.ReadFile(res.Path)
	got := string(body)
	// src/app/admin/ai/[[...slug]]/route.ts -> ../../../../../gravel.config
	// 5 hops up: [[...slug]] → ai → admin → app → src → cwd.
	mustContain(t, got, "../../../../../gravel.config")
	mustNotContain(t, got, "@/gravel.config")
}

func TestMount_BackupsExistingRoute(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"package.json": `{"dependencies":{"next":"15.0.0"}}`,
		"app/page.tsx": "",
		"app/admin/ai/[[...slug]]/route.ts": "// existing user code\n",
	})
	d := Detect(dir)
	res, err := Mount(d, "/admin/ai", MountOptions{})
	if err != nil {
		t.Fatal(err)
	}
	bak := res.Path + ".gravel.bak"
	if !pathExists(bak) {
		t.Errorf("expected backup at %s", bak)
	}
	bakBody, _ := os.ReadFile(bak)
	if !strings.Contains(string(bakBody), "existing user code") {
		t.Errorf("backup didn't preserve original content: %s", bakBody)
	}
}

func TestMount_FastAPIReturnsInstructions(t *testing.T) {
	d := Detection{Framework: FrameworkFastAPI, CWD: t.TempDir()}
	res, _ := Mount(d, "/admin/ai", MountOptions{})
	if res.Mode != MountManual {
		t.Errorf("Mode = %s, want manual", res.Mode)
	}
	mustContain(t, res.Instructions, "create_gravel_router")
}

// --- Env --------------------------------------------------------------------

func TestEnsureAdminPassword_GeneratesOnce(t *testing.T) {
	dir := t.TempDir()
	pw, isNew, err := EnsureAdminPassword(dir)
	if err != nil {
		t.Fatal(err)
	}
	if !isNew || pw == "" {
		t.Errorf("first call: pw=%q isNew=%v", pw, isNew)
	}
	body, _ := os.ReadFile(filepath.Join(dir, ".env.local"))
	if !strings.Contains(string(body), "GRAVEL_ADMIN_PASSWORD="+pw) {
		t.Errorf("password not persisted, got:\n%s", body)
	}
	pw2, isNew2, _ := EnsureAdminPassword(dir)
	if isNew2 {
		t.Errorf("second call should be idempotent")
	}
	if pw2 != pw {
		t.Errorf("idempotent call returned different password: %q vs %q", pw, pw2)
	}
}

func TestEnsureAdminPassword_PreservesOtherEntries(t *testing.T) {
	dir := t.TempDir()
	pre := "DATABASE_URL=file:./gravel.db\nNEXT_PUBLIC_FLAG=on\n"
	if err := os.WriteFile(filepath.Join(dir, ".env.local"), []byte(pre), 0o600); err != nil {
		t.Fatal(err)
	}
	_, _, err := EnsureAdminPassword(dir)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := os.ReadFile(filepath.Join(dir, ".env.local"))
	got := string(body)
	mustContain(t, got, "DATABASE_URL=file:./gravel.db")
	mustContain(t, got, "NEXT_PUBLIC_FLAG=on")
	mustContain(t, got, "GRAVEL_ADMIN_PASSWORD=")
}

// --- Hook -------------------------------------------------------------------

func TestInstallHook_NativeWhenNoManager(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, ".git", "hooks"), 0o755); err != nil {
		t.Fatal(err)
	}
	res, err := InstallHook(dir)
	if err != nil {
		t.Fatal(err)
	}
	if res.Mode != HookNative {
		t.Errorf("Mode = %s, want native", res.Mode)
	}
	body, _ := os.ReadFile(res.Path)
	mustContain(t, string(body), "gravel manifest --check")
	// Idempotent re-run.
	res2, _ := InstallHook(dir)
	if !res2.AlreadyInstalled {
		t.Errorf("expected AlreadyInstalled=true on re-run, got %+v", res2)
	}
}

func TestInstallHook_HuskyAppendOnce(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, ".husky"), 0o755); err != nil {
		t.Fatal(err)
	}
	huskyPath := filepath.Join(dir, ".husky", "pre-commit")
	if err := os.WriteFile(huskyPath, []byte("npm test\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	res, _ := InstallHook(dir)
	if res.Mode != HookHusky {
		t.Errorf("Mode = %s", res.Mode)
	}
	body, _ := os.ReadFile(huskyPath)
	if !strings.Contains(string(body), "npm test") || !strings.Contains(string(body), "gravel manifest --check") {
		t.Errorf("husky body not merged:\n%s", body)
	}
	res2, _ := InstallHook(dir)
	if !res2.AlreadyInstalled {
		t.Errorf("expected idempotent re-run")
	}
}

func TestInstallHook_SkipsOutsideGitRepo(t *testing.T) {
	dir := t.TempDir()
	res, _ := InstallHook(dir)
	if res.Mode != HookSkipped {
		t.Errorf("Mode = %s, want skipped", res.Mode)
	}
}

// --- End-to-end Run() -------------------------------------------------------

func TestRun_NextAppRouterEndToEnd(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"package.json": `{
			"dependencies": {
				"next": "15.0.0",
				"@clerk/nextjs": "6.0.0"
			}
		}`,
		"pnpm-lock.yaml": "",
		"app/page.tsx":   "",
		"prompts/welcome.md": "Hello, world.\n",
	})
	if err := os.MkdirAll(filepath.Join(dir, ".git", "hooks"), 0o755); err != nil {
		t.Fatal(err)
	}
	res, err := Run(context.Background(), RunOptions{
		CWD:         dir,
		MountPath:   "/admin/ai",
		YesToAll:    true,
		WithPrompts: true,
		WithTraces:  false, // no DATABASE_URL fixture, keep it tracing-less
	}, os.Stdout)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	// Each expected artifact present?
	if !pathExists(filepath.Join(dir, "gravel.config.ts")) {
		t.Errorf("missing gravel.config.ts")
	}
	if !pathExists(filepath.Join(dir, "app", "admin", "ai", "[[...slug]]", "route.ts")) {
		t.Errorf("missing app router route file")
	}
	if !pathExists(filepath.Join(dir, ".env.local")) {
		t.Errorf("missing .env.local")
	}
	if res.AdminPassword == "" {
		t.Errorf("AdminPassword empty")
	}
	if res.ManifestCount != 1 {
		t.Errorf("ManifestCount = %d, want 1 (prompts/welcome.md)", res.ManifestCount)
	}
	if res.Hook.Mode != HookNative {
		t.Errorf("Hook.Mode = %s, want native", res.Hook.Mode)
	}

	// Manifest round-trips.
	m, err := manifest.Read(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(m.Prompts) != 1 || m.Prompts[0].Path != "prompts/welcome.md" {
		t.Errorf("manifest unexpected: %+v", m)
	}
}

// --- helpers ----------------------------------------------------------------

// newFixture creates a tempdir populated with the given relative-path
// files. Parents are created as needed. Empty values create empty files.
func newFixture(t *testing.T, files map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	for rel, content := range files {
		full := filepath.Join(dir, rel)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", filepath.Dir(full), err)
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatalf("write %s: %v", rel, err)
		}
	}
	return dir
}

func contains[T comparable](haystack []T, needle T) bool {
	for _, h := range haystack {
		if h == needle {
			return true
		}
	}
	return false
}

func mustContain(t *testing.T, haystack, needle string) {
	t.Helper()
	if !strings.Contains(haystack, needle) {
		t.Errorf("missing %q in:\n%s", needle, haystack)
	}
}

func mustNotContain(t *testing.T, haystack, needle string) {
	t.Helper()
	if strings.Contains(haystack, needle) {
		t.Errorf("unexpected %q in:\n%s", needle, haystack)
	}
}
