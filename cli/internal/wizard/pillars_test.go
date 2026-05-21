package wizard

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/artanis-ai/gravel/cli/internal/stack"
)

func TestPlanMount_BareStack_EmitsMinimumActions(t *testing.T) {
	d := Detection{
		CWD:            t.TempDir(),
		Language:       stack.LanguageTS,
		PackageManager: stack.PackageManagerPNPM,
		Framework:      FrameworkExpress,
		Auth:           AuthUnknown,
		DBDriver:       DBUnknown,
	}
	plan := PlanMount(context.Background(), MountPillarOptions{Detection: d})
	if plan.Pillar != "mount" {
		t.Fatalf("pillar = %q, want %q", plan.Pillar, "mount")
	}
	// Always: config + mount file + admin password env.
	if len(plan.Actions) < 3 {
		t.Fatalf("expected at least 3 actions (config + mount + env), got %d: %+v", len(plan.Actions), plan.Actions)
	}
	kinds := map[string]int{}
	for _, a := range plan.Actions {
		kinds[a.Kind]++
	}
	if kinds[ActionWriteFile] < 2 {
		t.Errorf("want ≥2 write_file actions, got %d", kinds[ActionWriteFile])
	}
	if kinds[ActionWriteEnv] < 1 {
		t.Errorf("want ≥1 write_env action, got %d", kinds[ActionWriteEnv])
	}
}

// v0.9.1 polyglot fix: hybrid Next.js + FastAPI repo. Primary
// language is python (because of pyproject.toml + fastapi); the
// mount pillar still needs to patch next.config + Clerk
// middleware + vercel.json because the dashboard reaches the
// FastAPI side through the Next/Vercel edge. Claude's
// de_platform install (2026-05-20) hit the broken non-polyglot
// path — dashboard worked on localhost via FastAPI direct,
// 404'd on Vercel.
func TestPlanMount_PolyglotPythonPrimaryWithNextClerkVercel(t *testing.T) {
	dir := t.TempDir()
	// Python side (uv lockfile pushes HostStack to pick python primary
	// even though package.json is present alongside)
	writeTestFile(t, filepath.Join(dir, "pyproject.toml"), `[project]
name = "app"
dependencies = ["fastapi"]
`)
	writeTestFile(t, filepath.Join(dir, "uv.lock"), "")
	writeTestFile(t, filepath.Join(dir, "main.py"), "from fastapi import FastAPI\napp = FastAPI()\n")
	// Next.js side
	writeTestFile(t, filepath.Join(dir, "package.json"), `{
		"dependencies": {
			"next": "15.0.0",
			"@clerk/nextjs": "6.0.0"
		}
	}`)
	writeTestFile(t, filepath.Join(dir, "next.config.ts"), "export default {};")
	writeTestFile(t, filepath.Join(dir, "middleware.ts"), `import { clerkMiddleware } from '@clerk/nextjs/server'
export default clerkMiddleware()
`)
	writeTestFile(t, filepath.Join(dir, "vercel.json"), `{"rewrites":[]}`)
	if err := os.MkdirAll(filepath.Join(dir, "app"), 0o755); err != nil {
		t.Fatal(err)
	}
	writeTestFile(t, filepath.Join(dir, "app", "page.tsx"), "")

	d := Detect(dir)
	if d.Language != stack.LanguagePython {
		t.Errorf("Language = %q, want python (primary)", d.Language)
	}
	if d.Framework != FrameworkFastAPI {
		t.Errorf("Framework = %q, want fastapi (primary)", d.Framework)
	}
	if d.PolyglotNextFramework != FrameworkNextAppRouter {
		t.Errorf("PolyglotNextFramework = %q, want next-app-router", d.PolyglotNextFramework)
	}
	if d.PolyglotAuth != AuthClerk {
		t.Errorf("PolyglotAuth = %q, want clerk", d.PolyglotAuth)
	}

	plan := PlanMount(context.Background(), MountPillarOptions{Detection: d})
	patchPaths := map[string]bool{}
	for _, a := range plan.Actions {
		if a.Kind == ActionPatchFile {
			patchPaths[a.Path] = true
		}
	}
	// All three TS-side patches must be planned despite primary
	// language = python.
	if !patchPaths["middleware.ts"] {
		t.Errorf("expected middleware.ts patch action (polyglot Clerk): %v", patchPaths)
	}
	if !patchPaths["vercel.json"] {
		t.Errorf("expected vercel.json patch action: %v", patchPaths)
	}
	if !patchPaths["next.config.{ts,mjs,js}"] {
		t.Errorf("expected next.config patch action (polyglot Next): %v", patchPaths)
	}
}

