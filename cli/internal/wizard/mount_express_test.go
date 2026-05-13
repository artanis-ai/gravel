package wizard

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// mount_express_test.go: heavy coverage of the Express auto-mount.
// Same shape as mount_python_test.go — every idiomatic ctor form
// gets a positive test, every "should refuse" form gets a negative
// test, plus the cross-cutting concerns (ESM vs CJS emission, tree
// walk skipping noise dirs, idempotency, src-layout, manual
// fallback path).

// --- Happy-path mounts: every common entry shape ----------------

func TestMountExpress_ConstAppExpress_PatchesESM(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"package.json": `{"dependencies":{"express":"4.0.0"},"type":"module"}`,
		"index.js": `import express from 'express'

const app = express()
app.listen(3000)
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
	mustContain(t, got, "import { gravelHandler } from '@artanis-ai/gravel/node'")
	mustContain(t, got, "import { config } from './gravel.config'")
	mustContain(t, got, "app.use(config.mountPath, gravelHandler({ config }))")
	// CJS imports must NOT appear in an ESM file.
	if strings.Contains(got, "require(") {
		t.Errorf("ESM file got require() imports:\n%s", got)
	}
}

func TestMountExpress_ConstAppExpress_PatchesCJS(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"package.json": `{"dependencies":{"express":"4.0.0"}}`, // no "type":"module"
		"index.js": `const express = require('express')

const app = express()
app.listen(3000)
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
	mustContain(t, got, "const { gravelHandler } = require('@artanis-ai/gravel/node')")
	mustContain(t, got, "const { config } = require('./gravel.config')")
	mustContain(t, got, "app.use(config.mountPath, gravelHandler({ config }))")
	if strings.Contains(got, "import ") {
		t.Errorf("CJS file got import statements:\n%s", got)
	}
}

func TestMountExpress_TypeScriptFile_AlwaysESM(t *testing.T) {
	// .ts implies ESM even when package.json has no "type":"module".
	dir := newFixture(t, map[string]string{
		"package.json": `{"dependencies":{"express":"4.0.0"}}`,
		"server.ts": `import express from 'express'

const app = express()
`,
	})
	d := Detect(dir)
	_, _ = Mount(d, "/admin/ai", MountOptions{})
	body, _ := os.ReadFile(filepath.Join(dir, "server.ts"))
	mustContain(t, string(body), "import { gravelHandler } from '@artanis-ai/gravel/node'")
}

func TestMountExpress_MJS_ForcesESM(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"package.json": `{"dependencies":{"express":"4.0.0"}}`,
		"app.mjs": `import express from 'express'

const app = express()
`,
	})
	d := Detect(dir)
	_, _ = Mount(d, "/admin/ai", MountOptions{})
	body, _ := os.ReadFile(filepath.Join(dir, "app.mjs"))
	mustContain(t, string(body), "import { gravelHandler }")
}

func TestMountExpress_CJS_ForcesCJS(t *testing.T) {
	// .cjs forces require() even when package.json has "type":"module".
	dir := newFixture(t, map[string]string{
		"package.json": `{"dependencies":{"express":"4.0.0"},"type":"module"}`,
		"app.cjs": `const express = require('express')
const app = express()
`,
	})
	d := Detect(dir)
	_, _ = Mount(d, "/admin/ai", MountOptions{})
	body, _ := os.ReadFile(filepath.Join(dir, "app.cjs"))
	got := string(body)
	mustContain(t, got, "const { gravelHandler } = require(")
	if strings.Contains(got, "import ") {
		t.Errorf(".cjs file got import statements")
	}
}

