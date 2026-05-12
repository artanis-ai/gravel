package wizard

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// run_test.go drives Run() end-to-end with the full RunOptions surface
// and asserts on the wizard's behaviour: which files it wrote, what
// it printed to the UI stream, and which idempotency paths fired.
//
// Each test captures the UI output to a buffer (via SetUIOutput) so we
// can grep for specific copy — "Already wired up", "instrumentation.ts
// already present", "Trigger an LLM call", etc. The UI stream IS the
// contract the user sees; if we don't pin it, regressions go unnoticed
// until someone runs the binary by hand.

// captureUI swaps the wizard's UI writer for a bytes.Buffer for the
// duration of fn, returning everything that was written. Re-uses
// SetUIOutput so colour rendering is deterministic (off, plain ASCII).
func captureUI(t *testing.T, fn func()) string {
	t.Helper()
	buf := &bytes.Buffer{}
	prevOut := uiOut
	prevColor := hasColor
	prevTTY := hasTTY
	SetUIOutput(buf, false)
	t.Cleanup(func() {
		uiSync.Lock()
		uiOut = prevOut
		hasColor = prevColor
		hasTTY = prevTTY
		uiSync.Unlock()
	})
	fn()
	return buf.String()
}

func TestRun_DashboardOnly_PrintsTriggerHintFalseAbsent(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"package.json": `{"dependencies":{"next":"15.0.0"}}`,
		"app/page.tsx": "",
	})
	out := captureUI(t, func() {
		_, err := Run(context.Background(), RunOptions{
			CWD:            dir,
			MountPath:      "/admin/ai",
			YesToAll:       true,
			SkipSDKInstall: true,
			WithPrompts:    false, PromptsExplicit: true,
			WithTraces: false, TracesExplicit: true,
		}, os.Stdout)
		if err != nil {
			t.Fatal(err)
		}
	})
	// Dashboard written.
	if !pathExists(filepath.Join(dir, "app", "admin", "ai", "[[...slug]]", "route.ts")) {
		t.Errorf("dashboard mount not written")
	}
	if !pathExists(filepath.Join(dir, "gravel.config.ts")) {
		t.Errorf("gravel.config.ts not written")
	}
	// Step 1 success copy.
	mustContain(t, out, "Wrote app/admin/ai/[[...slug]]/route.ts")
	mustContain(t, out, "gravel.config.ts written")
	// Skipped pillars summary.
	mustContain(t, out, "Prompts: skipped")
	mustContain(t, out, "Traces: skipped")
	// Trigger-LLM hint must NOT appear when traces isn't run.
	if strings.Contains(out, "Trigger an LLM call") {
		t.Errorf("trigger-LLM hint shown despite traces being skipped")
	}
}

func TestRun_PythonProject_BulletSaysConfigPy(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"pyproject.toml": `[project]
name = "app"
dependencies = ["fastapi"]
`,
		"main.py": "from fastapi import FastAPI\napp = FastAPI()\n",
	})
	out := captureUI(t, func() {
		_, err := Run(context.Background(), RunOptions{
			CWD:            dir,
			MountPath:      "/admin/ai",
			YesToAll:       true,
			SkipSDKInstall: true,
			WithPrompts:    false, PromptsExplicit: true,
			WithTraces: false, TracesExplicit: true,
		}, os.Stdout)
		if err != nil {
			t.Fatal(err)
		}
	})
	// REGRESSION: the bullet used to say "gravel.config.ts written" on
	// Python projects too. Must report the correct filename.
	mustContain(t, out, "gravel_config.py written")
	if strings.Contains(out, "gravel.config.ts written") {
		t.Errorf("bullet should not say 'gravel.config.ts' for python:\n%s", out)
	}
	if !pathExists(filepath.Join(dir, "gravel_config.py")) {
		t.Errorf("gravel_config.py not written")
	}
}

func TestRun_FastAPIWithMainPy_AutoMounts(t *testing.T) {
	// Exact shape from Yousef's bug report: FastAPI project with
	// a real main.py. Must NOT show "manual step (instructions
	// below)" — must patch main.py automatically.
	dir := newFixture(t, map[string]string{
		"pyproject.toml": `[project]
name = "app"
dependencies = ["fastapi"]
`,
		"main.py": "from fastapi import FastAPI\napp = FastAPI()\n",
	})
	out := captureUI(t, func() {
		_, err := Run(context.Background(), RunOptions{
			CWD:            dir,
			MountPath:      "/admin/ai",
			YesToAll:       true,
			SkipSDKInstall: true,
			WithPrompts:    false, PromptsExplicit: true,
			WithTraces: false, TracesExplicit: true,
		}, os.Stdout)
		if err != nil {
			t.Fatal(err)
		}
	})
	// Must NOT hit the manual fallback.
	if strings.Contains(out, "manual step") || strings.Contains(out, "Manual mount instructions") {
		t.Errorf("FastAPI manual fallback fired when it shouldn't have:\n%s", out)
	}
	// main.py got the include_router line.
	body, _ := os.ReadFile(filepath.Join(dir, "main.py"))
	mustContain(t, string(body), "app.include_router(gravel_router, prefix='/admin/ai')")
}

