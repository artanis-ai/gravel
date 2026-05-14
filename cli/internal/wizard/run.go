package wizard

import (
	"context"
	"fmt"
	"io"
	"path/filepath"
	"strings"
	"time"

	"github.com/artanis-ai/gravel/cli/internal/doctor"
	"github.com/artanis-ai/gravel/cli/internal/manifest"
	"github.com/artanis-ai/gravel/cli/internal/migrate"
	"github.com/artanis-ai/gravel/cli/internal/stack"
	"github.com/artanis-ai/gravel/cli/internal/version"
)

// RunOptions captures the choices the user passes to `gravel init`.
// PromptsExplicit / TracesExplicit tell the wizard whether the user
// explicitly enabled or disabled a pillar via flag (controls whether
// to show the "Continue?" question or skip straight in/over).
type RunOptions struct {
	CWD               string
	MountPath         string
	MountPathExplicit bool // true when the user passed --mount-path; skips the "Mount path?" prompt
	YesToAll          bool
	WithPrompts       bool
	PromptsExplicit   bool
	WithTraces        bool
	TracesExplicit    bool
	SkipTestTrace     bool
	SkipDeepScan      bool // --no-deep-scan: short-circuits the "Did I find everything?" loop
	SkipSDKInstall    bool // tests + advanced users
	APIKey            string
	ProjectID         string
	Prompter          Prompter
}

// RunResult bundles everything the cobra layer might want to surface.
type RunResult struct {
	Detection      Detection
	SDKInstall     SDKInstallResult
	State          InspectedState
	ConfigPath     string
	Mount          MountResult
	AdminPassword  string
	AdminPwIsNew   bool
	Hook           HookResult
	DBProbe        DBProbeResult
	MigrateApplied bool
	ManifestPath   string
	ManifestCount  int
	PromptsRan     bool
	TracesRan      bool
	// Blockers collected during the run. Non-fatal errors accrue here
	// and the cobra layer surfaces them at the end so the user has a
	// single list of things to fix rather than a stack trace mid-flow.
	Blockers []string
}

