package cli

import (
	"context"
	"fmt"
	"os"
	"time"

	"github.com/artanis-ai/gravel/cli/internal/wizard"
	"github.com/spf13/cobra"
)

func newInitCmd() *cobra.Command {
	var (
		mountPath   string
		yes         bool
		withPrompts bool
		noPrompts   bool
		withTraces  bool
		noTraces    bool
		noTestTrace bool
		apiKey      string
		projectID   string
		skipOAuth   bool
		baseURL     string
	)
	cmd := &cobra.Command{
		Use:   "init",
		Short: "Install Gravel into the current project.",
		Long: `init runs the install wizard against the current directory:

  1. Detect framework, package manager, auth provider, DB driver.
  2. Authenticate against gravel.artanis.ai (browser handshake, skipped when
     --api-key + --project are passed, or --skip-oauth is set).
  3. Write gravel.config.{ts,py} tailored to that stack.
  4. Mount the dashboard route for the detected framework (Next.js App Router
     and Pages Router get the route file written directly; other frameworks
     get copy-paste instructions on stdout).
  5. Generate GRAVEL_ADMIN_PASSWORD into .env.local if missing.
  6. For the traces pillar (when --traces or no flag): pre-flight probe the
     DB, run schema bootstrap if reachable, surface a clear note otherwise.
  7. For the prompts pillar (when --prompts or no flag): scan known prompt
     files and install a pre-commit hook that keeps the manifest in sync.

Default is "both pillars on" for an interactive run. Use --no-prompts or
--no-traces to opt out of one of them; the SDK still works (every
DB-dependent path checks the config and short-circuits on null).

In --yes mode (CI / scripting), the wizard runs without prompting and
either accepts what was passed via flags or applies the defaults.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			cwd, err := os.Getwd()
			if err != nil {
				return err
			}
			out := cmd.OutOrStdout()
			opts := wizard.RunOptions{
				CWD:           cwd,
				MountPath:     mountPath,
				YesToAll:      yes,
				WithPrompts:   !noPrompts,
				WithTraces:    !noTraces,
				SkipTestTrace: noTestTrace,
				APIKey:        apiKey,
				ProjectID:     projectID,
			}
			if withPrompts {
				opts.WithPrompts = true
			}
			if withTraces {
				opts.WithTraces = true
			}

			// OAuth: skip if creds passed explicitly, --skip-oauth set,
			// or running non-interactively without --api-key/--project.
			// Matches the TS wizard's "creds-or-browser-or-stub" branch.
			needsBrowserOAuth := apiKey == "" && projectID == "" && !skipOAuth && !yes
			if needsBrowserOAuth {
				fmt.Fprintln(out, "Opening browser for Gravel sign-in (skip with --skip-oauth or pass --api-key + --project)...")
				ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
				defer cancel()
				claim, err := wizard.BrowserOAuthHandshake(ctx, wizard.OAuthOptions{
					BaseURL: baseURL,
					OnAuthURL: func(u string) {
						fmt.Fprintf(out, "  If your browser didn't open, visit: %s\n", u)
					},
				})
				if err != nil {
					fmt.Fprintf(out, "  OAuth skipped: %v\n", err)
					fmt.Fprintln(out, "  Continuing without API credentials. Add them later via the dashboard or re-run `gravel init`.")
				} else {
					if err := wizard.WriteAPICredsToEnv(cwd, claim); err != nil {
						return fmt.Errorf("write OAuth credentials: %w", err)
					}
					opts.APIKey = claim.APIKey
					opts.ProjectID = claim.ProjectID
					fmt.Fprintf(out, "  Signed in to %s\n", coalesce(claim.OrganizationName, claim.ProjectID))
				}
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
	cmd.Flags().StringVar(&apiKey, "api-key", "", "Pre-bake project key into .env.local.")
	cmd.Flags().StringVar(&projectID, "project", "", "Pre-bake project ID into .env.local.")
	cmd.Flags().BoolVar(&skipOAuth, "skip-oauth", false, "Skip the browser sign-in handshake.")
	cmd.Flags().StringVar(&baseURL, "control-plane", "", "Override the gravel.artanis.ai control-plane URL (testing only).")
	return cmd
}

func coalesce(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

func printSummary(cmd *cobra.Command, r wizard.RunResult) {
	out := cmd.OutOrStdout()
	d := r.Detection
	fmt.Fprintf(out, "Detected %s, %s, pkg=%s",
		d.Language, d.Framework, d.PackageManager,
	)
	if d.DBDriver != wizard.DBUnknown {
		fmt.Fprintf(out, ", db=%s", d.DBDriver)
	}
	if d.Auth != wizard.AuthUnknown {
		fmt.Fprintf(out, ", auth=%s", d.Auth)
	}
	fmt.Fprintln(out)
	if d.NextHasBothRouters {
		fmt.Fprintln(out, "Warning: both `app/` and `pages/` detected. Mounted under App Router (preferred).")
	}

	// SDK auto-install outcome. Surface before the config-file line
	// because chronologically it ran first (and a Failed result is
	// the thing the user most likely needs to act on).
	switch r.SDKInstall.Kind {
	case wizard.SDKAdded:
		fmt.Fprintf(out, "OK Added %s to dependencies.\n", r.SDKInstall.Package)
	case wizard.SDKAlreadyPresent:
		fmt.Fprintf(out, "OK %s already in dependencies, kept as-is.\n", r.SDKInstall.Package)
	case wizard.SDKSkippedNoManifest:
		fmt.Fprintf(out, "Note: no manifest in cwd. Add the SDK yourself:\n    %s\n", r.SDKInstall.Command)
	case wizard.SDKFailed:
		fmt.Fprintf(out, "Warning: SDK install command failed. Re-run yourself:\n    %s\n", r.SDKInstall.Command)
		if r.SDKInstall.Stderr != "" {
			fmt.Fprintln(out, "  (stderr from the failed run is above)")
		}
	}

	fmt.Fprintf(out, "OK Wrote %s\n", r.ConfigPath)
	switch r.Mount.Mode {
	case wizard.MountCreated:
		fmt.Fprintf(out, "OK Created %s\n", r.Mount.Path)
	case wizard.MountUpdated:
		fmt.Fprintf(out, "OK Updated %s\n", r.Mount.Path)
	case wizard.MountManual:
		fmt.Fprintln(out, "\nDashboard mount: this framework needs a manual step.")
		fmt.Fprintln(out, r.Mount.Instructions)
	case wizard.MountSkipped:
		fmt.Fprintln(out, "Dashboard mount: skipped.")
	}
	if r.AdminPwIsNew {
		fmt.Fprintf(out, "OK Generated GRAVEL_ADMIN_PASSWORD: %s\n", r.AdminPassword)
	} else {
		fmt.Fprintln(out, "OK GRAVEL_ADMIN_PASSWORD already set, kept as-is.")
	}

	// DB probe + migrate outcome (traces pillar).
	switch r.DBProbe.Kind {
	case wizard.ProbeOK:
		if r.MigrateApplied {
			fmt.Fprintln(out, "OK Ran schema bootstrap.")
		}
	case wizard.ProbeNoURL:
		fmt.Fprintln(out, "Traces: no DATABASE_URL detected. Set one in .env.local and re-run `gravel init --traces` when ready.")
	case wizard.ProbePlaceholder:
		fmt.Fprintf(out, "Traces: skipped (DATABASE_URL looks like a placeholder: %s). Update and re-run `gravel init --traces`.\n", r.DBProbe.URL)
	case wizard.ProbeConnectFailed:
		switch r.DBProbe.Reason {
		case wizard.FailAuth:
			fmt.Fprintf(out, "Traces: couldn't authenticate against %s. Check the credentials in your DATABASE_URL and re-run `gravel init --traces`.\n", r.DBProbe.URL)
		case wizard.FailHost:
			fmt.Fprintf(out, "Traces: couldn't reach %s. Start your DB and re-run `gravel init --traces`.\n", r.DBProbe.URL)
		default:
			fmt.Fprintf(out, "Traces: DB probe failed: %s\n", r.DBProbe.Message)
		}
	}

	if r.ManifestPath != "" {
		fmt.Fprintf(out, "OK Wrote %s (%d prompts).\n", r.ManifestPath, r.ManifestCount)
	}
	switch r.Hook.Mode {
	case wizard.HookHusky:
		fmt.Fprintf(out, "OK Installed pre-commit hook (husky): %s\n", r.Hook.Path)
	case wizard.HookPreCommitFramework:
		fmt.Fprintf(out, "OK Installed pre-commit hook (pre-commit framework): %s\n", r.Hook.Path)
	case wizard.HookNative:
		fmt.Fprintf(out, "OK Installed pre-commit hook (native git hook): %s\n", r.Hook.Path)
	case wizard.HookSkipped:
		fmt.Fprintln(out, "Pre-commit hook: skipped (no .git directory).")
	}

	fmt.Fprintln(out)
	fmt.Fprintln(out, "Gravel skeleton installed. Next:")
	fmt.Fprintf(out, "  1. Visit /admin/ai in your app and log in.\n")
	fmt.Fprintf(out, "  2. Edit your getUser callback in %s to match your auth.\n", r.ConfigPath)
	fmt.Fprintln(out, "  3. Read https://gravel.artanis.ai/docs")
}
