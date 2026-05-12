#!/bin/sh
# =============================================================================
# install.sh — canonical install path for the `gravel` CLI binary.
# =============================================================================
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/artanis-ai/gravel/main/install.sh | sh
#
# Env overrides:
#   GRAVEL_VERSION       Pin a specific version (e.g. v0.3.0). Default: latest.
#   GRAVEL_INSTALL_DIR   Target install directory. Default: $HOME/.local/bin.
#
# -----------------------------------------------------------------------------
# Notes for auditors / agents reviewing this script
# -----------------------------------------------------------------------------
# The script is intentionally small (~150 lines) and POSIX-only so it runs on
# macOS /bin/sh, BusyBox shells, and minimal Linux containers without bash
# present. Every line below is documented; nothing is obfuscated, encoded, or
# fetched in a way you can't reproduce by hand.
#
# What it does, step by step:
#   1. Detect host OS (`uname -s`) and CPU arch (`uname -m`).
#   2. Resolve the version: respect $GRAVEL_VERSION or query the GitHub Releases
#      API for `latest` (one HTTPS GET, no auth required, no cookies set).
#   3. Download the binary `gravel-<os>-<arch>` from the GitHub Release for that
#      version, plus the matching `.sha256` digest file.
#   4. Verify the binary against the digest with `sha256sum` or `shasum -a 256`.
#      Aborts if they don't match — no install happens on a digest mismatch.
#   5. Move the binary to $GRAVEL_INSTALL_DIR/gravel (default ~/.local/bin/gravel),
#      mode 0755.
#   6. Print PATH instructions if $GRAVEL_INSTALL_DIR isn't on $PATH.
#   7. Sanity check: invoke `gravel --version` and verify it ran.
#
# What it does NOT do:
#   - No sudo. The default install dir is in $HOME; no system-wide writes.
#   - No shell-profile edits (.zshrc / .bashrc are NEVER modified — the script
#     only prints instructions if PATH needs updating).
#   - No telemetry. No analytics. No outbound HTTP except to api.github.com and
#     github.com/<repo>/releases/...
#   - No package-manager touching. The CLI binary lives outside npm/PyPI by
#     design (see `cli/DESIGN.md`); installing it does not affect any project's
#     dependency graph.
#   - No background processes, daemons, or watchers spawned.
#
# Where everything lives:
#   - Script source: github.com/artanis-ai/gravel/install.sh (this file).
#   - Binary source: github.com/artanis-ai/gravel/cli/ (Go module, Apache 2.0).
#   - Build pipeline: .github/workflows/release-cli.yml in the same repo, using
#     `-trimpath -buildvcs=false -ldflags="-s -w -X .../version.Version=X.Y.Z"`
#     for reproducible builds. The workflow has `id-token: write` for OIDC
#     provenance attestations on the release assets.
#   - Release artifacts: github.com/artanis-ai/gravel/releases/tag/<version>
#     contain one binary + one .sha256 per supported target.
#   - Architecture doc: github.com/artanis-ai/gravel/blob/main/cli/DESIGN.md
#
# Supported targets:
#   - linux-amd64, linux-arm64
#   - darwin-amd64, darwin-arm64 (macOS Intel + Apple Silicon)
# Windows: download gravel-windows-amd64.exe from the release page directly.
#
# To reproduce a release locally and compare:
#   git clone https://github.com/artanis-ai/gravel
#   cd gravel/cli
#   git checkout v0.3.0
#   GOOS=linux GOARCH=amd64 CGO_ENABLED=0 \
#     go build -trimpath -buildvcs=false \
#     -ldflags="-s -w -X github.com/artanis-ai/gravel/cli/internal/version.Version=0.3.0" \
#     -o gravel-linux-amd64 ./cmd/gravel
#   sha256sum gravel-linux-amd64
#   # Compare against the .sha256 file on the release page.
# =============================================================================

set -eu

# REPO is the GitHub project this installer fetches from. Hard-coded so an
# auditor can see exactly which org/repo will be contacted. Forks should
# change this line.
REPO="artanis-ai/gravel"

# RELEASE_API is the unauthenticated GitHub Releases endpoint. 60 req/hr per
# IP for anonymous calls; plenty for `install.sh` invocations.
RELEASE_API="https://api.github.com/repos/${REPO}/releases/latest"

# INSTALL_DIR defaults to ~/.local/bin (XDG-aligned, no sudo needed). Override
# with $GRAVEL_INSTALL_DIR if you prefer /usr/local/bin (will require write
# permission there) or any other location.
INSTALL_DIR="${GRAVEL_INSTALL_DIR:-$HOME/.local/bin}"

# Terminal style helpers. Stripped to no-ops when stderr isn't a TTY would be
# nice but adds complexity; the escape codes are harmless when piped to a log.
bold=$(printf '\033[1m')
red=$(printf '\033[31m')
green=$(printf '\033[32m')
reset=$(printf '\033[0m')

err() { printf '%s%sgravel installer: %s%s\n' "$bold" "$red" "$1" "$reset" >&2; exit 1; }
info() { printf '%sgravel installer:%s %s\n' "$bold" "$reset" "$1"; }
ok() { printf '%s%s✓%s %s\n' "$bold" "$green" "$reset" "$1"; }

# ---------------------------------------------------------------------------
# 1. Detect platform
# ---------------------------------------------------------------------------
# Only OS + arch detection. No system fingerprinting beyond `uname -s -m`.