// Run executes the wizard end-to-end. See cli/DESIGN.md for the
// step-by-step contract.
//
// stdout/stderr are the caller's responsibility — Prompter.Info is
// the wizard's voice; structural output (step headers, bullets,
// spinners) goes through the UI helpers in ui.go.
func Run(ctx context.Context, opts RunOptions, _ io.Writer) (RunResult, error) {
	if opts.CWD == "" {
		return RunResult{}, fmt.Errorf("RunOptions.CWD is required")
	}
	if opts.MountPath == "" {
		opts.MountPath = "/admin/ai"
	}
	if opts.Prompter == nil {
		opts.Prompter = PrompterFromOptions(opts.YesToAll)
	}

	d := Detect(opts.CWD)
	state := InspectState(opts.CWD, d)
	interactive := isInteractive(opts.Prompter)

	Welcome("Gravel install", "Embedded prompt management and evals for domain experts")
	dbLabel := "unknown"
	if d.DBDriver != DBUnknown {
		dbLabel = string(d.DBDriver)
	}
	Say(fmt.Sprintf("Detected %s (%s, %s, db=%s). I'll walk you through three things; you can skip any.",
		Bold(string(d.Framework)), d.Language, d.PackageManager, dbLabel))
	if d.NextHasBothRouters {
		Bullet(fmt.Sprintf("Heads-up: this project has both %s/ and pages/. I'll mount under the App Router. Re-run with --framework or hand-mount inside pages/ if you want that instead.", string(d.NextAppDir)), BulletWarn)
		Say("")
	}

	// SDK auto-install. Runs BEFORE any pillar so the user's editor
	// can type-check the gravel.config.ts we're about to write.
	var sdkResult SDKInstallResult
	if !opts.SkipSDKInstall {
		pkg := gravelPackageName(d.Language)
		sp := NewSpinner(fmt.Sprintf("Adding %s to dependencies…", Bold(pkg)))
		sdkResult = EnsureSDKInstalled(ctx, d)
		switch sdkResult.Kind {
		case SDKAdded:
			sp.Stop(fmt.Sprintf("Added %s to dependencies", Bold(pkg)))
		case SDKAlreadyPresent:
			sp.Stop(fmt.Sprintf("%s already in dependencies", Bold(pkg)))
		case SDKSkippedNoManifest:
			sp.Fail(fmt.Sprintf("No project manifest in cwd; add %s yourself with: %s", pkg, Bold(sdkResult.Command)))
		case SDKFailed:
			sp.Fail(fmt.Sprintf("Install failed: %s", Bold(sdkResult.Command)))
			if strings.TrimSpace(sdkResult.Stderr) != "" {
				Say("")
				Say(Dim(strings.TrimRight(sdkResult.Stderr, "\n")))
				Say("")
			}
			Say("Fix the install above (or pass --skip-sdk-install if you'll add the dep yourself) and re-run gravel init. Aborting before we wire up files against an uninstalled SDK.")
			return RunResult{
				Detection:  d,
				SDKInstall: sdkResult,
				State:      state,
			}, fmt.Errorf("SDK install failed: %s", sdkResult.Command)
		}
	}

	result := RunResult{
		Detection:  d,
		SDKInstall: sdkResult,
		State:      state,
	}

	// ── Step 1 of 3 — Dashboard ──────────────────────────────────────
	StepHeader(1, 3, "Dashboard")
	Say("First I'll mount the embedded admin UI. This is where your domain experts open Gravel: they'll see prompts to edit and (later) LLM outputs to review. I'll also write a " + Bold("gravel.config.ts") + " so you can wire up your own " + Bold("getUser") + " callback later if you want to use your own auth.")

	mountPath := opts.MountPath
	dashboardWritten := false
	envFile := state.EnvFileWithPassword
	if envFile == "" {
		envFile = ".env.local"
	}

	switch {
	case state.MountExists && state.EnvHasPassword:
		// Idempotent re-run: the mount file already exists AND the
		// password is in .env.local/.env. Don't re-mount — the user
		// can wipe + re-run if they want a fresh state.
		Bullet(fmt.Sprintf("Already wired up at %s. Skipping.", Bold(mountPath)), BulletSkip)
		Note(fmt.Sprintf("(Re-run with a clean %s + %s removed if you want to start over.)", envFile, state.MountFilePath))
		Say("")
		dashboardWritten = true
		result.ConfigPath = filepath.Join(opts.CWD, configFilenameFor(d))
	default:
		// Interactive mount-path tweak. CLI --mount-path skips this.
		if interactive && !opts.MountPathExplicit {
			typed, err := opts.Prompter.Text(fmt.Sprintf("Mount path %s", Dim("(Enter to accept default "+mountPath+")")), mountPath)
			if err == nil {
				if cleaned := strings.TrimSpace(typed); cleaned != "" {
					if !strings.HasPrefix(cleaned, "/") {
						cleaned = "/" + cleaned
					}
					mountPath = cleaned
				}
			}
		}

		pw, isNew, err := EnsureAdminPassword(opts.CWD)
		if err != nil {
			result.Blockers = append(result.Blockers, fmt.Sprintf("Admin password write failed: %s", err))
			return result, fmt.Errorf("write admin password: %w", err)
		}
		result.AdminPassword = pw
		result.AdminPwIsNew = isNew
		// Pre-bake cloud creds into .env.local when both flags came in.
		// One half on its own is meaningless to the SDK so we only write
		// when we have a pair. upsertEnvVar leaves existing values alone.
		if opts.APIKey != "" && opts.ProjectID != "" {
			if err := upsertEnvVar(opts.CWD, "GRAVEL_PROJECT_ID", opts.ProjectID); err != nil {
				result.Blockers = append(result.Blockers, fmt.Sprintf("Couldn't write GRAVEL_PROJECT_ID: %s", err))
			}
			if err := upsertEnvVar(opts.CWD, "GRAVEL_API_KEY", opts.APIKey); err != nil {
				result.Blockers = append(result.Blockers, fmt.Sprintf("Couldn't write GRAVEL_API_KEY: %s", err))
			}
		}

		sp := NewSpinner("Mounting dashboard…")
		configPath, err := GenerateConfig(d, ConfigOptions{
			MountPath:    mountPath,
			WithDatabase: false, // re-written with db block in step 3 if traces confirms a DB
		})
		if err != nil {
			sp.Fail(fmt.Sprintf("Config write failed: %s", err))
			result.Blockers = append(result.Blockers, fmt.Sprintf("Mount failed: %s", err))
			return result, fmt.Errorf("write config: %w", err)
		}
		result.ConfigPath = configPath
		mount, err := Mount(d, mountPath, MountOptions{WithTracingDeps: false})
		if err != nil {
			sp.Fail(fmt.Sprintf("Mount failed: %s", err))
			result.Blockers = append(result.Blockers, fmt.Sprintf("Mount failed: %s", err))
			return result, fmt.Errorf("mount dashboard: %w", err)
		}
		result.Mount = mount
		switch mount.Mode {
		case MountCreated:
			sp.Stop(fmt.Sprintf("Wrote %s", Bold(describeMount(d, mountPath))))
		case MountUpdated:
			sp.Stop(fmt.Sprintf("Updated mount at %s", Bold(mountPath)))
		case MountManual:
			// Don't show a green ✓: the wizard couldn't auto-patch and
			// is asking the user to do the rest. Use Fail to swap in a
			// red ✗ on the spinner line, then dump the instructions
			// inline. The Step 1 idempotency check skips this on re-run
			// (mount file already present), so we don't spam on retry.
			sp.Fail("Couldn't auto-patch your app entry. Manual mount instructions below.")
			Say(mount.Instructions)
		default:
			sp.Stop("Dashboard mount skipped")
		}

		if isNew {
			Bullet(fmt.Sprintf("Admin password saved to %s", Bold(envFile)), BulletOK)
		} else {
			Bullet(fmt.Sprintf("Admin password already set in %s, kept as-is", Bold(envFile)), BulletSkip)
		}
		Bullet(fmt.Sprintf("%s written", Bold(configFilenameFor(d))), BulletOK)
		dashboardWritten = true
	}

	// Best-effort dashboard URL + pause so the user can verify Step 1
	// landed before Step 2 charges on.
	port := GuessDevPort(opts.CWD, d)
	dashboardURL := mountPath
	if port > 0 {
		dashboardURL = fmt.Sprintf("http://localhost:%d%s", port, mountPath)
	}
	if dashboardWritten {
		Say("")
		if port > 0 {
			Say("When your dev server's running, open " + Cyan(dashboardURL) + " and log in with the password from " + Bold(envFile) + ".")
		} else {
			Say("When your dev server's running, open " + Bold(dashboardURL) + " on whatever host:port your app uses, and log in with the password from " + Bold(envFile) + ".")
		}
		// Common footgun: user already had `uvicorn --reload` /
		// `next dev` running when they invoked `gravel init`. We just
		// wrote new mount code into files the running process won't
		// see until it restarts; the dashboard 404s and the user
		// thinks the install is broken. Warn loudly when we can
		// see something already listening on the framework port.
		if port > 0 && ServerListeningOnPort(port) {
			Say("")
			Bullet(
				Bold("Heads up:")+" something's already listening on port "+Cyan(fmt.Sprintf("%d", port))+
					". If that's your dev server, restart it before opening the dashboard, otherwise the routes I just wrote won't be loaded and the dashboard will 404.",
				BulletWarn,
			)
		}
		_ = opts.Prompter.PressEnter("Press Enter once you can see the dashboard (or Enter to skip ahead)")
	}

	// ── Step 2 of 3 — Prompts ────────────────────────────────────────
	wantPrompts := opts.WithPrompts
	if !opts.PromptsExplicit {
		StepHeader(2, 3, "Prompts")
		Say("Now I'll scan your repo for prompt files (" + Bold(".md") + " / " + Bold(".txt") + " under " + Bold("prompts/") + ", " + Bold("templates/") + ", etc.) and write a manifest. Your team edits these from the dashboard; nothing is sent anywhere, no DB needed.")
		if confirmed, err := opts.Prompter.YesNo("Continue?", true); err == nil {
			wantPrompts = confirmed
		}
	} else if opts.WithPrompts {
		StepHeader(2, 3, "Prompts ("+Dim("--prompts")+")")
	}

	if !wantPrompts && !opts.PromptsExplicit {
		Bullet("Skipped. Run `gravel init --prompts` later.", BulletSkip)
	}

	if wantPrompts {
		m, err := RunScanAndVerify(ctx, opts.CWD, opts.Prompter, opts.SkipDeepScan || !interactive)
		if err != nil {
			result.Blockers = append(result.Blockers, fmt.Sprintf("Scan failed: %s", err))
		}
		if m != nil {
			result.ManifestPath = filepath.Join(opts.CWD, manifest.Path)
			result.ManifestCount = len(m.Prompts)
			result.PromptsRan = true

			// Pre-commit hook is a SEPARATE question AFTER the scan,
			// only when git is detected and no hook is already in
			// place. Never the first thing a user is asked.
			switch {
			case state.HookInstalled:
				Bullet("Pre-commit hook already installed", BulletSkip)
			case d.HasGit:
				Say("Optional: install a pre-commit hook so the manifest stays in sync with your repo (so when you change a prompt file, the manifest updates automatically).")
				installHook := true
				if !opts.PromptsExplicit {
					if confirmed, err := opts.Prompter.YesNo("Install the hook?", true); err == nil {
						installHook = confirmed
					}
				}
				if installHook {
					sp := NewSpinner("Installing pre-commit hook…")
					hook, err := InstallHook(opts.CWD)
					if err != nil {
						sp.Fail(fmt.Sprintf("Hook install failed: %s", err))
						result.Blockers = append(result.Blockers, fmt.Sprintf("Hook install failed: %s", err))
					} else {
						result.Hook = hook
						sp.Stop(fmt.Sprintf("Hook installed (%s)", Bold(string(hook.Mode))))
					}
				}
			default:
				Note("(No .git/. Skipping pre-commit hook.)")
			}

			// Open-the-Prompts-tab hint + pause before Step 3.
			Say("Open the " + Bold("Prompts") + " tab in the dashboard and try editing one. Drafts are saved in the browser; to allow your team to submit changes, you'll need to connect the Gravel GitHub App, which you can do any time via the dashboard. PRs will be opened by " + Bold("gravel[bot]") + ".")
			_ = opts.Prompter.PressEnter("")
		}
	}

	// ── Step 3 of 3 — Traces ─────────────────────────────────────────
	dbName := ""
	switch d.DBDriver {
	case DBPostgres:
		dbName = "Postgres"
	case DBSQLite:
		dbName = "SQLite"
	}
	dbPhrase := "your database (you'll wire " + Bold("DATABASE_URL") + " in a moment)"
	if dbName != "" {
		dbPhrase = "your " + Bold(dbName) + " database"
	}
	tracerPhrase := "auto-tracing for raw fetch (no LLM SDKs detected; install one and re-run to add it)"
	if len(d.LLMLibs) > 0 {
		libs := make([]string, len(d.LLMLibs))
		for i, l := range d.LLMLibs {
			libs[i] = Bold(string(l))
		}
		tracerPhrase = "auto-tracing for " + strings.Join(libs, ", ") + ", plus raw fetch"
	}

	wantTraces := opts.WithTraces
	if !opts.TracesExplicit {
		StepHeader(3, 3, "Traces")
		Say("Last step: capture every LLM call your app makes. I'll add " + Bold("two tables") + " (gravel_samples, gravel_feedback) to " + dbPhrase + " and turn on " + tracerPhrase + ". Your team reviews the calls in the " + Bold("Review") + " tab.")
		if confirmed, err := opts.Prompter.YesNo("Continue?", true); err == nil {
			wantTraces = confirmed
		}
	} else if opts.WithTraces {
		StepHeader(3, 3, "Traces ("+Dim("--traces")+")")
	}

	if !wantTraces && !opts.TracesExplicit {
		Bullet("Skipped. Run `gravel init --traces` later.", BulletSkip)
	}

	tracesAttempted := false
	tracesSkipReason := ""
	if wantTraces {
		tracesAttempted = true
		probeSp := NewSpinner("Checking DATABASE_URL…")
		probe := ProbeDatabase(ctx, opts.CWD)
		result.DBProbe = probe
		switch probe.Kind {
		case ProbeOK:
			probeSp.Stop(fmt.Sprintf("Connected to %s OK", Bold(string(probe.Dialect))))
			// "Already bootstrapped?" check. If both tables exist,
			// skip the create-tables question.
			already, _ := migrate.TablesAlreadyExist(ctx, probe.URL, probe.Dialect)
			if already {
				Bullet("gravel_* tables already exist. Skipping CREATE.", BulletSkip)
				result.MigrateApplied = false
			} else {
				wantMigrate := true
				if interactive && !opts.TracesExplicit {
					yn, err := opts.Prompter.YesNo("Create the two gravel_* tables now? "+Dim("(idempotent CREATE TABLE IF NOT EXISTS)"), true)
					if err == nil {
						wantMigrate = yn
					}
				}
				if wantMigrate {
					mig := NewSpinner("Bootstrapping gravel_* tables…")
					applied, err := tryMigrateURL(ctx, probe.URL)
					if err != nil {
						mig.Fail(fmt.Sprintf("Bootstrap failed: %s", err))
						result.Blockers = append(result.Blockers, fmt.Sprintf("Bootstrap failed: %s", err))
						tracesSkipReason = fmt.Sprintf("Bootstrap failed (%s). Re-run with `gravel migrate`.", err)
					} else {
						result.MigrateApplied = applied
						mig.Stop("Two gravel_* tables ready")
					}
				} else {
					tracesSkipReason = "Tables not created. Run `gravel migrate` later."
				}
			}
			// Tracing hooks (Next.js only). Skip if the user already
			// has an instrumentation.ts so we don't clobber their edits.
			if d.Framework == FrameworkNextAppRouter || d.Framework == FrameworkNextPagesRouter {
				if state.InstrumentationExists {
					Bullet("instrumentation.ts already present", BulletSkip)
				} else {
					sp := NewSpinner("Wiring instrumentation.ts + next.config externals…")
					srcLayout := d.Framework == FrameworkNextAppRouter && d.NextAppDir == "src/app"
					if err := InstallNextTracingHooks(d.CWD, srcLayout); err != nil {
						sp.Fail(fmt.Sprintf("Tracing hook install failed: %s", err))
						result.Blockers = append(result.Blockers, fmt.Sprintf("Tracing hook install failed: %s", err))
					} else {
						sp.Stop("Tracing hooks installed")
					}
				}
			}
			Say("")
			Say("Trigger an LLM call from your app: auto-tracing's on, so the call lands in the " + Bold("Review") + " tab as soon as it completes.")
			result.TracesRan = true
		case ProbeNoURL:
			probeSp.Fail("No DATABASE_URL detected in .env / .env.local")
			Say("")
			Say("Set " + Bold("DATABASE_URL") + " in " + Bold(".env.local") + " and re-run " + Bold("gravel init --traces") + " when you're ready. The dashboard's Review tab will keep nudging you until tables exist.")
			tracesSkipReason = "No DATABASE_URL. Fix .env.local and run `gravel init --traces`."
		case ProbePlaceholder:
			probeSp.Fail("DATABASE_URL still has placeholder credentials")
			Note("  " + probe.URL)
			Say("")
			Say("That URL looks like a tutorial default. Swap in real credentials in " + Bold(".env.local") + " and re-run " + Bold("gravel init --traces") + ".")
			tracesSkipReason = "DATABASE_URL has placeholder credentials."
		case ProbeConnectFailed:
			switch probe.Reason {
			case FailAuth:
				probeSp.Fail("Couldn't connect: " + probe.Message)
				Say("")
				Say("Looks like a credentials problem. Fix " + Bold(".env.local") + " and re-run.")
			case FailHost:
				probeSp.Fail("Couldn't reach the database: " + probe.Message)
				Say("")
				Say("Is the database reachable? Try " + Bold(`psql "$DATABASE_URL"`) + " from your shell.")
			default:
				probeSp.Fail("DB probe failed: " + probe.Message)
			}
			if interactive {
				_, _ = opts.Prompter.YesNo("Skip Traces for now and continue?", true)
			}
			tracesSkipReason = "DB unreachable. Fix and re-run `gravel init --traces`."
		}
	}

	// Rewrite gravel.config.ts with the database block ONLY after the
	// traces pillar has actually been attempted. Mirrors TS §line 344:
	// the dashboard-only / prompts-only paths leave the config without
	// a `database` field so the handler short-circuits cleanly.
	if dashboardWritten && tracesAttempted {
		sp := NewSpinner("Updating gravel.config.ts with database block…")
		if _, err := GenerateConfig(d, ConfigOptions{
			MountPath:    mountPath,
			WithDatabase: true,
		}); err != nil {
			sp.Fail(fmt.Sprintf("Could not update gravel.config.ts: %s", err))
			result.Blockers = append(result.Blockers, fmt.Sprintf("Could not update gravel.config.ts: %s", err))
		} else {
			sp.Stop("gravel.config.ts updated")
		}
	}

	// ── Closing summary ──────────────────────────────────────────────
	Say("")
	Done("Done.")
	if port > 0 {
		Bullet(fmt.Sprintf("Dashboard at %s (password in %s)", Cyan(dashboardURL), Bold(envFile)), BulletOK)
	} else {
		Bullet(fmt.Sprintf("Dashboard at %s, mount path under your app (password in %s)", Bold(dashboardURL), Bold(envFile)), BulletOK)
	}
	if result.PromptsRan {
		hookSuffix := ""
		if result.Hook.Mode != "" {
			hookSuffix = ", hook installed"
		}
		Bullet(fmt.Sprintf("Prompts: %d in manifest%s", result.ManifestCount, hookSuffix), BulletOK)
	} else if opts.PromptsExplicit && !opts.WithPrompts {
		Bullet("Prompts: skipped (re-run with `gravel init --prompts`)", BulletSkip)
	}
	if result.MigrateApplied {
		Bullet("Traces: tables created, auto-tracing wired up", BulletOK)
	} else if opts.TracesExplicit && !opts.WithTraces {
		Bullet("Traces: skipped (re-run with `gravel init --traces`)", BulletSkip)
	} else if tracesSkipReason != "" {
		Bullet("Traces: "+tracesSkipReason, BulletSkip)
	}

	// Update-check on exit. checkVersionAndNudge enforces a 3-second
	// budget so a slow registry doesn't make init feel hung; honors
	// GRAVEL_VERSION_CHECK_DISABLED via doctor.FetchLatest.
	checkVersionAndNudge(ctx, d)

	// Blockers: surface non-fatal failures as a final visible list so
	// the user has a single thing to action rather than scrolling.
	if len(result.Blockers) > 0 {
		Say("")
		Say(Bold("Blockers to address:"))
		for _, b := range result.Blockers {
			Bullet(b, BulletWarn)
		}
	}

	return result, nil
}

