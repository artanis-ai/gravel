// Package e2e exercises the compiled `gravel` binary end-to-end against
// a synthetic project tree. Existing wizard tests in
// internal/wizard/*_test.go drive the `Run()` / `PlanMount()` /
// `ApplyMount()` functions directly; those are valuable for
// fine-grained logic coverage but don't catch breakage at the cobra
// boundary (flag parsing, command wiring, JSON output shape, exit
// codes). This package's tests build the binary at TestMain time and
// shell out to it the way an installing agent would.
//
// Per the audit-seams-not-parts memory: the binary IS the integration
// seam customers and agents drive. Unit tests on internal functions
// don't guarantee `npx @artanis-ai/gravel detect --json` works.
package e2e

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// binaryPath is set by TestMain after a one-time `go build`. Each test
// references this to spawn the compiled CLI.
var binaryPath string

// TestMain builds the `gravel` binary into a temp dir before running
// any tests, then cleans up. ~1-2s overhead per `go test` run for the
// build, amortised across every test in the package.
func TestMain(m *testing.M) {
	tmpDir, err := os.MkdirTemp("", "gravel-e2e-bin-*")
	if err != nil {
		panic("e2e: failed to create temp dir for binary: " + err.Error())
	}
	defer os.RemoveAll(tmpDir)

	binaryPath = filepath.Join(tmpDir, "gravel")
	// `..` to escape internal/e2e back to cli/, then ./cmd/gravel for the main package.
	build := exec.Command("go", "build", "-o", binaryPath, "../../cmd/gravel")
	build.Stderr = os.Stderr
	if err := build.Run(); err != nil {
		panic("e2e: failed to build gravel binary: " + err.Error())
	}

	os.Exit(m.Run())
}

// runGravel runs the compiled binary in `cwd` with `args`, returning
// (stdout, combined-stderr, exitCode). Doesn't fail the test on
// non-zero exit: callers assert what they expect.
func runGravel(t *testing.T, cwd string, args ...string) (stdout string, stderr string, exitCode int) {
	t.Helper()
	cmd := exec.Command(binaryPath, args...)
	cmd.Dir = cwd
	var stdoutBuf, stderrBuf strings.Builder
	cmd.Stdout = &stdoutBuf
	cmd.Stderr = &stderrBuf
	// Suppress the version-check network hit in tests; the CLI's doctor
	// + init flows call out to PyPI / npm which we don't want to depend
	// on in CI.
	cmd.Env = append(os.Environ(), "GRAVEL_VERSION_CHECK_DISABLED=1")
	err := cmd.Run()
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			exitCode = ee.ExitCode()
		} else {
			t.Fatalf("runGravel: unexpected error: %v", err)
		}
	}
	return stdoutBuf.String(), stderrBuf.String(), exitCode
}

