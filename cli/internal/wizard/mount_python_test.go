package wizard

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// mount_python_test.go exercises the FastAPI + Django auto-mount
// patchers. Each test sets up a realistic entry file shape, runs
// the mounter against a tempdir, and asserts on the final source +
// mount mode. The matrix covers EVERY shape we've seen in customer
// projects so far — anything that goes to manual-fallback today
// represents a real customer who hits a manual step.

// --- FastAPI ---------------------------------------------------------------

func TestMountFastAPI_SingleLineCtor_PatchesMainPy(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"pyproject.toml": `[project]
name = "app"
dependencies = ["fastapi"]
`,
		"main.py": `from fastapi import FastAPI

app = FastAPI()

@app.get("/")
def root():
    return {"hello": "world"}
`,
	})
	d := Detect(dir)
	res, err := Mount(d, "/admin/ai", MountOptions{})
	if err != nil {
		t.Fatalf("Mount: %v", err)
	}
	if res.Mode != MountUpdated {
		t.Errorf("Mode = %s, want updated (manual fallback means auto-patch failed)", res.Mode)
	}
	body, _ := os.ReadFile(filepath.Join(dir, "main.py"))
	got := string(body)
	mustContain(t, got, "from gravel_route import router as gravel_router")
	mustContain(t, got, "app.include_router(gravel_router, prefix='/admin/ai')")
	// gravel_route.py also written.
	if !pathExists(filepath.Join(dir, "gravel_route.py")) {
		t.Errorf("gravel_route.py not written")
	}
	route, _ := os.ReadFile(filepath.Join(dir, "gravel_route.py"))
	mustContain(t, string(route), "create_gravel_router(config=config)")
}

func TestMountFastAPI_CtorWithSimpleArgs_StillPatches(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"pyproject.toml": `[project]
name = "app"
dependencies = ["fastapi"]
`,
		"main.py": `from fastapi import FastAPI

app = FastAPI(title="My App", version="1.0")
`,
	})
	d := Detect(dir)
	res, err := Mount(d, "/admin/ai", MountOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if res.Mode != MountUpdated {
		t.Errorf("Mode = %s, want updated", res.Mode)
	}
	body, _ := os.ReadFile(filepath.Join(dir, "main.py"))
	mustContain(t, string(body), "app.include_router(gravel_router, prefix='/admin/ai')")
}

// REGRESSION: ctors with NESTED parens (e.g. an f-string with a
// function call inside) used to defeat the `[^()\n]*` regex and
// fall back to manual. This is the exact bug Yousef hit.
func TestMountFastAPI_NestedParensInCtor_StillPatches(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"pyproject.toml": `[project]
name = "app"
dependencies = ["fastapi"]
`,
		"main.py": `from fastapi import FastAPI
from config import settings

app = FastAPI(title="My App", openapi_url=f"/v{settings.api_version}/openapi.json")
`,
	})
	d := Detect(dir)
	res, err := Mount(d, "/admin/ai", MountOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if res.Mode != MountUpdated {
		t.Errorf("Mode = %s, want updated (nested-paren ctor should still match)", res.Mode)
	}
	body, _ := os.ReadFile(filepath.Join(dir, "main.py"))
	got := string(body)
	mustContain(t, got, "app.include_router(gravel_router, prefix='/admin/ai')")
	// Must NOT corrupt the original ctor.
	mustContain(t, got, `openapi_url=f"/v{settings.api_version}/openapi.json"`)
}

// REGRESSION: multi-line ctors. FastAPI projects often format like
// `app = FastAPI(\n    title="X",\n    version="1.0",\n)`. The
// patcher must still find the variable name and inject the include
// AFTER the closing paren.
func TestMountFastAPI_MultiLineCtor_StillPatches(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"pyproject.toml": `[project]
name = "app"
dependencies = ["fastapi"]
`,
		"main.py": `from fastapi import FastAPI

app = FastAPI(
    title="My App",
    version="1.0",
    description="A test app",
)
`,
	})
	d := Detect(dir)
	res, err := Mount(d, "/admin/ai", MountOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if res.Mode != MountUpdated {
		t.Errorf("Mode = %s, want updated (multi-line ctor should patch)", res.Mode)
	}
	body, _ := os.ReadFile(filepath.Join(dir, "main.py"))
	got := string(body)
	mustContain(t, got, "app.include_router(gravel_router, prefix='/admin/ai')")
	// Multi-line ctor preserved unchanged.
	mustContain(t, got, `    title="My App",`)
	mustContain(t, got, `    version="1.0",`)
}

