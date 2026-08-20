#Requires -Version 5.1
<#
.SYNOPSIS
  Phase 0a/0b: what does Windows actually know about the printer's physical
  state? Read-only. Changes nothing on this machine or on the printer.

.DESCRIPTION
  Two paid jobs have been reported as confirmed successes while the printer was
  physically out of paper (19 Aug, 1 sheet loaded of 2; 20 Aug, 4 of 5). The
  three-second settle window added after the first of those worked mechanically
  and returned printerStatuses: ["Normal"] -- the same answer it returns on
  healthy jobs. Windows also said "Normal" while paper was visibly emerging, so
  PrinterStatus does not appear to track the print engine at all.

  Before anyone buys a network adapter, this answers whether that is really
  true, because two much cheaper explanations are still open:

    1. Windows may learn of the fault later than the settle window looks. The
       agent keeps heartbeating long after a job is reported, and every health
       check that sees a non-READY queue writes the raw status to
       diagnostics.jsonl. If a PaperOut is in there, we were simply looking too
       early and no Ethernet is needed.
    2. Bidirectional support may be switched off on the port, in which case
       Windows never asks the device for status at all and every field stays at
       its default. That is a free fix.

  The SNMP side of Phase 0 lives in verify-printer-snmp.ps1 and is only worth
  running if this script comes back empty.

.PARAMETER QueueName
  The certified queue. Defaults to the kiosk's Canon queue.

.PARAMETER Samples
  How many times to sample device status. Take these while the printer is
  physically stalled with its error light on -- that is the moment the whole
  question turns on.

.EXAMPLE
  # Pull the tray, or leave one sheet and send a two-page job, then:
  .\verify-printer-telemetry.ps1 -Samples 10
#>

param(
  [string] $QueueName = 'CanonLBP361_UFR_II',
  [int] $Samples = 5,
  [int] $SampleDelayMilliseconds = 1000
)

# Deliberately *not* Set-StrictMode, unlike print-host.ps1. This reads arbitrary
# JSON written by older host versions and WMI objects whose properties differ
# between drivers and Windows builds. Under strict mode one absent property
# would abort a run whose entire purpose is collecting whatever evidence this
# machine happens to have.
$ErrorActionPreference = 'Continue'

$StateRoot = if ($env:ProgramData) { $env:ProgramData } else { [System.IO.Path]::GetTempPath() }
$DiagnosticDirectory = Join-Path $StateRoot 'PrintingKiosk\device-host\diagnostics'

# Reading a property that may not exist on this driver, this Windows build, or
# this version of the diagnostics format.
function Get-Safe {
  param($Source, [string] $Name, $Default = '')
  if ($null -eq $Source) { return $Default }
  $property = $Source.PSObject.Properties[$Name]
  if ($null -eq $property -or $null -eq $property.Value) { return $Default }
  return $property.Value
}

function Write-Section {
  param([string] $Title)
  Write-Host ''
  Write-Host ('=' * 72) -ForegroundColor Cyan
  Write-Host $Title -ForegroundColor Cyan
  Write-Host ('=' * 72) -ForegroundColor Cyan
}

function Write-Finding {
  param([string] $Text, [string] $Level = 'info')
  $colour = 'Gray'
  if ($Level -eq 'good') { $colour = 'Green' }
  elseif ($Level -eq 'bad') { $colour = 'Red' }
  elseif ($Level -eq 'warn') { $colour = 'Yellow' }
  Write-Host "  $Text" -ForegroundColor $colour
}

<#
.SYNOPSIS
  The decisive cheap check: has the printer ever told Windows anything?

.DESCRIPTION
  The host writes a health.unavailable line whenever a health check finds the
  queue not READY, carrying the raw printerStatus it saw. Those heartbeats run
  every thirty seconds and keep running long after a job is reported, so if the
  printer ever raises a fault to Windows the evidence is in this file even
  though the three-second settle window missed it.
