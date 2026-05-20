package wizard

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/artanis-ai/gravel/cli/internal/stack"
)

// PatchConfigForDatabase must:
//   - preserve user edits (# noqa pragmas, custom getUser, scan_roots, …)
//   - swap an empty-URL database line to the env-var lookup form
//   - insert a database kwarg when the existing config has none
//   - return (false, nil) when no config file exists
//
// Claude's de_platform install (2026-05-20) caught the regression:
// every `gravel traces --apply` regenerated the file and clobbered
// hand-edits.

func TestPatchConfig_Python_PreservesUserEdits(t *testing.T) {
	dir := t.TempDir()
	original := `import os
from pathlib import Path

# Auto-load .env.local block …
for _env_file in (".env.local", ".env"):
    pass

from artanis_gravel import GravelConfig  # noqa: E402

# User's custom scan-roots addition that the v0.9.0 wizard would clobber.
prompt_scan_roots = ['api/py/prompts']  # noqa: E402

# User wrote their own getUser body.
async def get_user(req):
    return None  # user's own implementation

config = GravelConfig(
    mount_path='/admin/ai',
    database={'url': ''},
    auth={'get_user': get_user},
)
`
	cfg := filepath.Join(dir, "gravel_config.py")
	if err := os.WriteFile(cfg, []byte(original), 0o644); err != nil {
		t.Fatal(err)
	}
	d := Detection{CWD: dir, Language: stack.LanguagePython, DBEnvVar: "DATABASE_URL"}
	patched, err := PatchConfigForDatabase(d, "/admin/ai")
	if err != nil {
		t.Fatal(err)
	}
	if !patched {
		t.Fatal("expected patched=true on existing file")
	}
	got, _ := os.ReadFile(cfg)
	s := string(got)
	// All user edits survive.
	mustContain(t, s, "# noqa: E402")
	mustContain(t, s, "prompt_scan_roots = ['api/py/prompts']")
	mustContain(t, s, "# user's own implementation")
	// Database URL flipped from empty to env-var lookup.
	mustContain(t, s, "database={'url': os.environ.get('DATABASE_URL', '')},")
	mustNotContain(t, s, "database={'url': ''},")
}

func TestPatchConfig_Python_InsertsWhenAbsent(t *testing.T) {
	dir := t.TempDir()
	original := `import os
from artanis_gravel import GravelConfig

config = GravelConfig(
    mount_path='/admin/ai',
    auth={'default_password': os.environ.get('GRAVEL_ADMIN_PASSWORD', '')},
)
`
	cfg := filepath.Join(dir, "gravel_config.py")
	if err := os.WriteFile(cfg, []byte(original), 0o644); err != nil {
		t.Fatal(err)
	}
	d := Detection{CWD: dir, Language: stack.LanguagePython, DBEnvVar: "DATABASE_URL"}
	patched, _ := PatchConfigForDatabase(d, "/admin/ai")
	if !patched {
		t.Fatal("patched=false")
	}
	got, _ := os.ReadFile(cfg)
	s := string(got)
	mustContain(t, s, "database={'url': os.environ.get('DATABASE_URL', '')},")
	// Inserted AFTER mount_path; auth block kept after it.
	mountIdx := strings.Index(s, "mount_path")
	dbIdx := strings.Index(s, "database=")
	authIdx := strings.Index(s, "auth=")
	if !(mountIdx < dbIdx && dbIdx < authIdx) {
		t.Errorf("expected order mount_path < database < auth in:\n%s", s)
	}
}

func TestPatchConfig_Python_IdempotentWhenAlreadyCorrect(t *testing.T) {
	dir := t.TempDir()
	original := `import os
from artanis_gravel import GravelConfig

config = GravelConfig(
    mount_path='/admin/ai',
    database={'url': os.environ.get('DATABASE_URL', '')},
    auth={'default_password': os.environ.get('GRAVEL_ADMIN_PASSWORD', '')},
)
`
	cfg := filepath.Join(dir, "gravel_config.py")
	if err := os.WriteFile(cfg, []byte(original), 0o644); err != nil {
		t.Fatal(err)
	}
	d := Detection{CWD: dir, Language: stack.LanguagePython, DBEnvVar: "DATABASE_URL"}
	patched, _ := PatchConfigForDatabase(d, "/admin/ai")
	if !patched {
		t.Fatal("expected patched=true on existing file")
	}
	got, _ := os.ReadFile(cfg)
	if string(got) != original {
		t.Errorf("file changed on no-op patch:\n%s", got)
	}
}

func TestPatchConfig_Python_CustomDBEnvVar(t *testing.T) {
	dir := t.TempDir()
	original := `import os
from artanis_gravel import GravelConfig
config = GravelConfig(
    mount_path='/admin/ai',
    database={'url': ''},
    auth={'default_password': ''},
)
`
	cfg := filepath.Join(dir, "gravel_config.py")
	_ = os.WriteFile(cfg, []byte(original), 0o644)
	d := Detection{CWD: dir, Language: stack.LanguagePython, DBEnvVar: "NEON_DATABASE_URL"}
	_, _ = PatchConfigForDatabase(d, "/admin/ai")
	got, _ := os.ReadFile(cfg)
	mustContain(t, string(got), "database={'url': os.environ.get('NEON_DATABASE_URL', '')},")
}

func TestPatchConfig_ReturnsFalseWhenNoConfigFile(t *testing.T) {
	dir := t.TempDir()
	d := Detection{CWD: dir, Language: stack.LanguagePython, DBEnvVar: "DATABASE_URL"}
	patched, err := PatchConfigForDatabase(d, "/admin/ai")
	if err != nil {
		t.Fatal(err)
	}
	if patched {
		t.Errorf("expected patched=false when no config file present")
	}
}

func TestPatchConfig_TS_PreservesUserEdits(t *testing.T) {
	dir := t.TempDir()
	original := `import { defineConfig } from '@artanis-ai/gravel/define'
import { auth } from '@clerk/nextjs/server'

// User's custom comment that v0.9.0 would have stripped.
export const config = defineConfig({
  mountPath: '/admin/ai',
  auth: {
    async getUser() {
      // user-edited: route by Clerk org role
      const { userId, orgRole } = await auth()
      return userId ? { id: userId, role: orgRole === 'admin' ? 'admin' : 'user' } : null
    },
  },
})
`
	cfg := filepath.Join(dir, "gravel.config.ts")
	_ = os.WriteFile(cfg, []byte(original), 0o644)
	d := Detection{CWD: dir, Language: stack.LanguageTS, DBEnvVar: "DATABASE_URL"}
	patched, err := PatchConfigForDatabase(d, "/admin/ai")
	if err != nil {
		t.Fatal(err)
	}
	if !patched {
		t.Fatal("expected patched=true")
	}
	got, _ := os.ReadFile(cfg)
	s := string(got)
	mustContain(t, s, "url: process.env.DATABASE_URL!")
	mustContain(t, s, "// user-edited: route by Clerk org role")
	mustContain(t, s, "orgRole === 'admin'")
}
