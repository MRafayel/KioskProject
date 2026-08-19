#Requires -Version 5.1
#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Install the printing kiosk agent as a Windows service.

.DESCRIPTION
  The agent has to be running before anybody touches the kiosk, has to come
  back after a power cut without a person logging in, and has to keep running
  when the shell it was started from goes away. That is a service, not a
  scheduled task and not a startup shortcut.

  Two decisions here are deliberate and should not be relaxed:

  * The service runs as a virtual account (`NT SERVICE\<name>`), not as
    LocalSystem and not as an interactive user. The agent's job is to talk
    outward and hand bytes to a print queue; nothing it does needs
    administrative rights on the machine, and a kiosk is a device strangers
    stand in front of.
  * Recovery restarts the service indefinitely rather than a fixed number of
    times. A kiosk that stopped restarting after three failures is a printer
    nobody can use until somebody drives to it.

  The device host is a separate program invoked per request (see
  print-host.ps1); it is not installed as a service and holds nothing between
  calls.

.PARAMETER InstallPath
  Directory holding the built agent — the output of `pnpm --filter
  @printing-kiosk/kiosk-agent build`, its node_modules, and the .env file.

.PARAMETER NodePath
  Absolute path to the Node runtime the service runs.

.PARAMETER EnvironmentFile
  The agent's configuration file. Defaults to `.env` inside InstallPath. It is
  passed to the service explicitly, never discovered, and the install fails if
  it is absent.

.EXAMPLE
  .\install-agent-service.ps1 -InstallPath 'C:\PrintingKiosk\agent' -NodePath 'C:\Program Files\nodejs\node.exe'
#>

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string] $InstallPath,
  [Parameter(Mandatory = $true)][string] $NodePath,
  [string] $ServiceName = 'PrintingKioskAgent',
  [string] $DisplayName = 'Printing Kiosk Agent',
  [string] $EnvironmentFile = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $NodePath)) { throw "Node runtime not found: $NodePath" }
$entryPoint = Join-Path $InstallPath 'dist\main.js'
if (-not (Test-Path -LiteralPath $entryPoint)) { throw "Agent build not found: $entryPoint" }

# A service starts in C:\Windows\System32, so nothing the agent does may depend
# on its working directory. The configuration file is therefore named outright
# rather than discovered by walking upwards for a workspace marker — that walk
# finds nothing from System32 and the agent would start on development
# defaults, printing to a folder instead of the printer.
$environmentFile = if ($EnvironmentFile) { $EnvironmentFile } else { Join-Path $InstallPath '.env' }
if (-not (Test-Path -LiteralPath $environmentFile)) {
  throw "Agent configuration not found: $environmentFile"
}
$environmentFile = (Resolve-Path -LiteralPath $environmentFile).ProviderPath

$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($null -ne $existing) {
  Write-Host "Stopping existing service $ServiceName"
  Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
  # sc.exe delete is asynchronous; the create below would fail on a name the
  # service control manager has not finished releasing.
  & sc.exe delete $ServiceName | Out-Null
  Start-Sleep -Seconds 2
}

$binaryPath = '"{0}" "{1}"' -f $NodePath, $entryPoint
New-Service -Name $ServiceName `
  -BinaryPathName $binaryPath `
  -DisplayName $DisplayName `
  -Description 'Drives the local printer and relays kiosk session traffic for the printing kiosk.' `
  -StartupType Automatic | Out-Null

# A virtual account: its own security identity, no password to store, and no
# rights beyond what is granted to it below.
& sc.exe config $ServiceName obj= "NT SERVICE\$ServiceName" | Out-Null

# The spooler and the network stack are what the agent needs before it starts.
& sc.exe config $ServiceName depend= Spooler/Tcpip | Out-Null

# Restart on every failure, forever, with a short pause so a crash loop does not
# saturate the machine. `reset= 0` keeps the failure count from clearing, which
# is what makes the third action apply to every subsequent failure.
& sc.exe failure $ServiceName reset= 0 actions= restart/10000/restart/30000/restart/60000 | Out-Null
& sc.exe failureflag $ServiceName 1 | Out-Null

# The service's own environment. `sc.exe` cannot set one, so it goes where the
# service control manager reads it from: a REG_MULTI_SZ under the service key.
#
# Two variables, and both are about failing closed. The first tells the agent
# where its configuration is, so it never has to guess. The second tells it that
# it is a deployment, which is what makes the simulated printer and the
# test-outcome switches a startup refusal rather than a silent surprise —
# NODE_ENV describes the build, not the machine.
$serviceKey = "HKLM:\SYSTEM\CurrentControlSet\Services\$ServiceName"
Set-ItemProperty -Path $serviceKey -Name 'Environment' -Type MultiString -Value @(
  "PRINTING_KIOSK_ENV_FILE=$environmentFile",
  'PRINTING_KIOSK_SERVICE=true'
)

# The install directory holds the configuration file, and that file holds this
# kiosk's API credential. Read rights for the service, which never writes here;
# everything else stays with administrators.
$installAcl = Get-Acl -Path $InstallPath
$installAcl.SetAccessRuleProtection($true, $false)
$installAcl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
  "NT SERVICE\$ServiceName", 'ReadAndExecute', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
foreach ($identity in @('BUILTIN\Administrators', 'NT AUTHORITY\SYSTEM')) {
  $installAcl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
    $identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
}
Set-Acl -Path $InstallPath -AclObject $installAcl

# The agent's local state — its installation identity, its spool, and its record
# of what it handed to a device — lives under ProgramData and must be readable
# only by the service and administrators.
$stateDirectory = Join-Path $env:ProgramData 'PrintingKiosk'
New-Item -ItemType Directory -Path $stateDirectory -Force | Out-Null
$acl = Get-Acl -Path $stateDirectory
$acl.SetAccessRuleProtection($true, $false)
foreach ($identity in @("NT SERVICE\$ServiceName", 'BUILTIN\Administrators', 'NT AUTHORITY\SYSTEM')) {
  $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
    $identity, 'Modify', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
}
Set-Acl -Path $stateDirectory -AclObject $acl

# A service has no console, so the agent's only local channel for "I could not
# start" is the event log. Registering the source needs administrative rights,
# which is why it happens here rather than at first use — the service account
# deliberately has none.
$eventSource = 'PrintingKioskAgent'
if (-not [System.Diagnostics.EventLog]::SourceExists($eventSource)) {
  New-EventLog -LogName Application -Source $eventSource
  Write-Host "Registered event source $eventSource in the Application log."
}

Start-Service -Name $ServiceName
Write-Host "$DisplayName installed and started."
Write-Host "State directory: $stateDirectory"
Write-Host "Configuration:  $environmentFile"
Write-Host "Agent lifecycle events: Get-WinEvent -LogName Application -MaxEvents 20 |"
Write-Host "  Where-Object ProviderName -eq '$eventSource'"
Write-Host "Confirm the kiosk registered: check the API for a kiosk_agents row with a recent heartbeat."