func TestMountFastAPI_AlternateVarName_RespectsIt(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"pyproject.toml": `[project]
name = "app"
dependencies = ["fastapi"]
`,
		"main.py": `from fastapi import FastAPI

application = FastAPI()
`,
	})
	d := Detect(dir)
	res, err := Mount(d, "/admin/ai", MountOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if res.Mode != MountUpdated {
		t.Errorf("Mode = %s, want updated", res.Mode)
	}
	body, _ := os.ReadFile(filepath.Join(dir, "main.py"))
	mustContain(t, string(body), "application.include_router(gravel_router, prefix='/admin/ai')")
}

func TestMountFastAPI_PrefersAppPy_FallsBackToSrcMain(t *testing.T) {
	// app.py exists with a FastAPI() ctor; src/main.py too. The
	// patcher walks the candidate list in order and stops on the
	// first one with a FastAPI() ctor.
	dir := newFixture(t, map[string]string{
		"pyproject.toml": `[project]
name = "app"
dependencies = ["fastapi"]
`,
		"app.py": `from fastapi import FastAPI
app = FastAPI()
`,
		"src/main.py": `from fastapi import FastAPI
app = FastAPI()
`,
	})
	d := Detect(dir)
	res, err := Mount(d, "/admin/ai", MountOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if res.Mode != MountUpdated {
		t.Errorf("Mode = %s", res.Mode)
	}
	// The candidate order in mount_python.go is [main.py, app.py,
	// src/main.py, src/app.py, app/main.py]. main.py doesn't exist
	// here, so app.py wins.
	if !strings.HasSuffix(res.Path, "/app.py") {
		t.Errorf("expected app.py to be patched, got %s", res.Path)
	}
	body, _ := os.ReadFile(filepath.Join(dir, "src", "main.py"))
	if strings.Contains(string(body), "gravel_router") {
		t.Errorf("src/main.py should be untouched once app.py matched")
	}
}

// REGRESSION: src-layout uv projects with package modules like
// src/<pkg>/server.py used to fall back to manual instructions
// because they weren't in the hard-coded candidate list. The tree
// walk now finds them. This is the exact shape of landlord-ai.
func TestMountFastAPI_SrcPackageLayout_FindsAndPatches(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"pyproject.toml": `[project]
name = "myapp"
dependencies = ["fastapi"]
`,
		"uv.lock":                  "",
		"src/myapp/__init__.py":    "",
		"src/myapp/server.py": `from fastapi import FastAPI

app = FastAPI(
    title="My App",
    description="Multi-workflow.",
)
`,
	})
	d := Detect(dir)
	res, err := Mount(d, "/admin/ai", MountOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if res.Mode != MountUpdated {
		t.Errorf("Mode = %s, want updated (tree walk should find src/myapp/server.py)", res.Mode)
	}
	body, _ := os.ReadFile(filepath.Join(dir, "src", "myapp", "server.py"))
	got := string(body)
	// REGRESSION: src-layout uv projects have only `src/` on sys.path
	// at runtime, so a top-level `gravel_route` import fails (the
	// `ModuleNotFoundError` Yousef hit). Package-mode entries must
	// use a relative import that resolves to the gravel_route.py the
	// mounter writes adjacent to the entry.
	mustContain(t, got, "from .gravel_route import router as gravel_router")
	if strings.Contains(got, "from gravel_route import router as gravel_router") {
		t.Errorf("absolute import emitted in package layout (won't resolve under uv):\n%s", got)
	}
	mustContain(t, got, "app.include_router(gravel_router, prefix='/admin/ai')")
	// Adjacent gravel_route.py must also be written.
	if !pathExists(filepath.Join(dir, "src", "myapp", "gravel_route.py")) {
		t.Errorf("gravel_route.py not written adjacent to entry")
	}
	routeBody, _ := os.ReadFile(filepath.Join(dir, "src", "myapp", "gravel_route.py"))
	mustContain(t, string(routeBody), "create_gravel_router(config=config)")
	// Package-mode template walks up to find gravel_config.py at the
	// project root.
	mustContain(t, string(routeBody), "sys.path.insert")
}