uname_os=$(uname -s 2>/dev/null || echo unknown)
uname_arch=$(uname -m 2>/dev/null || echo unknown)

case "$uname_os" in
  Linux)  os=linux ;;
  Darwin) os=darwin ;;
  MINGW*|MSYS*|CYGWIN*) err "This script is POSIX-only. On native Windows run:
    irm https://raw.githubusercontent.com/${REPO}/main/install.ps1 | iex
Or use WSL (where uname reports Linux and this script just works)." ;;
  *) err "unsupported OS '$uname_os'. Supported: Linux, macOS." ;;
esac

case "$uname_arch" in
  x86_64|amd64) arch=amd64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) err "unsupported architecture '$uname_arch'. Supported: amd64, arm64." ;;
esac

target="${os}-${arch}"
info "detected $target"

# ---------------------------------------------------------------------------
# 2. Pick version
# ---------------------------------------------------------------------------
# Honour an explicit $GRAVEL_VERSION (recommended for CI), otherwise resolve
# `latest` from the GitHub Releases API. We parse the JSON with sed to avoid a
# jq dependency; auditors can replicate the call with:
#   curl -fsSL https://api.github.com/repos/artanis-ai/gravel/releases/latest

version="${GRAVEL_VERSION:-}"
if [ -z "$version" ]; then
  if command -v curl >/dev/null 2>&1; then
    version=$(curl -fsSL "$RELEASE_API" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1) || true
  elif command -v wget >/dev/null 2>&1; then
    version=$(wget -qO- "$RELEASE_API" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1) || true
  else
    err "neither curl nor wget is available; install one and retry."
  fi
fi

if [ -z "$version" ]; then
  err "could not resolve a release version. Set GRAVEL_VERSION=vX.Y.Z to install a specific release, or check https://github.com/${REPO}/releases."
fi

info "installing gravel ${version} (${target})"

# ---------------------------------------------------------------------------
# 3. Download binary + sha256
# ---------------------------------------------------------------------------
# Two HTTPS GETs to github.com. Both URLs are constructed from $REPO and
# $version above; there's no URL manipulation hidden anywhere.

asset="gravel-${target}"
base_url="https://github.com/${REPO}/releases/download/${version}"
bin_url="${base_url}/${asset}"
sha_url="${base_url}/${asset}.sha256"

tmp=$(mktemp -d 2>/dev/null || mktemp -d -t gravel)
trap 'rm -rf "$tmp"' EXIT INT TERM

if command -v curl >/dev/null 2>&1; then
  curl -fL --progress-bar -o "$tmp/$asset" "$bin_url" || err "download failed: $bin_url"
  curl -fsSL -o "$tmp/$asset.sha256" "$sha_url" || err "download failed: $sha_url"
else
  wget -q --show-progress -O "$tmp/$asset" "$bin_url" || err "download failed: $bin_url"
  wget -q -O "$tmp/$asset.sha256" "$sha_url" || err "download failed: $sha_url"
fi

# ---------------------------------------------------------------------------
# 4. Verify sha256
# ---------------------------------------------------------------------------
# The release pipeline publishes "<sha>  <filename>" in each .sha256 file
# (output of `sha256sum`). We extract just the digest and compare. Aborts on
# mismatch before any install action occurs.

expected=$(awk '{print $1}' < "$tmp/$asset.sha256")
if [ -z "$expected" ]; then err "couldn't read expected sha256 from $asset.sha256"; fi

if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$tmp/$asset" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 "$tmp/$asset" | awk '{print $1}')
else
  err "neither sha256sum nor shasum is available; can't verify download."
fi

if [ "$expected" != "$actual" ]; then
  err "sha256 mismatch for ${asset}. Expected ${expected}, got ${actual}. Aborting."
fi
ok "sha256 verified"

# ---------------------------------------------------------------------------
# 5. Install
# ---------------------------------------------------------------------------
# Move-and-chmod. No setuid bits, no symlinks elsewhere, no service files.

mkdir -p "$INSTALL_DIR"
target_path="$INSTALL_DIR/gravel"
mv "$tmp/$asset" "$target_path"
chmod +x "$target_path"

ok "installed to $target_path"

# ---------------------------------------------------------------------------
# 6. PATH hint
# ---------------------------------------------------------------------------
# We DO NOT edit ~/.zshrc, ~/.bashrc, or ~/.profile. If $INSTALL_DIR isn't on
# $PATH, we print the line for the user to paste themselves. That's the only
# way to keep the install idempotent + auditable across shell flavours.

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    printf '\n%s%s$%s is not on your PATH.%s\n' "$bold" "$red" "$INSTALL_DIR" "$reset"
    printf 'Add this to your shell profile (~/.zshrc, ~/.bashrc, ~/.profile):\n\n'
    printf '    export PATH="%s:$PATH"\n\n' "$INSTALL_DIR"
    ;;
esac

# ---------------------------------------------------------------------------
# 7. Sanity check
# ---------------------------------------------------------------------------
# Last step: invoke the freshly-installed binary's --version and make sure it
# runs. If this fails the user knows immediately rather than discovering it
# next time they run `gravel init`.

if "$target_path" --version >/dev/null 2>&1; then
  ok "$("$target_path" --version)"
  info "next: run \`gravel init\` in your project directory."
else
  err "installed binary failed to run. Please report this at https://github.com/${REPO}/issues."
fi
