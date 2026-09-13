param(
  [switch]$OpenDashboard,
  [switch]$Tailscale,
  [switch]$ZeroTier,
  [switch]$CloudflareTunnel,
  [string]$CloudflareNamedTunnel,
  [string]$CloudflareOrigin
)

$ErrorActionPreference = "Stop"
$bridgeRoot = Split-Path -Parent $PSScriptRoot
$serverPath = Join-Path $bridgeRoot "src\server.js"
$healthUrl = "http://127.0.0.1:8787/api/health"
$dashboardUrl = "http://127.0.0.1:8787/"
$logDirectory = Join-Path $bridgeRoot ".agentbridge\logs"
$stdoutLog = Join-Path $logDirectory "bridge.stdout.log"
$stderrLog = Join-Path $logDirectory "bridge.stderr.log"

function Test-AgentBridgeHealth {
  try {
    $response = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 1
    return $response.ok -eq $true
  } catch {
    return $false
  }
}

function Get-AgentBridgeAdvertisedOrigin {
  try {
    $bootstrap = Invoke-RestMethod -Uri "http://127.0.0.1:8787/api/bootstrap" -TimeoutSec 1
    $pairingUri = [Uri]$bootstrap.pairing.url
    return "$($pairingUri.Scheme)://$($pairingUri.Authority)"
  } catch {
    return $null
  }
}

function Resolve-CommandPath {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [string[]]$FallbackPaths = @()
  )

  $command = Get-Command $Name -ErrorAction SilentlyContinue
  $candidates = @()
  if ($command) {
    $candidates += @($command.Source, $command.Path, $command.Definition)
  }
  $candidates += $FallbackPaths
  return $candidates |
    Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } |
    Select-Object -First 1
}

function Get-TailscaleRemoteConfig {
  $tailscaleFallbacks = @()
  if ($env:ProgramFiles) {
    $tailscaleFallbacks += (Join-Path $env:ProgramFiles "Tailscale\tailscale.exe")
  }
  $programFilesX86 = ${env:ProgramFiles(x86)}
  if ($programFilesX86) {
    $tailscaleFallbacks += (Join-Path $programFilesX86 "Tailscale\tailscale.exe")
  }
  $tailscalePath = Resolve-CommandPath -Name "tailscale" -FallbackPaths $tailscaleFallbacks
  if (-not $tailscalePath) {
    throw "Tailscale is not installed. Install it on this PC and phone, sign in to the same tailnet, then retry."
  }

  $previousErrorPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $statusOutput = & $tailscalePath status --json 2>&1
    $statusExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorPreference
  }
  if ($statusExitCode -ne 0) {
    $statusError = $statusOutput -join " "
    if ($statusError -match "Access is denied") {
      throw "This Windows user cannot read Tailscale status. Either run this shortcut as Administrator each time, or explicitly allow a one-time: tailscale set --operator=$env:USERNAME"
    }
    throw "Tailscale status failed: $statusError"
  }
  try {
    $status = ($statusOutput -join [Environment]::NewLine) | ConvertFrom-Json
  } catch {
    throw "Tailscale returned an unreadable status response."
  }
  if ($status.BackendState -ne "Running" -or -not $status.Self.Online) {
    throw "Tailscale is not online. Open the Tailscale tray app and sign in first."
  }

  $ErrorActionPreference = "Continue"
  try {
    $ipOutput = & $tailscalePath ip -4 2>&1
    $ipExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorPreference
  }
  if ($ipExitCode -ne 0 -or -not $ipOutput) {
    throw "Tailscale could not return this computer's IPv4 address."
  }
  $tailscaleIp = ($ipOutput | Select-Object -First 1).ToString().Trim()
  $ipParts = $tailscaleIp -split "\."
  $secondOctet = if ($ipParts.Length -eq 4) { $ipParts[1] -as [int] } else { $null }
  if ($ipParts.Length -ne 4 -or $ipParts[0] -ne "100" -or $null -eq $secondOctet -or $secondOctet -lt 64 -or $secondOctet -gt 127) {
    throw "Tailscale did not return a valid 100.64.0.0/10 IPv4 address."
  }

  return [pscustomobject]@{
    Path = $tailscalePath
    IPv4 = $tailscaleIp
    Origin = "http://${tailscaleIp}:8787"
  }
}