// Tree walk must skip junk directories so it doesn't spend seconds
// in node_modules / .venv on real projects.
func TestMountFastAPI_TreeWalkSkipsNoisyDirs(t *testing.T) {
	// Drop a poisoned FastAPI ctor inside .venv. The walk must NOT
	// patch it; the real entry at src/pkg/main.py must win.
	dir := newFixture(t, map[string]string{
		"pyproject.toml": `[project]
name = "myapp"
dependencies = ["fastapi"]
`,
		"src/myapp/main.py": "from fastapi import FastAPI\napp = FastAPI()\n",
		".venv/lib/python3.11/site-packages/somelib/example.py": "from fastapi import FastAPI\napp = FastAPI(title='Wrong target')\n",
	})
	d := Detect(dir)
	res, err := Mount(d, "/admin/ai", MountOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(filepath.ToSlash(res.Path), "src/myapp/main.py") {
		t.Errorf("walker patched the wrong file: %s", res.Path)
	}
	// Confirm the poisoned file in .venv was left untouched.
	venvBody, _ := os.ReadFile(filepath.Join(dir, ".venv", "lib", "python3.11", "site-packages", "somelib", "example.py"))
	if strings.Contains(string(venvBody), "gravel_router") {
		t.Errorf(".venv site-packages was modified — patcher walked into noise dir")
	}
}

// Shallowest match wins: src/pkg/main.py beats src/pkg/sub/nested.py.
func TestMountFastAPI_TreeWalkPrefersShallower(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"pyproject.toml": `[project]
name = "myapp"
dependencies = ["fastapi"]
`,
		"src/myapp/main.py":     "from fastapi import FastAPI\napp = FastAPI()\n",
		"src/myapp/sub/helper.py": "from fastapi import FastAPI\nhelper_app = FastAPI()\n",
	})
	d := Detect(dir)
	res, _ := Mount(d, "/admin/ai", MountOptions{})
	if !strings.HasSuffix(filepath.ToSlash(res.Path), "src/myapp/main.py") {
		t.Errorf("expected shallow main.py to win, got %s", res.Path)
	}
}

// The fast hard-coded list still beats the tree walk. If both
// main.py (at root) AND src/pkg/server.py contain FastAPI ctors,
// main.py wins by virtue of being in fastAPIEntryCandidates.
func TestMountFastAPI_FastPathBeatsTreeWalk(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"pyproject.toml": `[project]
name = "myapp"
dependencies = ["fastapi"]
`,
		"main.py":                "from fastapi import FastAPI\napp = FastAPI()\n",
		"src/myapp/server.py": "from fastapi import FastAPI\napp = FastAPI()\n",
	})
	d := Detect(dir)
	res, _ := Mount(d, "/admin/ai", MountOptions{})
	if !strings.HasSuffix(filepath.ToSlash(res.Path), "main.py") {
		t.Errorf("expected root main.py to win, got %s", res.Path)
	}
	// And the package server.py is untouched.
	body, _ := os.ReadFile(filepath.Join(dir, "src", "myapp", "server.py"))
	if strings.Contains(string(body), "gravel_router") {
		t.Errorf("src/myapp/server.py was modified when root main.py should have won")
	}
}

