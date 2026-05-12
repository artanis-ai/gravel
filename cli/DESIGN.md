# `gravel` CLI, single binary, cross-stack

## Why

The previous shape was two CLIs, one in TypeScript and one in Python,
kept "in sync" by hand. They drifted. The 0.2.0 release shipped a
Python wizard that was months behind the TS wizard. That's the bug
this rewrite kills.

The wizard's job is to *read and write files in the host's repo*. It
detects lockfiles, drops a config template, patches `next.config.ts`,
installs a pre-commit hook. None of that needs to run inside the host's
language runtime, it's just filesystem work. So a single binary in a
third language can do it, and both the TS and Python SDK packages stop
shipping any CLI at all.

This is the ruff / uv / mise pattern: cross-compiled native binary,
distributed via a `curl | sh` script that pulls signed assets from
GitHub Releases.

## Decision: Go

Not Rust. Reasons, in order:

1. **The wizard is filesystem + string work**, not perf-sensitive.
   Compiler choice is a wash on runtime.
2. **Cross-compile is trivial in Go**: `GOOS=linux GOARCH=arm64 go build`.
   Rust needs `cross` or per-target toolchain juggling.
3. **No CGO**: Go's `modernc.org/sqlite` is pure-Go, runs unchanged on
   every target without bundling a C compiler in CI.
4. **Smaller team cost**: one developer keeps the wizard moving without
   becoming a Rust expert.

The trade is binary size: Go binaries land at ~8 MB stripped (verified:
7.9 MB for the current doctor-only build). ruff ships a 30 MB Rust
binary; nobody complains. Acceptable.

## What the binary is

```
gravel <command> [flags]
```

Commands (in scope for v0):

| Command | Purpose | Replaces |
|---|---|---|
| `gravel init` | Interactive install wizard | TS `runWizard` + Python `run_wizard` |
| `gravel doctor` | Version check + install/upgrade command | TS `runDoctor` + Python `run_doctor` |
| `gravel manifest --check\|--update\|--list` | Scan prompts, write `.gravel/manifest.json` | Same on both sides |
| `gravel migrate` | Apply pending DB migrations / bootstrap | Same on both sides |
| `gravel scan --deep` | LLM-assisted prompt discovery (delegates to `claude` / `codex` CLIs) | Same |
| `gravel github` | (Future) ad-hoc commands for the GH App flow | n/a |

What stays out of the binary:

- **Runtime SDK code** (instrumentation patches, dashboard handler routes, drizzle/SQLAlchemy schema, judge client, manifest types). That's library code, has to live in the host's language.
- **The dashboard SPA**: already embedded in the TS SDK's bundle.

## Distribution

One canonical path. No registry tax.

### `curl | sh`, signed GitHub Release assets

```
curl -fsSL https://raw.githubusercontent.com/artanis-ai/gravel/main/install.sh | sh
```

The script (committed at `gravel/install.sh`):

1. Detects OS + arch (`uname -s`, `uname -m`).
2. Resolves `latest` from the GitHub Releases API, or honours `GRAVEL_VERSION=vX.Y.Z`.
3. Downloads `gravel-<os>-<arch>` + `gravel-<os>-<arch>.sha256`.
4. Verifies the digest with `sha256sum` or `shasum -a 256`.
5. Installs to `$HOME/.local/bin/gravel` (override: `GRAVEL_INSTALL_DIR`).
6. Prints a PATH-hint if the install dir isn't on `$PATH`.

Supported targets:

- `linux-amd64`, `linux-arm64`
- `darwin-amd64`, `darwin-arm64`
- `windows-amd64.exe` (manual download from the release page; the `.sh`
  installer cops out on Windows shells and points at the asset URL.
  Post-launch we'll ship a sibling `install.ps1`.)

### What we explicitly do NOT ship

- **No npm CLI package**. `@artanis-ai/gravel` is the SDK only. The
  `bin` field is removed from its `package.json`. Users who type
  `npx @artanis-ai/gravel` get a clear "install via `curl | sh`" error.
- **No PyPI CLI package**. `artanis-gravel` is the SDK only. The
  `console_scripts` entry is removed from its `pyproject.toml`.
- **No discoverability wrapper packages**. No `@artanis-ai/gravel-cli`
  on npm, no `artanis-gravel-cli` on PyPI. Pre-launch we have one
  install path. Post-launch we may add Homebrew if telemetry warrants
  it; we will not add it speculatively.

The reasoning:

- The CLI runs ~3 times in a project's lifetime (init, the occasional
  migrate, pre-commit calls). Carrying an 8 MB native binary inside
  every `npm install` so 99% of CI runs can ignore it is the wrong
  shape.