func TestMountExpress_TypedAppDeclaration(t *testing.T) {
	// `const app: Application = express()` — TypeScript with explicit type.
	dir := newFixture(t, map[string]string{
		"package.json": `{"dependencies":{"express":"4.0.0","@types/express":"4.0.0"}}`,
		"server.ts": `import express, { Application } from 'express'

const app: Application = express()
`,
	})
	d := Detect(dir)
	res, err := Mount(d, "/admin/ai", MountOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if res.Mode != MountUpdated {
		t.Errorf("typed declaration was not patched (Mode=%s)", res.Mode)
	}
	body, _ := os.ReadFile(filepath.Join(dir, "server.ts"))
	mustContain(t, string(body), "app.use(config.mountPath, gravelHandler({ config }))")
}

func TestMountExpress_TypedAppDeclaration_DottedType(t *testing.T) {
	// `const app: express.Application = express()`.
	dir := newFixture(t, map[string]string{
		"package.json": `{"dependencies":{"express":"4.0.0"}}`,
		"server.ts": `import express from 'express'

const app: express.Application = express()
`,
	})
	d := Detect(dir)
	res, _ := Mount(d, "/admin/ai", MountOptions{})
	if res.Mode != MountUpdated {
		t.Errorf("dotted-type declaration not patched")
	}
}

func TestMountExpress_LetVar_BothBindings(t *testing.T) {
	for _, kw := range []string{"let", "var"} {
		t.Run(kw, func(t *testing.T) {
			dir := newFixture(t, map[string]string{
				"package.json": `{"dependencies":{"express":"4.0.0"}}`,
				"index.js":     "const express = require('express')\n" + kw + " app = express()\n",
			})
			d := Detect(dir)
			res, _ := Mount(d, "/admin/ai", MountOptions{})
			if res.Mode != MountUpdated {
				t.Errorf("%s binding not patched", kw)
			}
		})
	}
}

func TestMountExpress_AlternateVarName(t *testing.T) {
	// `const application = express()` — name other than "app".
	dir := newFixture(t, map[string]string{
		"package.json": `{"dependencies":{"express":"4.0.0"}}`,
		"index.js": `const express = require('express')
const application = express()
`,
	})
	d := Detect(dir)
	_, _ = Mount(d, "/admin/ai", MountOptions{})
	body, _ := os.ReadFile(filepath.Join(dir, "index.js"))
	mustContain(t, string(body), "application.use(config.mountPath, gravelHandler({ config }))")
}

func TestMountExpress_CtorWithMiddlewareChain(t *testing.T) {
	// The gravel mount must land AFTER the express() ctor but doesn't
	// need to land before subsequent `app.use(...)` calls — order of
	// middleware can be tweaked by the user. We just verify the
	// patcher doesn't get confused by other app.use() lines.
	dir := newFixture(t, map[string]string{
		"package.json": `{"dependencies":{"express":"4.0.0"}}`,
		"index.js": `const express = require('express')
const app = express()

app.use(express.json())
app.use('/api', someRouter)
app.listen(3000)
`,
	})
	d := Detect(dir)
	_, _ = Mount(d, "/admin/ai", MountOptions{})
	body, _ := os.ReadFile(filepath.Join(dir, "index.js"))
	got := string(body)
	mustContain(t, got, "app.use(config.mountPath, gravelHandler({ config }))")
	// Existing middleware lines preserved.
	mustContain(t, got, "app.use(express.json())")
	mustContain(t, got, "app.listen(3000)")
}

// --- Refusal: never patch inside function/class bodies -----------

func TestMountExpress_FactoryFunction_RefusesToPatch(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"package.json": `{"dependencies":{"express":"4.0.0"}}`,
		"index.js": `const express = require('express')

function createApp() {
    const app = express()
    return app
}
`,
	})
	d := Detect(dir)
	res, _ := Mount(d, "/admin/ai", MountOptions{})
	// Indented `const app = express()` must NOT be patched — the
	// `app.use(...)` would land at column 0 with no `app` in scope.
	if res.Mode == MountUpdated {
		body, _ := os.ReadFile(filepath.Join(dir, "index.js"))
		if strings.Contains(string(body), "gravelHandler") {
			t.Errorf("factory pattern was patched (would corrupt the file):\n%s", body)
		}
	}
}

