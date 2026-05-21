package wizard

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/artanis-ai/gravel/cli/internal/stack"
)

// sdk_install.go: detect whether the user's project already lists the
// gravel SDK as a dependency and, if not, invoke the project's package
// manager to add it. Makes `npx @artanis-ai/gravel init` and
// `uvx artanis-gravel init` work as true one-liners — the wizard's
// own bin runs first, the SDK lands in the user's deps via this code,
// and the gravel.config.ts that gets written can import it.
//
// All package-manager invocations run with `stdio: 'inherit'`-style
// behaviour so the user sees pnpm/uv's own progress output. Failures
// are surfaced as warnings, not hard errors — the rest of the wizard
// has already produced a working set of files, and a registry hiccup
// shouldn't force the user to start over.

// SDKInstallKind discriminates the four outcomes the cobra layer
// renders in its summary line.
type SDKInstallKind string

const (
	// SDKAlreadyPresent: the SDK package was already in deps; we
	// didn't touch anything.
	SDKAlreadyPresent SDKInstallKind = "already-present"
	// SDKAdded: we ran the package manager and it returned success.
	SDKAdded SDKInstallKind = "added"
	// SDKSkippedNoManifest: there's no package.json / pyproject.toml,
	// so we have nowhere to record the dep. Tell the user to run the
	// add command themselves.
	SDKSkippedNoManifest SDKInstallKind = "skipped-no-manifest"
	// SDKFailed: package manager exited non-zero. We surface the
	// stderr so the user can see why.
	SDKFailed SDKInstallKind = "failed"
)

// SDKInstallResult describes what EnsureSDKInstalled actually did, so
// the cobra layer can print the right summary line.
type SDKInstallResult struct {
	Kind    SDKInstallKind
	Package string // "@artanis-ai/gravel" or "artanis-gravel"
	Command string // The exact command we ran (or would have run for skipped/failed). For user copy-paste.
	Stderr  string // Populated when Kind == SDKFailed.
}

// gravelPackageName picks the right registry name based on host language.
func gravelPackageName(lang stack.Language) string {
	if lang == stack.LanguagePython {
		return "artanis-gravel"
	}
	return "@artanis-ai/gravel"
}

// minSDKVersion is the minimum SDK release the wizard's generated
// configs are compatible with. Bumped together with the SDK whenever
// the wizard relies on a fix that lives only in a new version (e.g.
// the dashboard SPA bundled into the wheel, the no-DB stub URL path).
// Without this pin, customers running `gravel init` against an old
// PyPI version get a broken install with no useful error.
//
// Update in lockstep with python/gravel/pyproject.toml `version`.
const minSDKVersion = "0.9.6"

// gravelInstallSpec returns the dependency spec we hand to the
// package manager. For Python we pin `>=minSDKVersion` so `uv add`
// refuses to install a too-old SDK (which would crash at server
// startup). The TS package isn't currently version-pinned because
// the JS SDK hasn't shipped any wizard-breaking bumps yet; revisit
// when it does.
//
// For Flask we request the `[flask]` extra so the asgiref bridge
// (needed by artanis_gravel.flask.mount_on_flask) lands at install
// time. Without the extra, the customer would hit a clear-but-
// unnecessary ImportError on first server boot.
func gravelInstallSpec(d Detection) string {
	name := gravelPackageName(d.Language)
	if d.Language != stack.LanguagePython {
		return name
	}
	if d.Framework == FrameworkFlask {
		return name + "[flask]>=" + minSDKVersion
	}
	return name + ">=" + minSDKVersion
}

