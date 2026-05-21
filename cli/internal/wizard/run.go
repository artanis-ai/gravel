package wizard

import (
	"context"
	"fmt"
	"io"
	"os/exec"
	"path/filepath"
	"runtime"
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
	// Agent-detection signpost. When `gravel init` runs under an
	// agent (Claude Code, Codex, Cursor), the agent should be driving
	// pillar-by-pillar via `gravel mount --plan` / `--apply` etc. —
	// NOT `gravel init --yes`. Olly's 2026-05-21 dogfooding showed
	// agents reaching for `init --yes` because they only had the
	// landing page to go on. Print the curl-llms.txt line ALWAYS;
	// it's two lines of dim text for humans and a clear redirect for
	// any agent watching stdout.
	Note("Driving this install via an AI agent? Tell it to fetch the agent-facing install guide:")
	Note("  " + Bold("curl -fsSL https://artanis.ai/gravel/llms.txt"))
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
		case SDKBlockedByConstraint:
			// Resolver said no — typically `[tool.uv] exclude-newer` in
			// pyproject.toml cutting off the version we need. Never
			// silently install an older SDK; print the specific hint +
			// the raw stderr so the user (or agent) knows exactly what
			// to fix, then abort. Yousef's de-platform install
			// (2026-05-21): a `7 days` window excluded the just-published
			// SDK; pre-v0.10.3 the wizard silently fell through with
			// SDKFailed surfaced (or worse, didn't run at all in
			// step-subcommand paths) and FastAPI crashed at boot.
			sp.Fail(fmt.Sprintf("Install blocked: %s", Bold(sdkResult.Command)))
			Say("")
			Say(sdkResult.ConstraintHint)
			if strings.TrimSpace(sdkResult.Stderr) != "" {
				Say("")
				Say(Dim("Resolver output:"))
				Say(Dim(strings.TrimRight(sdkResult.Stderr, "\n")))
			}
			Say("")
			Say("Fix the project constraint and re-run. Don't downgrade — installing an older SDK against this wizard breaks features at boot.")
			return RunResult{
				Detection:  d,
				SDKInstall: sdkResult,
				State:      state,
			}, fmt.Errorf("SDK install blocked by project constraint: %s", sdkResult.ConstraintHint)
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
					hook, err := InstallHook(opts.CWD, d.PackageManager)
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
	// Gemini-via-Vertex / Gemini-Enterprise routing needs Google Cloud
	// auth (ADC / service account), NOT a Gemini API key. Flag it once
	// here so users don't think the tracer needs a separate credential.
	// Express Mode uses an API key + project ID — different signpost.
	geminiAuthHint := geminiVertexAuthHint(d)

	wantTraces := opts.WithTraces
	if !opts.TracesExplicit {
		StepHeader(3, 3, "Traces")
		Say("Last step: capture every LLM call your app makes. I'll add " + Bold("two tables") + " (gravel_samples, gravel_feedback) to " + dbPhrase + " and turn on " + tracerPhrase + ". Your team reviews the calls in the " + Bold("Review") + " tab.")
		if geminiAuthHint != "" {
			Note(geminiAuthHint)
		}
		if confirmed, err := opts.Prompter.YesNo("Continue?", true); err == nil {
			wantTraces = confirmed
		}
	} else if opts.WithTraces {
		StepHeader(3, 3, "Traces ("+Dim("--traces")+")")
		if geminiAuthHint != "" {
			Note(geminiAuthHint)
		}
	}

	if !wantTraces && !opts.TracesExplicit {
		Bullet("Skipped. Run `gravel init --traces` later.", BulletSkip)
	}

	tracesAttempted := false
	tracesSkipReason := ""
	if wantTraces {
		tracesAttempted = true
		// Python + postgres: make sure psycopg2 is in deps BEFORE the
		// probe runs. Pre-v0.10.0 this only ran via the standalone
		// `gravel traces --apply` subcommand; agents using `gravel init`
		// missed it entirely and hit "No module named 'psycopg2'" at
		// app boot. Olly's 2026-05-21 install was the canonical case.
		if NeedsPsycopg2(d) {
			depSp := NewSpinner("Adding psycopg2-binary to your Python deps…")
			dep := EnsureDepInstalled(ctx, d, "psycopg2-binary")
			switch dep.Kind {
			case SDKAlreadyPresent:
				depSp.Stop("psycopg2-binary already in deps")
			case SDKAdded:
				depSp.Stop("psycopg2-binary added")
			case SDKSkippedNoManifest:
				depSp.Fail("Couldn't add psycopg2-binary: no pyproject.toml found. Run `" + dep.Command + "` manually.")
				result.Blockers = append(result.Blockers,
					"psycopg2-binary install skipped (no pyproject.toml); run `"+dep.Command+"` manually before traces will work")
			case SDKFailed:
				depSp.Fail("psycopg2-binary install failed: " + dep.Stderr)
				result.Blockers = append(result.Blockers,
					"psycopg2-binary install failed: "+dep.Stderr+". Run `"+dep.Command+"` manually before traces will work.")
			}
		}
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

	// "What next?" menu. Interactive runs only — agents driving via
	// --yes / DefaultsPrompter never see it. The main pillars are
	// done; we offer the natural follow-ups Yousef called out
	// (2026-05-21 feedback): wire real auth, send install feedback,
	// or stop. Loops so the user can chain (e.g. wire auth → then
	// send feedback). llms.txt has the equivalent narration step for
	// agent-driven runs.
	if interactive {
		nextStepsMenu(d, mountPath, configFilenameFor(d), opts.Prompter)
	}

	return result, nil
}

// nextStepsMenu shows a short multiple-choice menu after the wizard's
// main pillars complete. Three options for v0.10.3 (Yousef's request):
//
//  1. Wire real auth — point at the `getUser` stub in gravel.config.{ts,py}
//     and explain how to replace it with the detected auth integration.
//  2. Send install feedback — print the feedback URL (and best-effort
//     `xdg-open`/`open` it).
//  3. Stop here — exit.
//
// Loops so picking 1 then 2 works without re-running `gravel init`.
// Defaults to option 3 so an unhanded Enter exits cleanly.
//
// Per Yousef's framing (2026-05-21): "extras" land here, NOT scattered
// inline mid-install. Keeps the main flow uncluttered for the common
// "I'm done, ship me" path.
func nextStepsMenu(d Detection, mountPath, configFilename string, prompter Prompter) {
	options := []string{
		"Wire your auth handler — replace the getUser stub in " + configFilename,
		"Send install feedback to the Gravel team",
		"Stop here",
	}
	for {
		Say("")
		idx, err := prompter.Select("What's next?", options, 2)
		if err != nil {
			return
		}
		switch idx {
		case 0:
			showWireAuthHint(d, configFilename)
		case 1:
			showFeedbackHint()
		case 2:
			return
		default:
			return
		}
	}
}

// showWireAuthHint prints a brief pointer at the getUser stub and the
// detected-auth integration snippet. Doesn't auto-modify the config —
// auth wiring is the one piece the user really has to read + understand
// before pasting, otherwise the dashboard would silently authorise the
// wrong identity.
func showWireAuthHint(d Detection, configFilename string) {
	Say("")
	Say("Open " + Bold(configFilename) + " and replace the " + Bold("getUser") + " stub with your auth integration.")
	switch d.Auth {
	case AuthClerk:
		Say("Detected auth: " + Bold("Clerk") + ". The Clerk template is in the config already; just remove the TODO + the stub return.")
	case AuthNextAuth:
		Say("Detected auth: " + Bold("NextAuth") + ". Import " + Bold("auth") + " from " + Bold("@/auth") + " and return `{ id: session.user.id }` when present.")
	case AuthDjango:
		Say("Detected auth: " + Bold("Django") + ". Read " + Bold("request.user") + " and return `{ id: str(request.user.pk) }` when authenticated.")
	case AuthFastAPIUsers:
		Say("Detected auth: " + Bold("fastapi-users") + ". Use the dependency-injected user from the FastAPI router and return its id.")
	default:
		Say("No auth library detected. Wire whatever you use (NextAuth / Clerk / Lucia / your own JWT) and return `{ id: '<user-id>' }`.")
	}
	Say("Once wired, redeploy and the dashboard will identify users by your real session.")
}

// showFeedbackHint prints the feedback URL + best-effort opens it in
// the user's browser. The /feedback page is dev-targeted (three
// explicit-action buttons rather than auto-mailto — v0.10.0 redesign).
func showFeedbackHint() {
	url := "https://gravel.artanis.ai/feedback"
	Say("")
	Say("Open " + Cyan(url) + " to drop the Gravel team a note about this install.")
	_ = tryOpenBrowser(url)
}

// tryOpenBrowser fires xdg-open / open / start best-effort. Silent
// failures are fine — the user already has the URL printed above.
func tryOpenBrowser(url string) error {
	var cmd string
	switch runtime.GOOS {
	case "linux":
		cmd = "xdg-open"
	case "darwin":
		cmd = "open"
	case "windows":
		cmd = "rundll32"
	default:
		return nil
	}
	if cmd == "rundll32" {
		return exec.Command(cmd, "url.dll,FileProtocolHandler", url).Start()
	}
	return exec.Command(cmd, url).Start()
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

// geminiVertexAuthHint returns a one-line note about the auth method
// the user's Vertex/Enterprise routing needs, or "" when no hint is
// needed. The wizard prints this above the Traces "Continue?" prompt so
// users don't think tracing requires a separate API key.
//
//   - Standard Vertex / Enterprise → ADC (`gcloud auth
//     application-default login`).
//   - Express Mode → uses the GEMINI_API_KEY / GOOGLE_API_KEY they
//     already set, no extra step.
//
// Tracing itself is auth-agnostic — the patch fires regardless. This is
// purely a courtesy to set expectations.
func geminiVertexAuthHint(d Detection) string {
	for _, lib := range d.LLMLibs {
		switch lib {
		case LLMGeminiVertex, LLMGeminiEnterprise:
			return "Vertex AI / Gemini Enterprise routing uses Google Cloud auth, not an API key. If you haven't already, run " + Cyan("gcloud auth application-default login") + " in this shell."
		case LLMGeminiVertexExpress:
			return "Vertex AI Express Mode picks up your " + Bold("GEMINI_API_KEY") + " + " + Bold("GOOGLE_CLOUD_PROJECT") + " automatically. No extra auth step needed for the tracer."
		}
	}
	return ""
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
