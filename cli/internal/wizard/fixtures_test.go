package wizard

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fixtures_test.go locks in the end-to-end install output for every
// stack the wizard claims to support. Each table entry sets up a
// minimal pre-init project tree, runs `Run()` against it with the
// non-interactive defaults, and asserts on the artefacts the wizard
// was supposed to produce.
//
// This is the closest thing to "drive `gravel init` over a real
// project" that we can do in-process. It catches regressions where a
// stack-specific code path goes silently dead (e.g. the next.config
// patcher stops firing, or a detector returns generic-node for a
// project that's clearly Next.js).
//
// Adding a new stack: copy a case, populate `setup` with the
// fixture's file contents, and list the artefacts that must exist in
// `expectFiles` + the contents that must appear in `expectContains`.

type fixtureCase struct {
	name           string
	setup          map[string]string
	withTraces     bool
	expectFiles    []string
	expectAbsent   []string
	expectContains map[string][]string // file path → substrings that must appear
}

func TestFixtureMatrix(t *testing.T) {
	cases := []fixtureCase{
		{
			name: "next-app-router-clerk",
			setup: map[string]string{
				"package.json": `{
					"dependencies": {
						"next": "15.0.0",
						"@clerk/nextjs": "6.0.0",
						"openai": "5.0.0"
					}
				}`,
				"pnpm-lock.yaml": "",
				"app/page.tsx":   "",
			},
			expectFiles: []string{
				"gravel.config.ts",
				"app/admin/ai/[[...slug]]/route.ts",
				".env.local",
				".git/hooks/pre-commit",
			},
			expectAbsent: []string{
				"gravel_config.py",
				"pages/api/admin/ai/[[...slug]].ts",
			},
			expectContains: map[string][]string{
				"gravel.config.ts": {
					"@artanis-ai/gravel/define",
					"@clerk/nextjs/server",
					"mountPath: '/admin/ai'",
				},
				"app/admin/ai/[[...slug]]/route.ts": {
					"createGravelHandler",
					"@/gravel.config",
					"export const dynamic = 'force-dynamic'",
				},
				".git/hooks/pre-commit": {"gravel manifest --check"},
			},
		},
		{
			name: "next-app-router-src-layout-no-auth",
			setup: map[string]string{
				"package.json":       `{"dependencies":{"next":"15.0.0"}}`,
				"yarn.lock":          "",
				"src/app/page.tsx":   "",
			},
			expectFiles: []string{
				"gravel.config.ts",
				"src/app/admin/ai/[[...slug]]/route.ts",
			},
			expectContains: map[string][]string{
				"gravel.config.ts": {
					"defaultPassword: process.env.GRAVEL_ADMIN_PASSWORD",
				},
				"src/app/admin/ai/[[...slug]]/route.ts": {
					// src layout uses a relative import (../../../../../gravel.config).
					"../../../../../gravel.config",
				},
			},
		},
		{
			name: "next-pages-router-nextauth",
			setup: map[string]string{
				"package.json": `{
					"dependencies": {
						"next": "15.0.0",
						"next-auth": "5.0.0"
					}
				}`,
				"npm-lock.json":  "",
				"pages/index.ts": "",
				// Mark the NextAuth v5 helper as present so the wizard
				// emits the next-auth template.
				"auth.ts": "export const auth = async () => null",
			},
			expectFiles: []string{
				"gravel.config.ts",
				"pages/api/admin/ai/[[...slug]].ts",
				"next.config.mjs", // wizard creates one when none existed
			},
			expectContains: map[string][]string{
				"gravel.config.ts": {
					"@/auth",
					"nextAuth",
				},
				"pages/api/admin/ai/[[...slug]].ts": {
					"@artanis-ai/gravel/next-pages",
				},
				"next.config.mjs": {
					"destination: '/api/admin/ai'",
					"destination: '/api/admin/ai/:path*'",
				},
			},
		},
		{
			name: "next-pages-router-existing-empty-config",
			setup: map[string]string{
				"package.json":     `{"dependencies":{"next":"15.0.0"}}`,
				"pages/index.ts":   "",
				"next.config.mjs":  "export default {}\n",
			},
			expectFiles: []string{
				"pages/api/admin/ai/[[...slug]].ts",
				"next.config.mjs",
			},
			expectContains: map[string][]string{
				"next.config.mjs": {
					"async rewrites()",
					"destination: '/api/admin/ai/:path*'",
				},
			},
		},
		{
			name: "express",
			setup: map[string]string{
				"package.json": `{"dependencies":{"express":"4.0.0"}}`,
			},
			expectFiles: []string{
				"gravel.config.ts",
				".env.local",
			},
			expectAbsent: []string{
				"app/admin/ai/[[...slug]]/route.ts",
				"pages/api/admin/ai/[[...slug]].ts",
			},
		},
		{
			name: "fastapi-uv",
			setup: map[string]string{
				"pyproject.toml": `[project]
name = "app"
dependencies = ["fastapi", "openai"]
`,
				"uv.lock": "",
			},
			expectFiles: []string{
				"gravel_config.py",
				".env.local",
			},
			expectAbsent: []string{
				"gravel.config.ts",
			},
			expectContains: map[string][]string{
				"gravel_config.py": {
					"from artanis_gravel import GravelConfig",
					"mount_path='/admin/ai'",
				},
			},
		},
		{
			name: "django-poetry",
			setup: map[string]string{
				"pyproject.toml": `[project]
name = "app"
dependencies = ["django"]
`,
				"poetry.lock": "",
				"manage.py":   "",
			},
			expectFiles: []string{
				"gravel_config.py",
			},
			expectContains: map[string][]string{
				"gravel_config.py": {
					"GravelUser",
					"django_user.groups.filter(name='gravel_admin')",
				},
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := newFixture(t, tc.setup)
			// Every fixture also gets a fake .git so the hook
			// installer doesn't bail out.
			if err := os.MkdirAll(filepath.Join(dir, ".git", "hooks"), 0o755); err != nil {
				t.Fatal(err)
			}
			_, err := Run(context.Background(), RunOptions{
				CWD:         dir,
				MountPath:   "/admin/ai",
				YesToAll:    true,
				WithPrompts: true,
				WithTraces:  tc.withTraces,
			}, os.Stdout)
			if err != nil {
				t.Fatalf("Run: %v", err)
			}
			for _, rel := range tc.expectFiles {
				if !pathExists(filepath.Join(dir, rel)) {
					t.Errorf("missing expected file: %s", rel)
				}
			}
			for _, rel := range tc.expectAbsent {
				if pathExists(filepath.Join(dir, rel)) {
					t.Errorf("unexpected file present: %s", rel)
				}
			}
			for rel, needles := range tc.expectContains {
				body, err := os.ReadFile(filepath.Join(dir, rel))
				if err != nil {
					t.Errorf("read %s: %v", rel, err)
					continue
				}
				for _, n := range needles {
					if !strings.Contains(string(body), n) {
						t.Errorf("%s missing %q. body:\n%s", rel, n, body)
					}
				}
			}
		})
	}
}
