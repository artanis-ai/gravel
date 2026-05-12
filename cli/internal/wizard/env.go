package wizard

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
)

// EnsureAdminPassword reads `.env.local` and adds `GRAVEL_ADMIN_PASSWORD=...`
// if missing. Returns the password (existing or newly generated) so
// the cobra layer can print it on first install.
//
// Idempotent: re-running keeps the same password value. The wizard
// runs this once per `gravel init` invocation; rotating the password
// is the user's job (delete the env line and re-run).
//
// Targets `.env.local` rather than `.env` because:
//   - Next.js loads .env.local last, so it always wins for local dev.
//   - .env.local is gitignored by every framework template we
//     support — secrets shouldn't end up in commits.
func EnsureAdminPassword(cwd string) (password string, wasNew bool, err error) {
	path := filepath.Join(cwd, ".env.local")
	body, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return "", false, err
	}
	current := string(body)
	if v := extractEnvValue(current, "GRAVEL_ADMIN_PASSWORD"); v != "" {
		return v, false, nil
	}
	pw, err := generatePassword()
	if err != nil {
		return "", false, err
	}
	// Append rather than rewrite to preserve other env entries +
	// formatting. Add a leading newline if the file didn't end with one.
	if current != "" && current[len(current)-1] != '\n' {
		current += "\n"
	}
	current += fmt.Sprintf("GRAVEL_ADMIN_PASSWORD=%s\n", pw)
	if err := os.WriteFile(path, []byte(current), 0o600); err != nil {
		return "", false, err
	}
	return pw, true, nil
}

// extractEnvValue finds VAR=value (unquoted or quoted) for the given
// key in the body, returning the empty string if absent OR if the
// line sets the key to an empty value (`KEY=` on its own).
//
// Important: the trailing-whitespace match uses [\t ]* rather than
// \s* so the regex can't bridge across a newline. A naive `\s*$`
// would let `KEY=\nOTHER=value` "match" by consuming the LF and
// capturing `OTHER=value` as the value of KEY.
func extractEnvValue(body, key string) string {
	re := regexp.MustCompile(`(?m)^[\t ]*` + regexp.QuoteMeta(key) + `[\t ]*=[\t ]*([^\n]*?)[\t ]*$`)
	m := re.FindStringSubmatch(body)
	if m == nil {
		return ""
	}
	val := m[1]
	if len(val) >= 2 {
		first, last := val[0], val[len(val)-1]
		if (first == '"' && last == '"') || (first == '\'' && last == '\'') {
			val = val[1 : len(val)-1]
		}
	}
	return val
}

// generatePassword returns 24 base64-url characters of crypto/rand
// entropy: ~144 bits. Long enough to never need to guard against
// brute-force on the default-password admin endpoint, short enough to
// paste into a terminal without word wrap.
func generatePassword() (string, error) {
	var buf [18]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf[:]), nil
}

// upsertEnvVar sets `key=value` in `.env.local`, preserving the
// rest of the file. If `key` already exists with a non-empty value,
// it's left alone (re-running the wizard doesn't clobber post-init
// edits). Empty existing values are overwritten.
func upsertEnvVar(cwd, key, value string) error {
	path := filepath.Join(cwd, ".env.local")
	body, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	current := string(body)
	if existing := extractEnvValue(current, key); existing != "" {
		return nil
	}
	// Drop any existing empty entry (`KEY=` line) before appending.
	re := regexp.MustCompile(`(?m)^\s*` + regexp.QuoteMeta(key) + `\s*=\s*$\n?`)
	current = re.ReplaceAllString(current, "")
	if current != "" && current[len(current)-1] != '\n' {
		current += "\n"
	}
	current += key + "=" + value + "\n"
	return os.WriteFile(path, []byte(current), 0o600)
}