// writeFile is a tiny helper that mkdir's the parent if missing.
func writeFile(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir parent of %s: %v", path, err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

// setupFastAPIFixture creates a synthetic Python + FastAPI + OpenAI
// project tree in `dir`. Mirrors the most common shape that hit Olly's
// and Claude's dogfooding sessions.
func setupFastAPIFixture(t *testing.T, dir string) {
	t.Helper()
	writeFile(t, filepath.Join(dir, "pyproject.toml"), strings.TrimSpace(`
[project]
name = "fixture-fastapi"
version = "0.0.1"
dependencies = ["fastapi", "uvicorn", "openai"]
`)+"\n")
	writeFile(t, filepath.Join(dir, "main.py"), strings.TrimSpace(`
from fastapi import FastAPI
app = FastAPI()

@app.get("/")
def root():
    return {"ok": True}
`)+"\n")
}

func TestE2E_Detect_PythonFastAPI(t *testing.T) {
	dir := t.TempDir()
	setupFastAPIFixture(t, dir)

	stdout, _, exit := runGravel(t, dir, "detect", "--json")
	if exit != 0 {
		t.Fatalf("detect exit=%d, want 0; stdout=%q", exit, stdout)
	}
	var got struct {
		SchemaVersion  int      `json:"schema_version"`
		Language       string   `json:"language"`
		Framework      string   `json:"framework"`
		PackageManager string   `json:"package_manager"`
		LLMLibs        []string `json:"llm_libs"`
	}
	if err := json.Unmarshal([]byte(stdout), &got); err != nil {
		t.Fatalf("detect json parse failed: %v\nstdout: %s", err, stdout)
	}
	if got.SchemaVersion != 1 {
		t.Errorf("schema_version=%d, want 1", got.SchemaVersion)
	}
	if got.Language != "python" {
		t.Errorf("language=%q, want python", got.Language)
	}
	if got.Framework != "fastapi" {
		t.Errorf("framework=%q, want fastapi", got.Framework)
	}
	wantLLM := "OpenAI"
	found := false
	for _, l := range got.LLMLibs {
		if l == wantLLM {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("llm_libs=%v, want to contain %q", got.LLMLibs, wantLLM)
	}
}

func TestE2E_MountPlan_PythonFastAPI(t *testing.T) {
	dir := t.TempDir()
	setupFastAPIFixture(t, dir)

	stdout, _, exit := runGravel(t, dir, "mount", "--plan")
	if exit != 0 {
		t.Fatalf("mount --plan exit=%d, want 0; stdout=%q", exit, stdout)
	}
	var plan struct {
		SchemaVersion int    `json:"schema_version"`
		Pillar        string `json:"pillar"`
		Actions       []struct {
			Kind string `json:"kind"`
			Path string `json:"path"`
		} `json:"actions"`
	}
	if err := json.Unmarshal([]byte(stdout), &plan); err != nil {
		t.Fatalf("mount --plan json parse failed: %v\nstdout: %s", err, stdout)
	}
	if plan.Pillar != "mount" {
		t.Errorf("pillar=%q, want mount", plan.Pillar)
	}
	if len(plan.Actions) < 3 {
		t.Errorf("expected at least 3 actions (config + route + env), got %d: %+v",
			len(plan.Actions), plan.Actions)
	}
	// Verify the three canonical mount actions appear by path.
	wantPaths := map[string]bool{
		"gravel_config.py": false,
		"gravel_route.py":  false,
		".env.local":       false,
	}
	for _, a := range plan.Actions {
		if _, want := wantPaths[a.Path]; want {
			wantPaths[a.Path] = true
		}
	}
	for path, seen := range wantPaths {
		if !seen {
			t.Errorf("mount --plan missing action for %q (got: %+v)", path, plan.Actions)
		}
	}

	// --plan must be PURE — no files written.
	for _, p := range []string{"gravel_config.py", "gravel_route.py", ".env.local"} {
		if _, err := os.Stat(filepath.Join(dir, p)); !os.IsNotExist(err) {
			t.Errorf("mount --plan unexpectedly wrote %s (err=%v)", p, err)
		}
	}
}

func TestE2E_MountApply_WritesExpectedFiles(t *testing.T) {
	dir := t.TempDir()
	setupFastAPIFixture(t, dir)

	stdout, _, exit := runGravel(t, dir, "mount", "--apply")
	if exit != 0 {
		t.Fatalf("mount --apply exit=%d, want 0; stdout=%q", exit, stdout)
	}

	// Three files MUST land on disk after apply.
	checks := []struct {
		path        string
		mustContain string
	}{
		{"gravel_config.py", "GravelConfig"},
		{"gravel_route.py", "create_gravel_router"},
		{".env.local", "GRAVEL_ADMIN_PASSWORD="},
	}
	for _, c := range checks {
		body, err := os.ReadFile(filepath.Join(dir, c.path))
		if err != nil {
			t.Errorf("mount --apply: %s missing: %v", c.path, err)
			continue
		}
		if !strings.Contains(string(body), c.mustContain) {
			t.Errorf("%s must contain %q; got %q", c.path, c.mustContain, string(body))
		}
	}

	// Confirm idempotence: a second --apply must succeed without
	// changing the password (the file already exists). The wizard
	// must NOT regenerate the password on every run; that would
	// surprise the user every time they re-ran the wizard.
	originalEnv, _ := os.ReadFile(filepath.Join(dir, ".env.local"))
	_, _, exit2 := runGravel(t, dir, "mount", "--apply")
	if exit2 != 0 {
		t.Fatalf("mount --apply (second run) exit=%d, want 0", exit2)
	}
	secondEnv, _ := os.ReadFile(filepath.Join(dir, ".env.local"))
	if string(originalEnv) != string(secondEnv) {
		t.Errorf("mount --apply rewrote .env.local on second run (should be idempotent)\nfirst:  %q\nsecond: %q",
			originalEnv, secondEnv)
	}
}

func TestE2E_DoctorJSON_EmitsShape(t *testing.T) {
	dir := t.TempDir()
	setupFastAPIFixture(t, dir)

	stdout, _, _ := runGravel(t, dir, "doctor", "--json")
	// doctor returns non-zero when behind on PyPI/npm, but we set
	// GRAVEL_VERSION_CHECK_DISABLED=1 so the check no-ops. Either way
	// the JSON shape must be emitted.
	var got map[string]any
	if err := json.Unmarshal([]byte(stdout), &got); err != nil {
		t.Fatalf("doctor --json parse failed: %v\nstdout: %s", err, stdout)
	}
	// doctor --json fields surfaced to installing agents. installHint is
	// the actionable per-stack upgrade command; language + packageManager
	// let the agent narrate what stack was detected; current is the
	// installed binary version.
	for _, key := range []string{"installHint", "current", "language", "packageManager"} {
		if _, ok := got[key]; !ok {
			t.Errorf("doctor --json missing %q field; got keys: %v", key, mapKeys(got))
		}
	}
}

func mapKeys(m map[string]any) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