#>
function Test-DiagnosticHistory {
  Write-Section '0a-1  Device host diagnostics -- was Windows ever told?'

  $paths = @(
    (Join-Path $DiagnosticDirectory 'diagnostics.jsonl'),
    (Join-Path $DiagnosticDirectory 'diagnostics.previous.jsonl')
  )
  $found = $false
  $faultLines = 0
  $realFault = $false

  foreach ($path in $paths) {
    if (-not (Test-Path $path)) {
      Write-Finding "absent: $path" 'warn'
      continue
    }
    $found = $true
    $size = (Get-Item -LiteralPath $path).Length
    Write-Finding "reading $path ($size bytes)"

    foreach ($line in (Get-Content -LiteralPath $path)) {
      if ([string]::IsNullOrWhiteSpace($line)) { continue }
      $entry = $null
      try { $entry = $line | ConvertFrom-Json } catch { continue }

      $name = [string](Get-Safe -Source $entry -Name 'event')
      # Every event that can carry a raw printer status word.
      $interesting = 'health\.unavailable|queue-not-ready|device-fault|job-not-observed|identity-mismatch'
      if ($name -notmatch $interesting) { continue }
      $faultLines++

      # The status has lived at the top level and under `fields` across host
      # versions, and this file outlives the host that wrote it.
      $status = [string](Get-Safe -Source $entry -Name 'printerStatus')
      if ($status.Length -eq 0) {
        $fields = Get-Safe -Source $entry -Name 'fields' -Default $null
        $status = [string](Get-Safe -Source $fields -Name 'printerStatus')
      }
      $stamp = [string](Get-Safe -Source $entry -Name 'timestamp' -Default '(no timestamp)')
      Write-Host "    $stamp  $name  status='$status'" -ForegroundColor Yellow

      if ($status -match 'PaperOut|PaperProblem|Jam|DoorOpen|Error') { $realFault = $true }
    }
  }

  Write-Host ''
  if (-not $found) {
    Write-Finding 'No diagnostics file at all.' 'warn'
    Write-Finding 'Run as the agent service account or as administrator; the path is ACLd.' 'warn'
    return
  }
  if ($realFault) {
    Write-Finding 'A REAL PHYSICAL FAULT REACHED WINDOWS (see the highlighted lines).' 'good'
    Write-Finding 'We were looking too early, not looking at a blind device.' 'good'
    Write-Finding 'STOP: a longer or later poll fixes this. Ethernet is not needed.' 'good'
    return
  }
  if ($faultLines -eq 0) {
    Write-Finding 'No fault or health-unavailable events of any kind.' 'bad'
    Write-Finding 'Windows was never told the printer had a problem.' 'bad'
  } else {
    Write-Finding "$faultLines status events, none carrying a physical fault." 'bad'
  }
}

<#
.SYNOPSIS
  Is the driver even allowed to talk back?

.DESCRIPTION
  With bidirectional support off, Windows never asks the device for status and
  every status field stays at its default, which would explain a permanent
  "Normal" completely. Checked two ways because the WMI property and the
  spooler's own attribute bit have been known to disagree.
#>
function Test-BidirectionalSupport {
  Write-Section '0a-2  Bidirectional support -- can the driver report status?'

  $printer = Get-WmiObject -Class Win32_Printer -Filter "Name='$QueueName'" -ErrorAction SilentlyContinue
  if ($null -eq $printer) {
    Write-Finding "Queue '$QueueName' not found in WMI. Check -QueueName." 'bad'
  } else {
    $bidi = Get-Safe -Source $printer -Name 'EnableBIDI' -Default $false
    if ($bidi) {
      Write-Finding "Win32_Printer.EnableBIDI = True" 'good'
    } else {
      Write-Finding "Win32_Printer.EnableBIDI = False" 'bad'
      Write-Finding 'OFF. Printer Properties -> Ports -> "Enable bidirectional support".' 'bad'
      Write-Finding 'STOP: turn it on and repeat the paper-out test before considering Ethernet.' 'bad'
    }
    $portName = [string](Get-Safe -Source $printer -Name 'PortName')
    if ($portName.Length -gt 0) {
      $port = Get-PrinterPort -Name $portName -ErrorAction SilentlyContinue
      if ($null -ne $port) {
        $monitor = [string](Get-Safe -Source $port -Name 'PortMonitor')
        Write-Finding "port '$portName' monitor='$monitor'"
      } else {
        Write-Finding "port '$portName' (no Get-PrinterPort entry)"
      }
    }
  }

  # PRINTER_ATTRIBUTE_ENABLE_BIDI = 0x00000004
  $key = "HKLM:\SYSTEM\CurrentControlSet\Control\Print\Printers\$QueueName"
  if (Test-Path $key) {
    $attributes = (Get-ItemProperty -Path $key -ErrorAction SilentlyContinue).Attributes
    if ($null -ne $attributes) {
      $hex = [Convert]::ToString([int]$attributes, 16)
      $enabled = (([int]$attributes) -band 0x4) -ne 0
      $level = 'bad'
      if ($enabled) { $level = 'good' }
      Write-Finding "spooler Attributes=0x$hex -> bidi enabled: $enabled" $level
    }
  } else {
    Write-Finding "No spooler registry key for '$QueueName'." 'warn'
  }
}

<#
.SYNOPSIS
  Everything Windows will say about the device, sampled repeatedly.

