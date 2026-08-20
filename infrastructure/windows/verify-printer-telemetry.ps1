#Requires -Version 5.1
<#
.SYNOPSIS
  Read-only evidence gathering for the printer-telemetry decision. Changes
  nothing on this machine or on the printer.

.DESCRIPTION
  Two real jobs have been reported as confirmed successes while the printer was
  physically out of paper (19 Aug, 1 sheet loaded of 2; 20 Aug, 4 of 5). The
  three-second settle window added after the first of those worked mechanically
  and returned `printerStatuses: ["Normal"]` — the same answer it returned on
  healthy jobs. Windows said "Normal" while paper was visibly emerging, so the
  status field does not appear to track the print engine at all.

  Before anyone buys a network adapter, this script answers whether that is
  really true, because two much cheaper explanations have not been ruled out:
  Windows may learn of the fault later than the settle window looks, or
  bidirectional communication may simply be switched off on the port.

  -Usb   answers those two, plus what Windows reports while a printer is
         physically stalled. No hardware changes needed. Run this first.
  -Snmp  walks the printer's MIB to find out whether it exposes an engine page
         counter and a usable error state. Needs the Ethernet cable and an
         address on the printer, so it is a later step.

  Nothing here writes to a queue, submits a job, or sets a printer value. The
  SNMP walk uses GET-NEXT only, which cannot write.

.PARAMETER QueueName
  The certified queue. Defaults to the kiosk's Canon queue.

.PARAMETER Usb
  Run the USB-side checks (0a and 0b in the plan).

.PARAMETER Snmp
  Run the MIB walk (0c). Requires -PrinterAddress.

.PARAMETER PrinterAddress
  The printer's telemetry address on the direct link.

.PARAMETER Community
  SNMPv1 community for the walk. This is a temporary read-only credential for
  verification only: SNMPv1 sends it in plaintext, so it must be disabled on the
  printer in favour of SNMPv3 before anything ships.

.PARAMETER Samples
  How many times to sample device status in -Usb mode. Take these while the
  printer is physically stalled with its paper-out light on — that is the
  moment the whole question turns on.

.EXAMPLE
  # First, with the printer stalled out of paper:
  .\verify-printer-telemetry.ps1 -Usb -Samples 10

.EXAMPLE
  # Later, once the direct cable and a static address exist:
  .\verify-printer-telemetry.ps1 -Snmp -PrinterAddress 192.168.253.2
#>

param(
  [string] $QueueName = 'CanonLBP361_UFR_II',
  [switch] $Usb,
  [switch] $Snmp,
  [string] $PrinterAddress,
  [string] $Community = 'public',
  [int] $Samples = 5,
  [int] $SampleDelayMilliseconds = 1000
)

# Deliberately *not* Set-StrictMode, unlike print-host.ps1. This script reads
# arbitrary JSON written by older host versions and WMI objects whose properties
# differ between drivers and Windows builds. Under strict mode a single absent
# property would abort the run, and the whole point is to collect whatever
# evidence this machine happens to have.
$ErrorActionPreference = 'Continue'

if (-not $Usb -and -not $Snmp) { $Usb = $true }

# Reading a property that may not exist on this driver, this Windows build, or
# this version of the diagnostics format.
function Get-Safe {
  param($Source, [string] $Name, $Default = '')
  if ($null -eq $Source) { return $Default }
  $property = $Source.PSObject.Properties[$Name]
  if ($null -eq $property -or $null -eq $property.Value) { return $Default }
  return $property.Value
}

$StateRoot = if ($env:ProgramData) { $env:ProgramData } else { [System.IO.Path]::GetTempPath() }
$DiagnosticDirectory = Join-Path $StateRoot 'PrintingKiosk\device-host\diagnostics'

function Write-Section {
  param([string] $Title)
  Write-Host ''
  Write-Host ('=' * 72) -ForegroundColor Cyan
  Write-Host $Title -ForegroundColor Cyan
  Write-Host ('=' * 72) -ForegroundColor Cyan
}

function Write-Finding {
  param([string] $Text, [string] $Level = 'info')
  $colour = switch ($Level) {
    'good' { 'Green' }
    'bad' { 'Red' }
    'warn' { 'Yellow' }
    default { 'Gray' }
  }
  Write-Host "  $Text" -ForegroundColor $colour
}

