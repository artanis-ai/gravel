// Package doctor implements `gravel doctor`: CLI version check +
// the canonical install/upgrade command.
//
// The binary is distributed as a single GitHub Release asset, fetched
// by install.sh. There is no per-package-manager upgrade story for the
// CLI itself (decoupled from the SDK packages on purpose; see
// cli/DESIGN.md). So this command reports:
//
//   1. the running CLI version,
//   2. the latest release on GitHub,
//   3. the host stack (informational only),
//   4. the `curl | sh` line to install/upgrade.
//
// The SDK packages have their own upgrade journey, surfaced by the
// dashboard's UpdateBanner (which reads the SDK version from the
// host's lockfile). The two are intentionally separated so a stale
// SDK pin and a stale CLI binary are diagnosed independently.
package doctor

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/artanis-ai/gravel/cli/internal/stack"
)

const (
	// releaseAPI is the GitHub Releases endpoint we consult for the
	// latest tag. Public, unauthenticated; rate-limit is 60 req/hr per
	// IP, plenty for `gravel doctor` invocations.
	releaseAPI = "https://api.github.com/repos/artanis-ai/gravel/releases/latest"

	// installURL is the canonical install command users see in the
	// doctor output. Single source of truth, kept in lockstep with
	// install.sh's location in the repo.
	installURL = "https://raw.githubusercontent.com/artanis-ai/gravel/main/install.sh"

	fetchTimeout = 5 * time.Second
	disabledEnv  = "GRAVEL_VERSION_CHECK_DISABLED"
)

// VersionInfo is the wire shape returned by `gravel doctor --json`.
//
// Stable across releases. The dashboard's UpdateBanner reads the SDK
// version separately from package.json / pyproject.toml; it does NOT
// consume this struct. So we keep the shape CLI-focused.
//
// JSON tags use camelCase for consistency with other Gravel JSON APIs.
//
// `installHint` is the package-manager-specific upgrade command, e.g.
// `uv add 'artanis-gravel>=0.9.0' --upgrade` for uv or `pnpm add
// @artanis-ai/gravel@latest` for pnpm. Falls back to the `curl | sh`
// binary install when the host stack is unrecognised. Step 0 in
// llms.txt instructs the installing agent to run this exact string
// after asking the user.
type VersionInfo struct {
	Current        string               `json:"current"`
	Latest         *string              `json:"latest"`
	HasUpdate      bool                 `json:"hasUpdate"`
	Language       stack.Language       `json:"language"`
	PackageManager stack.PackageManager `json:"packageManager"`
	InstallHint    string               `json:"installHint"`
	// SDK reports the version of the SDK package (`artanis-gravel` /
	// `@artanis-ai/gravel`) actually resolved into the user's
	// project, as opposed to `Current` which is the version of the
	// running CLI binary. They can legitimately diverge for any repo
	// with frozen lockfiles, `[tool.uv] exclude-newer`, or pinned
	// constraints. The dashboard's UpdateBanner catches the SDK skew
	// post-install, but install-TIME catching is doctor's job.
	// Pre-v0.10.3 doctor only knew about the binary; Yousef's
	// de-platform install (2026-05-21) hit `current=0.10.1,
	// hasUpdate=false` while the SDK had silently resolved to 0.6.0
	// because of an exclude-newer="7 days" window. Omitted from JSON
	// (`omitempty`) when we couldn't read the SDK from the project.
	SDK *SDKVersionInfo `json:"sdk,omitempty"`
}

// SDKVersionInfo carries the SDK-side current/latest/hasUpdate split
// so JSON consumers can render skew without re-deriving it.
type SDKVersionInfo struct {
	Current   string  `json:"current"`
	Latest    *string `json:"latest"`
	HasUpdate bool    `json:"hasUpdate"`
	// Source records where we read the SDK version from, so the
	// agent can surface the remediation when reporting skew. One of:
	// "uv.lock", "site-packages", "node_modules", "package.json",
	// "pyproject.toml".
	Source string `json:"source"`
}

