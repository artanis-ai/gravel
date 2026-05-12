#!/usr/bin/env bash
# tools/sync-dashboard-dist.sh — stage the built dashboard SPA inside
# the Python package so `python -m build --wheel` ships it.
#
# The wheel target's `artifacts` glob pulls in
# `src/artanis_gravel/_dashboard_dist/**`. We copy
# `packages/dashboard/dist/*` there before building. This avoids
# Hatch's `force-include` clause, which is resolved at every build
# (including `uv sync`'s editable install in CI) and errored before
# the dashboard had a chance to be built.
#
# Idempotent: clears any prior contents before copying. No-op exit
# code 0 when the source dist doesn't exist (we assume the caller
# wanted to build a wheel without a dashboard; the SDK's
# `find_dashboard_dist()` walk-up handles dev installs).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$REPO_ROOT/packages/dashboard/dist"
DEST="$REPO_ROOT/python/gravel/src/artanis_gravel/_dashboard_dist"

if [ ! -d "$SRC" ]; then
  echo "tools/sync-dashboard-dist.sh: no $SRC; nothing to stage (run \`pnpm --filter @artanis-ai/gravel-dashboard build\` first to bundle)"
  exit 0
fi
if [ ! -f "$SRC/index.html" ]; then
  echo "tools/sync-dashboard-dist.sh: $SRC has no index.html; refusing to stage half-built dist" >&2
  exit 1
fi

rm -rf "$DEST"
mkdir -p "$DEST"
cp -R "$SRC"/. "$DEST/"
echo "tools/sync-dashboard-dist.sh: staged $(find "$DEST" -type f | wc -l) files into $DEST"