func TestPlanMount_NextClerkVercel_AddsHostWiring(t *testing.T) {
	dir := t.TempDir()
	writeTestFile(t, filepath.Join(dir, "next.config.ts"), "export default { /* user config */ }")
	writeTestFile(t, filepath.Join(dir, "middleware.ts"), `import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server'
const isPublic = createRouteMatcher(['/sign-in(.*)', '/sign-up(.*)'])
export default clerkMiddleware()
`)
	writeTestFile(t, filepath.Join(dir, "vercel.json"), `{ "rewrites": [{"source": "/api/py/(.*)", "destination": "/api/py/$1"}] }`)

	d := Detection{
		CWD:       dir,
		Language:  stack.LanguageTS,
		Framework: FrameworkNextAppRouter,
		Auth:      AuthClerk,
	}
	plan := PlanMount(context.Background(), MountPillarOptions{Detection: d})

	gotPatchPaths := map[string]bool{}
	for _, a := range plan.Actions {
		if a.Kind == ActionPatchFile {
			gotPatchPaths[a.Path] = true
		}
	}
	if !gotPatchPaths["middleware.ts"] {
		t.Errorf("expected middleware.ts patch action, got patches: %v", gotPatchPaths)
	}
	if !gotPatchPaths["vercel.json"] {
		t.Errorf("expected vercel.json patch action, got patches: %v", gotPatchPaths)
	}
}

func TestPlanPrompts_NoGit_WarnsHookSkipped(t *testing.T) {
	d := Detection{
		CWD:      t.TempDir(),
		Language: stack.LanguageTS,
		HasGit:   false,
	}
	plan := PlanPrompts(context.Background(), PromptsPillarOptions{Detection: d, InstallHook: true})
	foundWarning := false
	for _, w := range plan.Warnings {
		if strings.Contains(w, "pre-commit hook") {
			foundWarning = true
		}
	}
	if !foundWarning {
		t.Errorf("expected pre-commit warning when HasGit=false, got: %v", plan.Warnings)
	}
}

// Hybrid Next.js + FastAPI stacks: the JS-side ORM sets DATABASE_URL=
// postgres://… but the Python side has no driver. PlanTraces must
// detect this and emit an install_dep action for psycopg2-binary so
// the agent narrates the dep BEFORE --apply changes pyproject.toml.
// Olly's dogfooding (2026-05-20) caught the agent choking at this
// step. NeedsPsycopg2 is the pure detection; this test pins the
// matrix.
func TestNeedsPsycopg2_Matrix(t *testing.T) {
	cases := []struct {
		name       string
		setup      func(t *testing.T, dir string)
		lang       stack.Language
		dbDriver   DBDriver
		expectNeed bool
	}{
		{
			name: "python + postgres + bare pyproject -> needs",
			setup: func(t *testing.T, dir string) {
				writeTestFile(t, filepath.Join(dir, "pyproject.toml"), "[project]\nname='x'\ndependencies = ['fastapi']\n")
			},
			lang:       stack.LanguagePython,
			dbDriver:   DBPostgres,
			expectNeed: true,
		},
		{
			name: "python + postgres + psycopg2-binary already there -> no need",
			setup: func(t *testing.T, dir string) {
				writeTestFile(t, filepath.Join(dir, "pyproject.toml"), "[project]\ndependencies = ['fastapi', 'psycopg2-binary>=2.9']\n")
			},
			lang:       stack.LanguagePython,
			dbDriver:   DBPostgres,
			expectNeed: false,
		},
		{
			name: "python + postgres + plain psycopg2 already there -> no need",
			setup: func(t *testing.T, dir string) {
				writeTestFile(t, filepath.Join(dir, "pyproject.toml"), "[project]\ndependencies = ['psycopg2==2.9.5']\n")
			},
			lang:       stack.LanguagePython,
			dbDriver:   DBPostgres,
			expectNeed: false,
		},
		{
			name: "python + sqlite -> no driver needed",
			setup: func(t *testing.T, dir string) {
				writeTestFile(t, filepath.Join(dir, "pyproject.toml"), "[project]\ndependencies = []\n")
			},
			lang:       stack.LanguagePython,
			dbDriver:   DBSQLite,
			expectNeed: false,
		},
		{
			name: "ts + postgres -> not python, skip",
			setup: func(t *testing.T, dir string) {
				writeTestFile(t, filepath.Join(dir, "package.json"), `{"name":"x"}`)
			},
			lang:       stack.LanguageTS,
			dbDriver:   DBPostgres,
			expectNeed: false,
		},
		{
			name: "python + postgres + no pyproject -> skip (can't install)",
			setup: func(t *testing.T, dir string) {
				// intentionally empty
			},
			lang:       stack.LanguagePython,
			dbDriver:   DBPostgres,
			expectNeed: false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			if tc.setup != nil {
				tc.setup(t, dir)
			}
			d := Detection{CWD: dir, Language: tc.lang, DBDriver: tc.dbDriver}
			got := NeedsPsycopg2(d)
			if got != tc.expectNeed {
				t.Errorf("NeedsPsycopg2 = %v, want %v", got, tc.expectNeed)
			}
		})
	}
}