// Fetcher abstracts the registry HTTP call so tests can drive the
// render layer with synthetic responses instead of hitting the network.
type Fetcher func(ctx context.Context) (string, error)

// FetchLatest is the production Fetcher. Returns ("", nil) when:
//   - GRAVEL_VERSION_CHECK_DISABLED=1
//   - the GitHub API returns non-2xx
//   - the network call errors out (timeout, DNS, etc.)
//
// We never propagate fetch errors to the caller. Doctor's job is
// "tell the user what we know"; "we don't know" is a valid answer.
func FetchLatest(ctx context.Context) (string, error) {
	if os.Getenv(disabledEnv) == "1" {
		return "", nil
	}
	ctx, cancel := context.WithTimeout(ctx, fetchTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "GET", releaseAPI, nil)
	if err != nil {
		return "", nil
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", nil
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", nil
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return "", nil
	}
	return parseLatestTag(body), nil
}

// parseLatestTag extracts `tag_name` from the GitHub release payload.
// We deliberately don't pull in a full GH API client; one field, one
// JSON unmarshal.
func parseLatestTag(body []byte) string {
	var rel struct {
		TagName string `json:"tag_name"`
	}
	if err := json.Unmarshal(body, &rel); err != nil {
		return ""
	}
	return rel.TagName
}

// IsNewer reports whether b is strictly newer than a using a tolerant
// semver compare: leading 'v' is stripped, prerelease / build metadata
// is dropped, missing tail components are treated as zero. Falls back
// to string compare if either side contains non-numeric parts.
func IsNewer(a, b string) bool {
	pa, okA := parseSemver(a)
	pb, okB := parseSemver(b)
	if !okA || !okB {
		return b > a
	}
	for i := 0; i < maxInt(len(pa), len(pb)); i++ {
		x, y := 0, 0
		if i < len(pa) {
			x = pa[i]
		}
		if i < len(pb) {
			y = pb[i]
		}
		if y > x {
			return true
		}
		if y < x {
			return false
		}
	}
	return false
}

func parseSemver(v string) ([]int, bool) {
	v = strings.TrimPrefix(v, "v")
	for i, c := range v {
		if c == '-' || c == '+' {
			v = v[:i]
			break
		}
	}
	parts := strings.Split(v, ".")
	out := make([]int, 0, len(parts))
	for _, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil {
			return nil, false
		}
		out = append(out, n)
	}
	return out, true
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

// GetVersionInfo composes the running version + the latest release tag
// + the detected host stack into the wire shape. `cwd` is the project
// root used to read the resolved SDK version; pass "" to skip the SDK
// probe (tests, agents that only care about the CLI).
func GetVersionInfo(ctx context.Context, s stack.Stack, current string, fetch Fetcher) VersionInfo {
	return GetVersionInfoFromCwd(ctx, s, current, "", fetch)
}

// GetVersionInfoFromCwd is the cwd-aware variant. Existing callers go
// through GetVersionInfo (cwd=""); the cobra doctor command passes
// os.Getwd() so the SDK probe can read uv.lock / node_modules.
func GetVersionInfoFromCwd(ctx context.Context, s stack.Stack, current, cwd string, fetch Fetcher) VersionInfo {
	latestRaw, _ := fetch(ctx)
	var latest *string
	if latestRaw != "" {
		// Normalise: GitHub releases tag as `v0.9.7`; PyPI / npm
		// report `0.9.7`. The doctor's `current` field is always the
		// bare semver (pyproject.toml / package.json values). Strip
		// the `v` prefix so JSON consumers compare apples to apples.
		// Pre-v0.10.0 fix: `current: 0.5.26, latest: v0.9.7` made
		// agents emit the `v` literally in upgrade hints.
		l := strings.TrimPrefix(latestRaw, "v")
		latest = &l
	}
	hasUpdate := latest != nil && IsNewer(current, *latest)
	var sdkInfo *SDKVersionInfo
	if cwd != "" {
		if sv, src := readInstalledSDKVersion(cwd, s.Language); sv != "" {
			sdkHasUpdate := latest != nil && IsNewer(sv, *latest)
			sdkInfo = &SDKVersionInfo{
				Current:   sv,
				Latest:    latest,
				HasUpdate: sdkHasUpdate,
				Source:    src,
			}
			// If the SDK is behind, top-level hasUpdate must reflect
			// that — agents checking only the top field still see the
			// skew and prompt the user to upgrade. The CLI-vs-SDK split
			// in InstallHint surfaces which one to upgrade.
			if sdkHasUpdate {
				hasUpdate = true
			}
		}
	}
	return VersionInfo{
		Current:        current,
		Latest:         latest,
		HasUpdate:      hasUpdate,
		Language:       s.Language,
		PackageManager: s.PackageManager,
		InstallHint:    InstallHint(s, latest),
		SDK:            sdkInfo,
	}
}

