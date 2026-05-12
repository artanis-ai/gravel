#!/usr/bin/env bash
# =============================================================================
# tools/smoke.sh — end-to-end test of `gravel init` against a fresh fixture
# WITHOUT publishing anything. Builds the current Go binary from cli/, serves
# it from a local HTTP server, then exercises the npm wrapper against it via
# the GRAVEL_RELEASES_BASE_URL env override.
#
# Usage:
#   ./tools/smoke.sh                # interactive prompts (no --yes)
#   ./tools/smoke.sh --yes          # non-interactive defaults
#   ./tools/smoke.sh --pages        # use Pages Router fixture instead
#   ./tools/smoke.sh --no-wrapper   # run the bare binary, skip npm wrapper layer
#
# What it does:
#   1. cd into cli/, go build the binary at the current SHA into a tmpdir.
#   2. Compute its sha256, stand up a tiny Python http.server that serves
#      gravel-linux-amd64 + gravel-linux-amd64.sha256 from v<DEV_VERSION>/.
#   3. Create a fresh fixture tmpdir: Next.js App Router project with a stub
#      package.json + pnpm-lock.yaml + app/page.tsx.
#   4. EITHER:
#        --no-wrapper: invoke the binary directly with stage 1's output
#        default:      `pnpm pack` the local sdk-ts, install it in the fixture,
#                      then run `./node_modules/.bin/gravel init` with the
#                      GRAVEL_RELEASES_BASE_URL pointed at the local server
#                      (so the wrapper fetches THIS build, not whatever is on
#                      GitHub Releases).
#   5. Print the full output + the post-init tree + the final package.json.
#   6. Tear down the server + tmpdirs on exit.
#
# Goal: see EXACTLY what a user would see, before pushing a tag.
# =============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEV_VERSION="${DEV_VERSION:-0.0.0-smoke}"
INIT_ARGS=()
USE_WRAPPER=1
FIXTURE_KIND="app-router"

for arg in "$@"; do
  case "$arg" in
    --yes) INIT_ARGS+=(--yes) ;;
    --pages) FIXTURE_KIND="pages-router" ;;
    --no-wrapper) USE_WRAPPER=0 ;;
    --traces) INIT_ARGS+=(--traces) ;;
    --no-traces) INIT_ARGS+=(--no-traces) ;;
    --prompts) INIT_ARGS+=(--prompts) ;;
    --no-prompts) INIT_ARGS+=(--no-prompts) ;;
    --no-test-trace) INIT_ARGS+=(--no-test-trace) ;;
    *) INIT_ARGS+=("$arg") ;;
  esac
done

bold=$(printf '\033[1m'); reset=$(printf '\033[0m'); cyan=$(printf '\033[36m')
note() { printf '%s== %s%s\n' "$bold" "$1" "$reset"; }
warn() { printf '%s!! %s%s\n' "$bold$cyan" "$1" "$reset"; }

WORK=$(mktemp -d -t gravel-smoke-XXXXXX)
PORT=$((40000 + RANDOM % 10000))
SERVER_PID=""
cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

# -----------------------------------------------------------------------------
# 1. Build the binary
# -----------------------------------------------------------------------------
note "building gravel binary from ${REPO_ROOT}/cli (DEV_VERSION=$DEV_VERSION)"
(
  cd "$REPO_ROOT/cli"
  go build -trimpath -buildvcs=false \
    -ldflags "-s -w -X github.com/artanis-ai/gravel/cli/internal/version.Version=$DEV_VERSION" \
    -o "$WORK/gravel-linux-amd64" \
    ./cmd/gravel
)
chmod +x "$WORK/gravel-linux-amd64"
SHA=$(sha256sum "$WORK/gravel-linux-amd64" | awk '{print $1}')
note "binary sha256: $SHA"

# -----------------------------------------------------------------------------
# 2. Local "github release" mirror, serving the matching .sha256 + binary
# -----------------------------------------------------------------------------
RELEASE_DIR="$WORK/releases/v$DEV_VERSION"
mkdir -p "$RELEASE_DIR"
cp "$WORK/gravel-linux-amd64" "$RELEASE_DIR/"
printf '%s  gravel-linux-amd64\n' "$SHA" > "$RELEASE_DIR/gravel-linux-amd64.sha256"

note "starting local releases mirror on http://127.0.0.1:$PORT"
(
  cd "$WORK/releases"
  python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 &
  echo $! > "$WORK/server.pid"
)
sleep 0.5
SERVER_PID=$(cat "$WORK/server.pid")
# Verify the mirror actually responds before continuing.
if ! curl -sS "http://127.0.0.1:$PORT/v$DEV_VERSION/gravel-linux-amd64.sha256" >/dev/null; then
  warn "local mirror not responding on port $PORT"
  exit 1
fi

