package wizard

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/artanis-ai/gravel/cli/internal/stack"
)

// state_test.go exercises InspectState — the idempotency engine that
// drives "Already wired up. Skipping." messages. Every field must
// flip True only when the wizard's prior pass left something on disk;
// false positives clobber user files on re-run.

func TestInspectState_FreshProject_AllFalse(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"package.json": `{"dependencies":{"next":"15.0.0"}}`,
		"app/page.tsx": "",
	})
	d := Detect(dir)
	s := InspectState(dir, d)
	if s.MountExists {
		t.Errorf("MountExists true on fresh project")
	}
	if s.EnvHasPassword {
		t.Errorf("EnvHasPassword true on fresh project")
	}
	if s.EnvFileWithPassword != "" {
		t.Errorf("EnvFileWithPassword = %q on fresh project", s.EnvFileWithPassword)
	}
	if s.HookInstalled {
		t.Errorf("HookInstalled true on fresh project")
	}
	if s.ConfigExists {
		t.Errorf("ConfigExists true on fresh project")
	}
	if s.InstrumentationExists {
		t.Errorf("InstrumentationExists true on fresh project")
	}
	if s.MountFilePath != "app/admin/ai/[[...slug]]/route.ts" {
		t.Errorf("MountFilePath = %q", s.MountFilePath)
	}
}

func TestInspectState_NextAppRouter_MountExists(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"package.json": `{"dependencies":{"next":"15.0.0"}}`,
		"app/page.tsx": "",
		"app/admin/ai/[[...slug]]/route.ts": "// prior install\n",
	})
	d := Detect(dir)
	s := InspectState(dir, d)
	if !s.MountExists {
		t.Errorf("MountExists should be true when route.ts exists")
	}
}

func TestInspectState_NextSrcLayoutMountPath(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"package.json":     `{"dependencies":{"next":"15.0.0"}}`,
		"src/app/page.tsx": "",
		"src/app/admin/ai/[[...slug]]/route.ts": "// prior install\n",
	})
	d := Detect(dir)
	s := InspectState(dir, d)
	if s.MountFilePath != "src/app/admin/ai/[[...slug]]/route.ts" {
		t.Errorf("MountFilePath = %q, want src/app/...", s.MountFilePath)
	}
	if !s.MountExists {
		t.Errorf("MountExists false despite src/app route.ts present")
	}
}

func TestInspectState_PagesRouter_MountFilePath(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"package.json":   `{"dependencies":{"next":"15.0.0"}}`,
		"pages/index.ts": "",
	})
	d := Detect(dir)
	s := InspectState(dir, d)
	if s.MountFilePath != "pages/api/admin/ai/[[...slug]].ts" {
		t.Errorf("MountFilePath = %q", s.MountFilePath)
	}
}

func TestInspectState_FastAPI_MountFilePath(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"pyproject.toml": `[project]
name = "app"
dependencies = ["fastapi"]
`,
	})
	d := Detect(dir)
	s := InspectState(dir, d)
	if s.MountFilePath != "gravel_route.py" {
		t.Errorf("MountFilePath = %q", s.MountFilePath)
	}
}

func TestInspectState_EnvFile_DotEnvLocal(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"package.json": `{"dependencies":{"next":"15.0.0"}}`,
		".env.local":   "GRAVEL_ADMIN_PASSWORD=abc123\nOTHER=stuff\n",
	})
	d := Detect(dir)
	s := InspectState(dir, d)
	if !s.EnvHasPassword {
		t.Errorf("EnvHasPassword false despite .env.local containing GRAVEL_ADMIN_PASSWORD")
	}
	if s.EnvFileWithPassword != ".env.local" {
		t.Errorf("EnvFileWithPassword = %q", s.EnvFileWithPassword)
	}
}

func TestInspectState_EnvFile_FallbackToDotEnv(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"package.json": `{"dependencies":{"next":"15.0.0"}}`,
		".env":         "GRAVEL_ADMIN_PASSWORD=abc123\n",
	})
	d := Detect(dir)
	s := InspectState(dir, d)
	if s.EnvFileWithPassword != ".env" {
		t.Errorf("EnvFileWithPassword = %q, want .env", s.EnvFileWithPassword)
	}
}

