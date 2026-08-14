#Requires -Version 5.1
#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Remove the printing kiosk agent service from a Windows machine.

.DESCRIPTION
  Stops and deletes the service. The agent's local state is left in place by
  default and removed only when asked, because it holds the record of what this
  machine handed to a printer — the thing that separates an operation which
  already printed from one that never started. Deleting it while a paid job is
  unsettled is how one job becomes two printed jobs after a reinstall.

  It also holds the installation's identity, so keeping it means the rebuilt
  agent is recognised as the same agent rather than appearing in the fleet as a
  new machine that went quiet.

.PARAMETER RemoveState
  Also delete the agent's local state. Use it when decommissioning a kiosk, not
  when reinstalling one.
#>

[CmdletBinding()]
param(
  [string] $ServiceName = 'PrintingKioskAgent',
  [switch] $RemoveState
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($null -eq $service) {
  Write-Host "$ServiceName is not installed."
} else {
  Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
  & sc.exe delete $ServiceName | Out-Null
  Write-Host "$ServiceName removed."
}

$stateDirectory = Join-Path $env:ProgramData 'PrintingKiosk'
if ($RemoveState) {
  if (Test-Path -LiteralPath $stateDirectory) {
    Remove-Item -LiteralPath $stateDirectory -Recurse -Force
    Write-Host "Local device state removed: $stateDirectory"
  }
} elseif (Test-Path -LiteralPath $stateDirectory) {
  Write-Host "Local device state kept: $stateDirectory"
  Write-Host "Re-run with -RemoveState only when this kiosk is being decommissioned."
}
