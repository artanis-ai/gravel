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
		mountPath   string
		yes         bool
		withPrompts bool
		noPrompts   bool
		withTraces  bool
		noTraces    bool
		noTestTrace bool
		apiKey      string
		projectID   string
	)
	cmd := &cobra.Command{
		Use:   "init",
		Short: "Install Gravel into the current project.",
		Long: `init runs the install wizard against the current directory:

  1. Detect framework, package manager, auth provider, DB driver.
  2. (--oauth only) Authenticate against gravel.artanis.ai via a browser
     handshake. Off by default while the control-plane endpoint is stubbed;
     pre-bake creds via --api-key + --project for CI flows.
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
	cmd.Flags().StringVar(&apiKey, "api-key", "", "Pre-bake project key into .env.local. Reads $GRAVEL_API_KEY if unset.")
	cmd.Flags().StringVar(&projectID, "project", "", "Pre-bake project ID into .env.local. Reads $GRAVEL_PROJECT_ID if unset.")
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
