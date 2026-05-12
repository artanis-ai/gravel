#!/usr/bin/env bash
# =============================================================================
# tools/smoke-landlord-ai.sh — full end-to-end wizard test on Yousef's real
# landlord-ai project. Resets the project to a pristine pre-wizard state,
# runs the current wizard binary, boots `uv run landlord serve`, and curls
# /admin/ai/. Reports PASS/FAIL.
#
# Use this BEFORE every wizard / SDK release to verify the install still
# works on a non-trivial real-world Python project (src-layout uv package,
# nested FastAPI entry, etc.). Anything that breaks here will break for
# customers.
#
# Usage:
#   ./tools/smoke-landlord-ai.sh                # full run
#   ./tools/smoke-landlord-ai.sh --keep         # leave artifacts in place
#                                               # (for poking around after)
#
# Safe to re-run: aborts upfront if landlord-ai has unrelated uncommitted
# changes (other than the gravel-generated files we expect to manage).
# =============================================================================
set -euo pipefail

LANDLORD_DIR="/home/amar/proj/code/artanis/landlord-ai"
GRAVEL_REPO="/home/amar/proj/code/artanis/gravel"
WIZARD_SRC="$GRAVEL_REPO/cli"
SDK_PYTHON_SRC="$GRAVEL_REPO/python/gravel"
SERVER_PORT=8799
KEEP=0
for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=1 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
fail()  { printf '\033[31m✗ %s\033[0m\n' "$*"; exit 1; }
ok()    { printf '\033[32m✓ %s\033[0m\n' "$*"; }
step()  { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }

