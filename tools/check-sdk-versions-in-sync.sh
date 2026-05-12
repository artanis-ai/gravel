#!/usr/bin/env bash
# tools/check-sdk-versions-in-sync.sh — guard rail against the failure
# mode that bit us on v0.5.3 and v0.5.4: bumping ONE SDK's version (the
# Python one in python/gravel/pyproject.toml) but forgetting the other
# (packages/sdk-ts/package.json), then pushing a `v*` tag that triggers
# BOTH publish workflows. PyPI accepts the new version, npm 409s on
# "cannot publish over the previously published version" — leaving the
# SDKs out of sync on the registries.
#
# Reads the version string from each manifest and exits non-zero (with
# a diff-style message) if they don't match. Invoked from:
#   * .pre-commit-config.yaml (pre-commit stage) — fast feedback
#   * .githooks/pre-push                          — catches before push
#   * .github/workflows/version-sync.yml          — CI guard
#
# Skips comparison if EITHER manifest's version contains a non-stable
# marker (e.g. `-dev`, `-rc1`), under the assumption that pre-release
# work intentionally diverges. Bump both back in lockstep at release.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PY="$REPO_ROOT/python/gravel/pyproject.toml"
TS="$REPO_ROOT/packages/sdk-ts/package.json"

[ -f "$PY" ] || { echo "check-sdk-versions: $PY missing" >&2; exit 2; }
[ -f "$TS" ] || { echo "check-sdk-versions: $TS missing" >&2; exit 2; }

# `version = "X.Y.Z"` in pyproject.toml — first match wins.
PY_VERSION=$(grep -m1 -E '^version[[:space:]]*=' "$PY" | sed -E 's/^version[[:space:]]*=[[:space:]]*"([^"]+)"/\1/')
# `"version": "X.Y.Z"` in package.json (no jq dep) — first match wins.
TS_VERSION=$(grep -m1 -E '"version"[[:space:]]*:' "$TS" | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')

if [ -z "$PY_VERSION" ] || [ -z "$TS_VERSION" ]; then
  echo "check-sdk-versions: could not parse a version from one or both manifests" >&2
  echo "  python/gravel/pyproject.toml -> ${PY_VERSION:-<empty>}" >&2
  echo "  packages/sdk-ts/package.json -> ${TS_VERSION:-<empty>}" >&2
  exit 2
fi

# Pre-release ("0.6.0-dev", "1.0.0-rc1") intentionally diverges; skip.
case "$PY_VERSION$TS_VERSION" in
  *-*) exit 0 ;;
esac

if [ "$PY_VERSION" != "$TS_VERSION" ]; then
  cat >&2 <<EOF
✗ SDK version mismatch:
    python/gravel/pyproject.toml = $PY_VERSION
    packages/sdk-ts/package.json = $TS_VERSION

Both SDKs publish off the same \`v*\` git tag. If they disagree, one of
the publish workflows will 409 on re-publishing the existing version
(npm: "cannot publish over the previously published version"). Bump
both in lockstep, or move the laggard to "$PY_VERSION" (or vice versa)
before tagging.

To override (rarely correct), commit/push with --no-verify.
EOF
  exit 1
fi
echo "check-sdk-versions: both SDKs at $PY_VERSION ✓"
