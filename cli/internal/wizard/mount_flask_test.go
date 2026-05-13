package wizard

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// mount_flask_test.go: heavy coverage of the Flask auto-mount.
// Pattern matches mount_python_test.go (FastAPI) — every Flask entry
// idiom, refusal cases, tree walk, idempotency, InspectState, regex
// matrix.

// --- Happy-path mounts -----------------------------------------

func TestMountFlask_PlainAppEqualsFlask_Patches(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"pyproject.toml": `[project]
name = "app"
dependencies = ["flask"]
`,
		"app.py": `from flask import Flask

app = Flask(__name__)

@app.route('/')
def index():
    return 'hello'
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
	body, _ := os.ReadFile(filepath.Join(dir, "app.py"))
	got := string(body)
	mustContain(t, got, "from artanis_gravel.flask import mount_on_flask")
	mustContain(t, got, "from gravel_config import config")
	mustContain(t, got, "mount_on_flask(app, config)")
	// Original route preserved.
	mustContain(t, got, "@app.route('/')")
}

func TestMountFlask_WithOptionsAndArgs(t *testing.T) {
	// `app = Flask(__name__, static_folder='static', template_folder='templates')`
	dir := newFixture(t, map[string]string{
		"pyproject.toml": `[project]
name = "app"
dependencies = ["flask"]
`,
		"app.py": `from flask import Flask

app = Flask(__name__, static_folder='static', template_folder='templates')
`,
	})
	d := Detect(dir)
	res, _ := Mount(d, "/admin/ai", MountOptions{})
	if res.Mode != MountUpdated {
		t.Errorf("Flask with kwargs not patched")
	}
	body, _ := os.ReadFile(filepath.Join(dir, "app.py"))
	mustContain(t, string(body), "mount_on_flask(app, config)")
	// Original kwargs preserved.
	mustContain(t, string(body), `static_folder='static'`)
}

func TestMountFlask_MultiLineCtor(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"pyproject.toml": `[project]
name = "app"
dependencies = ["flask"]
`,
		"app.py": `from flask import Flask

app = Flask(
    __name__,
    static_folder='static',
    template_folder='templates',
    static_url_path='',
)
`,
	})
	d := Detect(dir)
	res, _ := Mount(d, "/admin/ai", MountOptions{})
	if res.Mode != MountUpdated {
		t.Errorf("multi-line Flask ctor not patched")
	}
	body, _ := os.ReadFile(filepath.Join(dir, "app.py"))
	got := string(body)
	mustContain(t, got, "mount_on_flask(app, config)")
	// Multi-line ctor preserved.
	mustContain(t, got, `template_folder='templates',`)
}

func TestMountFlask_TypedDeclaration(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"pyproject.toml": `[project]
name = "app"
dependencies = ["flask"]
`,
		"app.py": `from flask import Flask

app: Flask = Flask(__name__)
`,
	})
	d := Detect(dir)
	res, _ := Mount(d, "/admin/ai", MountOptions{})
	if res.Mode != MountUpdated {
		t.Errorf("typed Flask declaration not patched")
	}
}

func TestMountFlask_AlternateVarName(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"pyproject.toml": `[project]
name = "app"
dependencies = ["flask"]
`,
		"app.py": `from flask import Flask

application = Flask(__name__)
`,
	})
	d := Detect(dir)
	_, _ = Mount(d, "/admin/ai", MountOptions{})
	body, _ := os.ReadFile(filepath.Join(dir, "app.py"))
	// Mount call uses the user's variable name, not "app".
	mustContain(t, string(body), "mount_on_flask(application, config)")
}

func TestMountFlask_WSGIPath(t *testing.T) {
	// wsgi.py is the production-deployment convention.
	dir := newFixture(t, map[string]string{
		"pyproject.toml": `[project]
name = "app"
dependencies = ["flask"]
`,
		"wsgi.py": `from flask import Flask
app = Flask(__name__)
`,
	})
	d := Detect(dir)
	res, _ := Mount(d, "/admin/ai", MountOptions{})
	if res.Mode != MountUpdated {
		t.Errorf("wsgi.py entry not patched")
	}
}

// --- Refusal: application-factory pattern -----------------------

func TestMountFlask_FactoryFunction_RefusesToPatch(t *testing.T) {
	// Flask's docs recommend the application-factory pattern. The
	// wizard CANNOT auto-mount that case (mount_on_flask needs the
	// module-level app, not the inside of a function). Must refuse
	// rather than corrupt the file.
	dir := newFixture(t, map[string]string{
		"pyproject.toml": `[project]
name = "app"
dependencies = ["flask"]
`,
		"app.py": `from flask import Flask

def create_app():
    app = Flask(__name__)
    return app
`,
	})
	d := Detect(dir)
	res, _ := Mount(d, "/admin/ai", MountOptions{})
	if res.Mode == MountUpdated {
		body, _ := os.ReadFile(filepath.Join(dir, "app.py"))
		if strings.Contains(string(body), "mount_on_flask") {
			t.Errorf("factory pattern was patched:\n%s", body)
		}
	}
}

func TestMountFlask_ClassBody_RefusesToPatch(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"pyproject.toml": `[project]
name = "app"
dependencies = ["flask"]
`,
		"app.py": `from flask import Flask
class Server:
    app = Flask(__name__)
`,
	})
	d := Detect(dir)
	res, _ := Mount(d, "/admin/ai", MountOptions{})
	if res.Mode == MountUpdated {
		body, _ := os.ReadFile(filepath.Join(dir, "app.py"))
		if strings.Contains(string(body), "mount_on_flask") {
			t.Errorf("class-body declaration was patched:\n%s", body)
		}
	}
}

// --- Idempotency -----------------------------------------------

func TestMountFlask_Idempotent_DoublePatchAvoided(t *testing.T) {
	src := `from flask import Flask
from artanis_gravel.flask import mount_on_flask
from gravel_config import config

app = Flask(__name__)
mount_on_flask(app, config)
`
	dir := newFixture(t, map[string]string{
		"pyproject.toml": `[project]
name = "app"
dependencies = ["flask"]
`,
		"app.py": src,
	})
	d := Detect(dir)
	res, _ := Mount(d, "/admin/ai", MountOptions{})
	if res.Mode != MountUpdated {
		t.Errorf("Mode = %s, want updated (idempotent)", res.Mode)
	}
	body, _ := os.ReadFile(filepath.Join(dir, "app.py"))
	if string(body) != src {
		t.Errorf("idempotent re-run mutated file:\n%s", body)
	}
}

// --- Import placement ------------------------------------------

func TestMountFlask_ImportsLandAfterExistingImports(t *testing.T) {
	// The patcher inserts our imports after the LAST `from ...` /
	// `import ...` line — keeping the user's imports grouped at the
	// top of the file rather than scattering ours among module-level
	// constants below.
	dir := newFixture(t, map[string]string{
		"pyproject.toml": `[project]
name = "app"
dependencies = ["flask"]
`,
		"app.py": `from flask import Flask
import os
from datetime import datetime

DEBUG = True
APP_NAME = "myapp"

app = Flask(__name__)
`,
	})
	d := Detect(dir)
	_, _ = Mount(d, "/admin/ai", MountOptions{})
	body, _ := os.ReadFile(filepath.Join(dir, "app.py"))
	got := string(body)
	// gravel imports MUST land before DEBUG / APP_NAME.
	gravelIdx := strings.Index(got, "from artanis_gravel.flask")
	debugIdx := strings.Index(got, "DEBUG = True")
	if gravelIdx < 0 || debugIdx < 0 {
		t.Fatalf("missing expected content in:\n%s", got)
	}
	if gravelIdx > debugIdx {
		t.Errorf("gravel imports landed AFTER module constants — they should sit with the other imports")
	}
}

// --- Tree walk + candidate ordering -----------------------------

func TestMountFlask_FastPathBeatsTreeWalk(t *testing.T) {
	entry := `from flask import Flask
app = Flask(__name__)
`
	dir := newFixture(t, map[string]string{
		"pyproject.toml": `[project]
name = "app"
dependencies = ["flask"]
`,
		"app.py":              entry,
		"src/myapp/server.py": entry,
	})
	d := Detect(dir)
	res, _ := Mount(d, "/admin/ai", MountOptions{})
	if !strings.HasSuffix(filepath.ToSlash(res.Path), "app.py") {
		t.Errorf("expected root app.py to win, got %s", res.Path)
	}
}

func TestMountFlask_TreeWalk_FindsSrcPackageEntry(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"pyproject.toml": `[project]
name = "myapp"
dependencies = ["flask"]
`,
		"src/myapp/__init__.py": "",
		"src/myapp/server.py": `from flask import Flask
app = Flask(__name__)
`,
	})
	d := Detect(dir)
	res, _ := Mount(d, "/admin/ai", MountOptions{})
	if res.Mode != MountUpdated {
		t.Errorf("tree walk failed for src-layout Flask (Mode=%s)", res.Mode)
	}
}

func TestMountFlask_TreeWalkSkipsNoisyDirs(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"pyproject.toml": `[project]
name = "myapp"
dependencies = ["flask"]
`,
		"app.py": `from flask import Flask
app = Flask(__name__)
`,
		".venv/lib/python3.12/site-packages/flask/__init__.py": `class Flask: pass
app = Flask(__name__)
`,
		"__pycache__/cached.py": `from flask import Flask
app = Flask(__name__)
`,
	})
	d := Detect(dir)
	res, _ := Mount(d, "/admin/ai", MountOptions{})
	if !strings.HasSuffix(filepath.ToSlash(res.Path), "app.py") {
		t.Errorf("walker patched wrong file: %s", res.Path)
	}
	for _, suffix := range []string{
		".venv/lib/python3.12/site-packages/flask/__init__.py",
		"__pycache__/cached.py",
	} {
		body, _ := os.ReadFile(filepath.Join(dir, suffix))
		if strings.Contains(string(body), "mount_on_flask") {
			t.Errorf("noise file got patched: %s", suffix)
		}
	}
}

// --- Manual fallback when no entry found ------------------------

func TestMountFlask_NoEntryFound_FallsBackToManual(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"pyproject.toml": `[project]
name = "app"
dependencies = ["flask"]
`,
	})
	d := Detect(dir)
	res, _ := Mount(d, "/admin/ai", MountOptions{})
	if res.Mode != MountManual {
		t.Errorf("Mode = %s, want manual", res.Mode)
	}
	mustContain(t, res.Instructions, "mount_on_flask")
	mustContain(t, res.Instructions, "artanis-gravel[flask]")
}

// --- InspectState round-trip -----------------------------------

func TestInspectState_Flask_DetectsMountedEntry(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"pyproject.toml": `[project]
name = "app"
dependencies = ["flask"]
`,
		"app.py": `from flask import Flask
from artanis_gravel.flask import mount_on_flask
from gravel_config import config

app = Flask(__name__)
mount_on_flask(app, config)
`,
	})
	d := Detect(dir)
	s := InspectState(dir, d)
	if !s.MountExists {
		t.Errorf("MountExists false despite Flask entry being patched")
	}
	if !strings.HasSuffix(s.MountFilePath, "app.py") {
		t.Errorf("MountFilePath = %q", s.MountFilePath)
	}
}

func TestInspectState_Flask_PristineEntry_NotMounted(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"pyproject.toml": `[project]
name = "app"
dependencies = ["flask"]
`,
		"app.py": `from flask import Flask
app = Flask(__name__)
`,
	})
	d := Detect(dir)
	s := InspectState(dir, d)
	if s.MountExists {
		t.Errorf("MountExists true on a pristine Flask project")
	}
}

func TestInspectState_Flask_SrcLayout_DetectsMountedEntry(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"pyproject.toml": `[project]
name = "myapp"
dependencies = ["flask"]
`,
		"src/myapp/__init__.py": "",
		"src/myapp/server.py": `from flask import Flask
from artanis_gravel.flask import mount_on_flask
from gravel_config import config

app = Flask(__name__)
mount_on_flask(app, config)
`,
	})
	d := Detect(dir)
	s := InspectState(dir, d)
	if !s.MountExists {
		t.Errorf("MountExists false despite nested Flask entry being patched")
	}
}

// --- regex unit tests ------------------------------------------

func TestTopLevelFlaskCtorRE_Matches(t *testing.T) {
	cases := []struct {
		name string
		src  string
		want bool
	}{
		{"plain", "app = Flask(__name__)", true},
		{"alt-name", "application = Flask(__name__)", true},
		{"with-kwargs", "app = Flask(__name__, static_folder='static')", true},
		{"typed", "app: Flask = Flask(__name__)", true},
		{"extra-spaces", "app   =   Flask  (  __name__  )", true},

		{"indented-rejected", "    app = Flask(__name__)", false},
		{"class-field-indent-rejected", "  app = Flask(__name__)", false},
		{"no-call-rejected", "app = Flask", false},
		{"import-line-not-matched", "from flask import Flask", false},
		{"class-decl-not-matched", "class Flask:", false},
		{"comment-rejected", "# app = Flask(__name__)", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := topLevelFlaskCtorRE.MatchString(tc.src)
			if got != tc.want {
				t.Errorf("MatchString(%q) = %v, want %v", tc.src, got, tc.want)
			}
		})
	}
}
