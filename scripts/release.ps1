<#
.SYNOPSIS
    Create a new CutReady release.

.DESCRIPTION
    Bumps the version in package.json, Cargo.toml, and tauri.conf.json,
    commits the change, creates a signed git tag, and pushes to trigger
    the release workflow.

.PARAMETER Version
    The version number (e.g. 0.2.0). Do not include the 'v' prefix.

.EXAMPLE
    .\scripts\release.ps1 0.2.0
#>

param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidatePattern('^\d+\.\d+\.\d+')]
    [string]$Version
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent

Write-Host "`n🚀 Releasing CutReady v$Version`n" -ForegroundColor Cyan

# Ensure we're on main and clean
$branch = git -C $root rev-parse --abbrev-ref HEAD
if ($branch -ne 'main') {
    Write-Error "Must be on 'main' branch (currently on '$branch')"
}

$status = git -C $root status --porcelain
if ($status) {
    Write-Error "Working directory is not clean. Commit or stash changes first."
}

# Bump version in all three files
Write-Host "  Bumping version to $Version..." -ForegroundColor Yellow

# package.json
$pkg = Get-Content "$root\package.json" -Raw
$pkg = $pkg -replace '"version":\s*"[^"]+"', "`"version`": `"$Version`""
Set-Content "$root\package.json" $pkg -NoNewline

# src-tauri/Cargo.toml (only the package version, not dependency versions)
$cargo = Get-Content "$root\src-tauri\Cargo.toml" -Raw
$cargo = $cargo -replace '(?m)^(version\s*=\s*)"[^"]+"', "`$1`"$Version`""
Set-Content "$root\src-tauri\Cargo.toml" $cargo -NoNewline

# src-tauri/tauri.conf.json
$tauri = Get-Content "$root\src-tauri\tauri.conf.json" -Raw
$tauri = $tauri -replace '"version":\s*"[^"]+"', "`"version`": `"$Version`""
Set-Content "$root\src-tauri\tauri.conf.json" $tauri -NoNewline

# Update Cargo.lock
Write-Host "  Updating Cargo.lock..." -ForegroundColor Yellow
Push-Location "$root\src-tauri"
cargo update -p cutready --quiet 2>$null
Pop-Location

# Commit
Write-Host "  Committing..." -ForegroundColor Yellow
git -C $root add package.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json
git -C $root commit -m "chore: bump version to $Version"

# Tag (uses your default signing config)
Write-Host "  Tagging v$Version..." -ForegroundColor Yellow
git -C $root tag "v$Version" -m "CutReady v$Version"

# Push
Write-Host "  Pushing to origin..." -ForegroundColor Yellow
git -C $root push origin main
git -C $root push origin "v$Version"

Write-Host ""
Write-Host "✅ Release v$Version triggered!" -ForegroundColor Green
Write-Host "   Watch:   gh run list --repo sethjuarez/cutready --workflow release.yml --limit 1"
Write-Host "   Publish: gh release edit v$Version --repo sethjuarez/cutready --draft=false"
Write-Host ""
