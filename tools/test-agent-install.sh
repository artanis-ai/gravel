#!/usr/bin/env bash
# =============================================================================
# tools/test-agent-install.sh — drive `claude -p` against the agent-facing
# install URL `https://artanis.ai/gravel/llms.txt` N times and assert that
# the agent EITHER fetches the file via curl directly OR self-corrects to
# curl after a paraphrased WebFetch result.
#
# Background: Olly's 2026-05-21 dogfooding showed Claude Code's WebFetch
# paraphrases llms.txt — the prescriptive Step 0 / Step 1 wording is
# semantically lost. v0.10.0 added a landing-page signpost + a
# curl-recommendation at the top of llms.txt so the agent corrects itself.
# This script measures how reliably that correction happens.
#
# Usage:
#   ./tools/test-agent-install.sh             # 5 runs, fail if <4 use curl
#   N=10 ./tools/test-agent-install.sh        # 10 runs
#   THRESHOLD=8 N=10 ./tools/test-agent-install.sh
#
# Costs ~$0.05 per run (one short prompt, capped at a few tool calls).
# Use locally before releases; not wired into CI.
# =============================================================================
set -euo pipefail

N=${N:-5}
THRESHOLD=${THRESHOLD:-$((N - 1))}
PROMPT='Install https://artanis.ai/gravel/llms.txt'

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '\033[32m✓ %s\033[0m\n' "$*"; }
fail() { printf '\033[31m✗ %s\033[0m\n' "$*"; }

bold "Running agent-install consistency test: N=$N, threshold=$THRESHOLD"
echo "Prompt: $PROMPT"
echo

if ! command -v claude >/dev/null 2>&1; then
  fail "claude CLI not found on PATH; install Claude Code first"
  exit 2
fi

passes=0
failures=()
for i in $(seq 1 "$N"); do
  echo "─── run $i / $N ───"
  # Run in a throwaway dir so the agent doesn't pollute any project.
  workdir=$(mktemp -d -t gravel-agent-test-XXXX)
  # `claude -p` runs non-interactive (one prompt, one response). The
  # `--max-turns` flag caps it so a hallucinating agent can't burn
  # money on a runaway loop. `--output-format json` gives us the
  # tool-call history we need to assert on.
  output=$(cd "$workdir" && claude -p --max-turns 6 --output-format json "$PROMPT" 2>&1 || true)
  rm -rf "$workdir"

  used_curl=false
  used_webfetch_only=false
  # The JSON output has a sequence of `tool_use` events. Look for
  # the canonical curl invocation pointing at gravel/llms.txt OR
  # llms-full.txt — both count as "agent fetched verbatim text".
  if echo "$output" | grep -qE 'curl[^"]*artanis\.ai/gravel/llms(-full)?\.txt'; then
    used_curl=true
  fi
  if echo "$output" | grep -qE '"name"\s*:\s*"WebFetch"' && ! $used_curl; then
    used_webfetch_only=true
  fi

  if $used_curl; then
    ok "run $i: used curl (with or without prior WebFetch)"
    passes=$((passes + 1))
  elif $used_webfetch_only; then
    fail "run $i: WebFetch only — did NOT self-correct to curl"
    failures+=("$i: WebFetch only")
  else
    fail "run $i: neither curl nor WebFetch detected — inspect raw output"
    failures+=("$i: no fetch tool")
  fi
done

echo
bold "Summary: $passes / $N runs used curl (threshold: $THRESHOLD)"
if [ "$passes" -ge "$THRESHOLD" ]; then
  ok "PASS"
  exit 0
fi
fail "FAIL — agent did not self-correct to curl consistently"
for f in "${failures[@]}"; do
  echo "  - $f"
done
exit 1