# -----------------------------------------------------------------------------
# 3. Fixture: a minimal Next.js project
# -----------------------------------------------------------------------------
FIX="$WORK/fixture"
mkdir -p "$FIX"
case "$FIXTURE_KIND" in
  app-router)
    mkdir -p "$FIX/app"
    cat > "$FIX/package.json" <<JSON
{
  "name": "gravel-smoke-fixture",
  "version": "0.0.1",
  "private": true,
  "dependencies": { "next": "15.0.0", "@clerk/nextjs": "6.0.0" }
}
JSON
    : > "$FIX/pnpm-lock.yaml"
    cat > "$FIX/app/page.tsx" <<TSX
export default function Page() { return null }
TSX
    ;;
  pages-router)
    mkdir -p "$FIX/pages"
    cat > "$FIX/package.json" <<JSON
{
  "name": "gravel-smoke-fixture",
  "version": "0.0.1",
  "private": true,
  "dependencies": { "next": "15.0.0" }
}
JSON
    : > "$FIX/pnpm-lock.yaml"
    cat > "$FIX/pages/index.ts" <<TSX
export default function Page() { return null }
TSX
    ;;
esac
(
  cd "$FIX"
  git init -q
  git add -A
  git commit -q -m "fixture init" --allow-empty
)
note "fixture ready at $FIX  ($FIXTURE_KIND)"

# -----------------------------------------------------------------------------
# 4a. Direct binary path (skip the wrapper)
# -----------------------------------------------------------------------------
if [ "$USE_WRAPPER" = "0" ]; then
  note "running BARE BINARY: $WORK/gravel-linux-amd64 init ${INIT_ARGS[*]:-} (cwd=$FIX)"
  (
    cd "$FIX"
    HOME="$WORK" "$WORK/gravel-linux-amd64" init "${INIT_ARGS[@]:-}"
  )
  note "--- post-init fixture tree ---"
  (cd "$FIX" && find . -path ./node_modules -prune -o -path ./.git -prune -o -type f -print 2>/dev/null | sort)
  note "--- final package.json ---"
  cat "$FIX/package.json"
  exit 0
fi

# -----------------------------------------------------------------------------
# 4b. Full wrapper path: pack the local sdk-ts, install in fixture, run wrapper
# -----------------------------------------------------------------------------
note "packing local @artanis-ai/gravel (no publish; bumps its own version to $DEV_VERSION)"
# Snapshot the real version so we can restore it after packing.
ORIG_VERSION=$(node -p "require('$REPO_ROOT/packages/sdk-ts/package.json').version")
# Rewrite the package's version to $DEV_VERSION temporarily so the wrapper
# fetches v$DEV_VERSION from our mirror (it reads ../package.json at runtime).
node -e "
  const fs = require('fs');
  const path = '$REPO_ROOT/packages/sdk-ts/package.json';
  const p = JSON.parse(fs.readFileSync(path, 'utf8'));
  p.version = '$DEV_VERSION';
  fs.writeFileSync(path, JSON.stringify(p, null, 2) + '\n');
"
restore_version() {
  node -e "
    const fs = require('fs');
    const path = '$REPO_ROOT/packages/sdk-ts/package.json';
    const p = JSON.parse(fs.readFileSync(path, 'utf8'));
    p.version = '$ORIG_VERSION';
    fs.writeFileSync(path, JSON.stringify(p, null, 2) + '\n');
  "
}
trap 'restore_version; cleanup' EXIT INT TERM

# pnpm pack writes the .tgz into cwd; capture its filename.
(
  cd "$REPO_ROOT/packages/sdk-ts"
  pnpm pack --pack-destination "$WORK" >/dev/null
)
TGZ=$(ls "$WORK"/artanis-ai-gravel-*.tgz | head -1)
note "tarball: $TGZ"

note "installing tarball into fixture (pnpm add file:$TGZ)"
(
  cd "$FIX"
  pnpm install --silent
  pnpm add "$TGZ" --silent
)

note "running WRAPPER: ./node_modules/.bin/gravel init ${INIT_ARGS[*]:-} (cwd=$FIX, GRAVEL_RELEASES_BASE_URL=http://127.0.0.1:$PORT)"
(
  cd "$FIX"
  HOME="$WORK" GRAVEL_RELEASES_BASE_URL="http://127.0.0.1:$PORT" \
    ./node_modules/.bin/gravel init "${INIT_ARGS[@]:-}"
)

note "--- post-init fixture tree ---"
(cd "$FIX" && find . -path ./node_modules -prune -o -path ./.git -prune -o -type f -print 2>/dev/null | sort)
note "--- final package.json deps ---"
node -p "JSON.stringify(JSON.parse(require('fs').readFileSync('$FIX/package.json')).dependencies, null, 2)"

restore_version
trap cleanup EXIT INT TERM
