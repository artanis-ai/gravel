package wizard

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// mount_fastify_test.go: heavy coverage of the Fastify auto-mount.
// Same shape as mount_express_test.go + mount_hono_test.go — every
// common entry idiom, both casings of the factory call (Fastify vs
// fastify), ESM/CJS, refusals, tree walk, idempotency, InspectState.

// --- Happy-path mounts -----------------------------------------

func TestMountFastify_DefaultImport_PatchesESM(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"package.json": `{"dependencies":{"fastify":"4.0.0"},"type":"module"}`,
		"index.js": `import Fastify from 'fastify'

const fastify = Fastify()
fastify.listen({ port: 3000 })
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
	body, _ := os.ReadFile(filepath.Join(dir, "index.js"))
	got := string(body)
	mustContain(t, got, "import { gravelFastifyPlugin } from '@artanis-ai/gravel/fastify'")
	mustContain(t, got, "import { config } from './gravel.config'")
	mustContain(t, got, "fastify.register(gravelFastifyPlugin(config), { prefix: config.mountPath })")
}

func TestMountFastify_NamedLowercaseImport_AlsoMatches(t *testing.T) {
	// `import { fastify } from 'fastify'` style — less common but
	// supported by the framework. The variable assignment is
	// `const f = fastify()`.
	dir := newFixture(t, map[string]string{
		"package.json": `{"dependencies":{"fastify":"4.0.0"},"type":"module"}`,
		"index.ts": `import { fastify as createFastify } from 'fastify'

const f = createFastify()
`,
	})
	d := Detect(dir)
	// This case actually has `createFastify()`, not `fastify()` or
	// `Fastify()` — the regex would only match if the factory call
	// is literally [Ff]astify. So it should fall back to manual,
	// which is the correct behavior.
	res, _ := Mount(d, "/admin/ai", MountOptions{})
	if res.Mode == MountUpdated {
		t.Errorf("aliased import was patched; expected manual fallback because the call site is 'createFastify()', not 'Fastify()'")
	}
}

func TestMountFastify_LowercaseFactoryCall(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"package.json": `{"dependencies":{"fastify":"4.0.0"},"type":"module"}`,
		"index.js": `import { fastify } from 'fastify'

const f = fastify()
`,
	})
	d := Detect(dir)
	res, _ := Mount(d, "/admin/ai", MountOptions{})
	if res.Mode != MountUpdated {
		t.Errorf("lowercase fastify() call not patched")
	}
	body, _ := os.ReadFile(filepath.Join(dir, "index.js"))
	mustContain(t, string(body), "f.register(gravelFastifyPlugin(config), { prefix: config.mountPath })")
}

func TestMountFastify_WithOptions(t *testing.T) {
	// `const fastify = Fastify({ logger: true })` — the most common
	// real-world shape (Fastify docs recommend turning logger on).
	dir := newFixture(t, map[string]string{
		"package.json": `{"dependencies":{"fastify":"4.0.0"},"type":"module"}`,
		"index.js": `import Fastify from 'fastify'

const fastify = Fastify({ logger: true })
`,
	})
	d := Detect(dir)
	res, _ := Mount(d, "/admin/ai", MountOptions{})
	if res.Mode != MountUpdated {
		t.Errorf("Fastify({ logger: true }) not patched")
	}
	body, _ := os.ReadFile(filepath.Join(dir, "index.js"))
	got := string(body)
	mustContain(t, got, "fastify.register(gravelFastifyPlugin(config), { prefix: config.mountPath })")
	// Original options preserved.
	mustContain(t, got, "Fastify({ logger: true })")
}

func TestMountFastify_MultiLineOptions(t *testing.T) {
	// Options spread across lines — the paren scanner has to balance
	// across newlines.
	dir := newFixture(t, map[string]string{
		"package.json": `{"dependencies":{"fastify":"4.0.0"},"type":"module"}`,
		"index.js": `import Fastify from 'fastify'

const fastify = Fastify({
    logger: { level: 'info' },
    bodyLimit: 1048576,
    ajv: { customOptions: { coerceTypes: true } },
})
`,
	})
	d := Detect(dir)
	res, _ := Mount(d, "/admin/ai", MountOptions{})
	if res.Mode != MountUpdated {
		t.Errorf("multi-line Fastify options not patched")
	}
	body, _ := os.ReadFile(filepath.Join(dir, "index.js"))
	got := string(body)
	mustContain(t, got, "fastify.register(gravelFastifyPlugin(config), { prefix: config.mountPath })")
	// Multi-line options preserved.
	mustContain(t, got, "logger: { level: 'info' },")
	mustContain(t, got, "ajv: { customOptions: { coerceTypes: true } },")
}

func TestMountFastify_TypeScriptFile(t *testing.T) {
	// `.ts` always ESM. Plus typed declaration.
	dir := newFixture(t, map[string]string{
		"package.json": `{"dependencies":{"fastify":"4.0.0"}}`,
		"src/server.ts": `import Fastify, { FastifyInstance } from 'fastify'

const fastify: FastifyInstance = Fastify({ logger: true })
`,
	})
	d := Detect(dir)
	res, _ := Mount(d, "/admin/ai", MountOptions{})
	if res.Mode != MountUpdated {
		t.Errorf("typed FastifyInstance not patched")
	}
	body, _ := os.ReadFile(filepath.Join(dir, "src", "server.ts"))
	mustContain(t, string(body), "import { gravelFastifyPlugin }")
}

func TestMountFastify_CJS(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"package.json": `{"dependencies":{"fastify":"4.0.0"}}`,
		"index.js": `const Fastify = require('fastify')

const fastify = Fastify()
`,
	})
	d := Detect(dir)
	res, _ := Mount(d, "/admin/ai", MountOptions{})
	if res.Mode != MountUpdated {
		t.Errorf("CJS Fastify entry not patched")
	}
	body, _ := os.ReadFile(filepath.Join(dir, "index.js"))
	got := string(body)
	mustContain(t, got, "const { gravelFastifyPlugin } = require('@artanis-ai/gravel/fastify')")
	mustContain(t, got, "const { config } = require('./gravel.config')")
	if strings.Contains(got, "import ") {
		t.Errorf("CJS file got import statements:\n%s", got)
	}
}

func TestMountFastify_AlternateVarName(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"package.json": `{"dependencies":{"fastify":"4.0.0"},"type":"module"}`,
		"index.js": `import Fastify from 'fastify'

const server = Fastify()
`,
	})
	d := Detect(dir)
	_, _ = Mount(d, "/admin/ai", MountOptions{})
	body, _ := os.ReadFile(filepath.Join(dir, "index.js"))
	mustContain(t, string(body), "server.register(gravelFastifyPlugin(config), { prefix: config.mountPath })")
}

// --- Refusal: never patch inside function/class bodies ----------

func TestMountFastify_FactoryFunction_RefusesToPatch(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"package.json": `{"dependencies":{"fastify":"4.0.0"},"type":"module"}`,
		"index.js": `import Fastify from 'fastify'

function buildServer() {
    const fastify = Fastify()
    return fastify
}
`,
	})
	d := Detect(dir)
	res, _ := Mount(d, "/admin/ai", MountOptions{})
	if res.Mode == MountUpdated {
		body, _ := os.ReadFile(filepath.Join(dir, "index.js"))
		if strings.Contains(string(body), "gravelFastifyPlugin") {
			t.Errorf("factory pattern was patched:\n%s", body)
		}
	}
}

func TestMountFastify_AsyncArrowFactory_RefusesToPatch(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"package.json": `{"dependencies":{"fastify":"4.0.0"},"type":"module"}`,
		"index.js": `import Fastify from 'fastify'
const buildServer = async () => {
    const fastify = Fastify()
    return fastify
}
`,
	})
	d := Detect(dir)
	res, _ := Mount(d, "/admin/ai", MountOptions{})
	if res.Mode == MountUpdated {
		body, _ := os.ReadFile(filepath.Join(dir, "index.js"))
		if strings.Contains(string(body), "gravelFastifyPlugin") {
			t.Errorf("async-arrow-factory pattern was patched:\n%s", body)
		}
	}
}

func TestMountFastify_ClassBody_RefusesToPatch(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"package.json": `{"dependencies":{"fastify":"4.0.0"},"type":"module"}`,
		"index.js": `import Fastify from 'fastify'
class Server {
    instance = Fastify()
}
`,
	})
	d := Detect(dir)
	res, _ := Mount(d, "/admin/ai", MountOptions{})
	if res.Mode == MountUpdated {
		body, _ := os.ReadFile(filepath.Join(dir, "index.js"))
		if strings.Contains(string(body), "gravelFastifyPlugin") {
			t.Errorf("class-body declaration was patched:\n%s", body)
		}
	}
}

// --- Idempotency -----------------------------------------------

func TestMountFastify_Idempotent_DoublePatchAvoided(t *testing.T) {
	src := `import Fastify from 'fastify'
import { gravelFastifyPlugin } from '@artanis-ai/gravel/fastify'
import { config } from './gravel.config'

const fastify = Fastify()
fastify.register(gravelFastifyPlugin(config), { prefix: config.mountPath })
`
	dir := newFixture(t, map[string]string{
		"package.json": `{"dependencies":{"fastify":"4.0.0"},"type":"module"}`,
		"index.js":     src,
	})
	d := Detect(dir)
	res, _ := Mount(d, "/admin/ai", MountOptions{})
	if res.Mode != MountUpdated {
		t.Errorf("Mode = %s, want updated (idempotent)", res.Mode)
	}
	body, _ := os.ReadFile(filepath.Join(dir, "index.js"))
	if string(body) != src {
		t.Errorf("idempotent re-run mutated file:\n%s", body)
	}
}

// --- Tree walk + candidate ordering -----------------------------

func TestMountFastify_FastPathBeatsTreeWalk(t *testing.T) {
	entry := `import Fastify from 'fastify'
const fastify = Fastify()
`
	dir := newFixture(t, map[string]string{
		"package.json":    `{"dependencies":{"fastify":"4.0.0"},"type":"module"}`,
		"index.js":        entry,
		"src/api/main.ts": entry,
	})
	d := Detect(dir)
	res, _ := Mount(d, "/admin/ai", MountOptions{})
	if !strings.HasSuffix(filepath.ToSlash(res.Path), "index.js") {
		t.Errorf("expected root index.js to win, got %s", res.Path)
	}
}

func TestMountFastify_TreeWalk_FindsNestedEntry(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"package.json": `{"dependencies":{"fastify":"4.0.0"},"type":"module"}`,
		"apps/api/src/server.ts": `import Fastify from 'fastify'
const fastify = Fastify()
`,
	})
	d := Detect(dir)
	res, _ := Mount(d, "/admin/ai", MountOptions{})
	if res.Mode != MountUpdated {
		t.Errorf("tree walk failed (Mode=%s)", res.Mode)
	}
}

func TestMountFastify_TreeWalkSkipsNoisyDirs(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"package.json": `{"dependencies":{"fastify":"4.0.0"},"type":"module"}`,
		"index.js": `import Fastify from 'fastify'
const fastify = Fastify()
`,
		"node_modules/some-pkg/index.js": `const Fastify = require('fastify'); const fastify = Fastify()`,
		"dist/index.js":                  `import Fastify from 'fastify'; const fastify = Fastify()`,
		".turbo/cache/index.js":          `import Fastify from 'fastify'; const fastify = Fastify()`,
	})
	d := Detect(dir)
	res, _ := Mount(d, "/admin/ai", MountOptions{})
	if !strings.HasSuffix(filepath.ToSlash(res.Path), "index.js") {
		t.Errorf("walker patched wrong file: %s", res.Path)
	}
	for _, suffix := range []string{
		"node_modules/some-pkg/index.js",
		"dist/index.js",
		".turbo/cache/index.js",
	} {
		body, _ := os.ReadFile(filepath.Join(dir, suffix))
		if strings.Contains(string(body), "gravelFastifyPlugin") {
			t.Errorf("noise file got patched: %s", suffix)
		}
	}
}

// --- Manual fallback when no entry found ------------------------

func TestMountFastify_NoEntryFound_FallsBackToManual(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"package.json": `{"dependencies":{"fastify":"4.0.0"},"type":"module"}`,
	})
	d := Detect(dir)
	res, _ := Mount(d, "/admin/ai", MountOptions{})
	if res.Mode != MountManual {
		t.Errorf("Mode = %s, want manual", res.Mode)
	}
	mustContain(t, res.Instructions, "gravelFastifyPlugin")
	mustContain(t, res.Instructions, "@artanis-ai/gravel/fastify")
}

// --- InspectState round-trip ------------------------------------

func TestInspectState_Fastify_DetectsMountedEntry(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"package.json": `{"dependencies":{"fastify":"4.0.0"},"type":"module"}`,
		"index.js": `import Fastify from 'fastify'
import { gravelFastifyPlugin } from '@artanis-ai/gravel/fastify'
import { config } from './gravel.config'

const fastify = Fastify()
fastify.register(gravelFastifyPlugin(config), { prefix: config.mountPath })
`,
	})
	d := Detect(dir)
	s := InspectState(dir, d)
	if !s.MountExists {
		t.Errorf("MountExists false despite Fastify entry being patched")
	}
	if !strings.HasSuffix(s.MountFilePath, "index.js") {
		t.Errorf("MountFilePath = %q", s.MountFilePath)
	}
}

func TestInspectState_Fastify_PristineEntry_NotMounted(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"package.json": `{"dependencies":{"fastify":"4.0.0"},"type":"module"}`,
		"index.js": `import Fastify from 'fastify'
const fastify = Fastify()
`,
	})
	d := Detect(dir)
	s := InspectState(dir, d)
	if s.MountExists {
		t.Errorf("MountExists true on a pristine Fastify project")
	}
}

func TestInspectState_Fastify_SrcLayout_DetectsMountedEntry(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"package.json": `{"dependencies":{"fastify":"4.0.0"},"type":"module"}`,
		"src/api/server.ts": `import Fastify from 'fastify'
import { gravelFastifyPlugin } from '@artanis-ai/gravel/fastify'
import { config } from './gravel.config'

const fastify = Fastify()
fastify.register(gravelFastifyPlugin(config), { prefix: config.mountPath })
`,
	})
	d := Detect(dir)
	s := InspectState(dir, d)
	if !s.MountExists {
		t.Errorf("MountExists false despite nested Fastify entry being patched")
	}
}

// --- regex unit tests ------------------------------------------

func TestTopLevelFastifyCtorRE_Matches(t *testing.T) {
	cases := []struct {
		name string
		src  string
		want bool
	}{
		{"default-uppercase", "const fastify = Fastify()", true},
		{"named-lowercase", "const f = fastify()", true},
		{"let", "let fastify = Fastify()", true},
		{"var", "var fastify = Fastify()", true},
		{"alt-name", "const app = Fastify()", true},
		{"typed", "const fastify: FastifyInstance = Fastify()", true},
		{"with-options", "const fastify = Fastify({ logger: true })", true},
		{"extra-spaces", "const   fastify   =   Fastify  (  )", true},

		{"indented-rejected", "  const fastify = Fastify()", false},
		{"no-keyword", "fastify = Fastify()", false},
		{"comment-line", "// const fastify = Fastify()", false},
		{"factory-aliased", "const f = createFastify()", false},
		{"static-method", "const cfg = Fastify.config", false}, // no opening paren after `Fastify`
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := topLevelFastifyCtorRE.MatchString(tc.src)
			if got != tc.want {
				t.Errorf("MatchString(%q) = %v, want %v", tc.src, got, tc.want)
			}
		})
	}
}
