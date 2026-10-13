<#
.SYNOPSIS
  Opens a debug Chrome on this machine and an ssh session to the remote one, so that a Claude Code
  running there can drive this Chrome (tabs, console, network) while it serves the app.

.EXAMPLE
  .\scripts\remote-browser.ps1 -Remote user@host -Install    # once: registers the MCP server on the remote
  .\scripts\remote-browser.ps1 -Remote user@host -AppPort 3000
  .\scripts\remote-browser.ps1 -Remote user@host -AppPort 8100 -Forward 8101,8102    # the app and its APIs
#>
param(
  [Parameter(Mandatory)] [string] $Remote,
  [int] $AppPort = 3000,
  # The app's port on the remote, when it is not the one used here (the local one being taken).
  [int] $RemoteAppPort = $AppPort,
  # Other ports of the remote brought here, its APIs for instance: 8101, or 8111:8101 for local:remote.
  [string[]] $Forward = @(),
  # An ssh config file to use in place of ~/.ssh/config.
  [string] $SshConfig,
  [int] $DebugPort = 9222,
  [string] $McpName = 'my-chrome',
  [switch] $Install,
  # Holds the tunnel without a shell on the remote, for when claude runs there in another session.
  [switch] $TunnelOnly
)

$ErrorActionPreference = 'Stop'
$sshConfigArgs = if ($SshConfig) { @('-F', $SshConfig) } else { @() }

if ($Install) {
  # A login shell, so that claude and npx are on the PATH of a non-interactive ssh command.
  $add = "claude mcp add --scope user $McpName -- npx -y chrome-devtools-mcp@latest --browserUrl http://127.0.0.1:$DebugPort"
  ssh @sshConfigArgs $Remote "bash -lc '$add'"
  exit $LASTEXITCODE
}

$chrome = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $chrome) { throw 'Chrome was not found.' }

# Chrome ignores the debug port on its default profile, so this one is its own. It is kept between
# runs: a login done in it stays.
$profileDir = "$env:LOCALAPPDATA\claude-debug-chrome"
$version = "http://127.0.0.1:$DebugPort/json/version"

function Test-DebugPort {
  try { $null = Invoke-RestMethod $version -TimeoutSec 1; $true } catch { $false }
}

if (-not (Test-DebugPort)) {
  Start-Process $chrome -ArgumentList @(
    "--remote-debugging-port=$DebugPort",
    "--user-data-dir=`"$profileDir`"",
    '--no-first-run',
    'about:blank'
  )
  $deadline = (Get-Date).AddSeconds(15)
  while (-not (Test-DebugPort)) {
    if ((Get-Date) -gt $deadline) {
      throw "Chrome does not answer on port $DebugPort. Close the windows of the debug profile and run this again."
    }
    Start-Sleep -Milliseconds 300
  }
}
Write-Host "Chrome answers on 127.0.0.1:$DebugPort (profile $profileDir)."

# The app is only reachable once ssh listens on its port, and ssh keeps this script busy from here
# on, so the tab is opened from a job that waits for that port.
$null = Start-Job -ArgumentList $chrome, $profileDir, $AppPort -ScriptBlock {
  param($chrome, $profileDir, $port)
  foreach ($i in 1..240) {
    $tcp = New-Object Net.Sockets.TcpClient
    try { $tcp.Connect('127.0.0.1', $port); $up = $true } catch { $up = $false } finally { $tcp.Close() }
    if ($up) {
      Start-Process $chrome -ArgumentList @("--user-data-dir=`"$profileDir`"", "http://localhost:$port")
      return
    }
    Start-Sleep -Milliseconds 500
  }
}

# -L brings the app here, -R hands this Chrome to the remote. 127.0.0.1 and not localhost: Chrome
# listens on IPv4 only, and both ends stay on the loopback.
$sshArgs = @(
  '-o', 'ExitOnForwardFailure=yes',
  '-L', "${AppPort}:127.0.0.1:${RemoteAppPort}",
  '-R', "127.0.0.1:${DebugPort}:127.0.0.1:${DebugPort}"
)
# Split here too: through `powershell -File`, 8101,8102 arrives as one string.
foreach ($pair in ($Forward -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })) {
  if ($pair -notmatch '^(\d+)(?::(\d+))?$') { throw "-Forward takes a port or local:remote, not '$pair'." }
  $local = $Matches[1]
  $remotePort = if ($Matches[2]) { $Matches[2] } else { $local }
  $sshArgs += '-L', "${local}:127.0.0.1:${remotePort}"
}
if ($TunnelOnly) {
  $sshArgs += '-N'
  Write-Host "Tunnel to $Remote is open until this is stopped (Ctrl+C)."
} else {
  Write-Host "Opening $Remote. Start claude there; the tunnel lasts as long as this session."
}
ssh @sshConfigArgs @sshArgs $Remote