func TestMountFastAPI_NoEntryFile_FallsBackToManual(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"pyproject.toml": `[project]
name = "app"
dependencies = ["fastapi"]
`,
	})
	d := Detect(dir)
	res, _ := Mount(d, "/admin/ai", MountOptions{})
	if res.Mode != MountManual {
		t.Errorf("Mode = %s, want manual (no entry file to patch)", res.Mode)
	}
	mustContain(t, res.Instructions, "create_gravel_router")
	// gravel_route.py still written so paste-instructions resolve.
	if !pathExists(filepath.Join(dir, "gravel_route.py")) {
		t.Errorf("gravel_route.py not written even on manual fallback")
	}
}

func TestMountFastAPI_EntryWithoutCtor_FallsBack(t *testing.T) {
	// A main.py exists but contains no FastAPI() ctor (e.g. it's
	// just helper functions). Patcher must skip it and surface
	// manual instructions, NOT inject the include against the wrong
	// variable.
	dir := newFixture(t, map[string]string{
		"pyproject.toml": `[project]
name = "app"
dependencies = ["fastapi"]
`,
		"main.py": "# not the entry file\nimport asyncio\n",
	})
	d := Detect(dir)
	res, _ := Mount(d, "/admin/ai", MountOptions{})
	if res.Mode != MountManual {
		t.Errorf("Mode = %s, want manual (no FastAPI() ctor)", res.Mode)
	}
}

func TestMountFastAPI_Idempotent_ReturnsUpdated(t *testing.T) {
	src := `from fastapi import FastAPI
from gravel_route import router as gravel_router

app = FastAPI()
app.include_router(gravel_router, prefix='/admin/ai')
`
	dir := newFixture(t, map[string]string{
		"pyproject.toml": `[project]
name = "app"
dependencies = ["fastapi"]
`,
		"main.py": src,
	})
	d := Detect(dir)
	res, err := Mount(d, "/admin/ai", MountOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if res.Mode != MountUpdated {
		t.Errorf("Mode = %s, want updated (idempotent)", res.Mode)
	}
	body, _ := os.ReadFile(filepath.Join(dir, "main.py"))
	if string(body) != src {
		t.Errorf("idempotent re-run mutated file:\n%s", body)
	}
}

func TestMountFastAPI_CustomMountPath(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"pyproject.toml": `[project]
name = "app"
dependencies = ["fastapi"]
`,
		"main.py": "from fastapi import FastAPI\napp = FastAPI()\n",
	})
	d := Detect(dir)
	res, err := Mount(d, "/dashboard", MountOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if res.Mode != MountUpdated {
		t.Errorf("Mode = %s", res.Mode)
	}
	body, _ := os.ReadFile(filepath.Join(dir, "main.py"))
	mustContain(t, string(body), "app.include_router(gravel_router, prefix='/dashboard')")
}

// --- Django ---------------------------------------------------------------

func TestMountDjango_PatchesRootURLs(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"pyproject.toml": `[project]
name = "app"
dependencies = ["django"]
`,
		"manage.py": "",
		"myproject/settings.py": "DEBUG = True\n",
		"myproject/urls.py": `from django.urls import path
from django.contrib import admin

urlpatterns = [
    path('admin/', admin.site.urls),
]
`,
	})
	d := Detect(dir)
	res, err := Mount(d, "/admin/ai", MountOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if res.Mode != MountUpdated {
		t.Errorf("Mode = %s, want updated", res.Mode)
	}
	body, _ := os.ReadFile(filepath.Join(dir, "myproject", "urls.py"))
	got := string(body)
	mustContain(t, got, "from artanis_gravel.django import gravel_urls")
	mustContain(t, got, "path('admin/ai/', include(gravel_urls)),")
	// FIRST entry, not last (prefix matching).
	idxGravel := strings.Index(got, "gravel_urls")
	idxAdminSite := strings.Index(got, "admin.site.urls")
	if idxGravel > idxAdminSite {
		t.Errorf("gravel_urls must appear BEFORE admin.site.urls in urlpatterns:\n%s", got)
	}
	// `include` was added to the django.urls import.
	mustContain(t, got, "from django.urls import path, include")
}

