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

Three doors, one binary. All paths fetch the same signed binary from
the same GitHub Release; the only difference is the door the user
walks through.

### Door 1: npm wrapper (the primary path for TS users)

```sh
pnpm add @artanis-ai/gravel
pnpm gravel init
```

`@artanis-ai/gravel` ships the SDK library + a thin Node wrapper at
`bin/gravel.js`. The wrapper:

1. Reads its own version from the sibling `package.json` so the binary
   it fetches matches the SDK semver in the user's lockfile.
2. Maps `process.platform`/`process.arch` to the GitHub Release asset
   filename (`gravel-linux-amd64`, etc.).
3. Looks in `~/.cache/artanis-gravel/v<version>/` for a cached binary.
4. On miss: downloads + sha256-verifies from the GH Release, writes to
   the cache atomically (tmp → rename).
5. `child_process.spawnSync`s the binary with the user's argv,
   `stdio: 'inherit'`, propagates the exit code.

No `postinstall` script. CI runs that never invoke the CLI pay zero
cost (no download, no disk). First `gravel <cmd>` is the only thing
that triggers the fetch.

### Door 2: PyPI wrapper (the primary path for Python users)

```sh
uv add artanis-gravel
uv run gravel init
```

Mirror of the npm wrapper: `artanis-gravel` ships the SDK library + a
thin Python wrapper at `artanis_gravel/_cli.py`. Same five-step flow
(version-via-`importlib.metadata`, platform mapping, cache, download
+ sha256 verify, `os.execv` on POSIX / `subprocess.call` on Windows).

### Door 3: `curl | sh` install script (Docker, CI, polyglot repos)

```sh
curl -fsSL https://raw.githubusercontent.com/artanis-ai/gravel/main/install.sh | sh
gravel init
```

POSIX shell script committed at `gravel/install.sh`. Same detect →
download → sha256-verify → install flow, but writes the binary to
`$HOME/.local/bin/gravel` (override: `GRAVEL_INSTALL_DIR`) so it lives
on PATH globally. Useful when:

- Docker / CI images don't want Node or Python just to install the
  CLI.
- Polyglot repos (Rust, Go) where neither npm nor PyPI is the natural
  home for a build dep.
- Power users who'd rather invoke `gravel` from a system shell than
  `pnpm gravel`/`uv run gravel`.

A sibling `install.ps1` covers native Windows shells.

### What the three doors share

| Concern | Source of truth |
|---|---|
| Binary content | The Go module under `cli/`, cross-compiled in the release matrix |
| Asset names | `gravel-<os>-<arch>` (plus `.exe` on windows). Same five targets across all wrappers; the `PLATFORMS` map is duplicated verbatim in `bin/gravel.js` and `_cli.py` |
| Cache layout | `~/.cache/artanis-gravel/v<version>/<asset>` for both wrappers; install.sh writes to `$INSTALL_DIR/gravel` directly |
| Version coupling | The wrapper's version (from its host package) is what gets fetched. `tools/release.sh` bumps cli + sdk-ts + python in lockstep |
| Verification | sha256 against the published `.sha256` companion file |
| Mirror escape hatch | `GRAVEL_RELEASES_BASE_URL` env override; both wrappers + install.sh honour it. Locked-down networks can mirror the assets internally |

### Why wrappers and not just `curl | sh`

The earlier version of this doc argued for `curl | sh` only and called
the wrappers "tech debt". The trust optics changed our mind. People
who pull from npm trust npm's signature + provenance and read the
small JS wrapper. People who'd never pipe a remote shell script into
sh now have a friendly door. The 0.2.0 drift bug — the actual disaster
that started this rewrite — was caused by **two separate wizards**, not
by having two registries. With the wizard logic in a single Go binary,
the wrappers can be ~100-line shims that drift trivially less than
"two thousand lines of TS+Python wizard maintained in parallel".

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

## SDK packages: library + thin CLI wrapper, no bundled binary

After this rewrite:

- `@artanis-ai/gravel` (npm) exports the runtime library + a
  `bin/gravel.js` wrapper that lazy-downloads the binary on first
  invocation. The binary is NOT bundled in the npm tarball; the package
  size stays at the SDK's natural size.
- `artanis-gravel` (PyPI) is the equivalent: SDK + `_cli.py` wrapper.
- The Go binary's version (`gravel --version`) follows the same
  `vX.Y.Z` numbering. The wrapper fetches the binary tagged with its
  own SDK version, so a user on SDK 0.4.0 always gets binary 0.4.0 from
  `pnpm gravel <cmd>` — even if a newer binary exists on the GH Release.
- A user installed via `install.sh` instead may have a newer binary on
  PATH. `gravel doctor` reports the version they actually invoked, plus
  the latest tag, so any drift is visible.

The version-in-step invariant is enforced by `tools/release.sh`: the
script bumps `cli/internal/version/version.go`, `packages/sdk-ts/package.json`,
and `python/gravel/pyproject.toml` in one commit, then tags.

## Repo layout

```
gravel/
├── install.sh                       # `curl | sh` entrypoint (POSIX)
├── install.ps1                      # PowerShell sibling for native Windows
├── cli/                             # Go module — single source of truth for the wizard
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
│   └── sdk-ts/                      # runtime library + bin/gravel.js wrapper
└── python/gravel/                   # runtime library + _cli.py wrapper
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
