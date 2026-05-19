// Package wizard implements `gravel init` — the framework / auth /
// database detector and the file generators that mount the dashboard
// route, write gravel.config, populate .env.local, and install the
// pre-commit hook. Mirrors packages/sdk-ts/src/wizard/.
//
// The detector is read-only: no files are touched until the caller
// passes Detection into one of the writer functions. That separation
// makes the wizard easy to test (drive Detection from a fixture, snap
// the resulting tree) and easy to dry-run (`--print` would call
// Detect + report without writing).
package wizard

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/artanis-ai/gravel/cli/internal/detect"
	"github.com/artanis-ai/gravel/cli/internal/stack"
)

type Framework string

const (
	FrameworkNextAppRouter   Framework = "next-app-router"
	FrameworkNextPagesRouter Framework = "next-pages-router"
	FrameworkExpress         Framework = "express"
	FrameworkFastify         Framework = "fastify"
	FrameworkHono            Framework = "hono"
	FrameworkFastAPI         Framework = "fastapi"
	FrameworkDjango          Framework = "django"
	FrameworkFlask           Framework = "flask"
	FrameworkGenericNode     Framework = "generic-node"
	FrameworkGenericASGI     Framework = "generic-asgi"
	FrameworkGenericWSGI     Framework = "generic-wsgi"
)

type AuthProvider string

const (
	AuthClerk        AuthProvider = "clerk"
	AuthNextAuth     AuthProvider = "next-auth"
	AuthBetterAuth   AuthProvider = "better-auth"
	AuthLucia        AuthProvider = "lucia"
	AuthAuth0        AuthProvider = "auth0"
	AuthFastAPIUsers AuthProvider = "fastapi-users"
	AuthDjango       AuthProvider = "django-auth"
	AuthUnknown      AuthProvider = "unknown"
)

type DBDriver string

const (
	DBPostgres DBDriver = "postgres"
	DBSQLite   DBDriver = "sqlite"
	DBMySQL    DBDriver = "mysql"
	DBUnknown  DBDriver = "unknown"
)

type LLMLib string

const (
	LLMOpenAI    LLMLib = "OpenAI"
	LLMAnthropic LLMLib = "Anthropic"
	LLMGemini    LLMLib = "Gemini"
	LLMLangChain LLMLib = "LangChain"
	LLMVercelAI  LLMLib = "Vercel AI"
)

// NextAppDirLocation is where Next.js's `app/` directory lives.
//   ""        = no app router (Pages Router project, or non-Next stack)
//   "app"     = ./app/    (root convention)
//   "src/app" = ./src/app/ (src/-layout convention)
type NextAppDirLocation string

// Detection is everything `gravel init` knows about the host before
// it writes a single file. Mirrors the TS DetectionResult shape so a
// future cross-language compatibility test can diff their outputs on
// the same fixture.
type Detection struct {
	CWD                string
	Language           stack.Language
	PackageManager     stack.PackageManager
	Framework          Framework
	NextAppDir         NextAppDirLocation
	NextHasBothRouters bool
	DBDriver           DBDriver
	DBEnvVar           string
	Auth               AuthProvider
	ExistingTracers    []string
	LLMLibs            []LLMLib
	HasGit             bool
}

// Detect inspects cwd and returns a deterministic Detection. Returns
// a never-failing best-effort result; nothing here panics on missing
// files. The HasGit flag is the only "is this a real repo?" signal
// and the caller uses it to decide whether to install a pre-commit
// hook.
func Detect(cwd string) Detection {
	hostStack := detect.HostStack(cwd)
	d := Detection{
		CWD:            cwd,
		Language:       hostStack.Language,
		PackageManager: hostStack.PackageManager,
		Framework:      FrameworkGenericNode,
		Auth:           AuthUnknown,
		DBDriver:       DBUnknown,
		HasGit:         pathExists(filepath.Join(cwd, ".git")),
	}

	if hostStack.Language == stack.LanguageTS {
		fillTS(&d, cwd)
	} else {
		fillPython(&d, cwd)
	}
	return d
}