func TestMountExpress_ArrowFactory_RefusesToPatch(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"package.json": `{"dependencies":{"express":"4.0.0"}}`,
		"index.js": `const express = require('express')
const createApp = () => {
    const app = express()
    return app
}
`,
	})
	d := Detect(dir)
	res, _ := Mount(d, "/admin/ai", MountOptions{})
	if res.Mode == MountUpdated {
		body, _ := os.ReadFile(filepath.Join(dir, "index.js"))
		if strings.Contains(string(body), "gravelHandler") {
			t.Errorf("arrow-factory pattern was patched:\n%s", body)
		}
	}
}

func TestMountExpress_ClassBody_RefusesToPatch(t *testing.T) {
	// `class Server { app = express() }` — class-field declaration.
	dir := newFixture(t, map[string]string{
		"package.json": `{"dependencies":{"express":"4.0.0"}}`,
		"index.js": `const express = require('express')
class Server {
    app = express()
}
`,
	})
	d := Detect(dir)
	res, _ := Mount(d, "/admin/ai", MountOptions{})
	if res.Mode == MountUpdated {
		body, _ := os.ReadFile(filepath.Join(dir, "index.js"))
		if strings.Contains(string(body), "gravelHandler") {
			t.Errorf("class-body declaration was patched:\n%s", body)
		}
	}
}

func TestMountExpress_RouterDeclaration_NotMistakenForApp(t *testing.T) {
	// `const router = express.Router()` is NOT a top-level
	// `<name> = express()` binding. Must NOT match the regex.
	dir := newFixture(t, map[string]string{
		"package.json": `{"dependencies":{"express":"4.0.0"}}`,
		"index.js": `const express = require('express')
const router = express.Router()
router.get('/health', (req, res) => res.send('ok'))
`,
	})
	d := Detect(dir)
	res, _ := Mount(d, "/admin/ai", MountOptions{})
	if res.Mode != MountManual {
		t.Errorf("Mode = %s, want manual (no real app declared)", res.Mode)
	}
	body, _ := os.ReadFile(filepath.Join(dir, "index.js"))
	if strings.Contains(string(body), "gravelHandler") {
		t.Errorf("Express router was mistaken for an app:\n%s", body)
	}
}

// --- Idempotency ------------------------------------------------

func TestMountExpress_Idempotent_DoublePatchAvoided(t *testing.T) {
	src := `const express = require('express')
const { gravelHandler } = require('@artanis-ai/gravel/node')
const { config } = require('./gravel.config')

const app = express()
app.use(config.mountPath, gravelHandler({ config }))
`
	dir := newFixture(t, map[string]string{
		"package.json": `{"dependencies":{"express":"4.0.0"}}`,
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
	if strings.Count(string(body), "gravelHandler") != 2 {
		t.Errorf("expected exactly 2 gravelHandler occurrences (require + call), got %d", strings.Count(string(body), "gravelHandler"))
	}
}

// --- Tree walk + candidate ordering -----------------------------

func TestMountExpress_FastPathBeatsTreeWalk(t *testing.T) {
	// Both files declare an Express app. The fast-path candidate
	// list (index.js, server.js, app.js, src/*) tries the root
	// index.js before walking the tree, so the root wins.
	entry := `const express = require('express')
const app = express()
`
	dir := newFixture(t, map[string]string{
		"package.json":       `{"dependencies":{"express":"4.0.0"}}`,
		"index.js":           entry,
		"src/server/main.js": entry,
	})
	d := Detect(dir)
	res, _ := Mount(d, "/admin/ai", MountOptions{})
	if !strings.HasSuffix(filepath.ToSlash(res.Path), "index.js") {
		t.Errorf("expected root index.js to win, got %s", res.Path)
	}
	body, _ := os.ReadFile(filepath.Join(dir, "src", "server", "main.js"))
	if strings.Contains(string(body), "gravelHandler") {
		t.Errorf("nested file got patched when root index.js should have won")
	}
}

func TestMountExpress_TreeWalk_FindsNestedEntry(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"package.json": `{"dependencies":{"express":"4.0.0"}}`,
		"src/api/server.js": `const express = require('express')
const app = express()
`,
	})
	d := Detect(dir)
	res, _ := Mount(d, "/admin/ai", MountOptions{})
	if res.Mode != MountUpdated {
		t.Errorf("tree walk failed to find src/api/server.js (Mode=%s)", res.Mode)
	}
	if !strings.HasSuffix(filepath.ToSlash(res.Path), "src/api/server.js") {
		t.Errorf("walker patched wrong file: %s", res.Path)
	}
}

