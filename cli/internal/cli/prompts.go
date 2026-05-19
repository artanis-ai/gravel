// gravel prompts — install only the prompts pillar.
package cli

import (
	"context"
	"errors"
	"fmt"
	"os"

	"github.com/artanis-ai/gravel/cli/internal/wizard"
	"github.com/spf13/cobra"
)

func newPromptsCmd() *cobra.Command {
	var (
		plan         bool
		apply        bool
		noDeepScan   bool
		noHook       bool
		acceptAll    bool
	)
	cmd := &cobra.Command{
		Use:   "prompts",
		Short: "Install only the prompts pillar (manifest + optional pre-commit hook).",
		Long: `The Prompts pillar: regex-scans conventional prompt dirs (prompts/,
templates/, etc.), writes .gravel/manifest.json indexing each prompt
by id/path/hash, and (by default, when .git is present) installs a
pre-commit hook so the manifest stays in sync.

Agents: --plan emits a JSON action list; --apply does the work. Pass
--no-deep-scan to skip the "did I find everything?" loop in non-TTY
contexts; agents normally pair --apply with --accept-all to avoid the
verify loop entirely.`,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if plan && apply {
				return errors.New("--plan and --apply are mutually exclusive")
			}
			cwd, err := os.Getwd()
			if err != nil {
				return err
			}
			d := wizard.Detect(cwd)
			opts := wizard.PromptsPillarOptions{
				Detection:    d,
				SkipDeepScan: noDeepScan,
				InstallHook:  !noHook,
				Prompter:     wizard.DefaultsPrompter{},
			}
			if !acceptAll && !plan {
				// Agents should pass --accept-all; humans use `gravel init`.
				// Bare `gravel prompts --apply` without --accept-all would
				// hang waiting for the deep-scan verify loop if the user
				// runs it directly. Tell them what to do.
				fmt.Fprintln(cmd.ErrOrStderr(),
					"Refusing to run interactive scan from `gravel prompts`. Either:")
				fmt.Fprintln(cmd.ErrOrStderr(),
					"  - re-run with --accept-all (agent-style; takes every regex hit), or")
				fmt.Fprintln(cmd.ErrOrStderr(),
					"  - use `gravel init` instead for the interactive scan + verify.")
				return errors.New("--accept-all required for non-interactive prompts pillar")
			}
			if plan {
				return emitJSON(cmd, wizard.PlanPrompts(context.Background(), opts))
			}
			res, err := wizard.ApplyPrompts(context.Background(), opts)
			if err != nil {
				return err
			}
			fmt.Fprintf(cmd.OutOrStdout(), "Manifest written: %d prompts\n", res.ManifestCount)
			return nil
		},
	}
	cmd.Flags().BoolVar(&plan, "plan", false, "Emit a JSON action plan without writing anything.")
	cmd.Flags().BoolVar(&apply, "apply", false, "Execute the scan + write the manifest (default).")
	cmd.Flags().BoolVar(&noDeepScan, "no-deep-scan", false, "Skip the LLM-assisted 'did I find everything?' second pass.")
	cmd.Flags().BoolVar(&noHook, "no-hook", false, "Don't install the pre-commit hook.")
	cmd.Flags().BoolVar(&acceptAll, "accept-all", false, "Accept every prompt the scanner finds (agent flow).")
	return cmd
}