// tryMigrateURL runs `gravel migrate` against an already-probed URL.
func tryMigrateURL(ctx context.Context, url string) (bool, error) {
	db, dialect, err := migrate.Open(ctx, url)
	if err != nil {
		return false, err
	}
	defer db.Close()
	if err := migrate.Bootstrap(ctx, db, dialect); err != nil {
		return false, err
	}
	return true, nil
}

// IsTSStack reports whether the detection targets a TypeScript host.
func (d Detection) IsTSStack() bool { return d.Language == stack.LanguageTS }

// configFilenameFor returns "gravel.config.ts" or "gravel_config.py"
// based on the detected host language. Used by the idempotent skip
// path to report the right path back to the user.
func configFilenameFor(d Detection) string {
	if d.Language == stack.LanguagePython {
		return "gravel_config.py"
	}
	return "gravel.config.ts"
}

// describeMount returns the short relative path of the mount file
// for the user-facing "Wrote X" log line in Step 1. Mirrors the
// TS reference (packages/sdk-ts/src/wizard/index.ts §describeMount)
// which interpolates the active mount path into the label.
func describeMount(d Detection, mountPath string) string {
	switch d.Framework {
	case FrameworkNextAppRouter:
		dir := "app"
		if d.NextAppDir == "src/app" {
			dir = "src/app"
		}
		return fmt.Sprintf("%s%s/[[...slug]]/route.ts", dir, mountPath)
	case FrameworkNextPagesRouter:
		return fmt.Sprintf("pages%s/[[...slug]].ts", mountPath)
	case FrameworkFastAPI:
		return "gravel_route.py"
	case FrameworkDjango:
		return "urls.py (patched)"
	}
	return "mount file"
}

// isInteractive returns true when the prompter is the real tty one
// (not DefaultsPrompter). Used to gate text inputs that need a human.
func isInteractive(p Prompter) bool {
	_, ok := p.(DefaultsPrompter)
	return !ok
}

// checkVersionAndNudge consults the GitHub release API for the latest
// tag and, if the running binary is older, prints a "Update available"
// bullet with the install/upgrade command. Race against a 3-second
// budget — a slow registry hit shouldn't extend the wizard.
func checkVersionAndNudge(ctx context.Context, _ Detection) {
	// 3-second budget. doctor.FetchLatest honors the context deadline
	// (5-second internal timeout via its own context.WithTimeout, but
	// our shorter parent deadline wins), so we don't need a separate
	// goroutine + select race.
	shortCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	latest, _ := doctor.FetchLatest(shortCtx)
	if latest == "" {
		return
	}
	if !doctor.IsNewer(version.Version, latest) {
		return
	}
	Say("")
	Bullet(fmt.Sprintf("Update available: %s → %s. Run %s.",
		version.Version, Bold(latest),
		Cyan("curl -fsSL https://raw.githubusercontent.com/artanis-ai/gravel/main/install.sh | sh")),
		BulletSkip)
}
