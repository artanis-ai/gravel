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

// REGRESSION: legacy / pre-PEP 518 Python projects ship a setup.py
// without a pyproject.toml. Detection used to bail out and treat
// them as "no project", so the install wizard offered Next.js
// detection instead of FastAPI. Make sure setup.py alone is enough.
func TestDetect_FastAPIWithSetupPyOnly(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"setup.py": `from setuptools import setup
setup(
    name="myapp",
    install_requires=["fastapi>=0.100", "openai>=1.0"],
)
`,
	})
	d := Detect(dir)
	if d.Language != stack.LanguagePython {
		t.Errorf("Language = %q (setup.py alone should still detect Python)", d.Language)
	}
	if d.Framework != FrameworkFastAPI {
		t.Errorf("Framework = %q, want fastapi", d.Framework)
	}
	if !contains(d.LLMLibs, LLMOpenAI) {
		t.Errorf("openai not detected from setup.py install_requires: %v", d.LLMLibs)
	}
}

func TestDetect_GeminiPython(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"pyproject.toml": `[project]
name = "app"
dependencies = ["fastapi", "google-genai>=1.0"]
`,
	})
	d := Detect(dir)
	if !contains(d.LLMLibs, LLMGemini) {
		t.Errorf("google-genai not detected as Gemini: %v", d.LLMLibs)
	}
}

func TestDetect_GeminiTS(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"package.json": `{
  "name": "app",
  "dependencies": {
    "next": "15.0.0",
    "@google/genai": "1.0.0"
  }
}`,
	})
	d := Detect(dir)
	if !contains(d.LLMLibs, LLMGemini) {
		t.Errorf("@google/genai not detected as Gemini: %v", d.LLMLibs)
	}
}

func TestDetect_FastAPIWithSetupCfg(t *testing.T) {
	// setup.cfg [options] install_requires syntax — another legacy
	// shape.
	dir := newFixture(t, map[string]string{
		"setup.cfg": `[metadata]
name = myapp

[options]
install_requires =
    fastapi
    anthropic
`,
		"setup.py": "from setuptools import setup\nsetup()\n",
	})
	d := Detect(dir)
	if d.Framework != FrameworkFastAPI {
		t.Errorf("Framework = %q, want fastapi", d.Framework)
	}
	if !contains(d.LLMLibs, LLMAnthropic) {
		t.Errorf("anthropic not detected from setup.cfg: %v", d.LLMLibs)
	}
}

