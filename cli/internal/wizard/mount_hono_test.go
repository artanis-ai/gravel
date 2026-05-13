package wizard

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// mount_hono_test.go: heavy coverage of the Hono auto-mount.
// Pattern matches mount_express_test.go — every common entry shape
// gets a positive test, every "should refuse" form gets a negative
// test, plus tree walk + idempotency + InspectState + regex matrix.

// --- Happy-path mounts: every common Hono entry shape -----------

func TestMountHono_PlainCtor_PatchesESM(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"package.json": `{"dependencies":{"hono":"4.0.0"}}`,
		"index.ts": `import { Hono } from 'hono'

const app = new Hono()

export default app
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
	body, _ := os.ReadFile(filepath.Join(dir, "index.ts"))
	got := string(body)
	mustContain(t, got, "import { createGravelHandler } from '@artanis-ai/gravel'")
	mustContain(t, got, "import { config } from './gravel.config'")
	mustContain(t, got, "app.mount(config.mountPath, createGravelHandler({ config }))")
	// Hono uses the main SDK entry, NOT `/node`.
	if strings.Contains(got, "@artanis-ai/gravel/node") {
		t.Errorf("Hono patch incorrectly used /node entry:\n%s", got)
	}
}

func TestMountHono_WithGenericTypeParam(t *testing.T) {
	// Cloudflare Workers idiom: `new Hono<{ Bindings: Env }>()`.
	dir := newFixture(t, map[string]string{
		"package.json": `{"dependencies":{"hono":"4.0.0"}}`,
		"src/index.ts": `import { Hono } from 'hono'

type Bindings = { DB: D1Database }
const app = new Hono<{ Bindings: Bindings }>()

export default app
`,
	})
	d := Detect(dir)
	res, _ := Mount(d, "/admin/ai", MountOptions{})
	if res.Mode != MountUpdated {
		t.Errorf("generic-type Hono ctor not patched")
	}
	body, _ := os.ReadFile(filepath.Join(dir, "src", "index.ts"))
	mustContain(t, string(body), "app.mount(config.mountPath, createGravelHandler({ config }))")
	// Generic type params preserved.
	mustContain(t, string(body), "new Hono<{ Bindings: Bindings }>()")
}

func TestMountHono_TypedAppDeclaration(t *testing.T) {
	// `const app: Hono = new Hono()` — explicit type annotation.
	dir := newFixture(t, map[string]string{
		"package.json": `{"dependencies":{"hono":"4.0.0"}}`,
		"index.ts": `import { Hono } from 'hono'

const app: Hono = new Hono()
`,
	})
	d := Detect(dir)
	res, _ := Mount(d, "/admin/ai", MountOptions{})
	if res.Mode != MountUpdated {
		t.Errorf("typed Hono declaration not patched")
	}
}

func TestMountHono_LetVar_BothBindings(t *testing.T) {
	for _, kw := range []string{"let", "var"} {
		t.Run(kw, func(t *testing.T) {
			dir := newFixture(t, map[string]string{
				"package.json": `{"dependencies":{"hono":"4.0.0"}}`,
				"index.ts": "import { Hono } from 'hono'\n" + kw + " app = new Hono()\n",
			})
			d := Detect(dir)
			res, _ := Mount(d, "/admin/ai", MountOptions{})
			if res.Mode != MountUpdated {
				t.Errorf("%s-bound Hono ctor not patched", kw)
			}
		})
	}
}

func TestMountHono_AlternateVarName(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"package.json": `{"dependencies":{"hono":"4.0.0"}}`,
		"index.ts": `import { Hono } from 'hono'

const router = new Hono()
`,
	})
	d := Detect(dir)
	_, _ = Mount(d, "/admin/ai", MountOptions{})
	body, _ := os.ReadFile(filepath.Join(dir, "index.ts"))
	mustContain(t, string(body), "router.mount(config.mountPath, createGravelHandler({ config }))")
}

func TestMountHono_CJS_File(t *testing.T) {
	// Rare but valid: a Hono app in a .cjs file.
	dir := newFixture(t, map[string]string{
		"package.json": `{"dependencies":{"hono":"4.0.0"}}`,
		"app.cjs": `const { Hono } = require('hono')
const app = new Hono()
`,
	})
	d := Detect(dir)
	_, _ = Mount(d, "/admin/ai", MountOptions{})
	body, _ := os.ReadFile(filepath.Join(dir, "app.cjs"))
	got := string(body)
	mustContain(t, got, "const { createGravelHandler } = require('@artanis-ai/gravel')")
	if strings.Contains(got, "import ") {
		t.Errorf(".cjs file got import statements")
	}
}

func TestMountHono_WorkerTS(t *testing.T) {
	// Cloudflare Workers convention: src/worker.ts or worker.ts.
	dir := newFixture(t, map[string]string{
		"package.json": `{"dependencies":{"hono":"4.0.0"}}`,
		"src/worker.ts": `import { Hono } from 'hono'

const app = new Hono<{ Bindings: Env }>()
export default app
`,
	})
	d := Detect(dir)
	res, _ := Mount(d, "/admin/ai", MountOptions{})
	if res.Mode != MountUpdated {
		t.Errorf("Hono worker.ts not patched")
	}
}

func TestMountHono_ExportDefaultPreserved(t *testing.T) {
	// After patching, `export default app` (or similar) must stay
	// intact below the mount line.
	dir := newFixture(t, map[string]string{
		"package.json": `{"dependencies":{"hono":"4.0.0"}}`,
		"index.ts": `import { Hono } from 'hono'

const app = new Hono()
app.get('/', (c) => c.text('hello'))

export default app
`,
	})
	d := Detect(dir)
	_, _ = Mount(d, "/admin/ai", MountOptions{})
	body, _ := os.ReadFile(filepath.Join(dir, "index.ts"))
	mustContain(t, string(body), "export default app")
	mustContain(t, string(body), "app.mount(config.mountPath, createGravelHandler({ config }))")
}

// --- Refusal: never patch inside function/class bodies ----------

func TestMountHono_FactoryFunction_RefusesToPatch(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"package.json": `{"dependencies":{"hono":"4.0.0"}}`,
		"index.ts": `import { Hono } from 'hono'

function createApp() {
    const app = new Hono()
    return app
}
`,
	})
	d := Detect(dir)
	res, _ := Mount(d, "/admin/ai", MountOptions{})
	if res.Mode == MountUpdated {
		body, _ := os.ReadFile(filepath.Join(dir, "index.ts"))
		if strings.Contains(string(body), "createGravelHandler") {
			t.Errorf("factory pattern was patched:\n%s", body)
		}
	}
}

func TestMountHono_ArrowFactory_RefusesToPatch(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"package.json": `{"dependencies":{"hono":"4.0.0"}}`,
		"index.ts": `import { Hono } from 'hono'
const createApp = () => {
    const app = new Hono()
    return app
}
`,
	})
	d := Detect(dir)
	res, _ := Mount(d, "/admin/ai", MountOptions{})
	if res.Mode == MountUpdated {
		body, _ := os.ReadFile(filepath.Join(dir, "index.ts"))
		if strings.Contains(string(body), "createGravelHandler") {
			t.Errorf("arrow-factory pattern was patched:\n%s", body)
		}
	}
}

func TestMountHono_ClassBody_RefusesToPatch(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"package.json": `{"dependencies":{"hono":"4.0.0"}}`,
		"index.ts": `import { Hono } from 'hono'
class Server {
    app = new Hono()
}
`,
	})
	d := Detect(dir)
	res, _ := Mount(d, "/admin/ai", MountOptions{})
	if res.Mode == MountUpdated {
		body, _ := os.ReadFile(filepath.Join(dir, "index.ts"))
		if strings.Contains(string(body), "createGravelHandler") {
			t.Errorf("class-body declaration was patched:\n%s", body)
		}
	}
}

// --- Idempotency ------------------------------------------------

func TestMountHono_Idempotent_DoublePatchAvoided(t *testing.T) {
	src := `import { Hono } from 'hono'
import { createGravelHandler } from '@artanis-ai/gravel'
import { config } from './gravel.config'

const app = new Hono()
app.mount(config.mountPath, createGravelHandler({ config }))
`
	dir := newFixture(t, map[string]string{
		"package.json": `{"dependencies":{"hono":"4.0.0"}}`,
		"index.ts":     src,
	})
	d := Detect(dir)
	res, _ := Mount(d, "/admin/ai", MountOptions{})
	if res.Mode != MountUpdated {
		t.Errorf("Mode = %s, want updated (idempotent)", res.Mode)
	}
	body, _ := os.ReadFile(filepath.Join(dir, "index.ts"))
	if string(body) != src {
		t.Errorf("idempotent re-run mutated file:\n%s", body)
	}
}

// --- Tree walk + candidate ordering -----------------------------

func TestMountHono_FastPathBeatsTreeWalk(t *testing.T) {
	entry := `import { Hono } from 'hono'
const app = new Hono()
`
	dir := newFixture(t, map[string]string{
		"package.json":     `{"dependencies":{"hono":"4.0.0"}}`,
		"index.ts":         entry,
		"src/api/main.ts":  entry,
	})
	d := Detect(dir)
	res, _ := Mount(d, "/admin/ai", MountOptions{})
	if !strings.HasSuffix(filepath.ToSlash(res.Path), "index.ts") {
		t.Errorf("expected root index.ts to win, got %s", res.Path)
	}
	body, _ := os.ReadFile(filepath.Join(dir, "src", "api", "main.ts"))
	if strings.Contains(string(body), "createGravelHandler") {
		t.Errorf("nested file got patched when root index.ts should have won")
	}
}

func TestMountHono_TreeWalk_FindsNestedEntry(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"package.json": `{"dependencies":{"hono":"4.0.0"}}`,
		"src/api/v1/main.ts": `import { Hono } from 'hono'
const app = new Hono()
`,
	})
	d := Detect(dir)
	res, _ := Mount(d, "/admin/ai", MountOptions{})
	if res.Mode != MountUpdated {
		t.Errorf("tree walk failed (Mode=%s)", res.Mode)
	}
}

func TestMountHono_TreeWalkSkipsNoisyDirs(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"package.json": `{"dependencies":{"hono":"4.0.0"}}`,
		"index.ts": `import { Hono } from 'hono'
const app = new Hono()
`,
		"node_modules/some-pkg/index.ts": `import { Hono } from 'hono'
const app = new Hono()
`,
		"dist/index.js": `import { Hono } from 'hono'
const app = new Hono()
`,
		".wrangler/tmp/index.ts": `import { Hono } from 'hono'
const app = new Hono()
`,
	})
	d := Detect(dir)
	res, _ := Mount(d, "/admin/ai", MountOptions{})
	if !strings.HasSuffix(filepath.ToSlash(res.Path), "index.ts") {
		t.Errorf("walker patched wrong file: %s", res.Path)
	}
	for _, suffix := range []string{
		"node_modules/some-pkg/index.ts",
		"dist/index.js",
		".wrangler/tmp/index.ts",
	} {
		body, _ := os.ReadFile(filepath.Join(dir, suffix))
		if strings.Contains(string(body), "createGravelHandler") {
			t.Errorf("noise file got patched: %s", suffix)
		}
	}
}

// --- Manual fallback when no entry found ------------------------

func TestMountHono_NoEntryFound_FallsBackToManual(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"package.json": `{"dependencies":{"hono":"4.0.0"}}`,
		// No file containing `new Hono(...)`.
	})
	d := Detect(dir)
	res, _ := Mount(d, "/admin/ai", MountOptions{})
	if res.Mode != MountManual {
		t.Errorf("Mode = %s, want manual", res.Mode)
	}
	mustContain(t, res.Instructions, "createGravelHandler")
	mustContain(t, res.Instructions, "@artanis-ai/gravel")
	mustContain(t, res.Instructions, "app.mount")
}

// --- ESM detection: Hono files are usually .ts/.mjs (always ESM) ---

func TestMountHono_AllTSVariantsAreESM(t *testing.T) {
	for _, ext := range []string{".ts", ".mts", ".tsx"} {
		t.Run(ext, func(t *testing.T) {
			dir := newFixture(t, map[string]string{
				"package.json":  `{"dependencies":{"hono":"4.0.0"}}`,
				"index" + ext:   "import { Hono } from 'hono'\nconst app = new Hono()\n",
			})
			d := Detect(dir)
			_, _ = Mount(d, "/admin/ai", MountOptions{})
			body, _ := os.ReadFile(filepath.Join(dir, "index"+ext))
			got := string(body)
			if !strings.Contains(got, "import { createGravelHandler }") {
				t.Errorf("%s file didn't get ESM imports", ext)
			}
		})
	}
}

// --- InspectState round-trip ------------------------------------

func TestInspectState_Hono_DetectsMountedEntry(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"package.json": `{"dependencies":{"hono":"4.0.0"}}`,
		"index.ts": `import { Hono } from 'hono'
import { createGravelHandler } from '@artanis-ai/gravel'
import { config } from './gravel.config'

const app = new Hono()
app.mount(config.mountPath, createGravelHandler({ config }))
`,
	})
	d := Detect(dir)
	s := InspectState(dir, d)
	if !s.MountExists {
		t.Errorf("MountExists false despite Hono entry being patched")
	}
	if !strings.HasSuffix(s.MountFilePath, "index.ts") {
		t.Errorf("MountFilePath = %q, want suffix index.ts", s.MountFilePath)
	}
}

func TestInspectState_Hono_PristineEntry_NotMounted(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"package.json": `{"dependencies":{"hono":"4.0.0"}}`,
		"index.ts": `import { Hono } from 'hono'
const app = new Hono()
`,
	})
	d := Detect(dir)
	s := InspectState(dir, d)
	if s.MountExists {
		t.Errorf("MountExists true on a pristine Hono project")
	}
}

func TestInspectState_Hono_SrcLayout_DetectsMountedEntry(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"package.json": `{"dependencies":{"hono":"4.0.0"}}`,
		"src/worker.ts": `import { Hono } from 'hono'
import { createGravelHandler } from '@artanis-ai/gravel'
import { config } from './gravel.config'

const app = new Hono<{ Bindings: Env }>()
app.mount(config.mountPath, createGravelHandler({ config }))
`,
	})
	d := Detect(dir)
	s := InspectState(dir, d)
	if !s.MountExists {
		t.Errorf("MountExists false despite nested Hono entry being patched")
	}
}

// --- regex unit tests ------------------------------------------

func TestTopLevelHonoCtorRE_Matches(t *testing.T) {
	cases := []struct {
		name string
		src  string
		want bool
	}{
		{"plain", "const app = new Hono()", true},
		{"let", "let app = new Hono()", true},
		{"var", "var app = new Hono()", true},
		{"alt-name", "const application = new Hono()", true},
		{"generic", "const app = new Hono<{ Bindings: Env }>()", true},
		{"generic-multi-line-arg-type", "const app = new Hono<Bindings>()", true},
		{"typed", "const app: Hono = new Hono()", true},
		{"typed-with-generic", "const app: Hono<Env> = new Hono<Env>()", true},
		{"extra-spaces", "const   app   =   new   Hono  (  )", true},

		{"indented-rejected", "  const app = new Hono()", false},
		{"router-not-app", "const route = Hono.someStaticMethod()", false}, // not `new Hono`
		{"no-keyword-rejected", "app = new Hono()", false},
		{"comment-line-rejected", "// const app = new Hono()", false},
		{"hono-without-new", "const app = Hono()", false}, // missing `new`
		{"new-but-different-class", "const app = new HonoExtension()", false}, // not exactly `Hono`
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := topLevelHonoCtorRE.MatchString(tc.src)
			if got != tc.want {
				t.Errorf("MatchString(%q) = %v, want %v", tc.src, got, tc.want)
			}
		})
	}
}
