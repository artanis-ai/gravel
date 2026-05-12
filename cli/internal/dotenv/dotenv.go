// Package dotenv loads variables from .env / .env.local / .env.<environment>
// files in the same order Next.js uses, so the binary picks up the same
// DATABASE_URL the host app reads at runtime.
//
// Subset of the dotenv format we support:
//   KEY=value
//   KEY="value with spaces"
//   KEY='single quoted'
//   # comment lines + blank lines ignored
//
// We deliberately do NOT support expansion (`${VAR}`), command
// substitution, or multi-line values; the wizard never writes those.
// Anything more exotic, users can set their actual shell env (which
// always wins).
package dotenv

import (
	"bufio"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// LoadCwd reads .env / .env.local / .env.production from cwd and
// returns a flat map. Later files win, mirroring Next.js precedence.
// Shell-set variables override everything (we read os.Getenv for each
// key after merging).
func LoadCwd(cwd string) map[string]string {
	files := []string{".env", ".env.local"}
	if env := os.Getenv("NODE_ENV"); env != "" {
		files = append(files, ".env."+env, ".env."+env+".local")
	}
	merged := make(map[string]string)
	for _, name := range files {
		path := filepath.Join(cwd, name)
		body, err := os.ReadFile(path)
		if err != nil {
			// Missing files are normal; only surface real errors.
			if errors.Is(err, fs.ErrNotExist) {
				continue
			}
			// Permission error / corrupt file: skip silently. The
			// caller will see "no DATABASE_URL" and complain clearly.
			continue
		}
		for k, v := range parse(string(body)) {
			merged[k] = v
		}
	}
	// Shell env overrides files (matches Next.js + dotenv semantics).
	for k := range merged {
		if v, ok := os.LookupEnv(k); ok {
			merged[k] = v
		}
	}
	return merged
}

// parse walks a .env body and returns the K=V pairs it can extract.
// Unsupported syntax (multi-line, expansion) is silently ignored
// rather than failing the whole load.
func parse(body string) map[string]string {
	out := make(map[string]string)
	sc := bufio.NewScanner(strings.NewReader(body))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		// `export FOO=bar` is common; strip the prefix.
		line = strings.TrimPrefix(line, "export ")
		eq := strings.IndexByte(line, '=')
		if eq < 0 {
			continue
		}
		key := strings.TrimSpace(line[:eq])
		val := strings.TrimSpace(line[eq+1:])
		// Strip surrounding quotes (single or double).
		if len(val) >= 2 {
			first, last := val[0], val[len(val)-1]
			if (first == '"' && last == '"') || (first == '\'' && last == '\'') {
				val = val[1 : len(val)-1]
			}
		}
		// Strip inline `# comment` on unquoted values only.
		if !strings.HasPrefix(strings.TrimSpace(line[eq+1:]), `"`) &&
			!strings.HasPrefix(strings.TrimSpace(line[eq+1:]), `'`) {
			if hash := strings.IndexByte(val, '#'); hash >= 0 {
				val = strings.TrimSpace(val[:hash])
			}
		}
		out[key] = val
	}
	return out
}
