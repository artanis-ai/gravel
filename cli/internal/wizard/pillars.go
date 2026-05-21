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
	"sort"
	"strings"

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
	// Folders is populated by `gravel prompts --plan`. It groups the
	// candidate prompt files the scan found by their parent directory
	// so the agent can ask the human user a folder-level question
	// before the apply step ("found 47 files in /docs, keep all or
	// skip that folder?"). Empty / omitted on non-prompts pillars.
	Folders []FolderSummary `json:"folders,omitempty"`
}

// FolderSummary lists one parent directory holding prompt-shaped files,
// with a sample of paths so the agent can narrate concretely.
type FolderSummary struct {
	// Path is the repo-relative folder (e.g. "api/py/prompts" or "."
	// for repo root). Use "." for root so JSON consumers don't have
	// to special-case empty string.
	Path string `json:"path"`
	// FileCount is the total number of prompt-shaped files under this
	// folder (one level deep — nested subfolders surface separately).
	FileCount int `json:"file_count"`
	// SamplePaths is the first ~3 paths under this folder so the agent
	// can name them without dumping the full list. Repo-relative.
	SamplePaths []string `json:"sample_paths"`
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
	// SkipSDKInstall skips the EnsureSDKInstalled step at the top of
	// ApplyMount. Tests + advanced users (`--skip-sdk-install` flag on
	// the cobra layer) flip this; defaults to false so `gravel mount
	// --apply` adds the SDK to deps automatically.
	SkipSDKInstall bool
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
	// SDKInstall captures what EnsureSDKInstalled did (added /
	// already-present / blocked-by-constraint / failed). The cobra
	// layer (`gravel mount --apply`) reads this when an error is
	// returned so it can render the specific remediation.
	SDKInstall SDKInstallResult
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

	// SDK auto-install. Pre-v0.10.3, ApplyMount skipped this entirely
	// — only `gravel init`'s top-level run called EnsureSDKInstalled.
	// Agents running the step subcommand path (`gravel mount --apply`)
	// finished without the SDK in pyproject.toml; the app then crashed
	// at boot with `ModuleNotFoundError: artanis_gravel`. Yousef's
	// de-platform install (2026-05-21) was the canonical case.
	if !opts.SkipSDKInstall {
		sdk := EnsureSDKInstalled(ctx, d)
		switch sdk.Kind {
		case SDKAdded, SDKAlreadyPresent:
			// Happy paths; nothing to do.
		case SDKSkippedNoManifest:
			// No package.json / pyproject.toml. The mount-wiring step
			// below will hit its own framework check; surface as a
			// MountApplyResult.SDKInstall so the caller can render the
			// remediation alongside the mount summary.
		case SDKBlockedByConstraint:
			// Resolver said no — typically `[tool.uv] exclude-newer`
			// cutting off the version we need. NEVER silently install
			// an older SDK; surface loud + abort. Caller (cobra layer
			// or `gravel init` orchestrator) renders sdk.ConstraintHint.
			return MountApplyResult{SDKInstall: sdk}, fmt.Errorf(
				"SDK install blocked by project constraint: %s — fix and re-run", sdk.ConstraintHint,
			)
		case SDKFailed:
			return MountApplyResult{SDKInstall: sdk}, fmt.Errorf(
				"SDK install failed (`%s`): %s", sdk.Command, strings.TrimSpace(sdk.Stderr),
			)
		}
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
	// SkipFolders lists repo-relative folder paths that should NOT be
	// scanned for prompts. Populated by `--skip-folder` (repeatable) on
	// the CLI; agents read the `folders[]` array from `--plan`, ask
	// the human "skip docs/?", and pass through the answer. Path match
	// is exact-prefix at folder boundary; a skip on `docs` filters
	// `docs/a.md` + `docs/sub/b.md` but not `docstrings.md`.
	SkipFolders []string
}

// PlanPrompts returns the action document for the prompts pillar. It
// also runs a dry scan to populate Folders[] with the per-directory
// breakdown of candidate prompt files; agents narrate this to the
// human user and pass back any "skip this folder" decisions via
// `--skip-folder` flags on apply.
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
	// Dry-scan + bucket findings by parent directory so agents can ask
	// folder-level. Errors here are non-fatal: the plan still works
	// for apply; the folder summary just lands empty.
	if scan, err := manifest.FastScan(d.CWD, manifest.Empty()); err == nil {
		plan.Folders = summariseFolders(scan.Manifest.Prompts)
	}
	return plan
}

