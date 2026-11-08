#Requires -Version 5.1
<#
.SYNOPSIS
    Publish dsh-agentbridge to the official npm registry and verify the result.

.DESCRIPTION
    The local .npmrc points at a read-only mirror (npmmirror), so every command
    here passes --registry https://registry.npmjs.org explicitly.

    Flow: preflight -> login check -> name/version check -> pack check ->
    publish -> post-publish verification.

.PARAMETER DryRun
    Run every check and preview, but do not publish.

.PARAMETER Registry
    Target registry. Defaults to the official npm registry.

.PARAMETER Otp
    One-time password from the authenticator app, for accounts with 2FA set to
    "auth-and-writes". A fresh code is only valid for about 30 seconds, so this
    is useful only when publishing right away.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\publish-dsh-agentbridge.ps1 -DryRun

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\publish-dsh-agentbridge.ps1

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\publish-dsh-agentbridge.ps1 -Otp 123456
#>
[CmdletBinding()]
param(
    [switch]$DryRun,
    [string]$Registry = "https://registry.npmjs.org",
    [string]$Otp = ""
)

# Native npm writes warnings/errors to stderr; with ErrorActionPreference=Stop,
# PowerShell would turn those into terminating errors before we can inspect them.
# Every failure below is therefore handled explicitly through $LASTEXITCODE.
$ErrorActionPreference = "Continue"

$repoRoot = Split-Path -Parent $PSScriptRoot
$pluginDir = Join-Path $repoRoot "integrations\dsh-phone"
$manifestPath = Join-Path $pluginDir "package.json"

if (-not (Test-Path $manifestPath)) {
    Write-Host "[x] manifest not found: $manifestPath" -ForegroundColor Red
    exit 1
}

$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
$pkgName = $manifest.name
$pkgVersion = $manifest.version

Write-Host ""
Write-Host "== 1/6 Preflight: plugin manifest" -ForegroundColor Cyan
if (-not $pkgName) { Write-Host "[x] package.json has no name" -ForegroundColor Red; exit 1 }
if (-not $pkgVersion) { Write-Host "[x] package.json has no version" -ForegroundColor Red; exit 1 }
if ($manifest.private -eq $true) { Write-Host "[x] package.json still has private: true; npm refuses to publish it" -ForegroundColor Red; exit 1 }
if ($pkgVersion -notmatch '^\d+\.\d+\.\d+$') {
    Write-Host "[x] version '$pkgVersion' is not a stable release; the marketplace only accepts npm latest stable versions" -ForegroundColor Red
    exit 1
}
Write-Host "  [ok] package: $pkgName@$pkgVersion" -ForegroundColor Green

if (-not $manifest.dsh -or -not $manifest.dsh.bundle -or -not $manifest.dsh.bundle.patch) {
    Write-Host "[x] missing dsh.bundle.patch; the marketplace requires it for automatic installation" -ForegroundColor Red
    exit 1
}
$patchRelative = [string]$manifest.dsh.bundle.patch
$patchPath = Join-Path $pluginDir ($patchRelative -replace '^\./', '')
if (-not (Test-Path $patchPath)) {
    Write-Host "[x] dsh.bundle.patch points at a missing file: $patchRelative" -ForegroundColor Red
    exit 1
}
Write-Host "  [ok] dsh.bundle.patch = $patchRelative (file exists)" -ForegroundColor Green

if (-not $manifest.license) { Write-Host "[x] missing license field" -ForegroundColor Red; exit 1 }
Write-Host "  [ok] license = $($manifest.license)" -ForegroundColor Green

Write-Host ""
Write-Host "== 2/6 Login check (registry=$Registry)" -ForegroundColor Cyan
$loginOut = (& npm whoami --registry $Registry 2>&1 | Out-String).Trim()
$loginCode = $LASTEXITCODE
if ($loginCode -ne 0) {
    Write-Host "[x] not logged in. Run: npm login --registry $Registry  (browser + one-time code), then rerun this script" -ForegroundColor Red
    exit 1
}
Write-Host "  [ok] logged in as $loginOut" -ForegroundColor Green

Write-Host ""
Write-Host "== 3/6 Name and version availability" -ForegroundColor Cyan
$nameOut = (& npm view $pkgName version --registry $Registry 2>&1 | Out-String).Trim()
$nameCode = $LASTEXITCODE
if ($nameCode -eq 0 -and $nameOut -match '\d+\.\d+\.\d+') {
    Write-Host "  [ok] name already exists on npm (a first publish would print 404 here instead)" -ForegroundColor Green
} else {
    Write-Host "  [ok] name $pkgName is free (404) - first publish" -ForegroundColor Green
}

