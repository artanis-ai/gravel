// Pillar plan/apply functions — the agent-driven install API.
//
// Each pillar (mount / prompts / traces) has a Plan function that
// returns a JSON-stable description of the actions it would take, and
// an Apply function that does the work. The interactive `gravel init`
// orchestrator uses these too (Plan to show the user, Apply on yes)
// so there's only one source of truth for what each pillar does.
//
// Why a stable JSON contract matters: agents (Claude Code, Codex,
// Cursor) parse `gravel mount --plan` output, narrate it to the human,
// and only then run `gravel mount --apply`. If the action schema
// drifts between releases the install script's prompts become wrong
// and the agent runs unauthorised side-effects. Bump schema_version
// when changing field names; tolerant additive changes are fine.
package wizard

import (
	"context"
	"fmt"
	"path/filepath"

	"github.com/artanis-ai/gravel/cli/internal/manifest"
	"github.com/artanis-ai/gravel/cli/internal/migrate"
)

// PillarPlan is the json document `gravel <pillar> --plan` prints.
type PillarPlan struct {
	SchemaVersion int            `json:"schema_version"`
	Pillar        string         `json:"pillar"` // "mount" | "prompts" | "traces"
	Actions       []PillarAction `json:"actions"`
	Warnings      []string       `json:"warnings,omitempty"`
	Blockers      []string       `json:"blockers,omitempty"`
	// Detection echoed back so the agent can show the user "I see X,
	// will do Y" without a second call.
	Detection DetectionDoc `json:"detection"`
}

// PillarAction describes one observable side-effect the apply step
// would perform. Kept short on purpose — humans (via the agent) read
// these one at a time.
type PillarAction struct {
	Kind    string `json:"kind"` // see ActionKind constants
	Path    string `json:"path,omitempty"`
	Summary string `json:"summary"`
}

// ActionKind values. Adding new kinds is non-breaking; agents fall
// back to printing the Summary if they don't recognise the kind.
const (
	ActionWriteFile     = "write_file"
	ActionPatchFile     = "patch_file"
	ActionWriteEnv      = "write_env"
	ActionInstallDep    = "install_dep"
	ActionInstallHook   = "install_hook"
	ActionScanPrompts   = "scan_prompts"
	ActionWriteManifest = "write_manifest"
	ActionProbeDb       = "probe_db"
	ActionCreateTables  = "create_tables"
	ActionWireTracing   = "wire_tracing"
)

// MountPillarOptions controls plan + apply for the mount pillar.
type MountPillarOptions struct {
	Detection Detection
	MountPath string // empty → /admin/ai
	// PreBakeCloudCreds writes GRAVEL_PROJECT_ID + GRAVEL_API_KEY into
	// .env.local when both are non-empty. One half on its own is
	// ignored (the SDK doesn't read API keys without a project id).
	APIKey    string
	ProjectID string
}

// PlanMount returns the action document for the mount pillar.
func PlanMount(_ context.Context, opts MountPillarOptions) PillarPlan {
	d := opts.Detection
	mountPath := opts.MountPath
	if mountPath == "" {
		mountPath = "/admin/ai"
	}
	state := InspectState(d.CWD, d)

	plan := PillarPlan{
		SchemaVersion: 1,
		Pillar:        "mount",
		Detection:     DetectionJSON(d),
	}

	configFile := configFilenameFor(d)
	if state.MountExists && state.EnvHasPassword {
		plan.Warnings = append(plan.Warnings,
			fmt.Sprintf("Already mounted at %s — apply will be a no-op idempotent skip.", mountPath))
		return plan
	}

	plan.Actions = append(plan.Actions, PillarAction{
		Kind:    ActionWriteFile,
		Path:    configFile,
		Summary: fmt.Sprintf("Write %s with mountPath=%s (no DB block until traces pillar opts in).", configFile, mountPath),
	})
	plan.Actions = append(plan.Actions, PillarAction{
		Kind:    ActionWriteFile,
		Path:    describeMount(d, mountPath),
		Summary: fmt.Sprintf("Mount the dashboard handler at %s inside your %s app.", mountPath, d.Framework),
	})
	envFile := state.EnvFileWithPassword
	if envFile == "" {
		envFile = ".env.local"
	}
	plan.Actions = append(plan.Actions, PillarAction{
		Kind:    ActionWriteEnv,
		Path:    envFile,
		Summary: "Generate and store a 32-byte admin password as GRAVEL_ADMIN_PASSWORD.",
	})
	if opts.APIKey != "" && opts.ProjectID != "" {
		plan.Actions = append(plan.Actions, PillarAction{
			Kind:    ActionWriteEnv,
			Path:    envFile,
			Summary: "Write GRAVEL_PROJECT_ID + GRAVEL_API_KEY (provided via flags) so paid evals work.",
		})
	}
	// Host-framework wiring: Next.js / Clerk / Vercel hooks live in the
	// Mount step now (Olly #5-8 turned them into wizard responsibilities).
	hostActions, hostWarnings := planMountHostWiring(d, mountPath, state)
	plan.Actions = append(plan.Actions, hostActions...)
	plan.Warnings = append(plan.Warnings, hostWarnings...)

	return plan
}