// filterPromptsBySkipFolders drops any prompt whose path is under one
// of `skips`. Folder paths are matched as exact prefixes at a folder
// boundary: a skip on "docs" filters "docs/a.md" and "docs/sub/b.md"
// but NOT "docstrings.md" (no folder boundary between "docs" and "t").
// Repo-root prompts (path with no directory) can be skipped via "."
// (mirrors the plan output's "." for root).
func filterPromptsBySkipFolders(prompts []manifest.Prompt, skips []string) []manifest.Prompt {
	if len(skips) == 0 {
		return prompts
	}
	cleanSkips := make([]string, 0, len(skips))
	for _, s := range skips {
		s = filepath.ToSlash(filepath.Clean(s))
		if s == "" {
			continue
		}
		cleanSkips = append(cleanSkips, s)
	}
	kept := prompts[:0]
	for _, p := range prompts {
		dir := filepath.Dir(p.Path)
		if dir == "" {
			dir = "."
		}
		dir = filepath.ToSlash(dir)
		skip := false
		for _, s := range cleanSkips {
			if s == "." {
				if dir == "." {
					skip = true
					break
				}
				continue
			}
			// dir == s (exact folder) OR dir starts with s + "/" (nested).
			if dir == s || (len(dir) > len(s) && dir[:len(s)] == s && dir[len(s)] == '/') {
				skip = true
				break
			}
		}
		if !skip {
			kept = append(kept, p)
		}
	}
	return kept
}

// summariseFolders groups prompts by their parent directory and
// returns one FolderSummary per folder. Sorted by file_count desc so
// the agent narrates the biggest buckets first.
func summariseFolders(prompts []manifest.Prompt) []FolderSummary {
	const sampleLimit = 3
	byFolder := map[string]*FolderSummary{}
	for _, p := range prompts {
		dir := filepath.Dir(p.Path)
		if dir == "" {
			dir = "."
		}
		entry, ok := byFolder[dir]
		if !ok {
			entry = &FolderSummary{Path: dir}
			byFolder[dir] = entry
		}
		entry.FileCount++
		if len(entry.SamplePaths) < sampleLimit {
			entry.SamplePaths = append(entry.SamplePaths, p.Path)
		}
	}
	out := make([]FolderSummary, 0, len(byFolder))
	for _, e := range byFolder {
		out = append(out, *e)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].FileCount != out[j].FileCount {
			return out[i].FileCount > out[j].FileCount
		}
		return out[i].Path < out[j].Path
	})
	return out
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
	// Apply folder skips after scan + verify. Agents reading the plan's
	// folders[] array ask the human user "skip docs/?" and pass any
	// yesses back via --skip-folder; the filter drops matching prompts.
	//
	// RunScanAndVerify writes the FULL set of accepted prompts to disk
	// at the end of its loop, BEFORE we get a chance to apply skips.
	// So if we filter here and stop, the on-disk manifest has all the
	// pre-filter prompts and the cobra summary says fewer — Yousef's
	// 2026-05-21 contradiction ("16 prompt(s)" + "5 prompts" in the
	// same run). Fix: filter in-memory, then re-write the manifest so
	// the disk state matches the reported count.
	if m != nil && len(opts.SkipFolders) > 0 {
		filtered := filterPromptsBySkipFolders(m.Prompts, opts.SkipFolders)
		if len(filtered) != len(m.Prompts) {
			m.Prompts = filtered
			if err := manifest.Write(d.CWD, *m); err != nil {
				return PromptsApplyResult{}, fmt.Errorf("rewrite manifest after skip: %w", err)
			}
			Bullet(
				fmt.Sprintf("Applied %d --skip-folder filter(s): manifest now has %d prompt(s)",
					len(opts.SkipFolders), len(m.Prompts)),
				BulletOK,
			)
		}
	}
	result := PromptsApplyResult{}
	if m != nil {
		result.ManifestPath = filepath.Join(d.CWD, manifest.Path)
		result.ManifestCount = len(m.Prompts)
	}
	if d.HasGit && opts.InstallHook {
		hook, err := InstallHook(d.CWD, d.PackageManager)
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
	// v0.9.1: patch the existing config in place rather than
	// regenerating from scratch. Claude's de_platform install
	// (2026-05-20) lost manual edits (# noqa pragmas, custom
	// scan_roots, user-written getUser bodies) every time
	// `gravel traces --apply` ran. The patcher only inserts the
	// database block where missing; everything else stays as the
	// user left it. Falls back to regeneration when the config
	// file doesn't exist yet (mount pillar didn't run).
	patched, err := PatchConfigForDatabase(d, mountPath)
	if err != nil {
		return result, fmt.Errorf("patch config with database block: %w", err)
	}
	if !patched {
		// No existing config to patch — regenerate.
		if _, err := GenerateConfig(d, ConfigOptions{MountPath: mountPath, WithDatabase: true}); err != nil {
			return result, fmt.Errorf("update config with database block: %w", err)
		}
	}
	return result, nil
}