// readInstalledSDKVersion probes the project for the resolved SDK
// version. Returns ("", "") when the project doesn't have one
// installed (or we couldn't find a way to read it; doctor is tolerant).
//
// Python: try `uv.lock` first (canonical for uv-managed projects),
// fall back to walking `.venv/lib/python*/site-packages/artanis_gravel-*.dist-info/METADATA`.
// TypeScript: read `node_modules/@artanis-ai/gravel/package.json`'s
// `version` field. No subprocess; just file reads — keeps doctor fast.
func readInstalledSDKVersion(cwd string, language stack.Language) (string, string) {
	if language == stack.LanguagePython {
		if v := readUvLockVersion(cwd); v != "" {
			return v, "uv.lock"
		}
		if v := readVenvDistInfoVersion(cwd); v != "" {
			return v, "site-packages"
		}
		return "", ""
	}
	if language == stack.LanguageTS {
		if v := readNodeModulesVersion(cwd); v != "" {
			return v, "node_modules"
		}
		return "", ""
	}
	return "", ""
}

// readUvLockVersion scans `uv.lock` for the `artanis-gravel` package
// block and extracts its version. uv.lock is TOML; we don't pull in
// a full parser — the shape is stable enough for a regex.
//
// Example block:
//
//	[[package]]
//	name = "artanis-gravel"
//	version = "0.6.0"
//	source = { registry = "https://pypi.org/simple" }
func readUvLockVersion(cwd string) string {
	body, err := os.ReadFile(filepath.Join(cwd, "uv.lock"))
	if err != nil {
		return ""
	}
	re := regexp.MustCompile(`(?m)^\s*name\s*=\s*"artanis-gravel"\s*$\s*version\s*=\s*"([^"]+)"`)
	m := re.FindSubmatch(body)
	if len(m) < 2 {
		return ""
	}
	return string(m[1])
}

// readVenvDistInfoVersion walks `.venv/lib/python*/site-packages/`
// looking for `artanis_gravel-<version>.dist-info/`. The version is in
// the directory name (PEP 376). Skips if no .venv exists.
func readVenvDistInfoVersion(cwd string) string {
	for _, venv := range []string{".venv", "venv"} {
		libDir := filepath.Join(cwd, venv, "lib")
		entries, err := os.ReadDir(libDir)
		if err != nil {
			continue
		}
		for _, e := range entries {
			if !e.IsDir() || !strings.HasPrefix(e.Name(), "python") {
				continue
			}
			sitePkg := filepath.Join(libDir, e.Name(), "site-packages")
			pkgEntries, err := os.ReadDir(sitePkg)
			if err != nil {
				continue
			}
			for _, p := range pkgEntries {
				name := p.Name()
				if !strings.HasPrefix(name, "artanis_gravel-") || !strings.HasSuffix(name, ".dist-info") {
					continue
				}
				trimmed := strings.TrimPrefix(name, "artanis_gravel-")
				trimmed = strings.TrimSuffix(trimmed, ".dist-info")
				return trimmed
			}
		}
	}
	return ""
}