// MountApplyResult mirrors the Mount fields callers care about.
type MountApplyResult struct {
	ConfigPath    string
	Mount         MountResult
	AdminPassword string
	AdminPwIsNew  bool
}

// ApplyMount writes the mount-pillar files. Idempotent on re-runs:
// when the mount file already exists AND the password is set, we
// return without touching anything (matches the Run() idempotency
// in run.go). Otherwise re-applies overwrite the config (wizard
// owns it) but leave the admin password alone if one is set.
func ApplyMount(ctx context.Context, opts MountPillarOptions) (MountApplyResult, error) {
	d := opts.Detection
	mountPath := opts.MountPath
	if mountPath == "" {
		mountPath = "/admin/ai"
	}
	// Fast-path: both halves already present → no-op.
	state := InspectState(d.CWD, d)
	if state.MountExists && state.EnvHasPassword {
		return MountApplyResult{
			ConfigPath: configFilenameFor(d),
			Mount:      MountResult{Mode: MountSkipped},
		}, nil
	}

	pw, isNew, err := EnsureAdminPassword(d.CWD)
	if err != nil {
		return MountApplyResult{}, fmt.Errorf("write admin password: %w", err)
	}
	if opts.APIKey != "" && opts.ProjectID != "" {
		if err := upsertEnvVar(d.CWD, "GRAVEL_PROJECT_ID", opts.ProjectID); err != nil {
			return MountApplyResult{}, fmt.Errorf("write GRAVEL_PROJECT_ID: %w", err)
		}
		if err := upsertEnvVar(d.CWD, "GRAVEL_API_KEY", opts.APIKey); err != nil {
			return MountApplyResult{}, fmt.Errorf("write GRAVEL_API_KEY: %w", err)
		}
	}
	configPath, err := GenerateConfig(d, ConfigOptions{
		MountPath:    mountPath,
		WithDatabase: false,
	})
	if err != nil {
		return MountApplyResult{}, fmt.Errorf("write config: %w", err)
	}
	mount, err := Mount(d, mountPath, MountOptions{WithTracingDeps: false})
	if err != nil {
		return MountApplyResult{}, fmt.Errorf("mount dashboard: %w", err)
	}
	if err := applyMountHostWiring(ctx, d, mountPath); err != nil {
		// Host-framework wiring failures (Clerk publicRoutes, Vercel
		// rewrite, etc.) are warnings, not blockers — the user can
		// patch manually using the messages we already printed. The
		// dashboard still works without them; they just unblock the
		// route through Clerk/Vercel.
		_ = err
	}
	return MountApplyResult{
		ConfigPath:    configPath,
		Mount:         mount,
		AdminPassword: pw,
		AdminPwIsNew:  isNew,
	}, nil
}

// PromptsPillarOptions controls plan + apply for the prompts pillar.
type PromptsPillarOptions struct {
	Detection    Detection
	SkipDeepScan bool
	// Prompter is required for Apply when SkipDeepScan is false (so the
	// "Did I find everything?" loop has a way to ask). Plan never
	// prompts.
	Prompter Prompter
	// InstallHook controls whether to install the pre-commit hook. Bare
	// `gravel prompts --apply` defaults to true when .git is present;
	// `--no-hook` flips it off. Plan reports both decisions separately.
	InstallHook bool
}