// REGRESSION: requirements.txt-only project (no pyproject.toml) is a
// common workflow — pip install -r style.
func TestDetect_FastAPIWithRequirementsTxtOnly(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"requirements.txt": "fastapi==0.100.0\nopenai>=1.0\n",
	})
	d := Detect(dir)
	if d.Language != stack.LanguagePython {
		t.Errorf("Language = %q", d.Language)
	}
	if d.Framework != FrameworkFastAPI {
		t.Errorf("Framework = %q", d.Framework)
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

// REGRESSION: the published artanis-gravel<=0.5.2 SDK crashes inside
// `create_gravel_router` when `database.url` is empty (calls
// `open_database('')` → ValueError). The wizard's `--no-traces`
// install used to write `database={'url': ''}`, so any customer
// running the wizard against the released SDK got a server that
// failed to import.
//
// v0.9.0: when WithDatabase=false, emit an EMPTY database URL.
// Pre-v0.9.0 we wrote a stub `file:.gravel/dev.db` because
// artanis-gravel<=0.5.2 crashed on empty URLs; with v0.5.3+ that's
// fixed and the stub URL caused a real bug — Olly's dogfooding
// (2026-05-20) saw a spurious SQLite file get created on every
// install, even when traces weren't enabled. Empty URL means
// `create_gravel_router` leaves engine=None and no file is created.
func TestGenerateConfig_PythonNoDatabase_WritesEmptyUrl(t *testing.T) {
	dir := t.TempDir()
	d := Detection{
		CWD:      dir,
		Language: stack.LanguagePython,
		Auth:     AuthUnknown,
		DBEnvVar: "DATABASE_URL",
	}
	path, err := GenerateConfig(d, ConfigOptions{MountPath: "/admin/ai", WithDatabase: false})
	if err != nil {
		t.Fatal(err)
	}
	body, _ := os.ReadFile(path)
	got := string(body)
	// Empty URL — no SQLite file gets created.
	mustContain(t, got, "database={'url': ''}")
	// No env-var lookup for DATABASE_URL when traces is skipped.
	if strings.Contains(got, "os.environ['DATABASE_URL']") {
		t.Errorf("config reads DATABASE_URL with bracket syntax (KeyError-prone):\n%s", got)
	}
	if strings.Contains(got, "os.environ.get('DATABASE_URL'") {
		t.Errorf("WithDatabase=false should NOT lookup DATABASE_URL at all:\n%s", got)
	}
	// Stub sqlite path must NOT appear (Olly bug).
	if strings.Contains(got, ".gravel/dev.db") {
		t.Errorf("regression: WithDatabase=false must NOT emit a stub SQLite URL:\n%s", got)
	}
	mustContain(t, got, "mount_path='/admin/ai'")
	mustContain(t, got, "'default_password': os.environ.get('GRAVEL_ADMIN_PASSWORD', '')")
	// .gravel/ directory still created (for manifest etc.); it just
	// stays empty on a no-traces install.
	if _, err := os.Stat(filepath.Join(dir, ".gravel")); err != nil {
		t.Errorf(".gravel/ directory not created: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, ".gravel", ".gitignore")); err != nil {
		t.Errorf(".gravel/.gitignore not created: %v", err)
	}
}

func TestGenerateConfig_PythonWithDatabase_EmitsDatabaseBlock(t *testing.T) {
	dir := t.TempDir()
	d := Detection{
		CWD:      dir,
		Language: stack.LanguagePython,
		Auth:     AuthUnknown,
		DBEnvVar: "DATABASE_URL",
	}
	path, _ := GenerateConfig(d, ConfigOptions{MountPath: "/admin/ai", WithDatabase: true})
	body, _ := os.ReadFile(path)
	got := string(body)
	mustContain(t, got, "database={'url': os.environ.get('DATABASE_URL', '')}")
}

// REGRESSION: the generated gravel_config.py used to crash app
// startup because env vars weren't loaded — `uv run` doesn't pull
// .env.local into os.environ automatically. The generator now
// inlines a tiny .env loader so the config resolves correctly no
// matter how the host is launched.
func TestGenerateConfig_PythonAutoLoadsDotEnv(t *testing.T) {
	dir := t.TempDir()
	d := Detection{
		CWD:      dir,
		Language: stack.LanguagePython,
		Auth:     AuthUnknown,
	}
	path, _ := GenerateConfig(d, ConfigOptions{MountPath: "/admin/ai"})
	body, _ := os.ReadFile(path)
	got := string(body)
	mustContain(t, got, `for _env_file in (".env.local", ".env"):`)
	mustContain(t, got, "os.environ.setdefault")
	// Loader must run BEFORE the env-var reads in the config body.
	loaderIdx := strings.Index(got, "_env_file")
	configIdx := strings.Index(got, "os.environ.get('GRAVEL_ADMIN_PASSWORD'")
	if loaderIdx < 0 || configIdx < 0 || loaderIdx > configIdx {
		t.Errorf("env loader must run before env reads in the config body:\n%s", got)
	}
}

// REGRESSION: the generated config used to read env vars with
// `os.environ['X']`, which raised KeyError at import time if the
// user started uvicorn without their .env loaded. We now use
// `os.environ.get(..., '')` so the import succeeds and the SDK
// raises a clearer runtime error from the right place.
func TestGenerateConfig_PythonUsesGetForEnvLookups(t *testing.T) {
	dir := t.TempDir()
	d := Detection{
		CWD:      dir,
		Language: stack.LanguagePython,
		Auth:     AuthUnknown,
		DBEnvVar: "DATABASE_URL",
	}
	path, _ := GenerateConfig(d, ConfigOptions{MountPath: "/admin/ai", WithDatabase: true})
	body, _ := os.ReadFile(path)
	got := string(body)
	if strings.Contains(got, "os.environ['") || strings.Contains(got, "os.environ[\"") {
		t.Errorf("config uses os.environ[X] subscript (KeyError-prone) instead of .get():\n%s", got)
	}
}

func TestGenerateConfig_PythonDjangoNoDatabase(t *testing.T) {
	// Django path generates its own auth block. WithDatabase=false
	// emits the empty database URL (v0.9.0 behaviour — no spurious
	// SQLite file).
	dir := t.TempDir()
	d := Detection{
		CWD:      dir,
		Language: stack.LanguagePython,
		Auth:     AuthDjango,
		DBEnvVar: "DATABASE_URL",
	}
	path, _ := GenerateConfig(d, ConfigOptions{MountPath: "/admin/ai", WithDatabase: false})
	body, _ := os.ReadFile(path)
	got := string(body)
	mustContain(t, got, "database={'url': ''}")
	if strings.Contains(got, ".gravel/dev.db") {
		t.Errorf("Django + WithDatabase=false must NOT emit stub SQLite URL:\n%s", got)
	}
	if strings.Contains(got, "os.environ.get('DATABASE_URL'") {
		t.Errorf("Django + WithDatabase=false should NOT lookup DATABASE_URL:\n%s", got)
	}
	mustContain(t, got, "'get_user': get_user")
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

func TestMount_BackupsExistingRoute_NoGit(t *testing.T) {
	// No .git directory anywhere in the tree → safeBackup writes a
	// .gravel.bak so user content is recoverable.
	dir := newFixture(t, map[string]string{
		"package.json":                      `{"dependencies":{"next":"15.0.0"}}`,
		"app/page.tsx":                      "",
		"app/admin/ai/[[...slug]]/route.ts": "// existing user code\n",
	})
	d := Detect(dir)
	res, err := Mount(d, "/admin/ai", MountOptions{})
	if err != nil {
		t.Fatal(err)
	}
	bak := res.Path + ".gravel.bak"
	if !pathExists(bak) {
		t.Errorf("expected .gravel.bak at %s (no git repo to fall back to)", bak)
	}
	bakBody, _ := os.ReadFile(bak)
	if !strings.Contains(string(bakBody), "existing user code") {
		t.Errorf("backup didn't preserve original content: %s", bakBody)
	}
}

// REGRESSION: when the project is inside a git working tree, the
// wizard should NOT write .gravel.bak files. Git is the safety net.
// Yousef raised this specifically — previous installs cluttered up
// his working tree with .gravel.bak files that he then had to clean
// up by hand.
func TestMount_NoBackup_InsideGitRepo(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"package.json":                      `{"dependencies":{"next":"15.0.0"}}`,
		"app/page.tsx":                      "",
		"app/admin/ai/[[...slug]]/route.ts": "// existing user code\n",
	})
	if err := os.MkdirAll(filepath.Join(dir, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	d := Detect(dir)
	res, err := Mount(d, "/admin/ai", MountOptions{})
	if err != nil {
		t.Fatal(err)
	}
	bak := res.Path + ".gravel.bak"
	if pathExists(bak) {
		t.Errorf(".gravel.bak shouldn't exist inside a git working tree; the user can `git diff` to recover (found at %s)", bak)
	}
	// Confirm the new content landed on top of the old file.
	body, _ := os.ReadFile(res.Path)
	if strings.Contains(string(body), "existing user code") {
		t.Errorf("new content should have overwritten the old file:\n%s", body)
	}
	if !strings.Contains(string(body), "createGravelHandler") {
		t.Errorf("new content missing:\n%s", body)
	}
}

// Walking up: a .git directory at the project root must satisfy
// safeBackup even when the file being backed up is deeper (e.g.
// src/app/admin/ai/[[...slug]]/route.ts).
func TestMount_NoBackup_GitAtParent(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"package.json":     `{"dependencies":{"next":"15.0.0"}}`,
		"src/app/page.tsx": "",
		"src/app/admin/ai/[[...slug]]/route.ts": "// existing\n",
	})
	if err := os.MkdirAll(filepath.Join(dir, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	d := Detect(dir)
	res, _ := Mount(d, "/admin/ai", MountOptions{})
	if pathExists(res.Path + ".gravel.bak") {
		t.Errorf("walker didn't find .git at project root for a deeply nested mount file")
	}
}

// .git file (worktree pointer) should count as well — git worktree
// uses `.git` as a *file* containing `gitdir: ...`, not a directory.
func TestMount_NoBackup_GitFile(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"package.json":                      `{"dependencies":{"next":"15.0.0"}}`,
		"app/page.tsx":                      "",
		"app/admin/ai/[[...slug]]/route.ts": "// existing\n",
		".git":                              "gitdir: /elsewhere/worktree/.git\n",
	})
	d := Detect(dir)
	res, _ := Mount(d, "/admin/ai", MountOptions{})
	if pathExists(res.Path + ".gravel.bak") {
		t.Errorf(".git file (git worktree pointer) wasn't recognised as a git work tree")
	}
}

func TestIsInsideGitWorkTree_NoGitAnywhere(t *testing.T) {
	// Use a tempdir under t.TempDir so we don't accidentally pick up
	// a real .git from /home/amar. t.TempDir is somewhere under
	// /tmp, which has no .git ancestor.
	dir := t.TempDir()
	probe := filepath.Join(dir, "some", "deep", "file.ts")
	if isInsideGitWorkTree(probe) {
		t.Errorf("isInsideGitWorkTree true under bare tempdir %q", dir)
	}
}

func TestIsInsideGitWorkTree_GitInImmediateParent(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	if !isInsideGitWorkTree(filepath.Join(dir, "a.ts")) {
		t.Errorf("isInsideGitWorkTree false when .git is in the immediate parent")
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
	res, err := InstallHook(dir, "")
	if err != nil {
		t.Fatal(err)
	}
	if res.Mode != HookNative {
		t.Errorf("Mode = %s, want native", res.Mode)
	}
	body, _ := os.ReadFile(res.Path)
	mustContain(t, string(body), "gravel manifest --check")
	// Idempotent re-run.
	res2, _ := InstallHook(dir, "")
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
	res, _ := InstallHook(dir, "")
	if res.Mode != HookHusky {
		t.Errorf("Mode = %s", res.Mode)
	}
	body, _ := os.ReadFile(huskyPath)
	if !strings.Contains(string(body), "npm test") || !strings.Contains(string(body), "gravel manifest --check") {
		t.Errorf("husky body not merged:\n%s", body)
	}
	res2, _ := InstallHook(dir, "")
	if !res2.AlreadyInstalled {
		t.Errorf("expected idempotent re-run")
	}
}

func TestInstallHook_SkipsOutsideGitRepo(t *testing.T) {
	dir := t.TempDir()
	res, _ := InstallHook(dir, "")
	if res.Mode != HookSkipped {
		t.Errorf("Mode = %s, want skipped", res.Mode)
	}
}

// v0.9.1: hook entry must use the package manager's run command so
// the bin resolves without an activated venv. Claude's de_platform
// install (2026-05-20) hit `command not found: gravel` because uv's
// venv wasn't on PATH.
func TestInstallHook_PythonUVUsesUvRun(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, ".git", "hooks"), 0o755); err != nil {
		t.Fatal(err)
	}
	res, err := InstallHook(dir, stack.PackageManagerUV)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := os.ReadFile(res.Path)
	got := string(body)
	if !strings.Contains(got, "uv run gravel manifest --check") {
		t.Errorf("uv hook must use `uv run gravel manifest --check`:\n%s", got)
	}
}