// readNodeModulesVersion reads
// `node_modules/@artanis-ai/gravel/package.json`'s `version` field.
// Standard pnpm/npm/yarn layout; returns "" if any link is broken.
func readNodeModulesVersion(cwd string) string {
	body, err := os.ReadFile(filepath.Join(cwd, "node_modules", "@artanis-ai", "gravel", "package.json"))
	if err != nil {
		return ""
	}
	var pkg struct {
		Version string `json:"version"`
	}
	if err := json.Unmarshal(body, &pkg); err != nil {
		return ""
	}
	return pkg.Version
}

// InstallHint returns the package-manager-specific upgrade command the
// agent should run after the user confirms an upgrade. Falls back to
// the binary `curl | sh` line when the stack isn't recognised.
//
// When `latest` is known we pin the floor in the version constraint —
// for uv / poetry this is the recommended form ("at least the latest")
// and avoids drift between repo runs. For npm / pnpm / yarn / bun the
// `@latest` dist-tag is canonical.
func InstallHint(s stack.Stack, latest *string) string {
	latestVer := ""
	if latest != nil {
		latestVer = strings.TrimPrefix(*latest, "v")
	}
	switch s.Language {
	case stack.LanguagePython:
		switch s.PackageManager {
		case stack.PackageManagerUV:
			if latestVer != "" {
				return fmt.Sprintf("uv add 'artanis-gravel>=%s' --upgrade-package artanis-gravel", latestVer)
			}
			return "uv add 'artanis-gravel' --upgrade-package artanis-gravel"
		case stack.PackageManagerPoetry:
			if latestVer != "" {
				return fmt.Sprintf("poetry add 'artanis-gravel@>=%s'", latestVer)
			}
			return "poetry add artanis-gravel"
		case stack.PackageManagerPip:
			return "pip install -U artanis-gravel"
		case stack.PackageManagerPipenv:
			return "pipenv install --upgrade artanis-gravel"
		}
	case stack.LanguageTS:
		switch s.PackageManager {
		case stack.PackageManagerPNPM:
			return "pnpm add @artanis-ai/gravel@latest"
		case stack.PackageManagerNPM:
			return "npm install @artanis-ai/gravel@latest"
		case stack.PackageManagerYarn:
			return "yarn add @artanis-ai/gravel@latest"
		case stack.PackageManagerBun:
			return "bun add @artanis-ai/gravel@latest"
		}
	}
	// Unknown stack — fall back to the canonical binary install. Same
	// command works as upgrade because install.sh overwrites.
	return InstallCommand()
}

// InstallCommand returns the single canonical install / upgrade line.
// Stack-agnostic on purpose: the binary install path doesn't care
// about pnpm vs uv. Pinning a specific version is documented via the
// `GRAVEL_VERSION` env var; we don't render that here because the
// default behaviour (latest) is what 99% of users want.
func InstallCommand() string {
	return fmt.Sprintf("curl -fsSL %s | sh", installURL)
}

// Render builds the human-readable doctor output. Pure (no IO).
func Render(info VersionInfo) string {
	var b strings.Builder
	fmt.Fprintf(&b, "gravel %s\n", info.Current)
	fmt.Fprintf(&b, "  host stack: %s (%s)\n", info.Language, info.PackageManager)
	switch {
	case info.Latest == nil:
		b.WriteString("  latest: (unknown; release API unreachable or version check disabled)\n")
	case info.HasUpdate:
		fmt.Fprintf(&b, "  latest: %s\n\n", *info.Latest)
		b.WriteString("  Update available. Run:\n")
		fmt.Fprintf(&b, "    %s\n", InstallCommand())
	default:
		fmt.Fprintf(&b, "  latest: %s (up to date)\n", *info.Latest)
	}
	return strings.TrimRight(b.String(), "\n")
}
