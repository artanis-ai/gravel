package cli

import (
	"context"
	"fmt"
	"os"

	"github.com/artanis-ai/gravel/cli/internal/wizard"
	"github.com/spf13/cobra"
)

func newInitCmd() *cobra.Command {
	var (
		mountPath      string
		yes            bool
		withPrompts    bool
		noPrompts      bool
		withTraces     bool
		noTraces       bool
		noTestTrace    bool
		noDeepScan     bool
		apiKey         string
		projectID      string
		skipSDKInstall bool
	)
	cmd := &cobra.Command{
		Use:   "init",
		Short: "Install Gravel into the current project.",
		Long: `init runs the install wizard against the current directory.

Three pillars (Dashboard / Prompts / Traces) run in sequence; you can
opt out of Prompts or Traces (Dashboard is always written — nothing
else works without it). Walks the user through each pillar with a
"Continue?" before doing anything.

Pre-bake cloud creds via --api-key + --project (or GRAVEL_API_KEY /
GRAVEL_PROJECT_ID env). The wizard never opens a browser handshake;
that belongs to a future ` + "`gravel login`" + ` subcommand.

In --yes mode (CI / scripting), the wizard runs without prompting and
either accepts what was passed via flags or applies the defaults.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			cwd, err := os.Getwd()
			if err != nil {
				return err
			}
			out := cmd.OutOrStdout()

			// Cloud credentials, if any, come from explicit flags or
			// env vars. `gravel init` does NOT run a browser OAuth
			// handshake — that's a separate `gravel login` flow once
			// the control plane endpoint lands. Matches the original
			// TS wizard's behaviour (see git history of
			// packages/sdk-ts/src/wizard/index.ts pre-v0.3): read
			// --api-key / --project (or GRAVEL_API_KEY / GRAVEL_PROJECT_ID
			// env), write to .env.local if both are present, otherwise
			// proceed without cloud creds. The dashboard's "connect to
			// cloud" CTA handles the OAuth handshake on first login.
			if apiKey == "" {
				apiKey = os.Getenv("GRAVEL_API_KEY")
			}
			if projectID == "" {
				projectID = os.Getenv("GRAVEL_PROJECT_ID")
			}

			// Resolve pillar state. Three outcomes per pillar:
			//   --prompts     → explicit on,  skip "Continue?" question
			//   --no-prompts  → explicit off, skip the whole pillar
			//   neither       → ask, default yes (or yes-without-asking under --yes)
			promptsExplicit := withPrompts || noPrompts || yes
			tracesExplicit := withTraces || noTraces || yes
			opts := wizard.RunOptions{
				CWD:               cwd,
				MountPath:         mountPath,
				MountPathExplicit: cmd.Flags().Changed("mount-path"),
				YesToAll:          yes,
				WithPrompts:       !noPrompts, // disabled only via --no-prompts
				PromptsExplicit:   promptsExplicit,
				WithTraces:        !noTraces,
				TracesExplicit:    tracesExplicit,
				SkipTestTrace:     noTestTrace,
				SkipDeepScan:      noDeepScan,
				SkipSDKInstall:    skipSDKInstall,
				APIKey:            apiKey,
				ProjectID:         projectID,
			}

			res, err := wizard.Run(context.Background(), opts, out)
			if err != nil {
				return err
			}
			printSummary(cmd, res)
			return nil
		},
	}
	cmd.Flags().StringVar(&mountPath, "mount-path", "/admin/ai", "URL path to mount the dashboard at.")
	cmd.Flags().BoolVar(&yes, "yes", false, "Assume yes to every prompt (alias for --non-interactive).")
	cmd.Flags().BoolVar(&yes, "non-interactive", false, "Assume yes to every prompt.")
	cmd.Flags().BoolVar(&withPrompts, "prompts", false, "Install the prompts pillar (manifest + hook).")
	cmd.Flags().BoolVar(&noPrompts, "no-prompts", false, "Skip the prompts pillar.")
	cmd.Flags().BoolVar(&withTraces, "traces", false, "Install the traces pillar (DB tables + tracing).")
	cmd.Flags().BoolVar(&noTraces, "no-traces", false, "Skip the traces pillar.")
	cmd.Flags().BoolVar(&noTestTrace, "no-test-trace", false, "Skip the end-to-end test trace step.")
	cmd.Flags().BoolVar(&noDeepScan, "no-deep-scan", false, "Skip the 'Did I find everything?' loop after the regex scan.")
	cmd.Flags().StringVar(&apiKey, "api-key", "", "Pre-bake project key into .env.local. Reads $GRAVEL_API_KEY if unset.")
	cmd.Flags().StringVar(&projectID, "project", "", "Pre-bake project ID into .env.local. Reads $GRAVEL_PROJECT_ID if unset.")
	// Smoke/test escape hatch. Hidden because production users should
	// never need it; the wizard always wants the SDK in deps to make
	// gravel.config.ts resolvable.
	cmd.Flags().BoolVar(&skipSDKInstall, "skip-sdk-install", false, "Skip the pnpm/uv add step. Hidden; for smoke tests + advanced users.")
	_ = cmd.Flags().MarkHidden("skip-sdk-install")
	// Back-compat: silently accept old --oauth / --skip-oauth / --control-plane
	// flags from v0.5.0 so existing scripts don't break. All three are no-ops
	// now; the wizard never opens a browser handshake (was a v0.5.0 bug).
	var _oauth, _skipOAuth bool
	var _controlPlane string
	cmd.Flags().BoolVar(&_oauth, "oauth", false, "Deprecated no-op. See `gravel login` (lands when control plane endpoint is live).")
	cmd.Flags().BoolVar(&_skipOAuth, "skip-oauth", false, "Deprecated no-op. OAuth never runs from init.")
	cmd.Flags().StringVar(&_controlPlane, "control-plane", "", "Deprecated no-op.")
	for _, f := range []string{"oauth", "skip-oauth", "control-plane"} {
		_ = cmd.Flags().MarkHidden(f)
	}
	return cmd
}

// printSummary appends the final "Docs:" line. The bulk of the
// closing summary (Done. + per-pillar bullets) is emitted by Run()
// in internal/wizard/run.go alongside the step-by-step output, so
// this function is intentionally tiny.
func printSummary(_ *cobra.Command, _ wizard.RunResult) {
	fmt.Fprintln(os.Stderr)
	fmt.Fprintf(os.Stderr, "Docs: %s\n", wizard.Cyan("https://gravel.artanis.ai/docs"))
	fmt.Fprintln(os.Stderr)
}
