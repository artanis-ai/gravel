package wizard

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/artanis-ai/gravel/cli/internal/stack"
)

// ConfigOptions controls which blocks the generated gravel.config
// file contains.
type ConfigOptions struct {
	// MountPath is the URL path the dashboard mounts at. Default is /admin/ai.
	MountPath string
	// WithDatabase emits the database block. Prompts-only installs
	// (the new "free prompt editor" pillar) leave it off so no
	// DATABASE_URL is required.
	WithDatabase bool
}

// GenerateConfig writes the per-language config file and returns its
// path. Always overwrites: the wizard is the source of truth for this
// file; hand-edits are explicitly out of scope (re-run `gravel init`
// to regenerate). Mirrors packages/sdk-ts/src/wizard/config-file.ts.
//
// Also ensures `.gravel/` exists alongside the config so the no-DB
// stub URL the Python generator writes (file:.gravel/dev.db) has a
// parent directory the SDK can create the sqlite file in.
func GenerateConfig(d Detection, opts ConfigOptions) (string, error) {
	if opts.MountPath == "" {
		opts.MountPath = "/admin/ai"
	}
	gravelDir := filepath.Join(d.CWD, ".gravel")
	if err := os.MkdirAll(gravelDir, 0o755); err != nil {
		return "", err
	}
	// .gitignore in .gravel/ so dev.db, draft caches, etc. don't end
	// up tracked. Only write it if missing; never clobber a user-edited
	// version.
	gitignore := filepath.Join(gravelDir, ".gitignore")
	if !pathExists(gitignore) {
		_ = os.WriteFile(gitignore, []byte("# Wizard-managed scratch dir. Manifest is the only tracked file.\ndev.db\ndev.db-*\n*.tmp\n"), 0o644)
	}
	if d.Language == stack.LanguagePython {
		path := filepath.Join(d.CWD, "gravel_config.py")
		return path, os.WriteFile(path, []byte(pythonConfig(d, opts)), 0o644)
	}
	path := filepath.Join(d.CWD, "gravel.config.ts")
	body, err := tsConfig(d, opts)
	if err != nil {
		return "", err
	}
	return path, os.WriteFile(path, []byte(body), 0o644)
}

func tsConfig(d Detection, opts ConfigOptions) (string, error) {
	// next-auth template imports from `@/auth` (NextAuth v5
	// convention). If that helper doesn't exist we'd ship a config
	// that 500s every dashboard request, so demote the auth block to
	// the password-only template and let the user wire getUser later.
	auth := d.Auth
	if auth == AuthNextAuth && !nextAuthHelperExists(d.CWD) {
		auth = AuthUnknown
	}

	dbBlock := ""
	if opts.WithDatabase {
		envVar := d.DBEnvVar
		if envVar == "" {
			envVar = "DATABASE_URL"
		}
		dbBlock = fmt.Sprintf("  database: {\n    url: process.env.%s!,\n  },\n", envVar)
	}

	return fmt.Sprintf(`import { defineConfig } from '@artanis-ai/gravel/define'
%s

export const config = defineConfig({
  mountPath: '%s',
%s%s
})
`, tsAuthImport(auth), opts.MountPath, dbBlock, tsAuthBlock(auth)), nil
}

func tsAuthImport(auth AuthProvider) string {
	switch auth {
	case AuthClerk:
		return "import { auth } from '@clerk/nextjs/server'"
	case AuthNextAuth:
		return "import { auth as nextAuth } from '@/auth'"
	}
	return ""
}

func tsAuthBlock(auth AuthProvider) string {
	switch auth {
	case AuthClerk:
		return `  auth: {
    async getUser() {
      const { userId, sessionClaims } = await auth()
      if (!userId) return null
      return {
        id: userId,
        firstName: (sessionClaims?.first_name as string) ?? 'User',
        // TODO: define your own admin check
        role: 'user',
      }
    },
  },`
	case AuthNextAuth:
		return `  auth: {
    async getUser() {
      const session = await nextAuth()
      if (!session?.user) return null
      return {
        id: session.user.id,
        firstName: session.user.name?.split(' ')[0] ?? 'User',
        role: 'user',
      }
    },
  },`
	}
	return `  auth: {
    // No auth callback detected. Default-password mode is active.
    // Configure getUser() to integrate with your real auth.
    defaultPassword: process.env.GRAVEL_ADMIN_PASSWORD!,
  },`
}

