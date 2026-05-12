package wizard

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
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
	// nativeHookBody is the full POSIX shell script for projects with
	// no other hook manager. Uses `gravel manifest --check`; the
	// binary must be on $PATH (which `install.sh` ensures).
	nativeHookBody = `#!/usr/bin/env sh
# Added by Gravel. Keep .gravel/manifest.json in sync with prompts in your code.
# Polite-blocking: bypass with ` + "`" + `git commit --no-verify` + "`" + `.
gravel manifest --check || {
  echo ""
  echo "Gravel: Your prompt manifest is out of date."
  echo "Run:    gravel manifest --update"
  echo "Then:   git add .gravel/manifest.json && git commit"
  echo ""
  echo "(To bypass: git commit --no-verify)"
  exit 1
}
`
	// huskyLine is appended to an existing .husky/pre-commit script.
	// Husky's runner is sh, so a bare command line is enough.
	huskyLine = "gravel manifest --check\n"

	// preCommitYAMLLocal is the local-hooks block injected into
	// .pre-commit-config.yaml. Matches the Python pre-commit
	// framework's syntax.
	preCommitYAMLLocal = `  - repo: local
    hooks:
      - id: gravel-manifest
        name: Gravel manifest check
        entry: gravel manifest --check
        language: system
        pass_filenames: false
`

	// alreadyInstalledMarker is the substring we look for to decide
	// whether the wizard's previous run already installed the hook.
	// "gravel manifest" appears nowhere else in a typical hook.
	alreadyInstalledMarker = "gravel manifest"
)

// InstallHook drops a pre-commit hook that runs `gravel manifest --check`.
// Returns Mode=HookSkipped when the project has no git repo (so we
// have nowhere to put the hook). Idempotent across runs.
func InstallHook(repoRoot string) (HookResult, error) {
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
		text += huskyLine
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
		if strings.Contains(text, "repos:") {
			if !strings.HasSuffix(text, "\n") {
				text += "\n"
			}
			text += preCommitYAMLLocal
		} else {
			text = "repos:\n" + preCommitYAMLLocal
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
		text += huskyLine
		if err := os.WriteFile(hook, []byte(text), 0o755); err != nil {
			return HookResult{}, err
		}
	} else {
		if err := os.WriteFile(hook, []byte(nativeHookBody), 0o755); err != nil {
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
