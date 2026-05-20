package wizard

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/artanis-ai/gravel/cli/internal/stack"
)

// HookMode tells the caller which strategy the wizard used. We try
// the more "polite" integrations first (Husky, then the Python-style
// pre-commit framework, then native .git/hooks/) so that we play
// nicely with whatever the project already had set up.
type HookMode string

const (
	HookHusky             HookMode = "husky"
	HookPreCommitFramework HookMode = "pre-commit-framework"
	HookNative            HookMode = "native"
	HookSkipped           HookMode = "skipped"
)

// HookResult describes what InstallHook actually did.
type HookResult struct {
	Mode             HookMode
	Path             string
	AlreadyInstalled bool
}

const (
	// alreadyInstalledMarker is the substring we look for to decide
	// whether the wizard's previous run already installed the hook.
	// "gravel manifest" appears nowhere else in a typical hook.
	alreadyInstalledMarker = "gravel manifest"
)

// hookCommand returns the right way to invoke `gravel manifest
// --check` for the project's package manager. Bare `gravel` only
// works when the SDK's venv is activated; projects using uv / poetry /
// pnpm / etc. need the package-manager prefix to find the binary.
// Claude's de_platform install (2026-05-20) caught this: hook fired
// with `command not found: gravel` because `uv run` wasn't prefixed.
func hookCommand(pm stack.PackageManager) string {
	switch pm {
	case stack.PackageManagerUV:
		return "uv run gravel manifest --check"
	case stack.PackageManagerPoetry:
		return "poetry run gravel manifest --check"
	case stack.PackageManagerPipenv:
		return "pipenv run gravel manifest --check"
	case stack.PackageManagerPNPM:
		return "pnpm exec gravel manifest --check"
	case stack.PackageManagerNPM:
		return "npx -y gravel manifest --check"
	case stack.PackageManagerYarn:
		return "yarn gravel manifest --check"
	case stack.PackageManagerBun:
		return "bunx gravel manifest --check"
	case stack.PackageManagerPip:
		// Plain pip projects rarely auto-activate a venv; assume the
		// user has the SDK's bin on PATH.
		return "gravel manifest --check"
	}
	return "gravel manifest --check"
}

// nativeHookBody renders the full POSIX shell script for projects
// with no other hook manager. The check line is package-manager
// specific so the binary resolves without an activated venv.
func nativeHookBody(pm stack.PackageManager) string {
	return `#!/usr/bin/env sh
# Added by Gravel. Keep .gravel/manifest.json in sync with prompts in your code.
# Polite-blocking: bypass with ` + "`" + `git commit --no-verify` + "`" + `.
` + hookCommand(pm) + ` || {
  echo ""
  echo "Gravel: Your prompt manifest is out of date."
  echo "Run:    ` + strings.Replace(hookCommand(pm), " --check", " --update", 1) + `"
  echo "Then:   git add .gravel/manifest.json && git commit"
  echo ""
  echo "(To bypass: git commit --no-verify)"
  exit 1
}
`
}

// huskyLine is appended to an existing .husky/pre-commit script.
// Husky's runner is sh; a bare command line is enough.
func huskyLine(pm stack.PackageManager) string {
	return hookCommand(pm) + "\n"
}

// preCommitYAMLLocal returns the local-hooks block for the
// .pre-commit-config.yaml framework, with the right entry command
// for the project's package manager.
func preCommitYAMLLocal(pm stack.PackageManager) string {
	return `  - repo: local
    hooks:
      - id: gravel-manifest
        name: Gravel manifest check
        entry: ` + hookCommand(pm) + `
        language: system
        pass_filenames: false
`
}

