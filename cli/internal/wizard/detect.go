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
	// Gemini-via-Vertex / Gemini-Enterprise: the `google-genai` SDK
	// supports three routing modes. Detection inspects env files
	// (GOOGLE_GENAI_USE_VERTEXAI / GOOGLE_GENAI_USE_ENTERPRISE) and
	// source-code grep (`vertexai=True` / `vertexai: true`); when a
	// signal fires, the base `LLMGemini` entry is upgraded so the
	// wizard prints "Detected: Gemini (Vertex AI)" — and so the auth
	// signpost recommends ADC instead of GEMINI_API_KEY.
	// `metadata.routing` from the tracer surfaces the same info per
	// trace in the dashboard.
	LLMGeminiVertex     LLMLib = "Gemini (Vertex AI)"
	LLMGeminiEnterprise LLMLib = "Gemini (Enterprise)"
	LLMGeminiVertexExpress LLMLib = "Gemini (Vertex AI Express Mode)"
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
	// Polyglot signals: populated on a Python-primary detection when
	// the repo ALSO has a package.json (hybrid Next.js + FastAPI is
	// the canonical shape — Claude's de_platform install, 2026-05-20).
	// The host-wiring planner consults these alongside the primary
	// fields so the dashboard gets the Next.config / Clerk
	// publicRoutes / vercel.json patches even though the install
	// targets the Python side.
	PolyglotNextFramework Framework
	PolyglotAuth          AuthProvider
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
		// Polyglot scan (v0.9.1): hybrid Next.js + FastAPI repos
		// detect as Python-primary, which would skip the
		// next.config / Clerk / Vercel patches the mount pillar
		// emits. Claude's de_platform install hit this — dashboard
		// worked locally via FastAPI direct, broke on the Vercel
		// deploy. fillPolyglotTSSignals re-runs the package.json
		// scan to pick up TS-stack signals (Next.js framework
		// markers, Clerk auth, Vercel AI SDK, etc.) WITHOUT
		// changing the primary language.
		if pathExists(filepath.Join(cwd, "package.json")) {
			fillPolyglotTSSignals(&d, cwd)
		}
		// Auth-field reconciliation: a Python-primary repo with Clerk
		// wired on the TS side (e.g. @clerk/nextjs in package.json) is
		// authenticated via Clerk in practice — `Auth: unknown` would
		// be misleading. If the polyglot scan found a concrete auth
		// provider and the primary scan left Auth at Unknown, promote
		// it. Mount pillar's host-wiring already consults both fields
		// (so the Clerk middleware patch fired correctly pre-v0.10.0);
		// this is purely about what the agent narrates to the user.
		// Olly's 2026-05-21 install saw "Auth: unknown" despite Clerk
		// being present; this fixes the report.
		if d.Auth == AuthUnknown && d.PolyglotAuth != AuthUnknown {
			d.Auth = d.PolyglotAuth
		}
	}
	return d
}

// fillPolyglotTSSignals augments a Python-primary Detection with
// TS-side signals from package.json. Used when the repo has both a
// pyproject.toml AND a package.json (hybrid Next.js + FastAPI is the
// canonical shape). Sets only fields the Python scan didn't populate;
// never overrides primary-language values.
//
// What it can set:
//   - PolyglotNextFramework + NextAppDir + NextHasBothRouters
//   - PolyglotAuth (Clerk / NextAuth / etc.)
//   - LLMLibs (merges TS-side libs like @anthropic-ai/sdk when the
//     Python scan didn't find them via pyproject.toml)
//
// What it deliberately leaves alone:
//   - Language (stays python — primary stack the install targets)
//   - Framework (stays fastapi/django/etc.)
//   - PackageManager (the install runs against the Python pm; TS-side
//     gets its own commands via PolyglotPMs)
func fillPolyglotTSSignals(d *Detection, cwd string) {
	pkgBytes, err := os.ReadFile(filepath.Join(cwd, "package.json"))
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

	// Next.js framework markers — sets PolyglotNextFramework + NextAppDir
	// so the host-wiring planner can detect the Next presence
	// regardless of d.Framework being fastapi.
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
			d.PolyglotNextFramework = FrameworkNextAppRouter
		} else {
			d.PolyglotNextFramework = FrameworkNextPagesRouter
		}
		d.NextHasBothRouters = d.NextAppDir != "" && (hasPagesRoot || hasPagesSrc)
	}

	// Auth — only set Polyglot variant; primary Auth stays as the
	// Python detection set it. If both detect auth, the planner will
	// patch both surfaces (e.g. publicRoutes in Clerk middleware AND
	// degrade the password to optional in gravel_config.py).
	switch {
	case deps["@clerk/nextjs"], deps["@clerk/clerk-js"]:
		d.PolyglotAuth = AuthClerk
	case deps["next-auth"]:
		d.PolyglotAuth = AuthNextAuth
	}
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
	upgradeGeminiRouting(d, cwd)
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
	upgradeGeminiRouting(d, cwd)
}