func fillTS(d *Detection, cwd string) {
	pkgPath := filepath.Join(cwd, "package.json")
	pkgBytes, err := os.ReadFile(pkgPath)
	if err != nil {
		return
	}
	var pkg struct {
		Dependencies    map[string]string `json:"dependencies"`
		DevDependencies map[string]string `json:"devDependencies"`
	}
	if err := json.Unmarshal(pkgBytes, &pkg); err != nil {
		return
	}
	deps := make(map[string]bool, len(pkg.Dependencies)+len(pkg.DevDependencies))
	for k := range pkg.Dependencies {
		deps[k] = true
	}
	for k := range pkg.DevDependencies {
		deps[k] = true
	}

	// Framework detection: Next overrides everything when present.
	if deps["next"] {
		hasAppRoot := pathExists(filepath.Join(cwd, "app"))
		hasAppSrc := pathExists(filepath.Join(cwd, "src", "app"))
		hasPagesRoot := pathExists(filepath.Join(cwd, "pages"))
		hasPagesSrc := pathExists(filepath.Join(cwd, "src", "pages"))
		switch {
		case hasAppRoot:
			d.NextAppDir = "app"
		case hasAppSrc:
			d.NextAppDir = "src/app"
		}
		if d.NextAppDir != "" {
			d.Framework = FrameworkNextAppRouter
		} else {
			d.Framework = FrameworkNextPagesRouter
		}
		d.NextHasBothRouters = d.NextAppDir != "" && (hasPagesRoot || hasPagesSrc)
	} else {
		switch {
		case deps["express"]:
			d.Framework = FrameworkExpress
		case deps["fastify"]:
			d.Framework = FrameworkFastify
		case deps["hono"]:
			d.Framework = FrameworkHono
		}
	}

	switch {
	case deps["@clerk/nextjs"], deps["@clerk/clerk-js"]:
		d.Auth = AuthClerk
	case deps["next-auth"]:
		d.Auth = AuthNextAuth
	case deps["better-auth"]:
		d.Auth = AuthBetterAuth
	case deps["lucia"]:
		d.Auth = AuthLucia
	case deps["@auth0/auth0-react"], deps["@auth0/nextjs-auth0"]:
		d.Auth = AuthAuth0
	}

	if deps["@sentry/node"] || deps["@sentry/nextjs"] {
		d.ExistingTracers = append(d.ExistingTracers, "Sentry")
	}
	if deps["langsmith"] {
		d.ExistingTracers = append(d.ExistingTracers, "LangSmith")
	}
	if deps["langfuse"] {
		d.ExistingTracers = append(d.ExistingTracers, "Langfuse")
	}

	if deps["openai"] {
		d.LLMLibs = append(d.LLMLibs, LLMOpenAI)
	}
	if deps["@anthropic-ai/sdk"] {
		d.LLMLibs = append(d.LLMLibs, LLMAnthropic)
	}
	if deps["@google/genai"] {
		d.LLMLibs = append(d.LLMLibs, LLMGemini)
	}
	if deps["@langchain/core"] || deps["@langchain/openai"] || deps["@langchain/anthropic"] || deps["langchain"] {
		d.LLMLibs = append(d.LLMLibs, LLMLangChain)
	}
	if deps["ai"] {
		d.LLMLibs = append(d.LLMLibs, LLMVercelAI)
	}

	d.DBDriver, d.DBEnvVar = readDBEnv(cwd, []string{"DATABASE_URL", "POSTGRES_URL", "NEON_DATABASE_URL"})
}

