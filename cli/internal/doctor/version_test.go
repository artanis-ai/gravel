package doctor

import (
	"context"
	"strings"
	"testing"

	"github.com/artanis-ai/gravel/cli/internal/stack"
)

func TestIsNewer(t *testing.T) {
	cases := []struct {
		a, b string
		want bool
	}{
		{"0.1.0", "0.1.1", true},
		{"0.1.1", "0.1.0", false},
		{"0.1.5", "0.2.0", true},
		{"0.9.9", "1.0.0", true},
		{"1.2.3", "1.2.3", false},
		{"v0.1.0", "0.1.1", true},
		{"0.1.0", "v0.1.1", true},
		// Prerelease tags strip down to the base.
		{"0.1.0-rc.1", "0.1.0", false},
		{"0.1.0", "0.1.0-rc.1", false},
		{"0.1.0-rc.1", "0.1.1", true},
		// Missing tail components are zero.
		{"1.0", "1.0.0", false},
		{"1.0", "1.0.1", true},
	}
	for _, tc := range cases {
		if got := IsNewer(tc.a, tc.b); got != tc.want {
			t.Errorf("IsNewer(%q, %q) = %v, want %v", tc.a, tc.b, got, tc.want)
		}
	}
}

func TestParseLatestTag(t *testing.T) {
	good := []byte(`{"tag_name":"v0.3.0","name":"v0.3.0","draft":false}`)
	if got := parseLatestTag(good); got != "v0.3.0" {
		t.Errorf("good: got %q, want %q", got, "v0.3.0")
	}
	if got := parseLatestTag([]byte(`garbage`)); got != "" {
		t.Errorf("garbage: got %q, want empty", got)
	}
	if got := parseLatestTag([]byte(`{"name":"v0.3.0"}`)); got != "" {
		t.Errorf("missing tag_name: got %q, want empty", got)
	}
}

// InstallHint maps the detected stack to a copy-pasteable upgrade
// command. The agent contract in llms.txt Step 0 promises this exact
// shape, so each stack/manager combo is pinned here. The `latest`
// pointer drives the version floor in the constraint; nil falls back
// to the dist-tag form.
func TestInstallHint(t *testing.T) {
	latest := "v0.9.0"
	cases := []struct {
		name    string
		stack   stack.Stack
		latest  *string
		want    string
	}{
		{
			"uv with latest pin",
			stack.Stack{Language: stack.LanguagePython, PackageManager: stack.PackageManagerUV},
			&latest,
			"uv add 'artanis-gravel>=0.9.0' --upgrade-package artanis-gravel",
		},
		{
			"uv without latest",
			stack.Stack{Language: stack.LanguagePython, PackageManager: stack.PackageManagerUV},
			nil,
			"uv add 'artanis-gravel' --upgrade-package artanis-gravel",
		},
		{
			"poetry with latest pin",
			stack.Stack{Language: stack.LanguagePython, PackageManager: stack.PackageManagerPoetry},
			&latest,
			"poetry add 'artanis-gravel@>=0.9.0'",
		},
		{
			"pip",
			stack.Stack{Language: stack.LanguagePython, PackageManager: stack.PackageManagerPip},
			&latest,
			"pip install -U artanis-gravel",
		},
		{
			"pipenv",
			stack.Stack{Language: stack.LanguagePython, PackageManager: stack.PackageManagerPipenv},
			&latest,
			"pipenv install --upgrade artanis-gravel",
		},
		{
			"pnpm",
			stack.Stack{Language: stack.LanguageTS, PackageManager: stack.PackageManagerPNPM},
			&latest,
			"pnpm add @artanis-ai/gravel@latest",
		},
		{
			"npm",
			stack.Stack{Language: stack.LanguageTS, PackageManager: stack.PackageManagerNPM},
			&latest,
			"npm install @artanis-ai/gravel@latest",
		},
		{
			"yarn",
			stack.Stack{Language: stack.LanguageTS, PackageManager: stack.PackageManagerYarn},
			&latest,
			"yarn add @artanis-ai/gravel@latest",
		},
		{
			"bun",
			stack.Stack{Language: stack.LanguageTS, PackageManager: stack.PackageManagerBun},
			&latest,
			"bun add @artanis-ai/gravel@latest",
		},
		{
			"unknown stack falls back to curl|sh",
			stack.Stack{Language: stack.Language(""), PackageManager: stack.PackageManager("")},
			&latest,
			InstallCommand(),
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := InstallHint(tc.stack, tc.latest); got != tc.want {
				t.Errorf("InstallHint(%v, %v) = %q, want %q", tc.stack, tc.latest, got, tc.want)
			}
		})
	}
}

// GetVersionInfo must populate the installHint field so the JSON
// payload llms.txt step 0 consumes contains the upgrade command.
func TestGetVersionInfo_IncludesInstallHint(t *testing.T) {
	fetcher := func(context.Context) (string, error) { return "v0.9.0", nil }
	info := GetVersionInfo(context.Background(),
		stack.Stack{Language: stack.LanguagePython, PackageManager: stack.PackageManagerUV},
		"0.8.4", fetcher)
	want := "uv add 'artanis-gravel>=0.9.0' --upgrade-package artanis-gravel"
	if info.InstallHint != want {
		t.Errorf("InstallHint = %q, want %q", info.InstallHint, want)
	}
	if !info.HasUpdate {
		t.Errorf("expected HasUpdate=true for 0.8.4 → 0.9.0")
	}
}

