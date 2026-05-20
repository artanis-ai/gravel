// PatchConfigForDatabase: surgically insert the database block into
// the user's existing gravel_config.{py,ts} on `gravel traces --apply`
// without clobbering hand-edits (# noqa pragmas, custom getUser
// bodies, scan_roots additions, etc.).
//
// Claude's de_platform install (2026-05-20) lost user edits on every
// traces apply because v0.9.0 rewrote the whole file. v0.9.1 inverts
// it: patch the file in place when it exists; only regenerate when
// missing entirely.

package wizard

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/artanis-ai/gravel/cli/internal/stack"
)

// PatchConfigForDatabase tries to insert the database block into the
// existing gravel_config file. Returns (true, nil) on a successful
// in-place patch, (false, nil) when no existing config file is
// present (caller should regenerate), (false, err) on any IO error.
//
// Logic:
//   1. Locate the config file based on Detection.Language.
//   2. If missing, return (false, nil).
//   3. Parse the file for an existing database block:
//      - If present with the same shape (env var lookup), no-op.
//      - If present empty (`database: {url: ''}` / `database={'url': ''}`),
//        replace just the URL value.
//      - If missing entirely, insert immediately after the `mount_path` /
//        `mountPath` line so it lands inside the config object.
//   4. Preserve everything else byte-for-byte.
func PatchConfigForDatabase(d Detection, mountPath string) (bool, error) {
	configPath := configFilenameFor(d)
	if !pathExists(filepath.Join(d.CWD, configPath)) {
		return false, nil
	}
	abs := filepath.Join(d.CWD, configPath)
	body, err := os.ReadFile(abs)
	if err != nil {
		return false, fmt.Errorf("read %s: %w", configPath, err)
	}
	text := string(body)

	envVar := d.DBEnvVar
	if envVar == "" {
		envVar = "DATABASE_URL"
	}

	if d.Language == stack.LanguagePython {
		updated, err := patchPythonDatabase(text, envVar)
		if err != nil {
			return false, err
		}
		if updated == text {
			return true, nil // already correct
		}
		return true, os.WriteFile(abs, []byte(updated), 0o644)
	}
	updated, err := patchTSDatabase(text, envVar)
	if err != nil {
		return false, err
	}
	if updated == text {
		return true, nil
	}
	return true, os.WriteFile(abs, []byte(updated), 0o644)
}

// patchPythonDatabase locates the `database={...}` kwarg inside
// `GravelConfig(...)` and either rewrites the empty-URL form to the
// env-var lookup OR inserts a new line if the kwarg is missing.
//
// Matches both styles the wizard has emitted historically:
//   database={'url': ''},                       — v0.9.0 prompts-only
//   database={'url': f'file:.../gravel/dev.db'} — pre-v0.9.0 stub
//   database={'url': os.environ.get('X', '')}   — already-traces
func patchPythonDatabase(text, envVar string) (string, error) {
	envExpr := fmt.Sprintf("os.environ.get('%s', '')", envVar)
	target := fmt.Sprintf("database={'url': %s},", envExpr)

	// 1. Already configured with the same env var — no-op.
	if strings.Contains(text, target) {
		return text, nil
	}

	// 2. Existing `database={'url': ...},` line of ANY shape — replace
	//    its url value in place. Quote-style-tolerant regex; preserves
	//    the leading indent and trailing comma.
	dbRe := regexp.MustCompile(`(?m)^(\s*)database\s*=\s*\{['"]url['"]\s*:\s*[^}]+\}\s*,?\s*$`)
	if dbRe.MatchString(text) {
		return dbRe.ReplaceAllString(text, "${1}database={'url': "+envExpr+"},"), nil
	}

	// 3. No database kwarg — insert one immediately after `mount_path`.
	mountRe := regexp.MustCompile(`(?m)^(\s*)mount_path\s*=\s*['"][^'"]*['"]\s*,?\s*$`)
	loc := mountRe.FindStringSubmatchIndex(text)
	if loc == nil {
		return text, fmt.Errorf("could not find `mount_path=...` to anchor database insert")
	}
	indent := text[loc[2]:loc[3]]
	insertion := indent + target + "\n"
	// Insert AFTER the matched mount_path line (with its trailing newline).
	end := loc[1]
	if end < len(text) && text[end] == '\n' {
		end++
	}
	return text[:end] + insertion + text[end:], nil
}

// patchTSDatabase locates the `database: { ... }` block inside
// `defineConfig({ ... })` and either rewrites or inserts. Same
// semantics as the Python sibling.
func patchTSDatabase(text, envVar string) (string, error) {
	envExpr := fmt.Sprintf("process.env.%s!", envVar)
	if strings.Contains(text, fmt.Sprintf("url: %s", envExpr)) {
		return text, nil
	}

	// Existing `database: { ... },` block — replace the whole block.
	// Non-greedy {...} match so we don't gobble the rest of the file.
	dbRe := regexp.MustCompile(`(?ms)^(\s*)database\s*:\s*\{[^}]*\}\s*,?\s*$`)
	if dbRe.MatchString(text) {
		return dbRe.ReplaceAllString(text, "${1}database: {\n${1}  url: "+envExpr+",\n${1}},"), nil
	}

	// Insert AFTER mountPath line.
	mountRe := regexp.MustCompile(`(?m)^(\s*)mountPath\s*:\s*['"][^'"]*['"]\s*,?\s*$`)
	loc := mountRe.FindStringSubmatchIndex(text)
	if loc == nil {
		return text, fmt.Errorf("could not find `mountPath: ...` to anchor database insert")
	}
	indent := text[loc[2]:loc[3]]
	insertion := fmt.Sprintf(
		"%sdatabase: {\n%s  url: %s,\n%s},\n",
		indent, indent, envExpr, indent,
	)
	end := loc[1]
	if end < len(text) && text[end] == '\n' {
		end++
	}
	return text[:end] + insertion + text[end:], nil
}