func TestMountDjango_ExistingInclude_PreservesIt(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"pyproject.toml": `[project]
name = "app"
dependencies = ["django"]
`,
		"manage.py":             "",
		"myproject/settings.py": "DEBUG = True\n",
		"myproject/urls.py": `from django.urls import path, include
from django.contrib import admin

urlpatterns = [
    path('admin/', admin.site.urls),
    path('api/', include('myapp.urls')),
]
`,
	})
	d := Detect(dir)
	_, err := Mount(d, "/admin/ai", MountOptions{})
	if err != nil {
		t.Fatal(err)
	}
	body, _ := os.ReadFile(filepath.Join(dir, "myproject", "urls.py"))
	got := string(body)
	// Only ONE `include` should be in the django.urls import,
	// duplicating it would break Django.
	importLine := ""
	for _, l := range strings.Split(got, "\n") {
		if strings.HasPrefix(l, "from django.urls import") {
			importLine = l
			break
		}
	}
	if strings.Count(importLine, "include") != 1 {
		t.Errorf("django.urls import has %d include(s), want 1:\n%s", strings.Count(importLine, "include"), importLine)
	}
}

func TestMountDjango_NoUrlPatterns_FallsBackToManual(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"pyproject.toml": `[project]
name = "app"
dependencies = ["django"]
`,
		"manage.py":             "",
		"myproject/settings.py": "DEBUG = True\n",
		"myproject/urls.py":     "# placeholder, no urlpatterns yet\n",
	})
	d := Detect(dir)
	res, _ := Mount(d, "/admin/ai", MountOptions{})
	if res.Mode != MountManual {
		t.Errorf("Mode = %s, want manual (no urlpatterns to inject)", res.Mode)
	}
}

func TestMountDjango_Idempotent(t *testing.T) {
	src := `from django.urls import path, include
from artanis_gravel.django import gravel_urls
from django.contrib import admin

urlpatterns = [
    path('admin/ai/', include(gravel_urls)),
    path('admin/', admin.site.urls),
]
`
	dir := newFixture(t, map[string]string{
		"pyproject.toml": `[project]
name = "app"
dependencies = ["django"]
`,
		"manage.py":             "",
		"myproject/settings.py": "DEBUG = True\n",
		"myproject/urls.py":     src,
	})
	d := Detect(dir)
	res, err := Mount(d, "/admin/ai", MountOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if res.Mode != MountUpdated {
		t.Errorf("Mode = %s, want updated", res.Mode)
	}
	body, _ := os.ReadFile(filepath.Join(dir, "myproject", "urls.py"))
	if string(body) != src {
		t.Errorf("idempotent re-run mutated file:\n%s", body)
	}
}

func TestMountDjango_NoSettingsSibling_FallsBackToManual(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"pyproject.toml": `[project]
name = "app"
dependencies = ["django"]
`,
		"manage.py": "",
	})
	d := Detect(dir)
	res, _ := Mount(d, "/admin/ai", MountOptions{})
	if res.Mode != MountManual {
		t.Errorf("Mode = %s, want manual (no Django project layout)", res.Mode)
	}
}

