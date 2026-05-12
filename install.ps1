# =============================================================================
# install.ps1 — canonical install path for the `gravel` CLI binary on Windows.
# =============================================================================
#
# Usage (PowerShell 5.1+ or 7+):
#
#   irm https://raw.githubusercontent.com/artanis-ai/gravel/main/install.ps1 | iex
#
# Env overrides:
#   $env:GRAVEL_VERSION       Pin a specific version (e.g. v0.3.0). Default: latest.
#   $env:GRAVEL_INSTALL_DIR   Target install directory.
#                             Default: %LOCALAPPDATA%\gravel\bin
#
# -----------------------------------------------------------------------------
# Notes for auditors / agents reviewing this script
# -----------------------------------------------------------------------------
# Sibling to install.sh; same behaviour, same trust model. The script is small,
# unminified, and every line is documented. Nothing fetched in a way you can't
# reproduce by hand.
#
# What it does, step by step:
#   1. Detect CPU arch ($env:PROCESSOR_ARCHITECTURE).
#   2. Resolve the version: $env:GRAVEL_VERSION or `latest` from the GitHub
#      Releases API (one HTTPS GET, anonymous, no cookies set).
#   3. Download `gravel-windows-<arch>.exe` from the GitHub Release + the
#      matching `.sha256` digest file.
#   4. Verify the binary against the digest with Get-FileHash. Aborts if they
#      don't match — no install happens on a digest mismatch.
#   5. Move the binary to $GRAVEL_INSTALL_DIR\gravel.exe.
#   6. Print PATH instructions if $GRAVEL_INSTALL_DIR isn't on $PATH.
#   7. Sanity check: invoke `gravel.exe --version` and verify it ran.
#
# What it does NOT do:
#   - No admin/UAC elevation. The default install dir is in %LOCALAPPDATA%;
#     no system-wide writes.
#   - No registry edits.
#   - No profile edits ($PROFILE is NEVER modified — script only prints
#     `setx PATH` instructions for the user to run themselves).
#   - No telemetry. No analytics. No outbound HTTP except to api.github.com
#     and github.com/<repo>/releases/...
#   - No package-manager touching.
#   - No scheduled tasks, services, or background processes spawned.
#
# Where everything lives:
#   - Script source: github.com/artanis-ai/gravel/install.ps1 (this file).
#   - Binary source: github.com/artanis-ai/gravel/cli/ (Go module, Apache 2.0).
#   - Build pipeline: .github/workflows/release-cli.yml (reproducible builds
#     with `-trimpath -buildvcs=false -ldflags=...`).
#   - Release artifacts: github.com/artanis-ai/gravel/releases/tag/<version>.
#   - Architecture doc: github.com/artanis-ai/gravel/blob/main/cli/DESIGN.md
#
# Supported targets:
#   - windows-amd64 (x64). ARM64 Windows users: run the .exe under x64
#     emulation, or build from source until we add a native arm64 binary.
# =============================================================================

$ErrorActionPreference = 'Stop'

# Hard-coded so an auditor can see exactly which org/repo will be contacted.
$Repo = 'artanis-ai/gravel'
$ReleaseAPI = "https://api.github.com/repos/$Repo/releases/latest"
$InstallDir = if ($env:GRAVEL_INSTALL_DIR) { $env:GRAVEL_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'gravel\bin' }

function Write-Info { param([string]$msg) Write-Host "gravel installer: $msg" }
function Write-Ok   { param([string]$msg) Write-Host "OK $msg" -ForegroundColor Green }
function Write-Err  { param([string]$msg) Write-Host "gravel installer: $msg" -ForegroundColor Red; exit 1 }

# ---------------------------------------------------------------------------
# 1. Detect arch
# ---------------------------------------------------------------------------
# windows-amd64 covers x64 + the WOW64 emulator on ARM. We refuse to install
# on truly exotic archs rather than guess.

$archEnv = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
switch ($archEnv) {
    'AMD64' { $arch = 'amd64' }
    'x86'   { Write-Err 'unsupported architecture: 32-bit Windows. Install a 64-bit OS first.' }
    default { Write-Err "unsupported architecture '$archEnv'. Supported: amd64." }
}
$target = "windows-$arch"
Write-Info "detected $target"

