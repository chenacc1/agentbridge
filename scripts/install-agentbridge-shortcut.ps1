$ErrorActionPreference = "Stop"
$bridgeRoot = Split-Path -Parent $PSScriptRoot
$launcherPath = Join-Path $PSScriptRoot "start-agentbridge.ps1"
$desktopDirectory = [Environment]::GetFolderPath("Desktop")
$powerShellPath = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"

if (-not (Test-Path -LiteralPath $launcherPath -PathType Leaf)) {
  throw "Launcher was not found: $launcherPath"
}

$shell = New-Object -ComObject WScript.Shell

function Save-AgentBridgeShortcut {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Arguments,
    [Parameter(Mandatory = $true)][string]$Description
  )
  $shortcutPath = Join-Path $desktopDirectory $Name
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = $powerShellPath
  $shortcut.Arguments = $Arguments
  $shortcut.WorkingDirectory = $bridgeRoot
  $shortcut.IconLocation = "$powerShellPath,0"
  $shortcut.Description = $Description
  $shortcut.Save()
  Write-Host "Desktop shortcut created: $shortcutPath" -ForegroundColor Green
}

Save-AgentBridgeShortcut `
  -Name "AgentBridge.lnk" `
  -Arguments "-NoLogo -NoProfile -ExecutionPolicy Bypass -File `"$launcherPath`" -OpenDashboard" `
  -Description "Start AgentBridge and open the local dashboard"

Save-AgentBridgeShortcut `
  -Name "AgentBridge Remote.lnk" `
  -Arguments "-NoLogo -NoProfile -ExecutionPolicy Bypass -File `"$launcherPath`" -Tailscale -OpenDashboard" `
  -Description "Start AgentBridge in Tailscale remote mode"

Save-AgentBridgeShortcut `
  -Name "AgentBridge Remote ZeroTier.lnk" `
  -Arguments "-NoLogo -NoProfile -ExecutionPolicy Bypass -File `"$launcherPath`" -ZeroTier -OpenDashboard" `
  -Description "Start AgentBridge in ZeroTier remote mode"

Save-AgentBridgeShortcut `
  -Name "AgentBridge Remote Cloudflare.lnk" `
  -Arguments "-NoLogo -NoProfile -ExecutionPolicy Bypass -File `"$launcherPath`" -CloudflareTunnel -OpenDashboard" `
  -Description "Start AgentBridge behind a Cloudflare quick tunnel (public HTTPS URL)"