func TestInstallHook_PNPMUsesPnpmExec(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, ".git", "hooks"), 0o755); err != nil {
		t.Fatal(err)
	}
	res, err := InstallHook(dir, stack.PackageManagerPNPM)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := os.ReadFile(res.Path)
	if !strings.Contains(string(body), "pnpm exec gravel manifest --check") {
		t.Errorf("pnpm hook must use `pnpm exec`:\n%s", body)
	}
}

// v0.9.1: a pre-commit YAML at 4-space indent must NOT get a
// 2-space block inserted (yaml becomes unparseable). Match the
// existing indent. Claude's de_platform was the canonical case.
func TestInstallHook_PreCommitYAML_MatchesExistingIndent(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	// 4-space existing config.
	existing := `repos:
    - repo: https://github.com/astral-sh/ruff-pre-commit
      rev: v0.1.0
      hooks:
          - id: ruff
`
	preYAML := filepath.Join(dir, ".pre-commit-config.yaml")
	if err := os.WriteFile(preYAML, []byte(existing), 0o644); err != nil {
		t.Fatal(err)
	}
	res, err := InstallHook(dir, stack.PackageManagerUV)
	if err != nil {
		t.Fatal(err)
	}
	if res.Mode != HookPreCommitFramework {
		t.Errorf("Mode = %s, want pre-commit-framework", res.Mode)
	}
	body, _ := os.ReadFile(preYAML)
	got := string(body)
	// Our injected block must use 4-space indent — the `- repo:` line
	// must have 4 leading spaces, NOT 2.
	if !strings.Contains(got, "    - repo: local") {
		t.Errorf("expected 4-space `- repo: local` to match existing indent:\n%s", got)
	}
	if strings.Contains(got, "  - repo: local") && !strings.Contains(got, "    - repo: local") {
		t.Errorf("regression: emitted 2-space block into 4-space config:\n%s", got)
	}
	// Entry must still use uv run.
	if !strings.Contains(got, "entry: uv run gravel manifest --check") {
		t.Errorf("entry should use uv run:\n%s", got)
	}
}

func TestInstallHook_PreCommitYAML_DefaultTwoSpaceOnFresh(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	// 2-space existing config (the pre-commit canonical).
	existing := `repos:
  - repo: https://github.com/astral-sh/ruff-pre-commit
    rev: v0.1.0
    hooks:
      - id: ruff
`
	preYAML := filepath.Join(dir, ".pre-commit-config.yaml")
	if err := os.WriteFile(preYAML, []byte(existing), 0o644); err != nil {
		t.Fatal(err)
	}
	res, _ := InstallHook(dir, stack.PackageManagerUV)
	if res.Mode != HookPreCommitFramework {
		t.Fatalf("Mode = %s, want pre-commit-framework", res.Mode)
	}
	body, _ := os.ReadFile(preYAML)
	got := string(body)
	if !strings.Contains(got, "  - repo: local") {
		t.Errorf("expected 2-space block in 2-space config:\n%s", got)
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
		CWD:            dir,
		MountPath:      "/admin/ai",
		YesToAll:       true,
		WithPrompts:    true,
		WithTraces:     false, // no DATABASE_URL fixture, keep it tracing-less
		SkipSDKInstall: true,  // fixture has no real registry; SDK install tested separately
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