func fillPython(d *Detection, cwd string) {
	hasPyproject := pathExists(filepath.Join(cwd, "pyproject.toml"))
	hasManagePy := pathExists(filepath.Join(cwd, "manage.py"))
	hasReqs := pathExists(filepath.Join(cwd, "requirements.txt"))
	// Legacy / pre-PEP 518 projects ship a setup.py without a
	// pyproject.toml. Skipping them entirely would tell those users
	// they have a non-Python project, which is wrong.
	hasSetup := pathExists(filepath.Join(cwd, "setup.py")) || pathExists(filepath.Join(cwd, "setup.cfg"))
	if !hasPyproject && !hasManagePy && !hasReqs && !hasSetup {
		return
	}

	// Substring search across every place dependencies typically
	// surface in a Python project. Mirrors the TS reference's
	// heuristic — good enough for "fastapi" / "django" mentioned in
	// install_requires / [project.dependencies] / requirements.txt.
	text := strings.ToLower(readManyOptional(cwd, "pyproject.toml", "requirements.txt", "Pipfile", "setup.py", "setup.cfg"))

	switch {
	case hasManagePy, strings.Contains(text, "django"):
		d.Framework = FrameworkDjango
	case strings.Contains(text, "fastapi"):
		d.Framework = FrameworkFastAPI
	case strings.Contains(text, "flask"):
		d.Framework = FrameworkFlask
	default:
		d.Framework = FrameworkGenericASGI
	}

	switch {
	case strings.Contains(text, "django.contrib.auth"), hasManagePy:
		d.Auth = AuthDjango
	case strings.Contains(text, "fastapi-users"):
		d.Auth = AuthFastAPIUsers
	}

	if strings.Contains(text, "sentry-sdk") {
		d.ExistingTracers = append(d.ExistingTracers, "Sentry")
	}
	if strings.Contains(text, "langsmith") {
		d.ExistingTracers = append(d.ExistingTracers, "LangSmith")
	}
	if strings.Contains(text, "langfuse") {
		d.ExistingTracers = append(d.ExistingTracers, "Langfuse")
	}
	if wordRE("openai").MatchString(text) {
		d.LLMLibs = append(d.LLMLibs, LLMOpenAI)
	}
	if wordRE("anthropic").MatchString(text) {
		d.LLMLibs = append(d.LLMLibs, LLMAnthropic)
	}
	if strings.Contains(text, "google-genai") {
		d.LLMLibs = append(d.LLMLibs, LLMGemini)
	}
	if wordRE("langchain").MatchString(text) {
		d.LLMLibs = append(d.LLMLibs, LLMLangChain)
	}

	d.DBDriver, d.DBEnvVar = readDBEnv(cwd, []string{"DATABASE_URL", "POSTGRES_URL"})
}

// readDBEnv scans .env.local then .env for the first candidate var
// the host has set. Same precedence as Next.js + the TS wizard.
func readDBEnv(cwd string, candidates []string) (DBDriver, string) {
	for _, file := range []string{".env.local", ".env"} {
		body, err := os.ReadFile(filepath.Join(cwd, file))
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(body), "\n") {
			name, value, ok := parseEnvLine(line)
			if !ok {
				continue
			}
			for _, want := range candidates {
				if name != want {
					continue
				}
				switch {
				case strings.HasPrefix(value, "postgres"):
					return DBPostgres, name
				case strings.HasPrefix(value, "mysql"):
					return DBMySQL, name
				case strings.HasPrefix(value, "file:"),
					strings.HasSuffix(value, ".db"):
					return DBSQLite, name
				default:
					return DBUnknown, name
				}
			}
		}
	}
	return DBUnknown, ""
}

var envLineRE = regexp.MustCompile(`^\s*(\w+)\s*=\s*(.+?)\s*$`)

func parseEnvLine(line string) (string, string, bool) {
	m := envLineRE.FindStringSubmatch(line)
	if m == nil {
		return "", "", false
	}
	val := m[2]
	if len(val) >= 2 {
		first, last := val[0], val[len(val)-1]
		if (first == '"' && last == '"') || (first == '\'' && last == '\'') {
			val = val[1 : len(val)-1]
		}
	}
	return m[1], val, true
}

func readManyOptional(cwd string, files ...string) string {
	var buf strings.Builder
	for _, f := range files {
		body, err := os.ReadFile(filepath.Join(cwd, f))
		if err != nil {
			continue
		}
		buf.Write(body)
		buf.WriteByte('\n')
	}
	return buf.String()
}

func wordRE(word string) *regexp.Regexp {
	return regexp.MustCompile(`\b` + regexp.QuoteMeta(word) + `\b`)
}

// pathExists returns true if p resolves to anything. Permission
// errors are treated as "not there" so the wizard moves on rather
// than crashing on a `.git/` directory it can't traverse; if the
// missing file actually matters downstream the writer surfaces it.
func pathExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}
