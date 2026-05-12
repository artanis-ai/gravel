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
func GenerateConfig(d Detection, opts ConfigOptions) (string, error) {
	if opts.MountPath == "" {
		opts.MountPath = "/admin/ai"
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
	envVar := d.DBEnvVar
	if envVar == "" {
		envVar = "DATABASE_URL"
	}

	if d.Auth == AuthDjango {
		return fmt.Sprintf(`import os
from artanis_gravel import GravelConfig, GravelUser

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
    database={'url': os.environ['%s']},
    auth={'get_user': get_user},
)
`, opts.MountPath, envVar)
	}
	return fmt.Sprintf(`import os
from artanis_gravel import GravelConfig

config = GravelConfig(
    mount_path='%s',
    database={'url': os.environ['%s']},
    auth={'default_password': os.environ['GRAVEL_ADMIN_PASSWORD']},
)
`, opts.MountPath, envVar)
}