func TestMountExpress_TreeWalkSkipsNoisyDirs(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"package.json": `{"dependencies":{"express":"4.0.0"}}`,
		"index.js": `const express = require('express')
const app = express()
`,
		// Poisoned express ctors inside dirs we MUST skip.
		"node_modules/some-pkg/index.js":   "const express = require('express'); const app = express()\n",
		"dist/server.js":                    "const express = require('express'); const app = express()\n",
		"build/output.js":                   "const express = require('express'); const app = express()\n",
		".next/static/chunks/express.js":    "const express = require('express'); const app = express()\n",
		"coverage/instrumented.js":          "const express = require('express'); const app = express()\n",
	})
	d := Detect(dir)
	res, _ := Mount(d, "/admin/ai", MountOptions{})
	if !strings.HasSuffix(filepath.ToSlash(res.Path), "index.js") {
		t.Errorf("walker patched wrong file: %s", res.Path)
	}
	// Confirm none of the noise dirs were touched.
	for _, suffix := range []string{
		"node_modules/some-pkg/index.js",
		"dist/server.js",
		"build/output.js",
		".next/static/chunks/express.js",
		"coverage/instrumented.js",
	} {
		body, _ := os.ReadFile(filepath.Join(dir, suffix))
		if strings.Contains(string(body), "gravelHandler") {
			t.Errorf("noise file got patched: %s", suffix)
		}
	}
}

func TestMountExpress_SkipsDeclarationFiles(t *testing.T) {
	// .d.ts files don't carry runnable code but might syntactically
	// contain `const app: Application = express()` in odd
	// hand-written declarations. Walker must skip them.
	dir := newFixture(t, map[string]string{
		"package.json": `{"dependencies":{"express":"4.0.0"}}`,
		"types.d.ts":   "const app: Application = express()\n", // would be invalid Express anyway
		"server.ts": `import express from 'express'
const app = express()
`,
	})
	d := Detect(dir)
	res, _ := Mount(d, "/admin/ai", MountOptions{})
	if !strings.HasSuffix(filepath.ToSlash(res.Path), "server.ts") {
		t.Errorf("walker should have skipped types.d.ts, got %s", res.Path)
	}
}

// --- Manual fallback when no entry found ------------------------

func TestMountExpress_NoEntryFound_FallsBackToManual(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"package.json": `{"dependencies":{"express":"4.0.0"}}`,
		// No JS/TS files containing `<name> = express()`.
	})
	d := Detect(dir)
	res, _ := Mount(d, "/admin/ai", MountOptions{})
	if res.Mode != MountManual {
		t.Errorf("Mode = %s, want manual", res.Mode)
	}
	mustContain(t, res.Instructions, "gravelHandler")
	mustContain(t, res.Instructions, "@artanis-ai/gravel/node")
}

// --- ESM/CJS detection edge cases -------------------------------