- Coupling the CLI to the SDK package on each registry was the source
  of the 0.2.0 drift bug. Decoupling them removes the failure mode.
- Pre-launch, every distribution channel we add is a maintenance
  surface we have to keep green. One is right.

### Release artifacts per tag

Each `vX.Y.Z` tag triggers a CI matrix that builds and uploads:

```
gravel-linux-amd64
gravel-linux-amd64.sha256
gravel-linux-arm64
gravel-linux-arm64.sha256
gravel-darwin-amd64
gravel-darwin-amd64.sha256
gravel-darwin-arm64
gravel-darwin-arm64.sha256
gravel-windows-amd64.exe
gravel-windows-amd64.exe.sha256
```

All five `.sha256` files are produced by `sha256sum` on the runner so
the format matches `sha256sum -c`. Reproducible builds: `-trimpath`
plus `-buildvcs=false` plus `-ldflags="-s -w -X .../version.Version=X.Y.Z"`.

## SDK packages are SDK only

After this rewrite:

- `@artanis-ai/gravel` (npm) exports the runtime library. No `bin`.
  The version on the registry tracks the SDK schema + dashboard bundle.
- `artanis-gravel` (PyPI) exports the runtime library. No `console_scripts`.
- The CLI's version (`gravel --version`) follows the same `vX.Y.Z`
  numbering, intentionally locked in step with the SDKs so `gravel
  doctor` can tell a user "you're on CLI 0.4.0 in a project pinned to
  SDK 0.3.2, run `pnpm update @artanis-ai/gravel@0.4.0`".

The version-in-step invariant is enforced by `tools/release.sh`: the
script bumps `cli/internal/version/version.go`, `packages/sdk-ts/package.json`,
and `python/gravel/pyproject.toml` in one commit, then tags.

## Repo layout

```
gravel/
├── install.sh                       # curl | sh entrypoint
├── cli/                             # Go module (single source of truth)
│   ├── go.mod
│   ├── cmd/gravel/main.go           # entrypoint
│   ├── internal/
│   │   ├── detect/                  # lockfile / framework / db detection
│   │   ├── config/                  # generate gravel.config.{ts,py}
│   │   ├── mount/                   # write route file, patch next.config
│   │   ├── manifest/                # prompt scan, manifest read/write/diff
│   │   ├── hook/                    # pre-commit hook installer
│   │   ├── doctor/                  # version check, registry fetch
│   │   ├── migrate/                 # SQL migrations (sqlite + postgres)
│   │   ├── stack/                   # PackageManager / Language types
│   │   └── cli/                     # cobra command tree
│   ├── testdata/                    # fixture inputs
│   ├── DESIGN.md
│   └── README.md
├── packages/
│   └── sdk-ts/                      # runtime library only; CLI source deleted
└── python/gravel/                   # runtime library only; CLI source deleted
```

## Schema for "one wizard, two SDKs"

The binary doesn't know anything about TS vs Python at runtime, it
figures that out from the host repo's files (`package.json` → ts,
`pyproject.toml` → py). The output it generates targets one stack or
the other: `gravel.config.ts` xor `gravel_config.py`.

The runtime SDK code stays language-specific. Both languages expose
the same public types (`GravelConfig`, `GravelRequest`, `GravelUser`).
That's the only contract the wizard's generated code needs to honour.

## Tests

Three layers.

### Layer 1: Go unit tests

Standard `go test ./...`. Each `internal/<pkg>/` ships `*_test.go`.
Coverage budget: 80% lines, gated in CI. Each package has table-driven
tests for every public function.

