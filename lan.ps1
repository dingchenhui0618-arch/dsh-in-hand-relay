# dsh-in-hand-relay LAN switch  (ASCII ONLY -- see note at the bottom)
#
#   powershell -ExecutionPolicy Bypass -File lan.ps1 on        # enable LAN mode
#   powershell -ExecutionPolicy Bypass -File lan.ps1 off       # back to loopback only
#   powershell -ExecutionPolicy Bypass -File lan.ps1 status    # read-only report
#
# All three actions are optional convenience. The real switch is the marker file
# ('.lan' next to server.mjs): present => server.mjs binds 0.0.0.0 (LAN reachable),
# absent => binds 127.0.0.1 (loopback only). You can just create/delete that file by
# hand and restart the relay; this script only adds the Windows specifics: firewall
# rule, restart of a relay that somebody else owns, and a live probe.
#
# Configuration (all optional, no value is baked in):
#   -Port <n>              relay port. Default: RELAY_PORT env var, else .env in this
#                          directory, else 3099.
#   -Watchdog <path>       script that supervises the relay and brings it back after a
#                          kill. Default: $env:RELAY_WATCHDOG, else the usual
#                          %USERPROFILE%\.dsh\autostart\services-watchdog.ps1 when it
#                          exists. When neither is usable, this script restarts the
#                          relay itself (node server.mjs) and the -Verb RunAs elevation
#                          is only needed for the firewall rule.
#   -Node <path>           node.exe to use when starting the relay here.
#                          Default: $env:RELAY_NODE, else `node` from PATH.
#
# None of this is needed just to make the relay work; it exists so that "enable LAN
# mode once" does not turn into ten manual steps.

param(
  [ValidateSet('on', 'off', 'status')][string]$Action = 'status',
  [int]$Port = 0,
  [string]$Watchdog = '',
  [string]$Node = ''
)

$ErrorActionPreference = 'Stop'
$Dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Marker = Join-Path $Dir '.lan'

function Resolve-Port {
  if ($Port -gt 0) { return $Port }
  if ($env:RELAY_PORT) { return [int]$env:RELAY_PORT }
  $envFile = Join-Path $Dir '.env'
  if (Test-Path $envFile) {
    foreach ($line in Get-Content -LiteralPath $envFile) {
      if ($line -match '^\s*RELAY_PORT\s*=\s*(\d+)') { return [int]$Matches[1] }
    }
  }
  return 3099
}

function Resolve-Watchdog {
  if ($Watchdog) { return $Watchdog }
  if ($env:RELAY_WATCHDOG) { return $env:RELAY_WATCHDOG }
  $guess = Join-Path $env:USERPROFILE '.dsh\autostart\services-watchdog.ps1'
  if (Test-Path $guess) { return $guess }
  return ''
}

function Resolve-Node {
  if ($Node) { return $Node }
  if ($env:RELAY_NODE) { return $env:RELAY_NODE }
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return 'node'
}

$RelayPort = Resolve-Port
$WatchdogPath = Resolve-Watchdog
$NodeExe = Resolve-Node
$RuleName = 'dsh-in-hand-relay LAN ' + $RelayPort

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  return (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
}

# Elevation is needed to add/remove a firewall rule. Starting the relay itself can be
# done unelevated, so keep the UAC prompt limited to what actually needs it.
if (-not (Test-Admin) -and ($Action -eq 'on' -or $Action -eq 'off')) {
  Write-Host 'Administrator rights are needed for the firewall rule.'
  Write-Host 'Asking for UAC now -- accept the prompt in the new window.'
  $fwd = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $PSCommandPath + '"'), $Action, '-Port', $RelayPort)
  if ($WatchdogPath) { $fwd += @('-Watchdog', ('"' + $WatchdogPath + '"')) }
  if ($NodeExe) { $fwd += @('-Node', ('"' + $NodeExe + '"')) }
  Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $fwd
  exit
}

function Get-ListeningLine {
  $hit = netstat -ano | Select-String 'LISTENING' | Select-String (':' + $RelayPort)
  if (-not $hit) { return $null }
  return $hit[0].ToString().Trim()
}

function Get-RelayPid {
  $line = Get-ListeningLine
  if (-not $line) { return $null }
  return [int](($line -split '\s+')[-1])
}

function Get-LanIPv4 {
  $out = @()
  foreach ($ni in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
    if ($ni.OperationalStatus -ne 'Up') { continue }
    try { $props = $ni.GetIPProperties() } catch { continue }
    foreach ($u in $props.UnicastAddresses) {
      if ($u.Address.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork) {
        $out += $u.Address.ToString()
      }
    }
  }
  return $out
}