func TestMountExpress_JSWithImportStatement_DetectedAsESM(t *testing.T) {
	// `.js` without `"type":"module"` — but the file uses `import`
	// syntax (transpiled later by Vite/esbuild/Babel). Patcher
	// should emit ESM imports to match.
	dir := newFixture(t, map[string]string{
		"package.json": `{"dependencies":{"express":"4.0.0"}}`, // no type
		"server.js": `import express from 'express'

const app = express()
`,
	})
	d := Detect(dir)
	_, _ = Mount(d, "/admin/ai", MountOptions{})
	body, _ := os.ReadFile(filepath.Join(dir, "server.js"))
	got := string(body)
	mustContain(t, got, "import { gravelHandler }")
	if strings.Contains(got, "require(") {
		t.Errorf("JS-with-import-syntax file got require() imports:\n%s", got)
	}
}

func TestMountExpress_ExplicitCommonJSType(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"package.json": `{"dependencies":{"express":"4.0.0"},"type":"commonjs"}`,
		"index.js": `const express = require('express')
const app = express()
`,
	})
	d := Detect(dir)
	_, _ = Mount(d, "/admin/ai", MountOptions{})
	body, _ := os.ReadFile(filepath.Join(dir, "index.js"))
	mustContain(t, string(body), "require(")
}

// --- InspectState round-trip ------------------------------------

func TestInspectState_Express_DetectsMountedEntry(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"package.json": `{"dependencies":{"express":"4.0.0"}}`,
		"index.js": `const express = require('express')
const { gravelHandler } = require('@artanis-ai/gravel/node')
const { config } = require('./gravel.config')

const app = express()
app.use(config.mountPath, gravelHandler({ config }))
`,
	})
	d := Detect(dir)
	s := InspectState(dir, d)
	if !s.MountExists {
		t.Errorf("MountExists false despite Express entry being patched")
	}
	if !strings.HasSuffix(s.MountFilePath, "index.js") {
		t.Errorf("MountFilePath = %q, want suffix index.js", s.MountFilePath)
	}
}

func TestInspectState_Express_PristineEntry_NotMounted(t *testing.T) {
	dir := newFixture(t, map[string]string{
		"package.json": `{"dependencies":{"express":"4.0.0"}}`,
		"index.js": `const express = require('express')
const app = express()
`,
	})
	d := Detect(dir)
	s := InspectState(dir, d)
	if s.MountExists {
		t.Errorf("MountExists true on a pristine Express project")
	}
}

func TestInspectState_Express_SrcLayout_DetectsMountedEntry(t *testing.T) {
	// Same fix as the FastAPI src-layout bug: patched entry deep in
	// src/<...>/ must trigger MountExists=true.
	dir := newFixture(t, map[string]string{
		"package.json": `{"dependencies":{"express":"4.0.0"}}`,
		"src/api/main.ts": `import express from 'express'
import { gravelHandler } from '@artanis-ai/gravel/node'
import { config } from './gravel.config'

const app = express()
app.use(config.mountPath, gravelHandler({ config }))
`,
	})
	d := Detect(dir)
	s := InspectState(dir, d)
	if !s.MountExists {
		t.Errorf("MountExists false despite nested Express entry being patched")
	}
}

// --- regex unit tests on the matcher ---------------------------

func TestTopLevelExpressCtorRE_Matches(t *testing.T) {
	cases := []struct {
		name string
		src  string
		want bool
	}{
		{"const-app", "const app = express()", true},
		{"let-app", "let app = express()", true},
		{"var-app", "var app = express()", true},
		{"alt-name", "const application = express()", true},
		{"typed", "const app: Application = express()", true},
		{"typed-dotted", "const app: express.Application = express()", true},
		{"typed-quoted", `const app: "Application" = express()`, true},
		{"extra-spaces", "const   app   =   express(  )", true},

		{"indented-rejected", "  const app = express()", false},
		{"router-not-app", "const router = express.Router()", false},
		{"no-keyword-rejected", "app = express()", false},
		{"chained-callsite", "const app = express()(foo)", true},
		{"call-without-equals", "express()", false},
		{"comment-like", "// const app = express()", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := topLevelExpressCtorRE.MatchString(tc.src)
			if got != tc.want {
				t.Errorf("MatchString(%q) = %v, want %v", tc.src, got, tc.want)
			}
		})
	}
}