// REGRESSION: src-layout Django (uv / poetry projects with
// `src/<project>/settings.py` + `src/<project>/urls.py`) used to fall
// back to manual because findDjangoRootURLs only walked one level.
func TestMountDjango_SrcLayoutPackage_FindsAndPatches(t *testing.T) {
	urlsPyPath := "src/myproject/urls.py"
	dir := newFixture(t, map[string]string{
		"pyproject.toml": `[project]
name = "myproject"
dependencies = ["django"]
`,
		"manage.py":               "",
		"src/myproject/__init__.py":  "",
		"src/myproject/settings.py": "DEBUG = True\n",
		urlsPyPath: `from django.urls import path
from django.contrib import admin

urlpatterns = [
    path('admin/', admin.site.urls),
]
`,
	})
	d := Detect(dir)
	res, err := Mount(d, "/admin/ai", MountOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if res.Mode != MountUpdated {
		t.Errorf("Mode = %s, want updated (tree walk should find %s)", res.Mode, urlsPyPath)
	}
	body, _ := os.ReadFile(filepath.Join(dir, "src", "myproject", "urls.py"))
	mustContain(t, string(body), "from artanis_gravel.django import gravel_urls")
	mustContain(t, string(body), "path('admin/ai/', include(gravel_urls))")
}

// Apps-dir pattern: `apps/<app>/settings.py` + `apps/<app>/urls.py`.
func TestMountDjango_AppsDirPattern_FindsAndPatches(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"pyproject.toml": `[project]
name = "myproject"
dependencies = ["django"]
`,
		"manage.py":                  "",
		"apps/myproject/__init__.py": "",
		"apps/myproject/settings.py": "DEBUG = True\n",
		"apps/myproject/urls.py": `from django.urls import path

urlpatterns = [
]
`,
	})
	d := Detect(dir)
	res, err := Mount(d, "/admin/ai", MountOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if res.Mode != MountUpdated {
		t.Errorf("Mode = %s, want updated", res.Mode)
	}
}

// Django tree walk must also skip .venv / node_modules / etc., same
// as FastAPI. A poisoned urls.py in .venv must not be picked.
func TestMountDjango_TreeWalkSkipsNoisyDirs(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"pyproject.toml": `[project]
name = "myproject"
dependencies = ["django"]
`,
		"manage.py":             "",
		"myproject/settings.py": "DEBUG = True\n",
		"myproject/urls.py": `from django.urls import path

urlpatterns = [
]
`,
		".venv/lib/python3.11/site-packages/somelib/settings.py": "",
		".venv/lib/python3.11/site-packages/somelib/urls.py": `from django.urls import path

urlpatterns = [
]
`,
	})
	d := Detect(dir)
	res, err := Mount(d, "/admin/ai", MountOptions{})
	if err != nil {
		t.Fatal(err)
	}
	// Must have patched the real urls.py, not the .venv one.
	if !strings.HasSuffix(filepath.ToSlash(res.Path), "myproject/urls.py") {
		t.Errorf("walker patched wrong file: %s", res.Path)
	}
	venvBody, _ := os.ReadFile(filepath.Join(dir, ".venv", "lib", "python3.11", "site-packages", "somelib", "urls.py"))
	if strings.Contains(string(venvBody), "gravel_urls") {
		t.Errorf(".venv urls.py was modified — patcher walked into noise dir")
	}
}

// Shallowest-first: a project-package urls.py at cwd/<proj>/urls.py
// wins over apps/<other>/urls.py if both look like Django projects.
func TestMountDjango_ShallowestFirstOrdering(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"pyproject.toml": `[project]
name = "myproject"
dependencies = ["django"]
`,
		"manage.py":             "",
		"myproject/settings.py": "DEBUG = True\n",
		"myproject/urls.py": `from django.urls import path

urlpatterns = [
]
`,
		"apps/other/__init__.py": "",
		"apps/other/settings.py": "DEBUG = True\n",
		"apps/other/urls.py": `from django.urls import path

urlpatterns = [
]
`,
	})
	d := Detect(dir)
	res, _ := Mount(d, "/admin/ai", MountOptions{})
	if !strings.HasSuffix(filepath.ToSlash(res.Path), "myproject/urls.py") {
		t.Errorf("expected shallowest myproject/urls.py to win, got %s", res.Path)
	}
}

func TestMountDjango_StripsLeadingSlashFromPrefix(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"pyproject.toml": `[project]
name = "app"
dependencies = ["django"]
`,
		"manage.py":             "",
		"myproject/settings.py": "DEBUG = True\n",
		"myproject/urls.py": `from django.urls import path
urlpatterns = [
]
`,
	})
	d := Detect(dir)
	_, _ = Mount(d, "/dashboard/gravel", MountOptions{})
	body, _ := os.ReadFile(filepath.Join(dir, "myproject", "urls.py"))
	// Django path() needs the leading slash stripped + trailing slash present.
	mustContain(t, string(body), "path('dashboard/gravel/', include(gravel_urls))")
}
