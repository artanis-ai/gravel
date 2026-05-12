package wizard

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strconv"

	"github.com/artanis-ai/gravel/cli/internal/stack"
)

// GuessDevPort returns a best-effort port number the user's app will
// run on, so the wizard can print a real http://localhost:PORT URL
// when it tells the user to open the dashboard.
//
// Order of precedence:
//   1. Scan package.json scripts.dev / .start / .serve for an explicit
//      port flag (--port, -p, or PORT= env-var prefix).
//   2. Framework default (Next.js / Express / Hono / FastAPI / etc.).
//   3. Return 0 when we can't be confident — caller drops the port
//      from the URL and tells the user "on whatever host:port your
//      app uses" instead of inventing one.
//
// Mirrors packages/sdk-ts/src/wizard/index.ts§guessDevPort.
func GuessDevPort(cwd string, d Detection) int {
	if port := scanScriptsForPort(cwd, d.Language); port > 0 {
		return port
	}
	return frameworkDefaultPort(d.Framework)
}

func scanScriptsForPort(cwd string, lang stack.Language) int {
	if lang != stack.LanguageTS {
		return 0
	}
	body, err := os.ReadFile(filepath.Join(cwd, "package.json"))
	if err != nil {
		return 0
	}
	var pkg struct {
		Scripts map[string]string `json:"scripts"`
	}
	if err := json.Unmarshal(body, &pkg); err != nil {
		return 0
	}
	for _, name := range []string{"dev", "start", "serve"} {
		script, ok := pkg.Scripts[name]
		if !ok || script == "" {
			continue
		}
		if port := extractPortFlag(script); port > 0 {
			return port
		}
	}
	return 0
}

var (
	portEnvRE  = regexp.MustCompile(`\bPORT=(\d+)`)
	portLongRE = regexp.MustCompile(`--port[=\s]+(\d+)`)
	portShortRE = regexp.MustCompile(`(?:^|\s)-p\s+(\d+)`)
)

// extractPortFlag pulls a port out of a script string like:
//   "next dev -p 4000"          → 4000
//   "next dev --port 4000"      → 4000
//   "PORT=4000 next dev"        → 4000
//   "vite --port=4000"          → 4000
//   "next dev"                  → 0  (no explicit flag)
func extractPortFlag(script string) int {
	for _, re := range []*regexp.Regexp{portEnvRE, portLongRE, portShortRE} {
		if m := re.FindStringSubmatch(script); m != nil {
			if n, err := strconv.Atoi(m[1]); err == nil {
				return n
			}
		}
	}
	return 0
}

func frameworkDefaultPort(f Framework) int {
	switch f {
	case FrameworkNextAppRouter, FrameworkNextPagesRouter,
		FrameworkExpress, FrameworkFastify, FrameworkHono:
		return 3000
	case FrameworkFastAPI, FrameworkDjango:
		return 8000
	case FrameworkFlask:
		return 5000
	}
	return 0
}