$versionOut = (& npm view "$pkgName@$pkgVersion" version --registry $Registry 2>&1 | Out-String).Trim()
$versionCode = $LASTEXITCODE
if ($versionCode -eq 0 -and $versionOut -match [regex]::Escape($pkgVersion)) {
    Write-Host "[x] $pkgName@$pkgVersion is already published; bump version in package.json first" -ForegroundColor Red
    exit 1
}
Write-Host "  [ok] version $pkgVersion is not published yet" -ForegroundColor Green

Write-Host ""
Write-Host "== 4/6 Pack contents" -ForegroundColor Cyan
# Run inside the plugin directory: `npm pack` at the repository root packs the
# bridge package, whose tarball has no cordis.patch.yml and would fail this check
# for the wrong reason.
Push-Location $pluginDir
try {
    $packOut = (& npm pack --dry-run --registry $Registry 2>&1 | Out-String)
} finally {
    Pop-Location
}
if ($packOut -notmatch 'cordis\.patch\.yml') {
    Write-Host "[x] cordis.patch.yml is not in the tarball; the marketplace would reject the plugin as non-standard" -ForegroundColor Red
    exit 1
}
Write-Host "  [ok] tarball includes cordis.patch.yml" -ForegroundColor Green

if ($DryRun) {
    Write-Host ""
    Write-Host "== DryRun: stopping before publish" -ForegroundColor Cyan
    Write-Host "  All checks passed. To publish, run again without -DryRun:"
    Write-Host "  powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\publish-dsh-agentbridge.ps1"
    exit 0
}

Write-Host ""
Write-Host "== 5/6 Publish to $Registry" -ForegroundColor Cyan
$publishArgs = @("publish", "--registry", $Registry, "--access", "public")
if ($Otp) {
    $publishArgs += "--otp=$Otp"
    Write-Host "  using one-time password from -Otp"
}
Push-Location $pluginDir
try {
    $publishLog = (& npm @publishArgs 2>&1 | Out-String)
    $publishCode = $LASTEXITCODE
} finally {
    Pop-Location
}
if ($publishCode -ne 0) {
    Write-Host $publishLog
    if ($publishLog -match 'two-factor|E403') {
        Write-Host "[x] npm requires a one-time password to publish on this account." -ForegroundColor Red
        Write-Host "    npm 11 does not prompt for it, so the code must be passed explicitly." -ForegroundColor Yellow
        Write-Host "    Run this in your own terminal, replacing 123456 with the current 6-digit code:" -ForegroundColor Yellow
        Write-Host "      cd $pluginDir" -ForegroundColor Yellow
        Write-Host "      npm publish --registry $Registry --access public --otp 123456" -ForegroundColor Yellow
        Write-Host "    Or rerun this script right after generating a code: -Otp 123456" -ForegroundColor Yellow
        Write-Host "    Or create a granular access token with 2FA bypass on npmjs.com and use it as _authToken." -ForegroundColor Yellow
    } else {
        Write-Host "[x] npm publish failed; see npm output above" -ForegroundColor Red
    }
    exit 1
}
Write-Host "  [ok] published $pkgName@$pkgVersion" -ForegroundColor Green

Write-Host ""
Write-Host "== 6/6 Post-publish verification" -ForegroundColor Cyan
$failures = @()

$latestOut = (& npm view $pkgName version --registry $Registry 2>&1 | Out-String).Trim()
Write-Host "  latest: $latestOut"
if ($LASTEXITCODE -ne 0) { $failures += "latest version" }

$patchOut = (& npm view $pkgName dsh.bundle.patch --registry $Registry 2>&1 | Out-String).Trim()
Write-Host "  dsh.bundle.patch: $patchOut"
if ($patchOut -notmatch 'cordis\.patch\.yml') { $failures += "dsh.bundle.patch" }

$licenseOut = (& npm view $pkgName license --registry $Registry 2>&1 | Out-String).Trim()
Write-Host "  license: $licenseOut"
if ($LASTEXITCODE -ne 0) { $failures += "license" }

Write-Host ""
if ($failures.Count -gt 0) {
    Write-Host "[!] These checks failed, the marketplace may not offer automatic install: $($failures -join ', ')" -ForegroundColor Yellow
    Write-Host "    Inspect: npm view $pkgName --registry $Registry --json" -ForegroundColor Yellow
} else {
    Write-Host "[ok] Published and verified. The package now satisfies the marketplace install conditions." -ForegroundColor Green
}

Write-Host ""
Write-Host "Next steps (manual, about 5 minutes):" -ForegroundColor Cyan
Write-Host "  1. Test the way the marketplace installs it:"
Write-Host "       cd `"`$env:USERPROFILE\.dsh\profiles\desktop`"; pnpm add $pkgName@latest"
Write-Host "     Restart DSH Desktop, run /phone in a project conversation; a QR code means success."
Write-Host "  2. Request a listing: Settings -> Plugin Market -> Discover -> 'Request a listing'"
Write-Host "     Submission material: docs/market-submission.md"
Write-Host "  3. Later releases: bump version, rerun this script, installed users see an Update button."