function Get-ZeroTierRemoteConfig {
  # Reads the managed IPv4 from the ZeroTier virtual adapter via WMI/CIM instead
  # of zerotier-cli, so a normal Windows user does not need Administrator rights
  # to read ProgramData\ZeroTier\One\authtoken.secret.
  $adapters = Get-NetAdapter -ErrorAction SilentlyContinue |
    Where-Object { $_.InterfaceDescription -match "ZeroTier" }
  if (-not $adapters) {
    throw "ZeroTier is not installed (no ZeroTier network adapter found). Install ZeroTier One on this PC and the ZeroTier app on the phone, join the same network ID, authorize both members at my.zerotier.com, then retry."
  }

  $upAdapters = $adapters | Where-Object { $_.Status -eq "Up" }
  if (-not $upAdapters) {
    throw "The ZeroTier adapter is not connected. Open ZeroTier One on this PC and confirm the network shows as connected."
  }

  $candidates = @()
  foreach ($adapter in $upAdapters) {
    $addresses = Get-NetIPAddress -InterfaceIndex $adapter.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue |
      Where-Object { $_.IPAddress -notlike "169.254.*" -and $_.IPAddress -ne "127.0.0.1" }
    foreach ($address in $addresses) {
      $candidates += [pscustomobject]@{ Adapter = $adapter.Name; IPv4 = $address.IPAddress }
    }
  }
  if (-not $candidates) {
    throw "ZeroTier has not assigned an IPv4 address to this PC yet. Confirm this member is authorized (Auth checked) at my.zerotier.com and shows Online."
  }

  $selected = $candidates | Select-Object -First 1
  return [pscustomobject]@{
    IPv4 = $selected.IPv4
    Adapter = $selected.Adapter
    Origin = "http://$($selected.IPv4):8787"
  }
}

function Get-PrimaryLanIPv4 {
  $route = Get-NetRoute -DestinationPrefix "0.0.0.0/0" -ErrorAction SilentlyContinue |
    Sort-Object -Property RouteMetric | Select-Object -First 1
  if (-not $route) {
    throw "No default route was found; cannot determine this PC's LAN IPv4 address."
  }
  $address = Get-NetIPAddress -InterfaceIndex $route.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike "169.254.*" } | Select-Object -First 1
  if (-not $address) {
    throw "The primary network adapter has no IPv4 address."
  }
  return $address.IPAddress
}

function Resolve-CloudflaredPath {
  $fallbacks = @()
  if ($env:ProgramFiles) {
    $fallbacks += (Join-Path $env:ProgramFiles "cloudflared\cloudflared.exe")
  }
  $cloudflaredPath = Resolve-CommandPath -Name "cloudflared" -FallbackPaths $fallbacks
  if (-not $cloudflaredPath) {
    throw "cloudflared is not installed. Install it with: winget install --id Cloudflare.cloudflared (or download cloudflared-windows-amd64.exe from https://github.com/cloudflare/cloudflared/releases), then retry."
  }
  return $cloudflaredPath
}