### Layer 2: Fixture integration tests

`cli/testdata/` mirrors `gravel-test-fixtures/`. For each fixture:

1. Snapshot input tree to a tmpdir.
2. Run `gravel init --yes --no-deep-scan --no-test-trace --cwd <tmpdir>`.
3. Assert the resulting tree matches a checked-in golden snapshot.
4. Assert `gravel doctor --json` returns the right shape for that stack.

These tests are what makes "the wizard is single source of truth"
*enforceable*. A drift in output is a failing diff.

### Layer 3: End-to-end against real Next/FastAPI

The existing `gravel-test-fixtures` Playwright runner already does
this for TS hosts. Once the Go binary replaces the TS CLI, the same
runner exercises it. A parallel Python-host runner mirrors the same
surfaces.

### Install-script smoke test

A separate CI job runs the published `install.sh` against a clean
Ubuntu and macOS container/runner, asserts `gravel --version` matches
the tagged version. Catches sha256 drift, broken release URLs, and
PATH corner cases.

## Release flow

`tools/release.sh v0.3.0`:

1. **Pre-flight**: assert `cli/`'s `go test ./...` passes; assert
   TS + Python SDKs build clean; assert there's no published GitHub
   release for this tag yet; assert the working tree is clean.
2. **Bump versions in lockstep**: `cli/internal/version/version.go`,
   `packages/sdk-ts/package.json`, `python/gravel/pyproject.toml`.
   Commit.
3. **Tag** `v0.3.0`. Push tag + commit.
4. **CI** runs the matrix build (5 Go binaries with sha256 sums),
   publishes the GitHub release, publishes the SDK packages to npm
   and PyPI via OIDC trusted publishers (SDK-only, no bin).
5. **Verify**: pipe `install.sh` through `sh`, run `gravel --version`,
   assert it matches the tag. Run `gravel doctor` against a fixture
   repo, assert clean exit.
6. **Rollback on any step failing**: delete the tag, post a clear
   error to the release thread.

This is the "make sure the deployment process can work without a
hitch" half of the original ask.

## Migration plan

This is a multi-release effort. Concrete phases:

1. **0.3.0-alpha.N** (current branch, not published as `latest`): Go
   binary handles `doctor` only. Existing TS + Python CLIs keep
   serving all other commands, untouched. Smoke-test the GitHub
   Release pipeline end-to-end with the doctor binary.
2. **0.3.0-alpha.N+1**: Go binary handles `doctor` + `manifest`.
3. **0.3.0-alpha.N+2**: + `init` (the big one). The old TS/Python
   wizard code stays in place but prints a deprecation banner.
4. **0.3.0-alpha.N+3**: + `migrate` + `scan`. TS/Python CLI source
   code deleted. SDK packages drop `bin` and `console_scripts`. Their
   READMEs point at `install.sh`.
5. **0.3.0** (proper release): canonical Go binary, no more drift.
6. **0.2.x line**: stays patchable from the current code for ~30
   days of overlap. After that, all bug fixes go into 0.3.x only.

## Open questions

- **`gravel scan --deep`** invokes the user's `claude` or `codex` CLI
  to do LLM-assisted prompt detection. The Go binary shells out to
  those CLIs the same way the TS code does today. No new design.
- **Interactive prompts** in `gravel init` (TTY-only "do you want the
  prompts pillar?" questions): Go's `bubbletea` or `survey` libraries
  handle this. `survey` is older + smaller; `bubbletea` is fancier
  but heavier. Lean toward `survey` for v0.
- **Windows shell install**: out of scope for v0. Windows users
  download the `.exe` from the release page. Post-launch we add
  `install.ps1`; that's a launch task, not pre-launch tech debt.
- **`drizzle-orm` migrator vs writing our own SQL applier**: drizzle's
  format is `0001_name.sql` files + `_journal.json`. Our Go migrator
  reads the journal, applies pending files, writes `__drizzle_migrations`
  rows. No need to keep drizzle-kit as a runtime dep. Same idea for
  Alembic on the Python side (once we add Alembic; currently the
  Python SDK uses `metadata.create_all`).