// EnsureSDKInstalled adds the gravel SDK to the user's project deps if
// it's not already there. Idempotent: a second call on a project that
// already has the SDK is a no-op.
//
// The decision tree:
//   1. Look for the manifest file (package.json / pyproject.toml). If
//      missing, return SDKSkippedNoManifest with the command we'd have
//      run — the user is invoking the wizard from a directory that
//      doesn't look like a project, and we'd rather fail safe than
//      silently `pnpm init` a new project.
//   2. Parse the manifest and check whether the gravel package is
//      already declared. If yes, SDKAlreadyPresent.
//   3. Otherwise, run the package-manager command, capture stderr,
//      return SDKAdded or SDKFailed.
func EnsureSDKInstalled(ctx context.Context, d Detection) SDKInstallResult {
	pkg := gravelPackageName(d.Language)
	spec := gravelInstallSpec(d)
	command := buildAddCommand(d.PackageManager, spec)
	result := SDKInstallResult{Package: pkg, Command: strings.Join(command, " ")}

	manifestPath := manifestPathFor(d)
	if !pathExists(manifestPath) {
		result.Kind = SDKSkippedNoManifest
		return result
	}

	present, err := alreadyDeclares(manifestPath, pkg, d.Language)
	if err == nil && present {
		result.Kind = SDKAlreadyPresent
		return result
	}
	// `err != nil` here means we couldn't parse the manifest. Be
	// conservative: try to install anyway. pnpm/uv will refuse if the
	// manifest is malformed, which is the right error path.

	cmd := exec.CommandContext(ctx, command[0], command[1:]...)
	cmd.Dir = d.CWD
	// Inherit stdout so the user sees pnpm/uv's normal progress. Capture
	// stderr separately so we can surface it on failure without
	// double-printing on success (uv/pnpm write nothing to stderr on
	// success in most cases).
	cmd.Stdout = os.Stderr // wizard summary is on stderr, keep pm noise there too
	var stderrBuf strings.Builder
	cmd.Stderr = &stderrBuf
	if err := cmd.Run(); err != nil {
		result.Kind = SDKFailed
		result.Stderr = stderrBuf.String()
		return result
	}
	result.Kind = SDKAdded
	return result
}

func manifestPathFor(d Detection) string {
	if d.Language == stack.LanguagePython {
		return filepath.Join(d.CWD, "pyproject.toml")
	}
	return filepath.Join(d.CWD, "package.json")
}

// buildAddCommand maps (PackageManager, packageName) to the argv that
// installs the package as a runtime dep. The wizard never needs to
// scope-pin a version; the wrapper that's currently running was
// installed from npm/PyPI, so the SDK from the same registry at the
// matching version is the natural target.
func buildAddCommand(pm stack.PackageManager, pkg string) []string {
	switch pm {
	case stack.PackageManagerPNPM:
		return []string{"pnpm", "add", pkg}
	case stack.PackageManagerYarn:
		return []string{"yarn", "add", pkg}
	case stack.PackageManagerBun:
		return []string{"bun", "add", pkg}
	case stack.PackageManagerNPM:
		return []string{"npm", "install", pkg}
	case stack.PackageManagerUV:
		return []string{"uv", "add", pkg}
	case stack.PackageManagerPoetry:
		return []string{"poetry", "add", pkg}
	case stack.PackageManagerPipenv:
		return []string{"pipenv", "install", pkg}
	case stack.PackageManagerPip:
		return []string{"pip", "install", pkg}
	}
	// Unknown manager: default to the JS-side pnpm. The user can read
	// the surfaced command and re-run with the right tool.
	return []string{"pnpm", "add", pkg}
}

// alreadyDeclares parses the manifest and tells the caller whether
// the gravel package is already a dependency. We deliberately do a
// shallow check (does the package name appear as a key in the
// dependencies / devDependencies block?) so we don't have to
// implement TOML parsing for pyproject.toml — a substring match on
// the right key suffices for the common shapes.
// EnsureDepResult mirrors SDKInstallResult but for an arbitrary
// package the wizard needs to add (e.g. psycopg2-binary when the
// traces pillar detects Python + postgres). Same kind enum.
type EnsureDepResult struct {
	Package string
	Kind    SDKInstallKind
	Command string
	Stderr  string
}