// InstallHook drops a pre-commit hook that runs `gravel manifest --check`.
// The hook command is package-manager aware (`uv run gravel`, `pnpm
// exec gravel`, etc.) so it resolves even when the SDK's venv isn't
// auto-activated. Returns Mode=HookSkipped when the project has no
// git repo. Idempotent across runs.
//
// Pass `stack.PackageManager("")` (zero value) to fall back to the
// bare `gravel` command — useful in tests and rare native installs.
func InstallHook(repoRoot string, pm stack.PackageManager) (HookResult, error) {
	// 1. Husky
	husky := filepath.Join(repoRoot, ".husky", "pre-commit")
	if pathExists(husky) {
		content, err := os.ReadFile(husky)
		if err != nil {
			return HookResult{}, err
		}
		if strings.Contains(string(content), alreadyInstalledMarker) {
			return HookResult{Mode: HookHusky, Path: husky, AlreadyInstalled: true}, nil
		}
		text := string(content)
		if !strings.HasSuffix(text, "\n") {
			text += "\n"
		}
		text += huskyLine(pm)
		if err := os.WriteFile(husky, []byte(text), 0o755); err != nil {
			return HookResult{}, err
		}
		return HookResult{Mode: HookHusky, Path: husky}, nil
	}

	// 2. pre-commit framework
	preYAML := filepath.Join(repoRoot, ".pre-commit-config.yaml")
	if pathExists(preYAML) {
		content, err := os.ReadFile(preYAML)
		if err != nil {
			return HookResult{}, err
		}
		if strings.Contains(string(content), "gravel-manifest") {
			return HookResult{Mode: HookPreCommitFramework, Path: preYAML, AlreadyInstalled: true}, nil
		}
		text := string(content)
		block := preCommitYAMLLocal(pm)
		// Match the existing indent so we don't corrupt 4-space configs.
		// Default block is 2-space; if the existing file uses 4, re-indent.
		if existingIndent(text) == 4 {
			block = reindentTwoToFour(block)
		}
		if strings.Contains(text, "repos:") {
			if !strings.HasSuffix(text, "\n") {
				text += "\n"
			}
			text += block
		} else {
			text = "repos:\n" + block
		}
		if err := os.WriteFile(preYAML, []byte(text), 0o644); err != nil {
			return HookResult{}, err
		}
		return HookResult{Mode: HookPreCommitFramework, Path: preYAML}, nil
	}

	// 3. Native git hook
	hookDir := filepath.Join(repoRoot, ".git", "hooks")
	if !pathExists(hookDir) {
		return HookResult{Mode: HookSkipped}, nil
	}
	hook := filepath.Join(hookDir, "pre-commit")
	if pathExists(hook) {
		content, err := os.ReadFile(hook)
		if err != nil {
			return HookResult{}, err
		}
		if strings.Contains(string(content), alreadyInstalledMarker) {
			return HookResult{Mode: HookNative, Path: hook, AlreadyInstalled: true}, nil
		}
		text := string(content)
		if !strings.HasSuffix(text, "\n") {
			text += "\n"
		}
		text += huskyLine(pm)
		if err := os.WriteFile(hook, []byte(text), 0o755); err != nil {
			return HookResult{}, err
		}
	} else {
		if err := os.WriteFile(hook, []byte(nativeHookBody(pm)), 0o755); err != nil {
			return HookResult{}, err
		}
	}
	// Ensure mode is executable even if WriteFile didn't honour it
	// (older filesystems / umask quirks).
	if err := os.Chmod(hook, 0o755); err != nil {
		return HookResult{}, fmt.Errorf("chmod %s: %w", hook, err)
	}
	return HookResult{Mode: HookNative, Path: hook}, nil
}

// existingIndent reports the dominant leading-space indent in a
// pre-commit YAML file. Looks at the first indented line under `repos:`
// since that's the canonical position. Returns 0 when undecidable
// (empty file, no `repos:` block); callers default to 2 in that case.
func existingIndent(yaml string) int {
	lines := strings.Split(yaml, "\n")
	seenRepos := false
	for _, line := range lines {
		if strings.HasPrefix(strings.TrimSpace(line), "repos:") {
			seenRepos = true
			continue
		}
		if !seenRepos {
			continue
		}
		// First non-blank line under repos: — count leading spaces.
		if strings.TrimSpace(line) == "" {
			continue
		}
		count := 0
		for _, ch := range line {
			if ch != ' ' {
				break
			}
			count++
		}
		if count > 0 {
			return count
		}
		return 0
	}
	return 0
}

// reindentTwoToFour doubles the leading-space indent of every line —
// turns the canonical 2-space pre-commit block into a 4-space block
// to match a project that uses 4-space YAML. Claude's de_platform
// install hit a YAML parse failure because we'd inserted a 2-space
// block into a 4-space file.
func reindentTwoToFour(block string) string {
	out := make([]string, 0, len(block))
	for _, line := range strings.Split(block, "\n") {
		// Count leading spaces.
		count := 0
		for _, ch := range line {
			if ch != ' ' {
				break
			}
			count++
		}
		out = append(out, strings.Repeat(" ", count*2)+line[count:])
	}
	return strings.Join(out, "\n")
}