#region ---------- 0a: has Windows ever been told? ----------

<#
.SYNOPSIS
  The decisive cheap check.

.DESCRIPTION
  The agent runs a health check on every heartbeat, and the host writes a
  `health.unavailable` line whenever the queue is not READY, carrying the raw
  `printerStatus` it saw. Those heartbeats keep running long after a job is
  reported, so if the printer ever tells Windows it is out of paper, the
  evidence is in this file even though the settle window missed it.

  A `PaperOut` here means the fault is observable and we were simply looking too
  early — which a longer or later poll could fix without any Ethernet at all.
#>
function Test-DiagnosticHistory {
  Write-Section '0a-1  Device host diagnostics — did Windows ever report a fault?'

  $paths = @(
    (Join-Path $DiagnosticDirectory 'diagnostics.jsonl'),
    (Join-Path $DiagnosticDirectory 'diagnostics.previous.jsonl')
  )
  $found = $false
  $faultLines = 0

  foreach ($path in $paths) {
    if (-not (Test-Path $path)) {
      Write-Finding "absent: $path" 'warn'
      continue
    }
    $found = $true
    $size = (Get-Item -LiteralPath $path).Length
    Write-Finding "reading $path ($size bytes)"

    Get-Content -LiteralPath $path | ForEach-Object {
      $line = $_
      if ([string]::IsNullOrWhiteSpace($line)) { return }
      $entry = $null
      try { $entry = $line | ConvertFrom-Json } catch { return }

      $name = [string](Get-Safe -Source $entry -Name 'event')
      # Every event that can carry a raw printer status word.
      if ($name -notmatch 'health\.unavailable|queue-not-ready|device-fault|job-not-observed|identity-mismatch') {
        return
      }
      $faultLines++
      # The status has lived at the top level and under `fields` across host
      # versions, and this file outlives the host that wrote it.
      $status = [string](Get-Safe -Source $entry -Name 'printerStatus')
      if ($status.Length -eq 0) {
        $status = [string](Get-Safe -Source (Get-Safe -Source $entry -Name 'fields' -Default $null) `
          -Name 'printerStatus')
      }
      $stamp = [string](Get-Safe -Source $entry -Name 'timestamp' -Default '(no timestamp)')
      Write-Host "    $stamp  $name  status='$status'" -ForegroundColor Yellow

      if ($status -match 'PaperOut|PaperProblem|Jam|DoorOpen|Error') {
        Write-Finding "^^ A REAL PHYSICAL FAULT REACHED WINDOWS. Ethernet may be unnecessary." 'good'
      }
    }
  }

  if (-not $found) {
    Write-Finding 'No diagnostics file. Has the host run on this machine as the service account?' 'warn'
    return
  }
  if ($faultLines -eq 0) {
    Write-Finding 'No fault or health-unavailable events at all.' 'bad'
    Write-Finding 'Windows was never told the printer had a problem. Strong evidence for the SNMP case.' 'bad'
  }
}

<#
.SYNOPSIS
  Is the driver even allowed to talk back?

.DESCRIPTION
  With bidirectional support switched off, Windows never asks the device for
  status and every status field stays at its default. That would explain a
  permanent "Normal" completely, and costs nothing to fix. Checked two ways
  because the WMI property and the spooler's own attribute bit have been known
  to disagree.
#>
function Test-BidirectionalSupport {
  Write-Section '0a-2  Bidirectional support — can the driver report status at all?'

  $printer = Get-WmiObject -Class Win32_Printer -Filter "Name='$QueueName'" -ErrorAction SilentlyContinue
  if ($null -eq $printer) {
    Write-Finding "Queue '$QueueName' not found in WMI." 'bad'
  } else {
    $bidi = Get-Safe -Source $printer -Name 'EnableBIDI' -Default $false
    Write-Finding "Win32_Printer.EnableBIDI = $bidi" $(if ($bidi) { 'good' } else { 'bad' })
    if (-not $bidi) {
      Write-Finding 'OFF. Printer Properties -> Ports -> "Enable bidirectional support".' 'bad'
      Write-Finding 'Turn it on and re-run the paper-out test before considering Ethernet.' 'bad'
    }
    $portName = [string](Get-Safe -Source $printer -Name 'PortName')
    if ($portName.Length -gt 0) {
      $port = Get-PrinterPort -Name $portName -ErrorAction SilentlyContinue
      if ($null -ne $port) {
        Write-Finding "port '$($port.Name)' monitor='$(Get-Safe -Source $port -Name 'PortMonitor')'"
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
      $enabled = (([int]$attributes) -band 0x4) -ne 0
      Write-Finding "spooler Attributes=0x$([Convert]::ToString([int]$attributes,16)) -> bidi $enabled" `
        $(if ($enabled) { 'good' } else { 'bad' })
    }
  } else {
    Write-Finding "No spooler registry key for '$QueueName'." 'warn'
  }
}

<#
.SYNOPSIS
  Everything Windows will say about the device, sampled repeatedly.

.DESCRIPTION
  Run while the printer is physically stalled. `PrinterStatus` is what the host
  already reads; `DetectedErrorState` and `ExtendedDetectedErrorState` are the
  WMI fields it does not, and they are the last place a paper-out could be
  hiding behind an API we simply never asked.

  If every sample reports normal while the device is visibly jammed or empty,
  the USB path carries no physical status and the SNMP case is made.
#>
function Test-DeviceStatus {
  Write-Section "0b  Windows device status, $Samples samples — run this while stalled"

  # 3=Idle 4=Printing 5=Warmup 1=Other 2=Unknown 6=Stopped printing 7=Offline
  $detected = @{
    0 = 'Unknown'; 1 = 'Other'; 2 = 'No Error'; 3 = 'Low Paper'; 4 = 'No Paper'
    5 = 'Low Toner'; 6 = 'No Toner'; 7 = 'Door Open'; 8 = 'Jammed'; 9 = 'Offline'
    10 = 'Service Requested'; 11 = 'Output Bin Full'
  }
  $distinct = @{}

  for ($i = 1; $i -le $Samples; $i++) {
    $line = "  [$i/$Samples] "
    $modern = Get-Printer -Name $QueueName -ErrorAction SilentlyContinue
    if ($null -ne $modern) {
      $line += "PrinterStatus=$($modern.PrinterStatus) "
      $distinct[[string]$modern.PrinterStatus] = $true
    }

    $wmi = Get-WmiObject -Class Win32_Printer -Filter "Name='$QueueName'" -ErrorAction SilentlyContinue
    if ($null -ne $wmi) {
      $code = [int]$wmi.DetectedErrorState
      $name = if ($detected.ContainsKey($code)) { $detected[$code] } else { "code$code" }
      $line += "| WMI status=$($wmi.PrinterStatus) ext=$($wmi.ExtendedPrinterStatus) "
      $line += "detectedError=$code($name) extDetected=$($wmi.ExtendedDetectedErrorState) "
      $line += "| state=$($wmi.PrinterState) workOffline=$($wmi.WorkOffline)"
    }

    $jobs = @(Get-PrintJob -PrinterName $QueueName -ErrorAction SilentlyContinue)
    $line += " | jobs=$($jobs.Count)"
    foreach ($job in $jobs) {
      $line += " [id=$($job.Id) status=$($job.JobStatus) pages=$($job.PagesPrinted)/$($job.TotalPages)]"
    }

    Write-Host $line
    if ($i -lt $Samples) { Start-Sleep -Milliseconds $SampleDelayMilliseconds }
  }

  Write-Host ''
  Write-Finding "distinct PrinterStatus values seen: $($distinct.Keys -join ', ')"
  if ($distinct.Keys.Count -eq 1 -and $distinct.ContainsKey('Normal')) {
    Write-Finding 'Only "Normal", across every sample. If the device was really stalled,' 'bad'
    Write-Finding 'this is direct proof the USB path carries no physical status.' 'bad'
  }
}

#endregion

#region ---------- 0c: minimal read-only SNMPv1 walk ----------

# Self-contained so the kiosk does not need Net-SNMP installed to answer the
# question. GET-NEXT only: there is no SET path in this file, so it cannot
# change a printer setting even by accident.

function ConvertTo-BerLength {
  param([int] $Length)
  if ($Length -lt 0x80) { return , [byte] $Length }
  $bytes = [System.Collections.Generic.List[byte]]::new()
  $value = $Length
  while ($value -gt 0) {
    $bytes.Insert(0, [byte]($value -band 0xFF))
    $value = $value -shr 8
  }
  return @([byte](0x80 -bor $bytes.Count)) + $bytes.ToArray()
}

function New-BerTlv {
  param([byte] $Tag, [byte[]] $Content)
  if ($null -eq $Content) { $Content = @() }
  return @($Tag) + (ConvertTo-BerLength -Length $Content.Length) + $Content
}

function New-BerInteger {
  param([int] $Value)
  $bytes = [System.Collections.Generic.List[byte]]::new()
  $value = $Value
  if ($value -eq 0) { $bytes.Add(0) }
  while ($value -ne 0 -and $value -ne -1) {
    $bytes.Insert(0, [byte]($value -band 0xFF))
    $value = $value -shr 8
  }
  # Keep a positive value from being read back as negative.
  if ($bytes.Count -gt 0 -and ($bytes[0] -band 0x80) -and $Value -gt 0) { $bytes.Insert(0, 0) }
  return New-BerTlv -Tag 0x02 -Content $bytes.ToArray()
}

function New-BerOid {
  param([string] $Oid)
  $arcs = @($Oid.TrimStart('.') -split '\.' | ForEach-Object { [uint32] $_ })
  $bytes = [System.Collections.Generic.List[byte]]::new()
  $bytes.Add([byte](40 * $arcs[0] + $arcs[1]))
  for ($i = 2; $i -lt $arcs.Count; $i++) {
    $arc = $arcs[$i]
    $chunk = [System.Collections.Generic.List[byte]]::new()
    $chunk.Insert(0, [byte]($arc -band 0x7F))
    $arc = $arc -shr 7
    while ($arc -gt 0) {
      $chunk.Insert(0, [byte](($arc -band 0x7F) -bor 0x80))
      $arc = $arc -shr 7
    }
    $bytes.AddRange($chunk)
  }
  return New-BerTlv -Tag 0x06 -Content $bytes.ToArray()
}

function Read-BerHeader {
  param([byte[]] $Buffer, [int] $Offset)
  $tag = $Buffer[$Offset]
  $first = $Buffer[$Offset + 1]
  if ($first -lt 0x80) {
    return @{ tag = $tag; length = [int]$first; valueOffset = $Offset + 2 }
  }
  $count = $first -band 0x7F
  $length = 0
  for ($i = 0; $i -lt $count; $i++) { $length = ($length -shl 8) -bor $Buffer[$Offset + 2 + $i] }
  return @{ tag = $tag; length = $length; valueOffset = $Offset + 2 + $count }
}

function ConvertFrom-BerOid {
  param([byte[]] $Buffer, [int] $Offset, [int] $Length)
  $first = [int]$Buffer[$Offset]
  $arcs = @([int][Math]::Floor($first / 40), $first % 40)
  $value = 0
  for ($i = 1; $i -lt $Length; $i++) {
    $byte = $Buffer[$Offset + $i]
    $value = ($value -shl 7) -bor ($byte -band 0x7F)
    if (($byte -band 0x80) -eq 0) {
      $arcs += $value
      $value = 0
    }
  }
  return '.' + ($arcs -join '.')
}

function ConvertFrom-BerValue {
  param([byte[]] $Buffer, [int] $Offset, [int] $Length, [byte] $Tag)
  switch ($Tag) {
    0x02 { # INTEGER
      $value = 0
      if ($Length -gt 0 -and ($Buffer[$Offset] -band 0x80)) { $value = -1 }
      for ($i = 0; $i -lt $Length; $i++) { $value = ($value -shl 8) -bor $Buffer[$Offset + $i] }
      return @{ type = 'INTEGER'; value = $value }
    }
    0x04 { # OCTET STRING — may be text or a binary bitmask.
      if ($Length -eq 0) { return @{ type = 'STRING'; value = '' } }
      $bytes = $Buffer[$Offset..($Offset + $Length - 1)]
      $printable = $true
      foreach ($b in $bytes) { if ($b -lt 0x20 -or $b -gt 0x7E) { $printable = $false; break } }
      $hex = ($bytes | ForEach-Object { $_.ToString('X2') }) -join ' '
      if ($printable) {
        return @{ type = 'STRING'; value = [System.Text.Encoding]::ASCII.GetString($bytes); hex = $hex }
      }
      return @{ type = 'OCTETS'; value = $hex; hex = $hex; bytes = $bytes }
    }
    0x05 { return @{ type = 'NULL'; value = $null } }
    0x06 { return @{ type = 'OID'; value = (ConvertFrom-BerOid -Buffer $Buffer -Offset $Offset -Length $Length) } }
    0x82 { return @{ type = 'endOfMibView'; value = $null } }
    default {
      # Counter32/Gauge32/TimeTicks/Counter64 all decode as unsigned integers.
      $value = [uint64] 0
      for ($i = 0; $i -lt $Length; $i++) { $value = ($value -shl 8) -bor $Buffer[$Offset + $i] }
      return @{ type = "tag0x$($Tag.ToString('X2'))"; value = $value }
    }
  }
}

function Invoke-SnmpGetNext {
  param([string] $Address, [string] $CommunityName, [string] $Oid, [int] $TimeoutMilliseconds = 2000)

  $requestId = Get-Random -Minimum 1 -Maximum 2000000000

  $binding = New-BerTlv -Tag 0x30 -Content ((New-BerOid -Oid $Oid) + (New-BerTlv -Tag 0x05 -Content @()))
  $bindings = New-BerTlv -Tag 0x30 -Content $binding
  $pdu = New-BerTlv -Tag 0xA1 -Content (
    (New-BerInteger -Value $requestId) +
    (New-BerInteger -Value 0) +
    (New-BerInteger -Value 0) +
    $bindings
  )
  $message = New-BerTlv -Tag 0x30 -Content (
    (New-BerInteger -Value 0) +
    (New-BerTlv -Tag 0x04 -Content ([System.Text.Encoding]::ASCII.GetBytes($CommunityName))) +
    $pdu
  )

  $client = New-Object System.Net.Sockets.UdpClient
  try {
    $client.Client.ReceiveTimeout = $TimeoutMilliseconds
    $client.Connect($Address, 161)
    [void]$client.Send($message, $message.Length)
    $remote = New-Object System.Net.IPEndPoint([System.Net.IPAddress]::Any, 0)
    $response = $client.Receive([ref]$remote)
  } catch {
    return $null
  } finally {
    $client.Close()
  }

  # SEQUENCE > version, community, PDU > requestId, errorStatus, errorIndex, bindings
  $outer = Read-BerHeader -Buffer $response -Offset 0
  $offset = $outer.valueOffset
  $version = Read-BerHeader -Buffer $response -Offset $offset
  $offset = $version.valueOffset + $version.length
  $community = Read-BerHeader -Buffer $response -Offset $offset
  $offset = $community.valueOffset + $community.length
  $pduHeader = Read-BerHeader -Buffer $response -Offset $offset
  $offset = $pduHeader.valueOffset
  foreach ($skip in 1..3) {
    $field = Read-BerHeader -Buffer $response -Offset $offset
    if ($skip -eq 2 -and $field.length -gt 0 -and $response[$field.valueOffset] -ne 0) {
      return @{ error = [int]$response[$field.valueOffset] }
    }
    $offset = $field.valueOffset + $field.length
  }
  $list = Read-BerHeader -Buffer $response -Offset $offset
  $entry = Read-BerHeader -Buffer $response -Offset $list.valueOffset
  $nameHeader = Read-BerHeader -Buffer $response -Offset $entry.valueOffset
  $name = ConvertFrom-BerOid -Buffer $response -Offset $nameHeader.valueOffset -Length $nameHeader.length
  $valueOffset = $nameHeader.valueOffset + $nameHeader.length
  $valueHeader = Read-BerHeader -Buffer $response -Offset $valueOffset
  $value = ConvertFrom-BerValue -Buffer $response -Offset $valueHeader.valueOffset `
    -Length $valueHeader.length -Tag $valueHeader.tag

  return @{ oid = $name; value = $value }
}

function Invoke-SnmpWalk {
  param([string] $Address, [string] $CommunityName, [string] $Root, [int] $MaxRows = 40)
  $results = @()
  $current = $Root
  for ($i = 0; $i -lt $MaxRows; $i++) {
    $step = Invoke-SnmpGetNext -Address $Address -CommunityName $CommunityName -Oid $current
    if ($null -eq $step) { break }
    if ($step.ContainsKey('error')) { break }
    if (-not $step.oid.StartsWith($Root.TrimEnd('.'))) { break }
    if ($step.value.type -eq 'endOfMibView') { break }
    $results += $step
    $current = $step.oid
  }
  return $results
}

function Test-PrinterMib {
  Write-Section "0c  MIB walk against $PrinterAddress"

  if ([string]::IsNullOrWhiteSpace($PrinterAddress)) {
    Write-Finding '-PrinterAddress is required for -Snmp.' 'bad'
    return
  }

  $targets = [ordered]@{
    'sysDescr                    ' = '.1.3.6.1.2.1.1.1'
    'sysObjectID                 ' = '.1.3.6.1.2.1.1.2'
    'hrPrinterStatus             ' = '.1.3.6.1.2.1.25.3.5.1.1'
    'hrPrinterDetectedErrorState ' = '.1.3.6.1.2.1.25.3.5.1.2'
    'prtGeneralSerialNumber      ' = '.1.3.6.1.2.1.43.5.1.1.17'
    'prtMarkerLifeCount          ' = '.1.3.6.1.2.1.43.10.2.1.4'
    'prtInputCurrentLevel        ' = '.1.3.6.1.2.1.43.8.2.1.10'
    'prtInputMaxCapacity         ' = '.1.3.6.1.2.1.43.8.2.1.9'
    'prtMarkerSuppliesLevel      ' = '.1.3.6.1.2.1.43.11.1.1.9'
    'prtAlertDescription         ' = '.1.3.6.1.2.1.43.18.1.1.8'
  }

  $reachable = $false
  foreach ($label in $targets.Keys) {
    $rows = Invoke-SnmpWalk -Address $PrinterAddress -CommunityName $Community -Root $targets[$label]
    if ($rows.Count -eq 0) {
      Write-Finding "$label  -- no response" 'warn'
      continue
    }
    $reachable = $true
    foreach ($row in $rows) {
      $rendered = if ($null -eq $row.value.value) { '(null)' } else { [string]$row.value.value }
      Write-Host "  $label  $($row.oid) = [$($row.value.type)] $rendered"
    }
  }

  Write-Host ''
  if (-not $reachable) {
    Write-Finding 'Nothing answered. Check the cable, the address, SNMPv1 being temporarily' 'bad'
    Write-Finding 'enabled, the community name, and the printer IP filter.' 'bad'
    return
  }

  Write-Finding 'GO/NO-GO for the whole project:' 'warn'
  Write-Finding '1. prtMarkerLifeCount present, and it advances by the right amount after a' 'warn'
  Write-Finding '   known job? That is the only signal that can prove physical output.' 'warn'
  Write-Finding '2. hrPrinterDetectedErrorState sets bit 1 (noPaper) when you pull the tray?' 'warn'
  Write-Finding '   Byte 0 bit 0=lowPaper 1=noPaper 2=lowToner 3=noToner 4=doorOpen 5=jammed.' 'warn'
  Write-Finding '3. prtInputCurrentLevel a real sheet count, or -1/-2/-3 (unknown)?' 'warn'
  Write-Finding 'If 1 and 2 both fail, stop. Ethernet buys nothing worth its attack surface.' 'warn'
}

#endregion

Write-Host ''
Write-Host 'Printer telemetry verification — READ ONLY, changes nothing.' -ForegroundColor White
Write-Host "queue: $QueueName" -ForegroundColor Gray

if ($Usb) {
  Test-DiagnosticHistory
  Test-BidirectionalSupport
  Test-DeviceStatus
}
if ($Snmp) { Test-PrinterMib }

Write-Host ''
Write-Host 'Save this output. It decides whether the Ethernet work goes ahead.' -ForegroundColor White
Write-Host ''