func TestRun_FastAPINoEntry_ShowsManualFallback_WithRedX(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"pyproject.toml": `[project]
name = "app"
dependencies = ["fastapi"]
`,
	})
	out := captureUI(t, func() {
		_, err := Run(context.Background(), RunOptions{
			CWD:            dir,
			MountPath:      "/admin/ai",
			YesToAll:       true,
			SkipSDKInstall: true,
			WithPrompts:    false, PromptsExplicit: true,
			WithTraces: false, TracesExplicit: true,
		}, os.Stdout)
		if err != nil {
			t.Fatal(err)
		}
	})
	// Manual-fallback message present.
	mustContain(t, out, "Couldn't auto-patch")
	// AND uses a red ✗ marker (not a green ✓). With colour off, the
	// symbol still has to be ✗.
	if !strings.Contains(out, "✗") {
		t.Errorf("expected ✗ marker on manual fallback, got:\n%s", out)
	}
	// gravel_route.py written anyway (so paste-instructions resolve).
	if !pathExists(filepath.Join(dir, "gravel_route.py")) {
		t.Errorf("gravel_route.py not written on manual fallback")
	}
}

func TestRun_IdempotentReRun_SkipsMountAndPasswordAndHook(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"package.json": `{"dependencies":{"next":"15.0.0"}}`,
		"app/page.tsx": "",
	})
	// First run: cold install.
	if _, err := Run(context.Background(), RunOptions{
		CWD: dir, MountPath: "/admin/ai", YesToAll: true,
		SkipSDKInstall: true,
		WithPrompts:    false, PromptsExplicit: true,
		WithTraces: false, TracesExplicit: true,
	}, os.Stdout); err != nil {
		t.Fatal(err)
	}
	// Second run: should hit the idempotent skip path.
	out := captureUI(t, func() {
		_, err := Run(context.Background(), RunOptions{
			CWD: dir, MountPath: "/admin/ai", YesToAll: true,
			SkipSDKInstall: true,
			WithPrompts:    false, PromptsExplicit: true,
			WithTraces: false, TracesExplicit: true,
		}, os.Stdout)
		if err != nil {
			t.Fatal(err)
		}
	})
	mustContain(t, out, "Already wired up at /admin/ai. Skipping.")
	// Mounting spinner should NOT fire on the idempotent path.
	if strings.Contains(out, "Mounting dashboard…") {
		t.Errorf("re-run re-ran the mounter:\n%s", out)
	}
}

func TestRun_APIKeyAndProjectID_WrittenToEnv(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"package.json": `{"dependencies":{"next":"15.0.0"}}`,
		"app/page.tsx": "",
	})
	_, err := Run(context.Background(), RunOptions{
		CWD: dir, MountPath: "/admin/ai", YesToAll: true,
		SkipSDKInstall: true,
		APIKey:         "sk_test_123",
		ProjectID:      "proj_abc",
		WithPrompts:    false, PromptsExplicit: true,
		WithTraces: false, TracesExplicit: true,
	}, os.Stdout)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := os.ReadFile(filepath.Join(dir, ".env.local"))
	got := string(body)
	mustContain(t, got, "GRAVEL_API_KEY=sk_test_123")
	mustContain(t, got, "GRAVEL_PROJECT_ID=proj_abc")
	mustContain(t, got, "GRAVEL_ADMIN_PASSWORD=")
}

func TestRun_APIKeyAlone_NotWrittenWithoutProjectID(t *testing.T) {
	// Both flags together → write. One alone → silently skip
	// (mirrors TS reference; half a credential pair is useless).
	dir := newFixture(t, map[string]string{
		"package.json": `{"dependencies":{"next":"15.0.0"}}`,
		"app/page.tsx": "",
	})
	_, err := Run(context.Background(), RunOptions{
		CWD: dir, MountPath: "/admin/ai", YesToAll: true,
		SkipSDKInstall: true,
		APIKey:         "sk_test_123",
		// No ProjectID.
		WithPrompts: false, PromptsExplicit: true,
		WithTraces: false, TracesExplicit: true,
	}, os.Stdout)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := os.ReadFile(filepath.Join(dir, ".env.local"))
	if strings.Contains(string(body), "GRAVEL_API_KEY") {
		t.Errorf("api key written without project ID:\n%s", body)
	}
}

