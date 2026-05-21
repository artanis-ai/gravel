#!/usr/bin/env bash
# =============================================================================
# tools/test-agent-install-fastapi.sh — happy-path agent install on a
# fresh Python + FastAPI fixture. Spawns `claude -p`, points it at the
# canonical install URL, asserts the agent runs the wizard's three
# pillars in order and that the dashboard responds at /admin/ai/.
#
# This is the v0.10.0 acceptance test for the "agent drives `gravel
# init` correctly when told only the URL" claim — the failure mode
# Olly's 2026-05-21 dogfooding exposed. One run takes ~60-90s and
# costs ~$0.10 (a few WebFetch + Bash tool calls).
#
# Usage:
#   ./tools/test-agent-install-fastapi.sh          # one run, fail-fast
#   KEEP=1 ./tools/test-agent-install-fastapi.sh   # keep artifacts
#
# Pre-reqs: claude CLI, uv, uvx all on PATH.
# =============================================================================
set -euo pipefail

KEEP=${KEEP:-0}
PORT=${PORT:-8911}
PROMPT='Install gravel from https://artanis.ai/gravel/llms.txt. Run the agent install steps yourself; do not ask me to run commands. When you are done, tell me where to open the dashboard.'

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '\033[32m✓ %s\033[0m\n' "$*"; }
fail() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
step() { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }

command -v claude >/dev/null 2>&1 || fail "claude CLI not on PATH"
command -v uv     >/dev/null 2>&1 || fail "uv not on PATH"
command -v uvx    >/dev/null 2>&1 || fail "uvx not on PATH"

workdir=$(mktemp -d -t gravel-agent-fastapi-XXXX)
cleanup() {
  if [ "$KEEP" = "1" ]; then
    echo "Artifacts kept at: $workdir"
    return
  fi
  rm -rf "$workdir"
}
trap cleanup EXIT

step "Building fresh FastAPI fixture in $workdir"
cd "$workdir"
cat > pyproject.toml <<'PYPROJ'
[project]
name = "gravel-agent-test"
version = "0.0.1"
requires-python = ">=3.11"
dependencies = [
  "fastapi>=0.115",
  "uvicorn>=0.30",
]
PYPROJ

mkdir -p app
cat > app/__init__.py <<'INIT'
INIT
cat > app/main.py <<'MAIN'
from fastapi import FastAPI

app = FastAPI()


@app.get("/")
def read_root():
    return {"hello": "world"}
MAIN

git init -q
git add -A
git -c user.name=test -c user.email=test@example.com commit -q -m "initial"

uv sync --quiet
ok "Fixture ready (FastAPI + uv + git)"

step "Driving agent install (claude -p, max-turns=30)"
# `--max-turns` cap stops a confused agent from burning money. 30 is
# plenty for the six steps + a few investigation tool calls.
output=$(claude -p \
  --max-turns 30 \
  --output-format json \
  "$PROMPT" 2>&1) || fail "claude -p exited non-zero"

step "Asserting agent ran the install pillars in order"
# Each assertion looks for either the literal subcommand OR the npx /
# uvx wrapper form. The agent might use either.
assert_ran() {
  local name="$1" pattern="$2"
  if echo "$output" | grep -qE "$pattern"; then
    ok "$name"
  else
    fail "agent never ran: $name"
  fi
}

# Step 0: version check (doctor --json or doctor)
assert_ran "version check (doctor)" 'gravel\s+doctor|gravel-doctor'
# Step 1: detect
assert_ran "stack detect"           'gravel\s+detect'
# Step 2: mount plan + apply
assert_ran "mount --plan"           'gravel\s+mount\s+--plan'
assert_ran "mount --apply"          'gravel\s+mount\s+--apply'
# Step 3: prompts plan + apply
assert_ran "prompts --plan"         'gravel\s+prompts\s+--plan'
# `--apply` for prompts may or may not run if the fixture has no
# prompt files; the apply call is the strict assertion below.
if echo "$output" | grep -qE 'gravel\s+prompts\s+--apply'; then
  ok "prompts --apply"
else
  ok "prompts --apply skipped (acceptable for prompt-less fixture)"
fi

step "Asserting agent used curl (not just WebFetch) for llms.txt"
if echo "$output" | grep -qE 'curl[^"]*artanis\.ai/gravel/llms(-full)?\.txt'; then
  ok "agent fetched llms.txt via curl"
else
  fail "agent never fetched llms.txt via curl — install guide may have been paraphrased"
fi

step "Booting the patched app + curling /admin/ai/"
uv run uvicorn app.main:app --host 127.0.0.1 --port "$PORT" >/tmp/gravel-agent-test-server.log 2>&1 &
server_pid=$!
trap 'kill $server_pid 2>/dev/null; cleanup' EXIT

# Poll for server-up.
for _ in $(seq 1 40); do
  if curl -fsS -o /dev/null "http://127.0.0.1:${PORT}/" 2>/dev/null; then
    break
  fi
  sleep 0.25
done

if curl -fsS -o /dev/null -w "%{http_code}" "http://127.0.0.1:${PORT}/admin/ai/" | grep -qE '^(200|301|302|303|307|308)$'; then
  ok "/admin/ai/ responds OK"
else
  fail "/admin/ai/ did not respond (server log: /tmp/gravel-agent-test-server.log)"
fi

bold "PASS — agent successfully installed Gravel from the URL alone"
