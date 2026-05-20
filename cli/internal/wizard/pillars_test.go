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