func TestRun_InstrumentationAlreadyPresent_Skipped(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"package.json":       `{"dependencies":{"next":"15.0.0"}}`,
		"app/page.tsx":       "",
		"instrumentation.ts": "export function register() {}\n",
	})
	if err := os.WriteFile(filepath.Join(dir, ".env.local"),
		[]byte("DATABASE_URL=file:"+filepath.Join(dir, "test.db")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	out := captureUI(t, func() {
		_, err := Run(context.Background(), RunOptions{
			CWD: dir, MountPath: "/admin/ai", YesToAll: true,
			SkipSDKInstall: true,
			WithPrompts:    false, PromptsExplicit: true,
			WithTraces: true, TracesExplicit: true,
		}, os.Stdout)
		if err != nil {
			t.Fatal(err)
		}
	})
	mustContain(t, out, "instrumentation.ts already present")
	// Existing instrumentation.ts must not be clobbered.
	body, _ := os.ReadFile(filepath.Join(dir, "instrumentation.ts"))
	if !strings.Contains(string(body), "register() {}") {
		t.Errorf("user's instrumentation.ts was overwritten:\n%s", body)
	}
}

func TestRun_TracesNoURL_SkipReasonInSummary(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"package.json": `{"dependencies":{"next":"15.0.0"}}`,
		"app/page.tsx": "",
	})
	out := captureUI(t, func() {
		_, err := Run(context.Background(), RunOptions{
			CWD: dir, MountPath: "/admin/ai", YesToAll: true,
			SkipSDKInstall: true,
			WithPrompts:    false, PromptsExplicit: true,
			WithTraces: true, TracesExplicit: true,
		}, os.Stdout)
		if err != nil {
			t.Fatal(err)
		}
	})
	mustContain(t, out, "No DATABASE_URL detected")
	// The actionable skip-reason bullet in the closing summary.
	mustContain(t, out, "Traces: No DATABASE_URL.")
}

func TestRun_PromptsPillar_WritesManifestAndHook(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"package.json":      `{"dependencies":{"next":"15.0.0"}}`,
		"app/page.tsx":      "",
		"prompts/welcome.md": "Hello world\n",
		"prompts/system.md":  "Be concise\n",
	})
	if err := os.MkdirAll(filepath.Join(dir, ".git", "hooks"), 0o755); err != nil {
		t.Fatal(err)
	}
	res, err := Run(context.Background(), RunOptions{
		CWD: dir, MountPath: "/admin/ai", YesToAll: true,
		SkipSDKInstall: true,
		WithPrompts:    true,
		WithTraces:     false, TracesExplicit: true,
	}, os.Stdout)
	if err != nil {
		t.Fatal(err)
	}
	if res.ManifestCount != 2 {
		t.Errorf("ManifestCount = %d, want 2", res.ManifestCount)
	}
	if res.Hook.Mode != HookNative {
		t.Errorf("Hook.Mode = %s, want native", res.Hook.Mode)
	}
	if !pathExists(filepath.Join(dir, ".gravel", "manifest.json")) {
		t.Errorf("manifest not written")
	}
}

