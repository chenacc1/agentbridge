[CmdletBinding()]
param(
  [ValidateRange(1, 65535)][int]$Port = 8787,
  [ValidateRange(1, 60)][int]$WaitSeconds = 10
)

$ErrorActionPreference = "Stop"
$bridgeRoot = Split-Path -Parent $PSScriptRoot
$serverPath = Join-Path $bridgeRoot "src\server.js"
$origin = "http://127.0.0.1:$Port"

function Get-AgentBridgeListener {
  Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
}

function Read-AgentBridgeErrorPayload {
  param([Parameter(Mandatory = $true)]$ErrorRecord)

  try {
    $response = $ErrorRecord.Exception.Response
    if (-not $response) { return $null }
    $stream = $response.GetResponseStream()
    if (-not $stream) { return $null }
    $reader = New-Object System.IO.StreamReader($stream)
    try {
      $text = $reader.ReadToEnd()
    } finally {
      $reader.Dispose()
    }
    if (-not $text) { return $null }
    return $text | ConvertFrom-Json
  } catch {
    return $null
  }
}

try {
  $listener = Get-AgentBridgeListener
  if (-not $listener) {
    Write-Host "AgentBridge is already stopped; port $Port is not listening." -ForegroundColor Green
    exit 0
  }

  $owner = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
  $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)" -ErrorAction SilentlyContinue
  $commandLine = $processInfo.CommandLine
  if (-not $owner -or $owner.ProcessName -ne "node" -or -not $commandLine -or $commandLine -notmatch [regex]::Escape($serverPath)) {
    throw "Refusing to stop PID $($listener.OwningProcess): port $Port is not owned by this AgentBridge server."
  }

  $webSession = New-Object Microsoft.PowerShell.Commands.WebRequestSession
  Invoke-WebRequest `
    -Uri "$origin/api/local-session" `
    -Method Post `
    -Headers @{ Origin = $origin } `
    -ContentType "application/json" `
    -Body "{}" `
    -WebSession $webSession `
    -UseBasicParsing `
    -TimeoutSec 3 | Out-Null

  try {
    Invoke-WebRequest `
      -Uri "$origin/api/local/shutdown" `
      -Method Post `
      -Headers @{ Origin = $origin } `
      -ContentType "application/json" `
      -Body "{}" `
      -WebSession $webSession `
      -UseBasicParsing `
      -TimeoutSec 5 | Out-Null
  } catch {
    $payload = Read-AgentBridgeErrorPayload -ErrorRecord $_
    if ($payload.code -eq "ACTIVE_SESSIONS") {
      $count = if ($payload.diagnostics.count) { [int]$payload.diagnostics.count } else { 1 }
      Write-Host "Safe shutdown was blocked: $count Agent task(s) are still running." -ForegroundColor Yellow
      foreach ($session in @($payload.diagnostics.sessions)) {
        Write-Host "  - $($session.title) [$($session.adapterId), $($session.status)]"
      }
      Write-Host "Stop those tasks in the AgentBridge dashboard, then run this file again."
      exit 2
    }
    if ($payload.error) { throw [string]$payload.error }
    throw
  }

  $deadline = (Get-Date).AddSeconds($WaitSeconds)
  do {
    Start-Sleep -Milliseconds 200
    $remaining = Get-AgentBridgeListener
  } while ($remaining -and (Get-Date) -lt $deadline)

  if ($remaining) {
    throw "AgentBridge accepted the safe shutdown request but did not release port $Port within $WaitSeconds seconds. No process was force-killed."
  }

  Write-Host "AgentBridge Node stopped safely. Port $Port is closed." -ForegroundColor Green
  Write-Host "Cloudflare, Tailscale, and ZeroTier processes were not stopped."
  exit 0
} catch {
  Write-Error $_.Exception.Message
  exit 1
}