func TestInspectState_EnvFile_LocalPrefersOverDotEnv(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"package.json": `{"dependencies":{"next":"15.0.0"}}`,
		".env":         "GRAVEL_ADMIN_PASSWORD=plain\n",
		".env.local":   "GRAVEL_ADMIN_PASSWORD=local\n",
	})
	d := Detect(dir)
	s := InspectState(dir, d)
	if s.EnvFileWithPassword != ".env.local" {
		t.Errorf("EnvFileWithPassword = %q, want .env.local (preference order)", s.EnvFileWithPassword)
	}
}

func TestInspectState_Hook_AllThreeLocations(t *testing.T) {
	for _, tc := range []struct {
		name string
		path string
	}{
		{"husky", ".husky/pre-commit"},
		{"pre-commit-framework", ".pre-commit-config.yaml"},
		{"native-git-hook", ".git/hooks/pre-commit"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := newFixture(t, map[string]string{
				"package.json": `{"dependencies":{"next":"15.0.0"}}`,
				tc.path:        "#!/bin/sh\ngravel manifest --check\n",
			})
			d := Detect(dir)
			s := InspectState(dir, d)
			if !s.HookInstalled {
				t.Errorf("HookInstalled false for %s at %s", tc.name, tc.path)
			}
		})
	}
}

func TestInspectState_Hook_OnlyMatchesGravelMarker(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"package.json":          `{"dependencies":{"next":"15.0.0"}}`,
		".git/hooks/pre-commit": "#!/bin/sh\nnpm test\n",
	})
	d := Detect(dir)
	s := InspectState(dir, d)
	if s.HookInstalled {
		t.Errorf("HookInstalled true for a non-gravel pre-commit (false positive would refuse to install)")
	}
}

func TestInspectState_Instrumentation_RootLevel(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"package.json":       `{"dependencies":{"next":"15.0.0"}}`,
		"instrumentation.ts": "export function register() {}",
	})
	d := Detect(dir)
	s := InspectState(dir, d)
	if !s.InstrumentationExists {
		t.Errorf("InstrumentationExists false despite root-level instrumentation.ts")
	}
}

func TestInspectState_Instrumentation_SrcLayout(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"package.json":           `{"dependencies":{"next":"15.0.0"}}`,
		"src/instrumentation.ts": "export function register() {}",
	})
	d := Detect(dir)
	s := InspectState(dir, d)
	if !s.InstrumentationExists {
		t.Errorf("InstrumentationExists false despite src/instrumentation.ts")
	}
}

func TestInspectState_ConfigExists_PythonProject(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"pyproject.toml":    `[project]\nname="app"\ndependencies=["fastapi"]\n`,
		"gravel_config.py":  "# config\n",
	})
	d := Detection{Language: stack.LanguagePython, Framework: FrameworkFastAPI, CWD: dir}
	// Skip Detect — we want to force the python path.
	s := InspectState(dir, d)
	if !s.ConfigExists {
		t.Errorf("ConfigExists false for python project with gravel_config.py")
	}
}

func TestInspectState_ConfigExists_TSProject(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"package.json":     `{"dependencies":{"next":"15.0.0"}}`,
		"gravel.config.ts": "// config\n",
	})
	d := Detect(dir)
	s := InspectState(dir, d)
	if !s.ConfigExists {
		t.Errorf("ConfigExists false for TS project with gravel.config.ts")
	}
}

// Regression test for the bug Yousef hit in v0.5.x: the previous
// IsTerminal helper called os.NewFile(fd, "") whose finalizer would
// close the underlying fd. If anyone reintroduces that pattern,
// stderr writes silently start failing. This test churns through
// IsTerminal many times to give GC plenty of garbage to collect,
// then writes to stderr (via a pipe captured into a buffer so we
// don't pollute test output) and asserts the write succeeds.
func TestIsTerminal_DoesNotLeakStderrFd(t *testing.T) {
	// Swap stderr for a pipe so we can both capture and detect bad-fd
	// errors from the write side. We're not interested in the data,
	// just whether the write returns a "bad file descriptor" error.
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	saved := os.Stderr
	os.Stderr = w
	defer func() { os.Stderr = saved; w.Close() }()

	for i := 0; i < 2000; i++ {
		_ = IsTerminal(os.Stderr)
		_ = IsTerminal(os.Stdin)
		_ = IsTerminal(os.Stdout)
	}
	// Force GC + drain finalizers. Two passes is the Go-recommended
	// way to ensure finalizers actually run before we assert.
	for i := 0; i < 3; i++ {
		runtime.GC()
		time.Sleep(10 * time.Millisecond)
	}
	if _, err := os.Stderr.Write([]byte("x")); err != nil {
		t.Fatalf("stderr corrupted after IsTerminal calls: %v", err)
	}
}