.DESCRIPTION
  Run while the printer is physically stalled. PrinterStatus is the field the
  host already reads. DetectedErrorState and ExtendedDetectedErrorState are the
  WMI fields it does not, and they are the last place a paper-out could be
  hiding behind an API nobody asked.
#>
function Test-DeviceStatus {
  Write-Section "0b  Windows device status, $Samples samples -- run this while stalled"

  $detected = @{
    0 = 'Unknown'; 1 = 'Other'; 2 = 'No Error'; 3 = 'Low Paper'; 4 = 'No Paper'
    5 = 'Low Toner'; 6 = 'No Toner'; 7 = 'Door Open'; 8 = 'Jammed'; 9 = 'Offline'
    10 = 'Service Requested'; 11 = 'Output Bin Full'
  }
  $seenStatus = @{}
  $seenError = @{}

  for ($i = 1; $i -le $Samples; $i++) {
    $line = "  [$i/$Samples] "

    $modern = Get-Printer -Name $QueueName -ErrorAction SilentlyContinue
    if ($null -ne $modern) {
      $printerStatus = [string](Get-Safe -Source $modern -Name 'PrinterStatus')
      $line += "PrinterStatus=$printerStatus "
      $seenStatus[$printerStatus] = $true
    }

    $wmi = Get-WmiObject -Class Win32_Printer -Filter "Name='$QueueName'" -ErrorAction SilentlyContinue
    if ($null -ne $wmi) {
      $code = [int](Get-Safe -Source $wmi -Name 'DetectedErrorState' -Default 0)
      $label = "code$code"
      if ($detected.ContainsKey($code)) { $label = $detected[$code] }
      $seenError["$code ($label)"] = $true
      $line += "| WMI status=$(Get-Safe -Source $wmi -Name 'PrinterStatus') "
      $line += "ext=$(Get-Safe -Source $wmi -Name 'ExtendedPrinterStatus') "
      $line += "detectedError=$code($label) "
      $line += "extDetected=$(Get-Safe -Source $wmi -Name 'ExtendedDetectedErrorState') "
      $line += "state=$(Get-Safe -Source $wmi -Name 'PrinterState') "
      $line += "workOffline=$(Get-Safe -Source $wmi -Name 'WorkOffline')"
    }

    $jobs = @(Get-PrintJob -PrinterName $QueueName -ErrorAction SilentlyContinue)
    $line += " | jobs=$($jobs.Count)"
    foreach ($job in $jobs) {
      $jobStatus = [string](Get-Safe -Source $job -Name 'JobStatus')
      $printed = [string](Get-Safe -Source $job -Name 'PagesPrinted' -Default 0)
      $total = [string](Get-Safe -Source $job -Name 'TotalPages' -Default 0)
      $line += " [id=$(Get-Safe -Source $job -Name 'Id') status=$jobStatus pages=$printed/$total]"
    }

    Write-Host $line
    if ($i -lt $Samples) { Start-Sleep -Milliseconds $SampleDelayMilliseconds }
  }

  Write-Host ''
  Write-Finding "distinct PrinterStatus values: $($seenStatus.Keys -join ', ')"
  Write-Finding "distinct DetectedErrorState values: $($seenError.Keys -join ', ')"

  $onlyNormal = $seenStatus.Keys.Count -eq 1 -and $seenStatus.ContainsKey('Normal')
  $sawWmiFault = $false
  foreach ($key in $seenError.Keys) {
    if ($key -match 'No Paper|Low Paper|Jammed|Door Open|No Toner') { $sawWmiFault = $true }
  }

  Write-Host ''
  if ($sawWmiFault) {
    Write-Finding 'WMI DetectedErrorState DID report the fault.' 'good'
    Write-Finding 'STOP: the fault is available, just not in the field the host reads.' 'good'
    Write-Finding 'A small change to the existing settle window fixes this. No Ethernet needed.' 'good'
  } elseif ($onlyNormal) {
    Write-Finding 'Only "Normal", in every sample, across every API.' 'bad'
    Write-Finding 'If the device really was stalled, this is direct proof the USB path' 'bad'
    Write-Finding 'carries no physical status. Proceed to verify-printer-snmp.ps1.' 'bad'
  }
}

Write-Host ''
Write-Host 'Phase 0a/0b printer telemetry check -- READ ONLY, changes nothing.' -ForegroundColor White
Write-Host "queue: $QueueName" -ForegroundColor Gray
Write-Host 'Take the samples while the printer is physically stalled.' -ForegroundColor Gray

Test-DiagnosticHistory
Test-BidirectionalSupport
Test-DeviceStatus

Write-Host ''
Write-Host 'Save this output. It decides whether the Ethernet work goes ahead.' -ForegroundColor White
Write-Host ''