function Wait-Relay([int]$Seconds) {
  for ($i = 0; $i -lt $Seconds; $i++) {
    Start-Sleep -Seconds 1
    $line = Get-ListeningLine
    if ($line) { return $true }
  }
  return $false
}

function Restart-Relay {
  $pid0 = Get-RelayPid
  if ($pid0) {
    Write-Host ('  stopping relay pid ' + $pid0)
    taskkill /F /PID $pid0 | Out-Null
  } else {
    Write-Host '  relay not running'
  }
  if ($WatchdogPath) {
    Write-Host ('  waiting for the watchdog to bring it back: ' + $WatchdogPath)
    if (Wait-Relay 40) { Write-Host ('  listening: ' + (Get-ListeningLine)); return }
    Write-Host '  watchdog did not bring it back in 40s -- starting it here instead'
  } else {
    Start-Sleep -Seconds 1
  }
  Start-Process -FilePath $NodeExe `
    -ArgumentList ('"' + (Join-Path $Dir 'server.mjs') + '"') -WorkingDirectory $Dir -WindowStyle Hidden
  if (-not (Wait-Relay 20)) { throw 'relay did not come up' }
  Write-Host ('  listening: ' + (Get-ListeningLine))
}

function Test-Http([string]$Url) {
  try {
    $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 8
    return [int]$r.StatusCode
  } catch {
    if ($_.Exception.Response) { return [int]$_.Exception.Response.StatusCode }
    return 0
  }
}

function Show-Report {
  Write-Host ''
  Write-Host '--- dsh-in-hand relay: LAN access ---'
  $state = if (Test-Path $Marker) { 'LAN mode ON' } else { 'LAN mode OFF (loopback only)' }
  Write-Host ('  marker file : ' + $Marker + '  -> ' + $state)
  Write-Host ('  port        : ' + $RelayPort)
  Write-Host ('  listening   : ' + (Get-ListeningLine))
  Write-Host ('  loopback    : http://127.0.0.1:' + $RelayPort + '/healthz  -> http ' + (Test-Http ('http://127.0.0.1:' + $RelayPort + '/healthz')))
  $ips = Get-LanIPv4
  if ($ips.Count -eq 0) { Write-Host '  no LAN IPv4 address found (not on Wi-Fi/LAN?)' }
  foreach ($ip in $ips) {
    $code = Test-Http ('http://' + $ip + ':' + $RelayPort + '/taskwatch/lan')
    Write-Host ('  LAN entry   : http://' + $ip + ':' + $RelayPort + '/taskwatch   (lan page -> http ' + $code + ')')
  }
  Write-Host ('  pairing code: http://127.0.0.1:' + $RelayPort + '/taskwatch/pair  (6-digit code shows here only)')
  Write-Host '  how a friend connects: same Wi-Fi -> open the LAN entry -> type the 6-digit code.'
  Write-Host '  limits: plain http is not a secure context (no PWA/service worker/camera/clipboard);'
  Write-Host '          anyone on this Wi-Fi with the code gets a terminal on this machine.'
  Write-Host '  note: on the Public firewall profile an existing node.exe rule may already allow'
  Write-Host '        inbound; the rule added by "on" covers private/domain explicitly.'
  Write-Host ''
}

switch ($Action) {
  'on' {
    Write-Host 'Enabling LAN mode.'
    if (-not (Test-Path $Marker)) { New-Item -ItemType File -Path $Marker | Out-Null }
    Write-Host '  marker created'
    $existing = netsh advfirewall firewall show rule name="$RuleName" 2>$null
    if (-not $existing) {
      netsh advfirewall firewall add rule name="$RuleName" dir=in action=allow `
        protocol=TCP localport=$RelayPort profile=private,domain | Out-Null
      Write-Host '  firewall rule added (private, domain only -- not public)'
    } else {
      Write-Host '  firewall rule already present'
    }
    Restart-Relay
    Show-Report
  }
  'off' {
    Write-Host 'Disabling LAN mode (loopback only).'
    if (Test-Path $Marker) { Remove-Item -LiteralPath $Marker -Force; Write-Host '  marker removed' }
    else { Write-Host '  marker was not there' }
    netsh advfirewall firewall delete rule name="$RuleName" 2>$null | Out-Null
    Write-Host '  firewall rule removed (if it existed)'
    Restart-Relay
    Show-Report
  }
  'status' { Show-Report }
}

# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads a .ps1 without a BOM
# as ANSI, which shreds non-ASCII text; an ASCII file sidesteps that entirely.