func TestMountFilePathFor_KnownFrameworks(t *testing.T) {
	cases := []struct {
		name  string
		d     Detection
		want  string
	}{
		{"app-router", Detection{Framework: FrameworkNextAppRouter, NextAppDir: "app"}, "app/admin/ai/[[...slug]]/route.ts"},
		{"app-router-src", Detection{Framework: FrameworkNextAppRouter, NextAppDir: "src/app"}, "src/app/admin/ai/[[...slug]]/route.ts"},
		{"pages-router", Detection{Framework: FrameworkNextPagesRouter}, "pages/api/admin/ai/[[...slug]].ts"},
		{"fastapi", Detection{Framework: FrameworkFastAPI}, "gravel_route.py"},
		{"express", Detection{Framework: FrameworkExpress}, ""},
		{"django", Detection{Framework: FrameworkDjango}, ""},
		{"generic-node", Detection{Framework: FrameworkGenericNode}, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := mountFilePathFor(tc.d)
			if got != tc.want {
				t.Errorf("mountFilePathFor(%s) = %q, want %q", tc.d.Framework, got, tc.want)
			}
		})
	}
}

func TestDescribeMount_HonorsMountPath(t *testing.T) {
	cases := []struct {
		name      string
		d         Detection
		mountPath string
		want      string
	}{
		{"app-default", Detection{Framework: FrameworkNextAppRouter, NextAppDir: "app"}, "/admin/ai", "app/admin/ai/[[...slug]]/route.ts"},
		{"app-custom-mountpath", Detection{Framework: FrameworkNextAppRouter, NextAppDir: "app"}, "/control", "app/control/[[...slug]]/route.ts"},
		{"app-src-custom", Detection{Framework: FrameworkNextAppRouter, NextAppDir: "src/app"}, "/dashboard/gravel", "src/app/dashboard/gravel/[[...slug]]/route.ts"},
		{"pages-custom", Detection{Framework: FrameworkNextPagesRouter}, "/x/y", "pages/x/y/[[...slug]].ts"},
		{"fastapi-static", Detection{Framework: FrameworkFastAPI}, "/anywhere", "gravel_route.py"},
		{"django-static", Detection{Framework: FrameworkDjango}, "/anywhere", "urls.py (patched)"},
		{"unknown-fallback", Detection{Framework: FrameworkExpress}, "/admin/ai", "mount file"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := describeMount(tc.d, tc.mountPath)
			if got != tc.want {
				t.Errorf("describeMount = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestConfigFilenameFor(t *testing.T) {
	if got := configFilenameFor(Detection{Language: stack.LanguagePython}); got != "gravel_config.py" {
		t.Errorf("python config = %q", got)
	}
	if got := configFilenameFor(Detection{Language: stack.LanguageTS}); got != "gravel.config.ts" {
		t.Errorf("ts config = %q", got)
	}
}

// Helper: ensure InspectState's MountFilePath lines up with the file
// the mounter actually writes — otherwise the idempotency check
// would never fire after a successful install.
func TestInspectState_RoundTripWithMounter(t *testing.T) {
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
		t.Fatalf("Mount.Mode = %s", res.Mode)
	}
	s := InspectState(dir, d)
	if !s.MountExists {
		t.Errorf("InspectState.MountExists false after a successful Mount call; idempotency is broken")
	}
	wantSuffix := filepath.FromSlash(s.MountFilePath)
	if filepath.Join(dir, wantSuffix) != res.Path {
		t.Errorf("MountFilePath %q doesn't match mounter's actual write at %q", s.MountFilePath, res.Path)
	}
}
