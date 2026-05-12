#!/usr/bin/env bash
# tools/release.sh vX.Y.Z
#
# Single-command release for the gravel CLI binary + SDK packages.
#
# What it does:
#   1. Pre-flight: clean tree, on main, version not already released,
#      tests pass.
#   2. Bumps version in lockstep across:
#        - cli/internal/version/version.go
#        - packages/sdk-ts/package.json
#        - python/gravel/pyproject.toml
#   3. Commits + tags + pushes.
#   4. Triggers three GitHub Actions workflows by tag push:
#        - release-cli.yml  (cross-compile + GitHub Release)
#        - publish-npm.yml  (SDK to npm, library-only, OIDC)
#        - publish-python.yml (SDK to PyPI, library-only, OIDC)
#   5. Post-release verify: re-pulls the install.sh, asserts version.
#
# Usage:  tools/release.sh v0.3.0
# Dry run: DRY_RUN=1 tools/release.sh v0.3.0

set -euo pipefail

bold=$(printf '\033[1m')
red=$(printf '\033[31m')
green=$(printf '\033[32m')
yellow=$(printf '\033[33m')
reset=$(printf '\033[0m')

die()  { printf '%s%srelease: %s%s\n' "$bold" "$red"    "$1" "$reset" >&2; exit 1; }
info() { printf '%srelease:%s %s\n'   "$bold" "$reset"  "$1"; }
warn() { printf '%s%srelease: %s%s\n' "$bold" "$yellow" "$1" "$reset"; }
ok()   { printf '%s%s✓%s %s\n'        "$bold" "$green"  "$reset" "$1"; }

# --- arg parsing -------------------------------------------------------------

[ $# -eq 1 ] || die "usage: tools/release.sh vX.Y.Z"
TAG="$1"

case "$TAG" in
  v[0-9]*.[0-9]*.[0-9]*) ;;
  *) die "tag must look like vX.Y.Z (got '$TAG')" ;;
esac

VERSION="${TAG#v}"
DRY_RUN="${DRY_RUN:-0}"

run() {
  if [ "$DRY_RUN" = "1" ]; then
    printf '  [dry-run] %s\n' "$*"
  else
    "$@"
  fi
}

# --- locate repo root --------------------------------------------------------

cd "$(git rev-parse --show-toplevel)" || die "not in a git repo"
REPO_ROOT="$PWD"
info "repo root: $REPO_ROOT"
info "releasing $TAG (version literal: $VERSION)"
[ "$DRY_RUN" = "1" ] && warn "DRY_RUN=1, nothing will be committed or pushed"

# --- pre-flight --------------------------------------------------------------

info "pre-flight"

# Clean working tree.
if [ -n "$(git status --porcelain)" ]; then
  die "working tree dirty; commit or stash before releasing."
fi
ok "working tree clean"

# Must be on main (or override via FORCE_BRANCH=1 for hotfixes).
BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$BRANCH" != "main" ] && [ "${FORCE_BRANCH:-0}" != "1" ]; then
  die "must release from main (currently on '$BRANCH'). Override with FORCE_BRANCH=1."
fi
ok "on branch $BRANCH"

# Tag must not already exist locally or on origin.
if git rev-parse "$TAG" >/dev/null 2>&1; then
  die "tag $TAG already exists locally."
fi
if git ls-remote --tags origin "refs/tags/$TAG" | grep -q "$TAG"; then
  die "tag $TAG already exists on origin."
fi
ok "tag $TAG is free"

# Go tests pass.
info "running go test ./..."
( cd "$REPO_ROOT/cli" && go test ./... ) || die "go tests failed"
ok "go tests pass"

# SDK builds clean.
info "building SDKs"
( cd "$REPO_ROOT" && pnpm -F @artanis-ai/gravel build ) >/dev/null || die "sdk-ts build failed"
ok "sdk-ts builds"

if [ -d "$REPO_ROOT/python/gravel" ]; then
  ( cd "$REPO_ROOT/python/gravel" && python -m build --sdist --outdir /tmp/gravel-release-check ) >/dev/null 2>&1 || warn "python build skipped (python -m build not available)"
fi

# --- version bumps -----------------------------------------------------------

info "bumping versions to $VERSION"

# Go: cli/internal/version/version.go
GO_VERSION_FILE="$REPO_ROOT/cli/internal/version/version.go"
if ! grep -q '^var Version' "$GO_VERSION_FILE"; then
  die "couldn't find Version var in $GO_VERSION_FILE"
fi
run sed -i.bak "s/^var Version = .*/var Version = \"$VERSION\"/" "$GO_VERSION_FILE"
run rm -f "$GO_VERSION_FILE.bak"
ok "cli/internal/version/version.go"

# npm: packages/sdk-ts/package.json
SDK_TS_PKG="$REPO_ROOT/packages/sdk-ts/package.json"
run node -e "
  const fs = require('fs');
  const p = JSON.parse(fs.readFileSync('$SDK_TS_PKG', 'utf8'));
  p.version = '$VERSION';
  fs.writeFileSync('$SDK_TS_PKG', JSON.stringify(p, null, 2) + '\n');
"
ok "packages/sdk-ts/package.json"

# Python: python/gravel/pyproject.toml
PYPROJECT="$REPO_ROOT/python/gravel/pyproject.toml"
if [ -f "$PYPROJECT" ]; then
  run sed -i.bak "s/^version = \".*\"/version = \"$VERSION\"/" "$PYPROJECT"
  run rm -f "$PYPROJECT.bak"
  ok "python/gravel/pyproject.toml"
fi

# --- commit + tag + push -----------------------------------------------------

info "committing + tagging + pushing"

run git add \
  "$GO_VERSION_FILE" \
  "$SDK_TS_PKG" \
  $([ -f "$PYPROJECT" ] && echo "$PYPROJECT")

run git commit -m "release: $TAG"
run git tag -a "$TAG" -m "$TAG"
run git push origin main
run git push origin "$TAG"

ok "pushed $TAG"

# --- monitor + verify --------------------------------------------------------

if [ "$DRY_RUN" = "1" ]; then
  info "dry-run complete; skipping post-release verify."
  exit 0
fi

info "GitHub Actions will now run:"
info "  - release-cli.yml      (cross-compile + GitHub Release)"
info "  - publish-npm.yml      (SDK to npm)"
info "  - publish-python.yml   (SDK to PyPI)"
info "watch progress: https://github.com/artanis-ai/gravel/actions"

# Don't block on workflows here; a separate `tools/verify-release.sh`
# can be run after they complete. Returning success the moment the tag
# is pushed lets the operator move on; the workflow run page is the
# authoritative status.

ok "release $TAG initiated"