// PlanPrompts returns the action document for the prompts pillar.
func PlanPrompts(_ context.Context, opts PromptsPillarOptions) PillarPlan {
	d := opts.Detection
	plan := PillarPlan{
		SchemaVersion: 1,
		Pillar:        "prompts",
		Detection:     DetectionJSON(d),
	}
	plan.Actions = append(plan.Actions, PillarAction{
		Kind:    ActionScanPrompts,
		Summary: "Regex-scan conventional prompt dirs (prompts/, templates/, etc.) + any custom paths in gravel_config.",
	})
	plan.Actions = append(plan.Actions, PillarAction{
		Kind:    ActionWriteManifest,
		Path:    manifest.Path,
		Summary: "Write .gravel/manifest.json indexing every discovered prompt by id + path + hash.",
	})
	if d.HasGit && opts.InstallHook {
		plan.Actions = append(plan.Actions, PillarAction{
			Kind:    ActionInstallHook,
			Path:    ".git/hooks/pre-commit",
			Summary: "Install pre-commit hook (gravel manifest check) so the manifest stays in sync on every commit.",
		})
	} else if !d.HasGit {
		plan.Warnings = append(plan.Warnings, "No .git/ detected — pre-commit hook will be skipped.")
	}
	return plan
}

// PromptsApplyResult bundles results of the prompts pillar.
type PromptsApplyResult struct {
	ManifestPath  string
	ManifestCount int
	Hook          HookResult
}

// ApplyPrompts runs the scan, writes the manifest, optionally installs
// the hook. Idempotent: re-running on an existing manifest only adds
// newly-discovered prompts.
func ApplyPrompts(ctx context.Context, opts PromptsPillarOptions) (PromptsApplyResult, error) {
	d := opts.Detection
	prompter := opts.Prompter
	if prompter == nil {
		prompter = DefaultsPrompter{}
	}
	m, err := RunScanAndVerify(ctx, d.CWD, prompter, opts.SkipDeepScan)
	if err != nil {
		return PromptsApplyResult{}, fmt.Errorf("scan: %w", err)
	}
	result := PromptsApplyResult{}
	if m != nil {
		result.ManifestPath = filepath.Join(d.CWD, manifest.Path)
		result.ManifestCount = len(m.Prompts)
	}
	if d.HasGit && opts.InstallHook {
		hook, err := InstallHook(d.CWD)
		if err != nil {
			return result, fmt.Errorf("install hook: %w", err)
		}
		result.Hook = hook
	}
	return result, nil
}

// TracesPillarOptions controls plan + apply for the traces pillar.
type TracesPillarOptions struct {
	Detection     Detection
	MountPath     string // for rewriting config with DB block
	SkipTestTrace bool
}