// upgradeGeminiRouting rewrites the base `LLMGemini` entry to one of
// `LLMGeminiVertex` / `LLMGeminiEnterprise` / `LLMGeminiVertexExpress`
// when the project carries routing signals. Called from both fillTS
// and fillPython after base LLM detection has populated `d.LLMLibs`.
//
// Signal priority (highest first):
//
//  1. `.env*` declares GOOGLE_GENAI_USE_ENTERPRISE=true — explicit
//     enterprise routing.
//  2. `.env*` declares GOOGLE_GENAI_USE_VERTEXAI=true. If a Gemini
//     API key is ALSO declared (GEMINI_API_KEY / GOOGLE_API_KEY) AND
//     GOOGLE_CLOUD_PROJECT is set, the user is on Express Mode — surface
//     that specifically. Otherwise standard Vertex (ADC / service acct).
//  3. Source-code grep for `vertexai=True` (Python) / `vertexai: true`
//     (TS) in any `.py` / `.ts` / `.tsx` / `.mjs` file under cwd.
//
// If no signal fires, leaves `LLMGemini` in place.
//
// Why upgrade rather than append: keeping a single Gemini entry in the
// summary line ("Detected: Gemini (Vertex AI)") is less noisy than
// listing both. The dashboard's per-trace routing pill carries the
// finer detail.
func upgradeGeminiRouting(d *Detection, cwd string) {
	// Quick pre-check: only do the work if base Gemini was detected.
	idx := -1
	for i, lib := range d.LLMLibs {
		if lib == LLMGemini {
			idx = i
			break
		}
	}
	if idx < 0 {
		return
	}

	envVals := readEnvKeys(cwd, "GOOGLE_GENAI_USE_VERTEXAI", "GOOGLE_GENAI_USE_ENTERPRISE",
		"GOOGLE_CLOUD_PROJECT", "GEMINI_API_KEY", "GOOGLE_API_KEY")
	isTrue := func(v string) bool {
		v = strings.ToLower(strings.TrimSpace(v))
		return v == "true" || v == "1" || v == "yes"
	}

	upgrade := LLMLib("")
	switch {
	case isTrue(envVals["GOOGLE_GENAI_USE_ENTERPRISE"]):
		upgrade = LLMGeminiEnterprise
	case isTrue(envVals["GOOGLE_GENAI_USE_VERTEXAI"]):
		// Express Mode: Vertex AI but with an API key, not Google Cloud
		// auth. Recognised by an api-key env var alongside the Vertex flag.
		// The auth signpost differs (no `gcloud auth application-default
		// login` required for Express).
		hasAPIKey := envVals["GEMINI_API_KEY"] != "" || envVals["GOOGLE_API_KEY"] != ""
		hasProject := envVals["GOOGLE_CLOUD_PROJECT"] != ""
		if hasAPIKey && hasProject {
			upgrade = LLMGeminiVertexExpress
		} else {
			upgrade = LLMGeminiVertex
		}
	default:
		// Source-code grep fallback. Cheap walk over the user's own
		// .py / .ts / .tsx / .mjs files (skips node_modules / .venv etc).
		if greppedVertexaiTrue(cwd) {
			upgrade = LLMGeminiVertex
		}
	}

	if upgrade != "" {
		d.LLMLibs[idx] = upgrade
	}
}

// readEnvKeys reads .env.local then .env and returns a map containing
// only the keys the caller named. Last write wins on duplicates across
// files (i.e. .env overrides .env.local — matches readDBEnv's order
// where .env.local is read first and "wins" because it returns early).
// We don't return early here because we may need multiple keys from
// different files; the merged view is good enough for our routing
// decision.
func readEnvKeys(cwd string, names ...string) map[string]string {
	out := make(map[string]string, len(names))
	wanted := make(map[string]struct{}, len(names))
	for _, n := range names {
		wanted[n] = struct{}{}
	}
	// .env first, then .env.local so the latter wins (Next.js precedence).
	for _, file := range []string{".env", ".env.local"} {
		body, err := os.ReadFile(filepath.Join(cwd, file))
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(body), "\n") {
			name, value, ok := parseEnvLine(line)
			if !ok {
				continue
			}
			if _, want := wanted[name]; want {
				out[name] = value
			}
		}
	}
	return out
}

var vertexaiSourceRE = regexp.MustCompile(`vertexai\s*[:=]\s*[Tt]rue`)

// greppedVertexaiTrue walks the project (skipping node_modules / .venv /
// .git / dist / build) looking for `vertexai=True` (Python) or
// `vertexai: true` (TS) literals. Best-effort; returns true on first
// match. Bounded by file count + extension filter so it stays cheap.
func greppedVertexaiTrue(cwd string) bool {
	const maxFiles = 200
	count := 0
	found := false
	skipDirs := map[string]struct{}{
		"node_modules": {}, ".venv": {}, "venv": {}, ".git": {},
		"dist": {}, "build": {}, "__pycache__": {}, ".next": {},
	}
	_ = filepath.WalkDir(cwd, func(path string, dee os.DirEntry, err error) error {
		if err != nil || found || count >= maxFiles {
			return filepath.SkipAll
		}
		if dee.IsDir() {
			if _, skip := skipDirs[dee.Name()]; skip {
				return filepath.SkipDir
			}
			return nil
		}
		ext := filepath.Ext(dee.Name())
		switch ext {
		case ".py", ".ts", ".tsx", ".mjs", ".js":
		default:
			return nil
		}
		count++
		body, err := os.ReadFile(path)
		if err != nil {
			return nil
		}
		if vertexaiSourceRE.Match(body) {
			found = true
		}
		return nil
	})
	return found
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