func TestInstallCommand(t *testing.T) {
	got := InstallCommand()
	// We don't pin the exact URL in the assertion (DESIGN doc owns it),
	// but the user-visible shape must be `curl ... | sh`.
	if !strings.HasPrefix(got, "curl -fsSL ") || !strings.HasSuffix(got, " | sh") {
		t.Errorf("InstallCommand looks wrong: %q", got)
	}
	if !strings.Contains(got, "install.sh") {
		t.Errorf("InstallCommand should reference install.sh, got %q", got)
	}
}

// stubFetcher returns a fixed version (or empty for "unknown") so the
// render tests don't hit the network.
func stubFetcher(latest string) Fetcher {
	return func(_ context.Context) (string, error) {
		return latest, nil
	}
}

func TestGetVersionInfo(t *testing.T) {
	ctx := context.Background()
	s := stack.Stack{Language: stack.LanguageTS, PackageManager: stack.PackageManagerPNPM}

	info := GetVersionInfo(ctx, s, "0.1.0", stubFetcher("0.9.9"))
	if info.Current != "0.1.0" || info.Latest == nil || *info.Latest != "0.9.9" {
		t.Errorf("got %+v", info)
	}
	if !info.HasUpdate {
		t.Errorf("expected hasUpdate=true")
	}
	if info.Language != stack.LanguageTS || info.PackageManager != stack.PackageManagerPNPM {
		t.Errorf("stack not propagated: %+v", info)
	}

	// Equal versions; no update.
	if got := GetVersionInfo(ctx, s, "0.9.9", stubFetcher("0.9.9")); got.HasUpdate {
		t.Errorf("equal: expected hasUpdate=false, got %+v", got)
	}
	// Unknown latest; no update, latest is nil.
	got := GetVersionInfo(ctx, s, "0.1.0", stubFetcher(""))
	if got.HasUpdate || got.Latest != nil {
		t.Errorf("unknown latest: expected (hasUpdate=false, latest=nil), got %+v", got)
	}
	// Tagged release with leading "v" still compares correctly.
	tagged := GetVersionInfo(ctx, s, "0.1.0", stubFetcher("v0.2.0"))
	if !tagged.HasUpdate || tagged.Latest == nil || *tagged.Latest != "v0.2.0" {
		t.Errorf("v-prefixed: got %+v, want hasUpdate=true latest=v0.2.0", tagged)
	}
}

func TestRender_Upgrade(t *testing.T) {
	latest := "0.9.9"
	info := VersionInfo{
		Current:        "0.1.0",
		Latest:         &latest,
		HasUpdate:      true,
		Language:       stack.LanguageTS,
		PackageManager: stack.PackageManagerPNPM,
	}
	out := Render(info)
	mustContain(t, out, "gravel 0.1.0")
	mustContain(t, out, "host stack: ts (pnpm)")
	mustContain(t, out, "Update available")
	mustContain(t, out, "curl -fsSL ")
	mustContain(t, out, "install.sh")
	mustContain(t, out, "| sh")
	// Render must NOT print a per-stack upgrade command (that's the
	// dashboard banner's job; the CLI binary lives outside any stack).
	mustNotContain(t, out, "pnpm update")
	mustNotContain(t, out, "@artanis-ai/gravel")
}

func TestRender_UpgradePython(t *testing.T) {
	// Even on a Python host, the upgrade command is the same.
	latest := "0.9.9"
	info := VersionInfo{
		Current:        "0.1.0",
		Latest:         &latest,
		HasUpdate:      true,
		Language:       stack.LanguagePython,
		PackageManager: stack.PackageManagerUV,
	}
	out := Render(info)
	mustContain(t, out, "host stack: python (uv)")
	mustContain(t, out, "curl -fsSL ")
	mustNotContain(t, out, "uv pip")
	mustNotContain(t, out, "artanis-gravel")
}

func TestRender_UpToDate(t *testing.T) {
	latest := "0.1.0"
	info := VersionInfo{
		Current:        "0.1.0",
		Latest:         &latest,
		HasUpdate:      false,
		Language:       stack.LanguageTS,
		PackageManager: stack.PackageManagerPNPM,
	}
	out := Render(info)
	mustContain(t, out, "up to date")
	mustNotContain(t, out, "Update available")
	mustNotContain(t, out, "curl -fsSL ")
}

func TestRender_UnknownLatest(t *testing.T) {
	info := VersionInfo{
		Current:        "0.1.0",
		Latest:         nil,
		HasUpdate:      false,
		Language:       stack.LanguageTS,
		PackageManager: stack.PackageManagerPNPM,
	}
	out := Render(info)
	mustContain(t, out, "(unknown")
	mustNotContain(t, out, "Update available")
	mustNotContain(t, out, "curl -fsSL ")
}

func mustContain(t *testing.T, haystack, needle string) {
	t.Helper()
	if !strings.Contains(haystack, needle) {
		t.Errorf("missing %q in:\n%s", needle, haystack)
	}
}
func mustNotContain(t *testing.T, haystack, needle string) {
	t.Helper()
	if strings.Contains(haystack, needle) {
		t.Errorf("unexpected %q in:\n%s", needle, haystack)
	}
}
