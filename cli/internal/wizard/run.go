package wizard

import (
	"context"
	"fmt"
	"io"
	"path/filepath"

	"github.com/artanis-ai/gravel/cli/internal/manifest"
	"github.com/artanis-ai/gravel/cli/internal/migrate"
	"github.com/artanis-ai/gravel/cli/internal/stack"
)

// RunOptions captures the choices the user passes to `gravel init`.
// Mirrors the CLI flags. Pass an explicit Prompter to override the
// default (tty → real prompter, --yes → defaults).
type RunOptions struct {
	CWD           string
	MountPath     string
	YesToAll      bool
	WithPrompts   bool // install the prompts pillar (manifest + hook)
	WithTraces    bool // install the traces pillar (DB + migrations)
	SkipTestTrace bool
	APIKey        string   // pre-bake into .env.local
	ProjectID     string   // pre-bake into .env.local
	Prompter      Prompter // optional override; PrompterFromOptions(YesToAll) used otherwise
}

// RunResult bundles everything the cobra layer might want to surface
// to the user. Designed so the same data can drive both the
// human-readable summary and a future `--json` flag.
type RunResult struct {
	Detection      Detection
	ConfigPath     string
	Mount          MountResult
	AdminPassword  string
	AdminPwIsNew   bool
	Hook           HookResult
	DBProbe        DBProbeResult // populated when WithTraces is true
	MigrateApplied bool
	ManifestPath   string
	ManifestCount  int
	OAuthClaim     *OAuthClaim // populated when the wizard ran the browser handshake
}

// Run executes the wizard end-to-end against opts.CWD. Side effects
// are deliberate and ordered so a failure midway leaves the project
// in a recoverable state:
//   1. Detect (read-only)
//   2. Write gravel.config (file create; safe to overwrite)
//   3. Mount dashboard route (file create with backup)
//   4. Write GRAVEL_ADMIN_PASSWORD to .env.local (idempotent)
//   5. Run migrate (DB-only; gated by WithTraces + DATABASE_URL)
//   6. Initialise manifest + install hook (gated by WithPrompts)
//
// stdout/stderr are the caller's responsibility; this function
// returns the structured result so the cobra layer can format it.
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

	// Confirm pillar selection when the user didn't pass explicit
	// flags. DefaultsPrompter under --yes / non-TTY returns the
	// supplied default unchanged, so the same code path drives CI
	// and interactive runs.
	if !opts.YesToAll {
		if wantPrompts, err := opts.Prompter.YesNo(
			"Install the prompts pillar (scan repo, install pre-commit hook)?",
			opts.WithPrompts,
		); err == nil {
			opts.WithPrompts = wantPrompts
		}
		if wantTraces, err := opts.Prompter.YesNo(
			"Install the traces pillar (DB tables + tracing on LLM calls)?",
			opts.WithTraces,
		); err == nil {
			opts.WithTraces = wantTraces
		}
	}

	configPath, err := GenerateConfig(d, ConfigOptions{
		MountPath:    opts.MountPath,
		WithDatabase: opts.WithTraces,
	})
	if err != nil {
		return RunResult{}, fmt.Errorf("write config: %w", err)
	}

	mount, err := Mount(d, opts.MountPath, MountOptions{
		WithTracingDeps: opts.WithTraces,
	})
	if err != nil {
		return RunResult{}, fmt.Errorf("mount dashboard: %w", err)
	}

	pw, isNew, err := EnsureAdminPassword(opts.CWD)
	if err != nil {
		return RunResult{}, fmt.Errorf("write admin password: %w", err)
	}

	result := RunResult{
		Detection:     d,
		ConfigPath:    configPath,
		Mount:         mount,
		AdminPassword: pw,
		AdminPwIsNew:  isNew,
	}

	if opts.WithTraces {
		// Pre-flight probe: catch unset / placeholder / unreachable
		// URLs BEFORE attempting bootstrap. The probe never aborts
		// the wizard; the cobra layer prints a clear note for each
		// outcome and the rest of init still runs (config + mount
		// have already landed and re-running `gravel init --traces`
		// later picks up the missing DB pillar).
		probe := ProbeDatabase(ctx, opts.CWD)
		result.DBProbe = probe
		if probe.Kind == ProbeOK {
			applied, err := tryMigrateURL(ctx, probe.URL)
			if err == nil {
				result.MigrateApplied = applied
			}
		}
	}

	if opts.WithPrompts {
		current, err := manifest.Read(opts.CWD)
		if err != nil {
			return result, fmt.Errorf("read manifest: %w", err)
		}
		scanRes, err := manifest.FastScan(opts.CWD, current)
		if err != nil {
			return result, fmt.Errorf("manifest scan: %w", err)
		}
		if err := manifest.Write(opts.CWD, scanRes.Manifest); err != nil {
			return result, fmt.Errorf("write manifest: %w", err)
		}
		result.ManifestPath = filepath.Join(opts.CWD, manifest.Path)
		result.ManifestCount = len(scanRes.Manifest.Prompts)

		hook, err := InstallHook(opts.CWD)
		if err != nil {
			return result, fmt.Errorf("install hook: %w", err)
		}
		result.Hook = hook
	}

	return result, nil
}

// tryMigrateURL runs `gravel migrate` against an already-probed URL.
// Probing ensures we don't double-Open(); the URL is the one
// ProbeDatabase confirmed works.
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
// Used by the cobra layer to skip TS-only steps on Python repos.
func (d Detection) IsTSStack() bool { return d.Language == stack.LanguageTS }