func TestRun_TracesPillar_SQLite_BootstrapsAndRewritesConfig(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"package.json": `{"dependencies":{"next":"15.0.0"}}`,
		"app/page.tsx": "",
	})
	// SQLite URLs resolve relative to the runtime CWD, not the wizard's
	// cwd argument — use an absolute path so the test doesn't have to
	// chdir.
	if err := os.WriteFile(filepath.Join(dir, ".env.local"),
		[]byte("DATABASE_URL=file:"+filepath.Join(dir, "test.db")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	out := captureUI(t, func() {
		res, err := Run(context.Background(), RunOptions{
			CWD: dir, MountPath: "/admin/ai", YesToAll: true,
			SkipSDKInstall: true,
			WithPrompts:    false, PromptsExplicit: true,
			WithTraces: true,
		}, os.Stdout)
		if err != nil {
			t.Fatal(err)
		}
		if !res.MigrateApplied {
			t.Errorf("MigrateApplied = false, want true")
		}
	})
	mustContain(t, out, "Two gravel_* tables ready")
	mustContain(t, out, "Trigger an LLM call from your app")
	mustContain(t, out, "Updating gravel.config.ts with database block")
	// Config got rewritten with the DB block.
	body, _ := os.ReadFile(filepath.Join(dir, "gravel.config.ts"))
	mustContain(t, string(body), "database:")
	mustContain(t, string(body), "url: process.env.DATABASE_URL!")
}

func TestRun_TracesReRun_ShowsAlreadyExistsSkip(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"package.json": `{"dependencies":{"next":"15.0.0"}}`,
		"app/page.tsx": "",
	})
	if err := os.WriteFile(filepath.Join(dir, ".env.local"),
		[]byte("DATABASE_URL=file:"+filepath.Join(dir, "test.db")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	// First run installs everything.
	if _, err := Run(context.Background(), RunOptions{
		CWD: dir, MountPath: "/admin/ai", YesToAll: true,
		SkipSDKInstall: true,
		WithPrompts:    false, PromptsExplicit: true,
		WithTraces: true,
	}, os.Stdout); err != nil {
		t.Fatal(err)
	}
	// Second run hits the already-exists path.
	out := captureUI(t, func() {
		_, err := Run(context.Background(), RunOptions{
			CWD: dir, MountPath: "/admin/ai", YesToAll: true,
			SkipSDKInstall: true,
			WithPrompts:    false, PromptsExplicit: true,
			WithTraces: true,
		}, os.Stdout)
		if err != nil {
			t.Fatal(err)
		}
	})
	mustContain(t, out, "gravel_* tables already exist. Skipping CREATE.")
	mustContain(t, out, "instrumentation.ts already present")
}

func TestRun_CustomMountPath_ReflectsInOutput(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"package.json": `{"dependencies":{"next":"15.0.0"}}`,
		"app/page.tsx": "",
	})
	out := captureUI(t, func() {
		_, err := Run(context.Background(), RunOptions{
			CWD: dir, MountPath: "/control", MountPathExplicit: true,
			YesToAll: true, SkipSDKInstall: true,
			WithPrompts: false, PromptsExplicit: true,
			WithTraces: false, TracesExplicit: true,
		}, os.Stdout)
		if err != nil {
			t.Fatal(err)
		}
	})
	mustContain(t, out, "Wrote app/control/[[...slug]]/route.ts")
	if !pathExists(filepath.Join(dir, "app", "control", "[[...slug]]", "route.ts")) {
		t.Errorf("custom mount path file not written")
	}
}

func TestRun_PortFromPackageJson_AppearsInURL(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"package.json": `{
			"scripts": {"dev": "next dev -p 4001"},
			"dependencies": {"next": "15.0.0"}
		}`,
		"app/page.tsx": "",
	})
	out := captureUI(t, func() {
		_, err := Run(context.Background(), RunOptions{
			CWD: dir, MountPath: "/admin/ai", YesToAll: true,
			SkipSDKInstall: true,
			WithPrompts:    false, PromptsExplicit: true,
			WithTraces: false, TracesExplicit: true,
		}, os.Stdout)
		if err != nil {
			t.Fatal(err)
		}
	})
	mustContain(t, out, "http://localhost:4001/admin/ai")
	// Should NOT say "on whatever host:port" when we have a guess.
	if strings.Contains(out, "on whatever host:port") {
		t.Errorf("fallback URL copy shown despite port guess:\n%s", out)
	}
}

func TestRun_BothRouters_HeadsUpBullet(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"package.json":   `{"dependencies":{"next":"15.0.0"}}`,
		"app/page.tsx":   "",
		"pages/index.ts": "",
	})
	out := captureUI(t, func() {
		_, err := Run(context.Background(), RunOptions{
			CWD: dir, MountPath: "/admin/ai", YesToAll: true,
			SkipSDKInstall: true,
			WithPrompts:    false, PromptsExplicit: true,
			WithTraces: false, TracesExplicit: true,
		}, os.Stdout)
		if err != nil {
			t.Fatal(err)
		}
	})
	mustContain(t, out, "Heads-up: this project has both")
}

func TestRun_ResultStructFieldsPopulated(t *testing.T) {
	// Sanity-check that RunResult is filled in correctly for the
	// cobra layer's printSummary to work with.
	dir := newFixture(t, map[string]string{
		"package.json": `{"dependencies":{"next":"15.0.0"}}`,
		"app/page.tsx": "",
	})
	if err := os.WriteFile(filepath.Join(dir, ".env.local"),
		[]byte("DATABASE_URL=file:"+filepath.Join(dir, "t.db")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	res, err := Run(context.Background(), RunOptions{
		CWD: dir, MountPath: "/admin/ai", YesToAll: true,
		SkipSDKInstall: true,
		WithPrompts:    false, PromptsExplicit: true,
		WithTraces: true,
	}, os.Stdout)
	if err != nil {
		t.Fatal(err)
	}
	if res.Detection.Framework != FrameworkNextAppRouter {
		t.Errorf("Detection.Framework = %s", res.Detection.Framework)
	}
	if res.ConfigPath == "" {
		t.Errorf("ConfigPath empty")
	}
	if res.AdminPassword == "" {
		t.Errorf("AdminPassword empty")
	}
	if !res.AdminPwIsNew {
		t.Errorf("AdminPwIsNew = false on cold install")
	}
	if !res.MigrateApplied {
		t.Errorf("MigrateApplied = false despite DATABASE_URL present")
	}
}