cleanup() {
  if [ -n "${SERVER_PID:-}" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

[ -d "$LANDLORD_DIR" ] || fail "landlord-ai not found at $LANDLORD_DIR"
[ -d "$WIZARD_SRC" ]   || fail "wizard source not found at $WIZARD_SRC"
[ -d "$SDK_PYTHON_SRC" ] || fail "python SDK source not found at $SDK_PYTHON_SRC"

# ----- Pre-flight: confirm landlord-ai is in a known-good state ---------------
step "Pre-flight: checking landlord-ai working tree"

# Files the wizard owns. Anything outside this list with uncommitted
# changes means the user has in-progress work we MUST NOT clobber.
GRAVEL_FILES=(
  "gravel_route.py"
  "gravel_config.py"
  "src/landlord_ai/gravel_route.py"
  ".env.local"
  "pyproject.toml"      # tool.uv.sources is what we'll add
  "uv.lock"
  "src/landlord_ai/server.py"  # patched in-place
)

cd "$LANDLORD_DIR"
DIRTY="$(git status --porcelain | grep -v -E "^\?\? __pycache__|^.. ($(printf '%s|' "${GRAVEL_FILES[@]}" | sed 's/|$//'))" || true)"
if [ -n "$DIRTY" ]; then
  echo "$DIRTY"
  fail "landlord-ai has uncommitted changes outside the gravel-owned set; commit or stash first"
fi
ok "working tree clean (gravel-owned files OK to mutate)"

# ----- Reset landlord-ai to pristine pre-wizard state ------------------------
step "Resetting landlord-ai to pre-wizard state"
rm -f gravel_route.py gravel_config.py
rm -f src/landlord_ai/gravel_route.py
rm -f .env.local
# Restore every tracked file the wizard might have touched. `git checkout --`
# on a clean (or just-this-test-dirty) tree just resets our changes.
# uv.lock is tracked in landlord-ai and MUST be present for the wizard's
# detector to recognise it as a uv project (otherwise it falls back to pip
# and tries `pip install artanis-gravel`, which fails outside an activated
# venv).
git checkout -- src/landlord_ai/server.py
git checkout -- pyproject.toml 2>/dev/null || true
git checkout -- uv.lock 2>/dev/null || true
find . -name "__pycache__" -type d -not -path "./.venv/*" -exec rm -rf {} + 2>/dev/null || true
ok "removed gravel-generated files and reset patched entry"

# Sanity-check: detector inputs are in place.
[ -f uv.lock ] || fail "uv.lock missing after reset — wizard will mis-detect as pip"
ok "uv.lock present (wizard will detect uv)"

# Confirm server.py is back to its untouched state.
if grep -q "gravel_router" src/landlord_ai/server.py; then
  fail "server.py still contains gravel_router import after reset"
fi
ok "server.py is back to its pristine state"

# ----- Build the wizard binary from current source --------------------------
step "Building wizard binary from $WIZARD_SRC"
WIZARD_BIN="$(mktemp -t gravel-smoke-XXXXXX)"
(cd "$WIZARD_SRC" && go build -o "$WIZARD_BIN" ./cmd/gravel) || fail "go build failed"
ok "built $WIZARD_BIN ($(stat -c%s "$WIZARD_BIN") bytes)"

# ----- Run the wizard --------------------------------------------------------
# Note: we deliberately do NOT pass --skip-sdk-install. The wizard's own
# `uv add artanis-gravel` step is what we want to exercise here — that's
# half the contract. tool.uv.sources later redirects the install to our
# in-progress local source.
step "Running wizard: $WIZARD_BIN init --yes --no-traces --no-prompts"
WIZARD_OUT="$(mktemp -t gravel-smoke-wizout-XXXXXX)"
"$WIZARD_BIN" init --yes --no-traces --no-prompts > "$WIZARD_OUT" 2>&1 \
  || { cat "$WIZARD_OUT"; fail "wizard exited non-zero"; }

tail -15 "$WIZARD_OUT"

# Confirm the wizard's SDK-install step actually added the dep.
grep -q '"artanis-gravel' pyproject.toml \
  || fail "wizard didn't add artanis-gravel to pyproject.toml dependencies"
ok "artanis-gravel listed in pyproject.toml dependencies"

# Wizard must NOT have left .bak files (we're in a git repo).
BAK_COUNT="$(find . -name '*.gravel.bak*' -not -path './.venv/*' | wc -l)"
[ "$BAK_COUNT" -eq 0 ] || fail ".gravel.bak files present despite git repo (count=$BAK_COUNT)"
ok "no .gravel.bak files in working tree"

# Required artifacts:
[ -f gravel_config.py ] || fail "gravel_config.py not written"
ok "gravel_config.py written at project root"
[ -f src/landlord_ai/gravel_route.py ] || fail "src/landlord_ai/gravel_route.py not written"
ok "gravel_route.py written alongside the entry"
grep -q "from .gravel_route import router as gravel_router" src/landlord_ai/server.py \
  || fail "entry file not patched with relative gravel_router import"
ok "server.py patched with relative import"
grep -q "for _env_file in" gravel_config.py \
  || fail "gravel_config.py missing .env loader"
ok "gravel_config.py auto-loads .env.local"
[ -f .env.local ] || fail ".env.local not written"
grep -q "^GRAVEL_ADMIN_PASSWORD=" .env.local \
  || fail ".env.local missing GRAVEL_ADMIN_PASSWORD"
ok ".env.local has GRAVEL_ADMIN_PASSWORD"

# ----- Pin the SDK to the local source so `uv run` doesn't resync over it ---
step "Configuring tool.uv.sources for editable SDK install"
# Idempotent insert: only add the block if it isn't already there.
if ! grep -q "tool.uv.sources" pyproject.toml; then
  cat >> pyproject.toml <<EOF

# Smoke-test override: point uv at the in-progress artanis-gravel source tree
# so \`uv run\` doesn't resync the venv back to the published version on every
# invocation. editable=true keeps the SDK's __file__ inside the source tree
# so its dashboard-dist walk-up actually finds packages/dashboard/dist.
[tool.uv.sources]
artanis-gravel = { path = "$SDK_PYTHON_SRC", editable = true }
EOF
fi
ok "tool.uv.sources points at $SDK_PYTHON_SRC (editable)"

step "uv sync (rebuilds the lockfile against the local SDK)"
uv sync 2>&1 | tail -3
ok "venv synced"

# ----- Boot the server -------------------------------------------------------
step "Booting: uv run landlord serve --port $SERVER_PORT"
SERVER_LOG="$(mktemp -t gravel-smoke-server-XXXXXX)"
uv run landlord serve --port "$SERVER_PORT" > "$SERVER_LOG" 2>&1 &
SERVER_PID=$!

# Wait for the socket to bind (uvicorn imports a lot; can take a few seconds).
BOUND=0
for i in $(seq 1 30); do
  if ss -ltn 2>/dev/null | grep -q ":${SERVER_PORT} "; then
    BOUND=1
    ok "server bound after ${i}s"
    break
  fi
  sleep 1
done
[ "$BOUND" -eq 1 ] || { tail -30 "$SERVER_LOG"; fail "server never bound on port $SERVER_PORT"; }

# Confirm server hasn't crashed in the background.
if ! kill -0 "$SERVER_PID" 2>/dev/null; then
  tail -30 "$SERVER_LOG"
  fail "server process exited unexpectedly"
fi

# ----- Probe ----------------------------------------------------------------
step "Probing /admin/ai/"
STATUS_SLASH=$(curl -sS -o /tmp/smoke-admin-body.html -w "%{http_code}" "http://localhost:${SERVER_PORT}/admin/ai/" || echo "000")
echo "GET /admin/ai/        -> $STATUS_SLASH"
[ "$STATUS_SLASH" = "200" ] || fail "expected 200 on /admin/ai/, got $STATUS_SLASH"
head -c 100 /tmp/smoke-admin-body.html
echo

step "Probing /admin/ai (no slash, should redirect)"
STATUS_REDIR=$(curl -sS -L -o /dev/null -w "%{http_code}" "http://localhost:${SERVER_PORT}/admin/ai" || echo "000")
echo "GET /admin/ai         -> (follow) $STATUS_REDIR"
[ "$STATUS_REDIR" = "200" ] || fail "expected 200 after redirect, got $STATUS_REDIR"

step "Probing /admin/ai/api/version"
STATUS_VER=$(curl -sS -o /dev/null -w "%{http_code}" "http://localhost:${SERVER_PORT}/admin/ai/api/version" || echo "000")
echo "GET /admin/ai/api/ver -> $STATUS_VER"
[ "$STATUS_VER" = "200" ] || fail "expected 200 from api/version, got $STATUS_VER"

step "Probing /admin/ai/api/auth/login with real password"
PW=$(grep "^GRAVEL_ADMIN_PASSWORD=" .env.local | cut -d= -f2)
LOGIN_RESP=$(curl -sS -X POST -H "content-type: application/json" \
  -d "{\"password\":\"$PW\"}" \
  -o /dev/null -w "%{http_code}" \
  "http://localhost:${SERVER_PORT}/admin/ai/api/auth/login" || echo "000")
echo "POST /api/auth/login  -> $LOGIN_RESP"
[ "$LOGIN_RESP" = "200" ] || fail "expected 200 from auth/login, got $LOGIN_RESP"

# ----- Done -----------------------------------------------------------------
step "ALL CHECKS PASSED"
ok "wizard works end-to-end on landlord-ai"

if [ "$KEEP" -eq 0 ]; then
  step "Cleanup: leaving landlord-ai files in place (use git to inspect/revert)"
  echo "  - $LANDLORD_DIR was wizard'd; \`git status\` to see the install diff"
  echo "  - Use --keep to skip this notice on re-runs"
fi