// PlanTraces returns the action document for the traces pillar.
func PlanTraces(ctx context.Context, opts TracesPillarOptions) PillarPlan {
	d := opts.Detection
	plan := PillarPlan{
		SchemaVersion: 1,
		Pillar:        "traces",
		Detection:     DetectionJSON(d),
	}

	probe := ProbeDatabase(ctx, d.CWD)
	switch probe.Kind {
	case ProbeNoURL:
		plan.Blockers = append(plan.Blockers,
			"No DATABASE_URL set in .env / .env.local. Set it before applying the traces pillar (the gravel_* tables go into your existing DB).")
		return plan
	case ProbePlaceholder:
		plan.Blockers = append(plan.Blockers,
			"DATABASE_URL has placeholder credentials ("+probe.URL+"). Swap in real creds first.")
		return plan
	case ProbeConnectFailed:
		plan.Blockers = append(plan.Blockers,
			"DATABASE_URL is set but unreachable: "+probe.Message)
		return plan
	case ProbeOK:
		plan.Actions = append(plan.Actions, PillarAction{
			Kind:    ActionProbeDb,
			Summary: fmt.Sprintf("Confirmed %s reachable via DATABASE_URL.", probe.Dialect),
		})
	}
	// Hybrid Next.js + FastAPI stacks routinely set DATABASE_URL for
	// the JS-side ORM (Drizzle/Prisma) without ever adding a Python
	// driver. SQLAlchemy crashes at create_engine with
	// "ModuleNotFoundError: psycopg2" — same bite as Olly v0.6.2 #10.
	// Surface the install in the plan so the agent can narrate it.
	if NeedsPsycopg2(d) {
		plan.Actions = append(plan.Actions, PillarAction{
			Kind:    ActionInstallDep,
			Path:    "pyproject.toml",
			Summary: "Add `psycopg2-binary` to your Python deps so SQLAlchemy can talk to the detected Postgres DATABASE_URL.",
		})
	}
	already, _ := migrate.TablesAlreadyExist(ctx, probe.URL, probe.Dialect)
	if already {
		plan.Warnings = append(plan.Warnings, "gravel_samples + gravel_feedback already exist in this DB; CREATE TABLE step will be a no-op.")
	} else {
		plan.Actions = append(plan.Actions, PillarAction{
			Kind:    ActionCreateTables,
			Summary: "Run idempotent CREATE TABLE on gravel_samples and gravel_feedback.",
		})
	}
	if d.Framework == FrameworkNextAppRouter || d.Framework == FrameworkNextPagesRouter {
		plan.Actions = append(plan.Actions, PillarAction{
			Kind:    ActionWireTracing,
			Path:    "instrumentation.ts",
			Summary: "Add instrumentation.ts + next.config externals so the OpenAI / Anthropic / Vercel-AI patches load at boot.",
		})
	}
	plan.Actions = append(plan.Actions, PillarAction{
		Kind:    ActionPatchFile,
		Path:    configFilenameFor(d),
		Summary: "Update the existing config with a `database` block pointing at DATABASE_URL.",
	})
	return plan
}

// TracesApplyResult bundles results of the traces pillar.
type TracesApplyResult struct {
	DBProbe        DBProbeResult
	MigrateApplied bool
	// PsycopgInstall is populated when the hybrid-postgres detection
	// added (or attempted to add) psycopg2-binary. Zero value means
	// the driver was already present or not needed.
	PsycopgInstall EnsureDepResult
}

// ApplyTraces probes the DB, creates the tables, wires instrumentation,
// and rewrites the config to include the database block.
func ApplyTraces(ctx context.Context, opts TracesPillarOptions) (TracesApplyResult, error) {
	d := opts.Detection
	probe := ProbeDatabase(ctx, d.CWD)
	result := TracesApplyResult{DBProbe: probe}
	if probe.Kind != ProbeOK {
		return result, fmt.Errorf("DB probe failed: %s", probe.Message)
	}
	// Add psycopg2-binary first so the migrate step's later
	// `create_engine` call has a driver. Surfaced via PsycopgInstall
	// on the result so the wizard's summary line can report it.
	if NeedsPsycopg2(d) {
		result.PsycopgInstall = EnsureDepInstalled(ctx, d, "psycopg2-binary")
	}
	already, _ := migrate.TablesAlreadyExist(ctx, probe.URL, probe.Dialect)
	if !already {
		applied, err := tryMigrateURL(ctx, probe.URL)
		if err != nil {
			return result, fmt.Errorf("migrate: %w", err)
		}
		result.MigrateApplied = applied
	}
	if d.Framework == FrameworkNextAppRouter || d.Framework == FrameworkNextPagesRouter {
		state := InspectState(d.CWD, d)
		if !state.InstrumentationExists {
			srcLayout := d.Framework == FrameworkNextAppRouter && d.NextAppDir == "src/app"
			if err := InstallNextTracingHooks(d.CWD, srcLayout); err != nil {
				return result, fmt.Errorf("instrumentation: %w", err)
			}
		}
	}
	mountPath := opts.MountPath
	if mountPath == "" {
		mountPath = "/admin/ai"
	}
	if _, err := GenerateConfig(d, ConfigOptions{MountPath: mountPath, WithDatabase: true}); err != nil {
		return result, fmt.Errorf("update config with database block: %w", err)
	}
	return result, nil
}