function Get-CloudflareTunnelOrigin {
  $cloudflaredPath = Resolve-CloudflaredPath
  $lanIPv4 = Get-PrimaryLanIPv4
  $statePath = Join-Path $bridgeRoot ".agentbridge\cloudflare-tunnel.json"

  if ($CloudflareNamedTunnel) {
    if (-not $CloudflareOrigin) {
      throw "A named Cloudflare tunnel needs its public hostname. Pass -CloudflareOrigin https://bridge.example.com (the hostname routed to this tunnel in the Cloudflare dashboard)."
    }
    $running = Get-CimInstance Win32_Process -Filter "Name = 'cloudflared.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -match "tunnel\s+run\s+" -and $_.CommandLine -match [regex]::Escape($CloudflareNamedTunnel) }
    if (-not $running) {
      Start-Process -FilePath $cloudflaredPath `
        -ArgumentList @("tunnel", "--no-autoupdate", "run", $CloudflareNamedTunnel) `
        -WorkingDirectory $bridgeRoot -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $logDirectory "cloudflared.stdout.log") `
        -RedirectStandardError (Join-Path $logDirectory "cloudflared.stderr.log") | Out-Null
    }
    return $CloudflareOrigin.TrimEnd("/")
  }

  # Quick tunnel: the assigned trycloudflare URL lives as long as the cloudflared
  # process, so reuse a running tunnel instead of minting a new origin each time.
  $state = $null
  if (Test-Path -LiteralPath $statePath -PathType Leaf) {
    try { $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json } catch { $state = $null }
  }
  if ($state -and $state.url -and $state.pid) {
    $alive = Get-CimInstance Win32_Process -Filter "ProcessId = $($state.pid)" -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -eq "cloudflared.exe" -and $_.CommandLine -match "--url" }
    if ($alive) {
      return ([string]$state.url).TrimEnd("/")
    }
    Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue
  }

  # Forward to the LAN IP, never 127.0.0.1: tunneled traffic must NOT look
  # loopback-local, or the public URL would unlock the local setup endpoints.
  $stdoutPath = Join-Path $logDirectory "cloudflared.stdout.log"
  $stderrPath = Join-Path $logDirectory "cloudflared.stderr.log"
  $process = Start-Process -FilePath $cloudflaredPath `
    -ArgumentList @("tunnel", "--no-autoupdate", "--url", "http://${lanIPv4}:8787") `
    -WorkingDirectory $bridgeRoot -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru

  for ($attempt = 0; $attempt -lt 75; $attempt += 1) {
    Start-Sleep -Milliseconds 400
    foreach ($logPath in @($stdoutPath, $stderrPath)) {
      if (Test-Path -LiteralPath $logPath -PathType Leaf) {
        $content = Get-Content -LiteralPath $logPath -Raw -ErrorAction SilentlyContinue
        if ($content) {
          $match = [regex]::Match($content, "https://[-a-z0-9]+\.trycloudflare\.com")
          if ($match.Success) {
            [pscustomobject]@{ url = $match.Value; pid = $process.Id; startedAt = [DateTime]::UtcNow.ToString("o") } |
              ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding UTF8
            return $match.Value
          }
        }
      }
    }
    if ($process.HasExited) { break }
  }
  throw "cloudflared did not announce a trycloudflare URL within 30 seconds. Check $stderrPath for details (Cloudflare's edge may be unreachable from this network)."
}

function Get-OrCreateAccessKey {
  $keyPath = Join-Path $bridgeRoot ".agentbridge\access-key"
  if (Test-Path -LiteralPath $keyPath -PathType Leaf) {
    $existing = (Get-Content -LiteralPath $keyPath -Raw -ErrorAction SilentlyContinue)
    if ($existing -and $existing.Trim().Length -ge 16) { return $existing.Trim() }
  }
  $bytes = New-Object byte[] 24
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
  $key = [Convert]::ToBase64String($bytes).Replace("+", "-").Replace("/", "_").TrimEnd("=")
  New-Item -ItemType Directory -Path (Split-Path -Parent $keyPath) -Force | Out-Null
  Set-Content -LiteralPath $keyPath -Value $key -NoNewline -Encoding ascii
  return $key
}

function Stop-VerifiedAgentBridge {
  $listener = Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $listener) {
    throw "AgentBridge reports healthy, but its port owner could not be resolved."
  }
  $owner = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
  $commandLine = (Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)" -ErrorAction SilentlyContinue).CommandLine
  if (-not $owner -or $owner.ProcessName -ne "node" -or -not $commandLine -or $commandLine -notmatch [regex]::Escape($serverPath)) {
    throw "Refusing to stop PID $($listener.OwningProcess): it could not be verified as this AgentBridge server."
  }

  Stop-Process -Id $listener.OwningProcess -ErrorAction Stop
  for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
    Start-Sleep -Milliseconds 100
    if (-not (Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue)) {
      return
    }
  }
  throw "The previous AgentBridge process did not release port 8787."
}

function Open-AgentBridgeDashboard {
  if ($OpenDashboard) {
    Start-Process $dashboardUrl
  }
}

$selectedModeCount = [int]$Tailscale.IsPresent + [int]$ZeroTier.IsPresent + [int]$CloudflareTunnel.IsPresent
if ($selectedModeCount -gt 1) {
  Write-Error "Choose only one remote mode: -Tailscale, -ZeroTier, or -CloudflareTunnel."
  exit 1
}
$remoteMode = $selectedModeCount -eq 1
$remoteModeLabel = if ($Tailscale) { "Tailscale" } elseif ($ZeroTier) { "ZeroTier" } elseif ($CloudflareTunnel) { "Cloudflare Tunnel" } else { $null }
$desiredOrigin = $null
if ($Tailscale -or $ZeroTier) {
  try {
    $desiredOrigin = if ($Tailscale) { (Get-TailscaleRemoteConfig).Origin } else { (Get-ZeroTierRemoteConfig).Origin }
  } catch {
    Write-Error $_.Exception.Message
    exit 1
  }
}
if ($CloudflareTunnel) {
  try {
    $desiredOrigin = Get-CloudflareTunnelOrigin
  } catch {
    Write-Error $_.Exception.Message
    exit 1
  }
}

if (Test-AgentBridgeHealth) {
  $currentOrigin = Get-AgentBridgeAdvertisedOrigin
  if (-not $remoteMode -or $currentOrigin -eq $desiredOrigin) {
    $modeLabel = if ($remoteMode) { "$remoteModeLabel remote mode at $desiredOrigin" } else { "local mode" }
    Write-Host "AgentBridge is already running in ${modeLabel}: $dashboardUrl" -ForegroundColor Green
    Open-AgentBridgeDashboard
    exit 0
  }

  Write-Host "Restarting AgentBridge to change its QR origin from $currentOrigin to $desiredOrigin ..."
  try {
    Stop-VerifiedAgentBridge
  } catch {
    Write-Error $_.Exception.Message
    exit 1
  }
}

$listener = Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
  $owner = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
  $ownerLabel = if ($owner) { "$($owner.ProcessName) (PID $($owner.Id))" } else { "PID $($listener.OwningProcess)" }
  Write-Error "Port 8787 is owned by $ownerLabel, but the AgentBridge health check failed. Stop that process or inspect its state first."
  exit 1
}

$nodePath = Resolve-CommandPath -Name "node"
if (-not $nodePath) {
  Write-Error "Node.js was not found. Install Node.js 22 or newer first."
  exit 1
}
if (-not (Test-Path -LiteralPath $serverPath -PathType Leaf)) {
  Write-Error "AgentBridge server entry was not found: $serverPath"
  exit 1
}

New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
if ($remoteMode) {
  $env:AGENTBRIDGE_HOST = "0.0.0.0"
  $env:AGENTBRIDGE_PUBLIC_ORIGIN = $desiredOrigin
}
# The quick-tunnel URL is public, so gate it behind a shared access key. The key
# is generated once, reused across restarts, embedded in pairing QR codes, and
# printed here for manual entry on the phone.
$accessKeyNotice = $null
if ($CloudflareTunnel) {
  $env:AGENTBRIDGE_ACCESS_KEY = Get-OrCreateAccessKey
  $accessKeyNotice = $env:AGENTBRIDGE_ACCESS_KEY
}
$bridgeProcess = Start-Process -FilePath $nodePath `
  -ArgumentList @($serverPath) `
  -WorkingDirectory $bridgeRoot `
  -WindowStyle Hidden `
  -RedirectStandardOutput $stdoutLog `
  -RedirectStandardError $stderrLog `
  -PassThru

for ($attempt = 0; $attempt -lt 50; $attempt += 1) {
  Start-Sleep -Milliseconds 200
  if (Test-AgentBridgeHealth) {
    Write-Host "AgentBridge started successfully (PID $($bridgeProcess.Id)): $dashboardUrl" -ForegroundColor Green
    if ($remoteMode) {
      Write-Host "Remote QR origin: $desiredOrigin" -ForegroundColor Cyan
      if ($Tailscale) {
        Write-Host "The phone must be online in the same Tailscale tailnet."
      } elseif ($ZeroTier) {
        Write-Host "The phone must have ZeroTier connected to the same network. If pairing fails, allow Node.js through Windows Firewall on the ZeroTier (private) network."
      } else {
        Write-Host "This URL is reachable from the public Internet over HTTPS. Pairing still requires the one-time code shown on this desktop, but do not share the URL."
        Write-Host "The URL stays valid while the cloudflared process runs; rerun this launcher if it is stopped."
        if ($accessKeyNotice) {
          Write-Host "Access-key gate is ON. Phone key (also embedded in QR codes): $accessKeyNotice" -ForegroundColor Yellow
        }
      }
    }
    Write-Host "Logs: $logDirectory"
    Open-AgentBridgeDashboard
    exit 0
  }
  if ($bridgeProcess.HasExited) {
    break
  }
}

$lastError = if (Test-Path -LiteralPath $stderrLog) {
  (Get-Content -LiteralPath $stderrLog -Tail 20 -ErrorAction SilentlyContinue) -join [Environment]::NewLine
} else {
  "No error log was generated."
}
Write-Error "AgentBridge did not become healthy within 10 seconds. Error log: $stderrLog`n$lastError"
exit 1