// Hook is opt-in (v0.9.0): bare PromptsPillarOptions with InstallHook
// unset (zero value = false) must NOT emit an install_hook action,
// even when .git is present. Olly's dogfooding (2026-05-20) caught
// the previous --no-hook-default behaviour silently dropping a
// pre-commit hook into the user's repo.
func TestPlanPrompts_HookIsOptIn(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	d := Detection{
		CWD:      dir,
		Language: stack.LanguageTS,
		HasGit:   true,
	}
	defaultPlan := PlanPrompts(context.Background(), PromptsPillarOptions{Detection: d /* InstallHook zero-value = false */})
	for _, a := range defaultPlan.Actions {
		if a.Kind == ActionInstallHook {
			t.Errorf("default plan must NOT install the hook; got action %+v", a)
		}
	}
	optInPlan := PlanPrompts(context.Background(), PromptsPillarOptions{Detection: d, InstallHook: true})
	found := false
	for _, a := range optInPlan.Actions {
		if a.Kind == ActionInstallHook {
			found = true
		}
	}
	if !found {
		t.Errorf("opt-in plan must include install_hook action; got actions %+v", optInPlan.Actions)
	}
}

func TestDetectionJSON_RoundTrip(t *testing.T) {
	d := Detection{
		CWD:            "/x",
		Language:       stack.LanguagePython,
		PackageManager: stack.PackageManagerUV,
		Framework:      FrameworkFastAPI,
		LLMLibs:        []LLMLib{LLMOpenAI, LLMAnthropic},
		HasGit:         true,
		DBDriver:       DBPostgres,
		DBEnvVar:       "DATABASE_URL",
		Auth:           AuthUnknown,
	}
	doc := DetectionJSON(d)
	if doc.Language != "python" || doc.Framework != "fastapi" || doc.DbDriver != "postgres" {
		t.Errorf("DetectionJSON drift: %+v", doc)
	}
	if len(doc.LlmLibs) != 2 || doc.LlmLibs[0] != "OpenAI" {
		t.Errorf("LLMLibs not projected: %v", doc.LlmLibs)
	}
	if doc.SchemaVersion != 1 {
		t.Errorf("schema_version drift: %d", doc.SchemaVersion)
	}
}

func writeTestFile(t *testing.T, path, body string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatalf("writeTestFile(%s): %v", path, err)
	}
}

// ApplyPrompts must filter --skip-folder entries AND rewrite the
// manifest on disk so on-disk count matches the cobra layer's
// "Manifest written: N" summary. Yousef's de-platform install
// 2026-05-21: 16 prompts written first, then ApplyPrompts filtered
// the in-memory copy to 5 without rewriting; cobra said 5 but the
// manifest on disk had 16.
func TestApplyPrompts_SkipFolderRewritesManifest(t *testing.T) {
	dir := t.TempDir()
	// Layout: 4 prompts across 3 folders.
	must := func(rel, body string) {
		path := filepath.Join(dir, rel)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	must("prompts/system.md", "# System prompt")
	must("prompts/router.md", "# Router prompt")
	must("data/demo/HIQ/sample.md", "# HIQ sample")
	must("data/demo/hospice-iq/lib.md", "# hospice-iq lib prompt")

	opts := PromptsPillarOptions{
		Detection: Detection{
			CWD:            dir,
			Language:       stack.LanguagePython,
			PackageManager: stack.PackageManagerUV,
		},
		SkipDeepScan: true,
		Prompter:     DefaultsPrompter{},
		SkipFolders:  []string{"data/demo/HIQ", "data/demo/hospice-iq"},
	}
	res, err := ApplyPrompts(context.Background(), opts)
	if err != nil {
		t.Fatalf("ApplyPrompts: %v", err)
	}
	// In-memory count post-filter.
	if res.ManifestCount != 2 {
		t.Errorf("ManifestCount = %d, want 2 (4 - 2 skipped folders)", res.ManifestCount)
	}
	// On-disk count must MATCH the in-memory count. Pre-v0.10.3 the
	// disk had all 4 and ManifestCount said 2 — Yousef's contradictory
	// "16 prompt(s)" + "5 prompts" symptom.
	body, err := os.ReadFile(filepath.Join(dir, ".gravel/manifest.json"))
	if err != nil {
		t.Fatalf("read manifest: %v", err)
	}
	if strings.Contains(string(body), "HIQ") || strings.Contains(string(body), "hospice-iq") {
		t.Errorf("manifest still contains skipped-folder entries:\n%s", body)
	}
	if !strings.Contains(string(body), "system.md") || !strings.Contains(string(body), "router.md") {
		t.Errorf("manifest is missing unskipped entries:\n%s", body)
	}
}