// EnsureDepInstalled is the generic sibling of EnsureSDKInstalled.
// Adds `pkg` via the project's package manager unless it's already
// declared. Used by the traces pillar for psycopg2-binary on
// hybrid Python+postgres stacks (Olly's #10 from the v0.6.2
// dogfooding; bites again every time someone's frontend ORM in
// Next.js sets DATABASE_URL but the Python side never grew a
// driver).
func EnsureDepInstalled(ctx context.Context, d Detection, pkg string) EnsureDepResult {
	command := buildAddCommand(d.PackageManager, pkg)
	result := EnsureDepResult{Package: pkg, Command: strings.Join(command, " ")}

	manifestPath := manifestPathFor(d)
	if !pathExists(manifestPath) {
		result.Kind = SDKSkippedNoManifest
		return result
	}
	present, _ := alreadyDeclares(manifestPath, pkg, d.Language)
	if present {
		result.Kind = SDKAlreadyPresent
		return result
	}
	cmd := exec.CommandContext(ctx, command[0], command[1:]...)
	cmd.Dir = d.CWD
	cmd.Stdout = os.Stderr
	var stderrBuf strings.Builder
	cmd.Stderr = &stderrBuf
	if err := cmd.Run(); err != nil {
		result.Kind = SDKFailed
		result.Stderr = stderrBuf.String()
		return result
	}
	result.Kind = SDKAdded
	return result
}

// NeedsPsycopg2 returns true when the host stack is Python with a
// postgres DATABASE_URL but pyproject.toml doesn't yet declare
// either psycopg2 or psycopg2-binary. Pre-flight check used by
// PlanTraces so the action plan + agent narration mention the
// driver before --apply touches the install.
func NeedsPsycopg2(d Detection) bool {
	if d.Language != stack.LanguagePython {
		return false
	}
	if d.DBDriver != DBPostgres {
		return false
	}
	manifestPath := manifestPathFor(d)
	if !pathExists(manifestPath) {
		// No pyproject.toml — we'd skip the install entirely; nothing
		// to announce. The traces pillar will surface the missing
		// manifest separately.
		return false
	}
	// Either psycopg2 OR psycopg2-binary satisfies SQLAlchemy's
	// driver lookup; treat both as "already wired".
	for _, candidate := range []string{"psycopg2-binary", "psycopg2"} {
		if present, _ := alreadyDeclares(manifestPath, candidate, d.Language); present {
			return false
		}
	}
	return true
}

func alreadyDeclares(manifestPath, pkg string, lang stack.Language) (bool, error) {
	body, err := os.ReadFile(manifestPath)
	if err != nil {
		return false, err
	}
	if lang == stack.LanguagePython {
		// pyproject.toml is TOML; rather than depend on a full parser
		// we regex-match the three common shapes:
		//   PEP 621 list:    "artanis-gravel" or "artanis-gravel>=0.4.0"
		//   Poetry table:    artanis-gravel = "^0.4.0"
		//   uv sources etc.: artanis-gravel = { workspace = true }
		// The regex below catches all of these: the package name
		// followed by either a closing quote, a version specifier
		// (>=, <=, ~=, ==, ^, !=, ===, [extras]), a TOML `=`, or
		// whitespace/end-of-line. Anchored by either a `"` / `'`
		// (list form) or line-start with optional whitespace (table
		// form), so we don't match `not-artanis-gravel` etc.
		needle := regexp.QuoteMeta(pkg)
		boundary := `(?:["'\s\]=<>!~^,;]|$|>=|<=|~=|==)`
		re := regexp.MustCompile(`(?m)(?:["']|^\s*)` + needle + boundary)
		return re.FindIndex(body) != nil, nil
	}
	// package.json: real JSON, real keys. Parse + check both
	// dependencies and devDependencies maps.
	var manifest struct {
		Dependencies    map[string]any `json:"dependencies"`
		DevDependencies map[string]any `json:"devDependencies"`
	}
	if err := json.Unmarshal(body, &manifest); err != nil {
		return false, fmt.Errorf("parse %s: %w", filepath.Base(manifestPath), err)
	}
	if _, ok := manifest.Dependencies[pkg]; ok {
		return true, nil
	}
	if _, ok := manifest.DevDependencies[pkg]; ok {
		return true, nil
	}
	return false, nil
}

