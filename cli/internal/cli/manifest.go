package cli

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"

	"github.com/artanis-ai/gravel/cli/internal/manifest"
	"github.com/spf13/cobra"
)

func newManifestCmd() *cobra.Command {
	var check, update, list bool
	cmd := &cobra.Command{
		Use:   "manifest",
		Short: "Scan prompts, read/write/diff .gravel/manifest.json.",
		Long: `manifest is the fast prompt-discovery path used by the pre-commit hook
and the dashboard's Prompts tab.

Modes:
  --check       (used by the pre-commit hook) scan working tree, diff against
                the on-disk manifest, exit non-zero if drift is found.
  --update      scan + write the updated manifest.
  --list        scan + print prompts to stdout. Does not touch disk.

Embedded prompts in code are discovered by the deep-scan command, not
this one; fast scan only catches edits to entries already in the
manifest plus new .md / .txt / .prompt files in conventional directories.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			modes := 0
			if check {
				modes++
			}
			if update {
				modes++
			}
			if list {
				modes++
			}
			if modes != 1 {
				return fmt.Errorf("pick exactly one of --check, --update, --list")
			}
			cwd, err := os.Getwd()
			if err != nil {
				return fmt.Errorf("getwd: %w", err)
			}
			current, err := manifest.Read(cwd)
			if err != nil {
				return err
			}
			if hasPromptScanRootsField(cwd) {
				// v0.9.0 deprecation: the scanner now walks the entire
				// repo respecting .gitignore, so the per-project
				// override is no longer needed. One-line warning to
				// stderr; we still do the scan correctly.
				fmt.Fprintln(cmd.ErrOrStderr(),
					"Gravel (deprecation): `promptScanRoots` in your gravel_config is ignored as of v0.9.0 — the scanner now walks the full repo respecting .gitignore. Safe to remove the field.")
			}
			res, err := manifest.FastScan(cwd, current)
			if err != nil {
				return err
			}
			switch {
			case check:
				return runCheck(cmd, current, res)
			case update:
				return runUpdate(cmd, cwd, res)
			case list:
				return runList(cmd, res)
			}
			return nil
		},
	}
	cmd.Flags().BoolVar(&check, "check", false, "Exit non-zero if the on-disk manifest is out of date.")
	cmd.Flags().BoolVar(&update, "update", false, "Write the updated manifest to disk.")
	cmd.Flags().BoolVar(&list, "list", false, "Print prompts to stdout without touching disk.")
	return cmd
}

func runCheck(cmd *cobra.Command, current manifest.Manifest, res manifest.FastScanResult) error {
	inSync := res.Added == 0 && res.Removed == 0 && res.Changed == 0
	if inSync {
		fmt.Fprintln(cmd.OutOrStdout(), "Gravel manifest is in sync.")
		return nil
	}
	// Pre-commit hooks read this from stderr; the format is contract.
	fmt.Fprintln(cmd.ErrOrStderr(), "Gravel: Your prompt manifest is out of date.")
	fmt.Fprintln(cmd.ErrOrStderr(), manifest.Diff(current, res.Manifest))
	fmt.Fprintln(cmd.ErrOrStderr())
	fmt.Fprintln(cmd.ErrOrStderr(), "Run:    gravel manifest --update")
	fmt.Fprintln(cmd.ErrOrStderr(), "Then:   git add "+manifest.Path+" && git commit")
	fmt.Fprintln(cmd.ErrOrStderr())
	fmt.Fprintln(cmd.ErrOrStderr(), "(To bypass: git commit --no-verify)")
	os.Exit(1)
	return nil
}

func runUpdate(cmd *cobra.Command, cwd string, res manifest.FastScanResult) error {
	if err := manifest.Write(cwd, res.Manifest); err != nil {
		return err
	}
	fmt.Fprintf(cmd.OutOrStdout(),
		"Manifest updated: +%d -%d ~%d (%d unchanged).\n",
		res.Added, res.Removed, res.Changed, res.Unchanged,
	)
	return nil
}

func runList(cmd *cobra.Command, res manifest.FastScanResult) error {
	fmt.Fprintf(cmd.OutOrStdout(), "Manifest: %d prompts\n", len(res.Manifest.Prompts))
	for _, p := range res.Manifest.Prompts {
		line := "  " + p.Path
		if p.Type == manifest.PromptEmbedded && p.LineStart != nil && p.LineEnd != nil {
			line += fmt.Sprintf(" (line %d-%d)", *p.LineStart, *p.LineEnd)
		}
		fmt.Fprintln(cmd.OutOrStdout(), line)
	}
	return nil
}

// hasPromptScanRootsField returns true when the project's
// gravel_config.{ts,py} still defines the deprecated `promptScanRoots`
// / `prompt_scan_roots` field. v0.9.0 dropped it (scanner now walks
// the full repo respecting .gitignore); detecting it on disk lets us
// nudge the user to remove the field without errors.
func hasPromptScanRootsField(cwd string) bool {
	for _, name := range []string{"gravel.config.ts", "gravel_config.py"} {
		body, err := os.ReadFile(filepath.Join(cwd, name))
		if err != nil {
			continue
		}
		re := regexp.MustCompile(`(?i)prompt[_]?scan[_]?roots\s*[:=]\s*\[`)
		if re.Match(body) {
			return true
		}
	}
	return false
}