// nextAuthHelperExists checks for the NextAuth v5 helper file at the
// conventional locations. Older NextAuth setups don't have one and
// would 500 if we generated their config.
func nextAuthHelperExists(cwd string) bool {
	for _, c := range []string{"auth.ts", "auth.js", "src/auth.ts", "src/auth.js"} {
		if pathExists(filepath.Join(cwd, c)) {
			return true
		}
	}
	return false
}

func pythonConfig(d Detection, opts ConfigOptions) string {
	// All env var reads use `os.environ.get(name, '')` rather than
	// `os.environ[name]` so importing this module doesn't crash with
	// KeyError when the user starts the server without their .env
	// loaded. The wizard's auto-loaded `.env.local` block (below)
	// usually fills these in, but defensive `.get()` matters when
	// uvicorn is launched in a way that bypasses our config import.
	//
	// The `database` key is ALWAYS emitted (Python's GravelConfig
	// dataclass declares it required). When the user opts out of the
	// traces pillar, we still need a URL the SDK can open without
	// crashing — published `artanis-gravel<=0.5.2` calls
	// `open_database(url)` unconditionally and raises ValueError on
	// the empty string. We write a stub local SQLite URL pointing at
	// `.gravel/dev.db`; the SDK opens it (empty file), no gravel_*
	// tables exist, sample routes degrade to empty pages, the
	// dashboard SPA still renders. The user can later swap in a real
	// DATABASE_URL by re-running with `--traces`.
	//
	// The file also auto-loads `.env.local` / `.env` at import time
	// so `uv run …` / `python -m uvicorn …` / `gunicorn` all pick up
	// the wizard-generated env vars without the user remembering to
	// source them manually. This is the lazy-but-correct alternative
	// to taking a hard dep on python-dotenv.
	envVar := d.DBEnvVar
	if envVar == "" {
		envVar = "DATABASE_URL"
	}
	// Stub URL for the no-traces case. Resolved relative to the
	// config file's own directory so the path is stable regardless
	// of where uvicorn is invoked from.
	urlExpr := "f'file:{Path(__file__).resolve().parent}/.gravel/dev.db'"
	if opts.WithDatabase {
		urlExpr = fmt.Sprintf("os.environ.get('%s', '')", envVar)
	}
	dbBlock := fmt.Sprintf("    database={'url': %s},\n", urlExpr)
	envLoader := `from pathlib import Path

# Auto-load .env.local then .env from the project root so the config
# resolves to real values regardless of how the host is launched
# (uv run, gunicorn, raw uvicorn, …). os.environ.setdefault means
# the host's existing environment always wins; we only fill gaps.
for _env_file in (".env.local", ".env"):
    _path = Path(__file__).resolve().parent / _env_file
    if not _path.is_file():
        continue
    for _line in _path.read_text(encoding="utf-8").splitlines():
        _line = _line.strip()
        if not _line or _line.startswith("#") or "=" not in _line:
            continue
        _k, _, _v = _line.partition("=")
        _v = _v.strip().strip("'\"")
        os.environ.setdefault(_k.strip(), _v)

`

	if d.Auth == AuthDjango {
		return fmt.Sprintf(`import os
%sfrom artanis_gravel import GravelConfig, GravelUser

async def get_user(req):
    django_user = req.scope.get('user')
    if not django_user or not getattr(django_user, 'is_authenticated', False):
        return None
    return GravelUser(
        id=str(django_user.id),
        first_name=django_user.first_name or 'User',
        role='admin' if django_user.groups.filter(name='gravel_admin').exists() else 'user',
    )

config = GravelConfig(
    mount_path='%s',
%s    auth={'get_user': get_user},
)
`, envLoader, opts.MountPath, dbBlock)
	}
	return fmt.Sprintf(`import os
%sfrom artanis_gravel import GravelConfig

config = GravelConfig(
    mount_path='%s',
%s    auth={'default_password': os.environ.get('GRAVEL_ADMIN_PASSWORD', '')},
)
`, envLoader, opts.MountPath, dbBlock)
}