# ---------------------------------------------------------------------------
# 2. Pick version
# ---------------------------------------------------------------------------
# Honour an explicit $env:GRAVEL_VERSION (recommended for CI), otherwise
# resolve `latest` from the GitHub Releases API.

$version = $env:GRAVEL_VERSION
if (-not $version) {
    try {
        $release = Invoke-RestMethod -Uri $ReleaseAPI -UseBasicParsing -Headers @{ 'User-Agent' = 'gravel-installer' }
        $version = $release.tag_name
    } catch {
        Write-Err "could not resolve a release version: $_. Set `$env:GRAVEL_VERSION = 'vX.Y.Z'` to pin a specific release."
    }
}
if (-not $version) { Write-Err 'release version is empty.' }
Write-Info "installing gravel $version ($target)"

# ---------------------------------------------------------------------------
# 3. Download binary + sha256
# ---------------------------------------------------------------------------

$asset = "gravel-$target.exe"
$baseUrl = "https://github.com/$Repo/releases/download/$version"
$binUrl = "$baseUrl/$asset"
$shaUrl = "$baseUrl/$asset.sha256"

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) "gravel-install-$([Guid]::NewGuid().Guid)"
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
try {
    Write-Info "downloading $binUrl"
    Invoke-WebRequest -Uri $binUrl -OutFile (Join-Path $tmp $asset) -UseBasicParsing
    Invoke-WebRequest -Uri $shaUrl -OutFile (Join-Path $tmp "$asset.sha256") -UseBasicParsing

    # -----------------------------------------------------------------------
    # 4. Verify sha256
    # -----------------------------------------------------------------------
    # `.sha256` is formatted as "<sha>  <filename>" by sha256sum on the
    # release pipeline. We extract just the digest and compare with
    # Get-FileHash. Aborts on mismatch before installing.

    $shaText = (Get-Content (Join-Path $tmp "$asset.sha256") -Raw).Trim()
    $expected = ($shaText -split '\s+')[0].ToLowerInvariant()
    if (-not $expected) { Write-Err "couldn't read expected sha256 from $asset.sha256" }

    $actual = (Get-FileHash -Path (Join-Path $tmp $asset) -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($expected -ne $actual) {
        Write-Err "sha256 mismatch for $asset. Expected $expected, got $actual. Aborting."
    }
    Write-Ok 'sha256 verified'

    # -----------------------------------------------------------------------
    # 5. Install
    # -----------------------------------------------------------------------

    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    $targetPath = Join-Path $InstallDir 'gravel.exe'
    Move-Item -Force -Path (Join-Path $tmp $asset) -Destination $targetPath
    Write-Ok "installed to $targetPath"

    # -----------------------------------------------------------------------
    # 6. PATH hint
    # -----------------------------------------------------------------------
    # We DO NOT edit $PROFILE or call `setx PATH` directly. If the install
    # dir isn't on User PATH, we print the line the user needs to paste.

    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not ($userPath -split ';' | Where-Object { $_ -eq $InstallDir })) {
        Write-Host ''
        Write-Host "$InstallDir is not on your PATH." -ForegroundColor Yellow
        Write-Host 'Add it permanently with:' -ForegroundColor Yellow
        Write-Host "    setx PATH `"`$env:PATH;$InstallDir`"" -ForegroundColor Yellow
        Write-Host '(Open a new shell after running setx so the change takes effect.)' -ForegroundColor Yellow
        Write-Host ''
    }

    # -----------------------------------------------------------------------
    # 7. Sanity check
    # -----------------------------------------------------------------------

    $versionOut = & $targetPath --version 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Err "installed binary failed to run. Please report this at https://github.com/$Repo/issues."
    }
    Write-Ok $versionOut
    Write-Info 'next: run `gravel init` in your project directory.'
} finally {
    Remove-Item -Recurse -Force -Path $tmp -ErrorAction SilentlyContinue
}
