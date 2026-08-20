#Requires -Version 5.1
<#
.SYNOPSIS
  Phase 0c: does this printer expose an engine page counter and a usable error
  state over SNMP? Read-only -- GET-NEXT only, no code path here can write.

.DESCRIPTION
  Only worth running if verify-printer-telemetry.ps1 came back empty, meaning
  the USB path really does carry no physical status.

  The decisive object is prtMarkerLifeCount: a lifetime count of pages the
  print engine has actually marked. Read before and after a job, its delta is
  the only signal available anywhere that can prove physical output. If this
  printer does not implement it, the whole Ethernet plan buys diagnostics we
  cannot act on and should be abandoned.

  Carries its own minimal SNMPv1 client so Net-SNMP does not need installing.
  The BER encoder and decoder were verified against hand-computed packets.

.PARAMETER PrinterAddress
  The printer's address on the direct link, e.g. 192.168.253.2

.PARAMETER Community
  Temporary SNMPv1 read-only community for verification only. SNMPv1 sends this
  in plaintext, so it must be disabled on the printer in favour of SNMPv3
  before anything ships. Use a throwaway value and turn SNMPv1 off afterwards.

.EXAMPLE
  .\verify-printer-snmp.ps1 -PrinterAddress 192.168.253.2 -Community throwaway
#>

param(
  [string] $PrinterAddress,
  [string] $Community = 'public',
  [int] $TimeoutMilliseconds = 2000,
  [switch] $SelfTest
)

$ErrorActionPreference = 'Continue'

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

# ---------- BER encoding ----------

function ConvertTo-BerLength {
  param([int] $Length)
  if ($Length -lt 0x80) { return , [byte] $Length }
  $bytes = New-Object 'System.Collections.Generic.List[byte]'
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
  $bytes = New-Object 'System.Collections.Generic.List[byte]'
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
  $bytes = New-Object 'System.Collections.Generic.List[byte]'
  $bytes.Add([byte](40 * $arcs[0] + $arcs[1]))
  for ($i = 2; $i -lt $arcs.Count; $i++) {
    $arc = $arcs[$i]
    $chunk = New-Object 'System.Collections.Generic.List[byte]'
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

# ---------- BER decoding ----------

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

# The element is pulled into its own variable before being cast. Written as
# `[int]$Buffer[$Offset]`, Windows PowerShell binds the cast to $Buffer rather
# than to the indexed element and hands back an array, which then fails with
# "[System.Object[]] does not contain a method named 'op_Modulus'". Indexing
# first removes the ambiguity entirely.
function ConvertFrom-BerOid {
  param([byte[]] $Buffer, [int] $Offset, [int] $Length)

  $firstByte = $Buffer[$Offset]
  $first = [int] $firstByte

  # The first octet packs the first two arcs: 40 * arc1 + arc2.
  $arcs = New-Object 'System.Collections.Generic.List[int]'
  $arcs.Add([int][System.Math]::Floor($first / 40))
  $arcs.Add([int]($first % 40))

  # Every later arc is base-128, most significant group first, with the high
  # bit set on all but the final octet.
  $value = 0
  for ($i = 1; $i -lt $Length; $i++) {
    $current = $Buffer[$Offset + $i]
    $byte = [int] $current
    $value = ($value -shl 7) -bor ($byte -band 0x7F)
    if (($byte -band 0x80) -eq 0) {
      $arcs.Add([int] $value)
      $value = 0
    }
  }
  return '.' + ($arcs.ToArray() -join '.')
}

# if/elseif rather than a switch: Windows PowerShell 5.1 rejected hex numeric
# labels used as switch clauses with "Unexpected token '{'".
function ConvertFrom-BerValue {
  param([byte[]] $Buffer, [int] $Offset, [int] $Length, [byte] $Tag)

  $tagValue = [int] $Tag

  if ($tagValue -eq 2) {
    $value = 0
    if ($Length -gt 0 -and ($Buffer[$Offset] -band 0x80)) { $value = -1 }
    for ($i = 0; $i -lt $Length; $i++) { $value = ($value -shl 8) -bor $Buffer[$Offset + $i] }
    return @{ type = 'INTEGER'; value = $value }
  }

  if ($tagValue -eq 4) {
    # Either text (a serial number) or a bitmask (hrPrinterDetectedErrorState),
    # so both readings are reported.
    if ($Length -eq 0) { return @{ type = 'STRING'; value = '' } }
    $bytes = $Buffer[$Offset..($Offset + $Length - 1)]
    $printable = $true
    foreach ($b in $bytes) {
      if ($b -lt 0x20 -or $b -gt 0x7E) { $printable = $false }
    }
    $hex = ($bytes | ForEach-Object { $_.ToString('X2') }) -join ' '
    if ($printable) {
      $text = [System.Text.Encoding]::ASCII.GetString($bytes)
      return @{ type = 'STRING'; value = $text; hex = $hex }
    }
    return @{ type = 'OCTETS'; value = $hex; hex = $hex }
  }

  if ($tagValue -eq 5) { return @{ type = 'NULL'; value = '' } }

  if ($tagValue -eq 6) {
    $oid = ConvertFrom-BerOid -Buffer $Buffer -Offset $Offset -Length $Length
    return @{ type = 'OID'; value = $oid }
  }

  if ($tagValue -eq 128) { return @{ type = 'noSuchObject'; value = '' } }
  if ($tagValue -eq 129) { return @{ type = 'noSuchInstance'; value = '' } }
  if ($tagValue -eq 130) { return @{ type = 'endOfMibView'; value = '' } }

  # Counter32, Gauge32, TimeTicks and Counter64 all decode as unsigned.
  $value = [uint64] 0
  for ($i = 0; $i -lt $Length; $i++) { $value = ($value -shl 8) -bor $Buffer[$Offset + $i] }
  $label = 'tag0x' + $Tag.ToString('X2')
  return @{ type = $label; value = $value }
}

# ---------- transport ----------

function Invoke-SnmpGetNext {
  param([string] $Address, [string] $CommunityName, [string] $Oid)

  $requestId = Get-Random -Minimum 1 -Maximum 2000000000
  $nullTlv = New-BerTlv -Tag 0x05 -Content @()
  $binding = New-BerTlv -Tag 0x30 -Content ((New-BerOid -Oid $Oid) + $nullTlv)
  $bindings = New-BerTlv -Tag 0x30 -Content $binding
  $pduBody = (New-BerInteger -Value $requestId) +
             (New-BerInteger -Value 0) +
             (New-BerInteger -Value 0) +
             $bindings
  $pdu = New-BerTlv -Tag 0xA1 -Content $pduBody
  $communityBytes = [System.Text.Encoding]::ASCII.GetBytes($CommunityName)
  $messageBody = (New-BerInteger -Value 0) +
                 (New-BerTlv -Tag 0x04 -Content $communityBytes) +
                 $pdu
  $message = New-BerTlv -Tag 0x30 -Content $messageBody

  $client = New-Object System.Net.Sockets.UdpClient
  $response = $null
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
  if ($null -eq $response -or $response.Length -lt 16) { return $null }

  # SEQUENCE { version, community, PDU { requestId, errorStatus, errorIndex,
  #            bindings { binding { name, value } } } }
  $outer = Read-BerHeader -Buffer $response -Offset 0
  $offset = $outer.valueOffset
  $version = Read-BerHeader -Buffer $response -Offset $offset
  $offset = $version.valueOffset + $version.length
  $community = Read-BerHeader -Buffer $response -Offset $offset
  $offset = $community.valueOffset + $community.length
  $pduHeader = Read-BerHeader -Buffer $response -Offset $offset
  $offset = $pduHeader.valueOffset

  for ($skip = 1; $skip -le 3; $skip++) {
    $field = Read-BerHeader -Buffer $response -Offset $offset
    if ($skip -eq 2 -and $field.length -gt 0 -and $response[$field.valueOffset] -ne 0) {
      # Indexed into its own variable first, for the same reason as in
      # ConvertFrom-BerOid above.
      $statusByte = $response[$field.valueOffset]
      return @{ snmpError = [int] $statusByte }
    }
    $offset = $field.valueOffset + $field.length
  }

  $list = Read-BerHeader -Buffer $response -Offset $offset
  $entry = Read-BerHeader -Buffer $response -Offset $list.valueOffset
  $nameHeader = Read-BerHeader -Buffer $response -Offset $entry.valueOffset
  $name = ConvertFrom-BerOid -Buffer $response -Offset $nameHeader.valueOffset -Length $nameHeader.length
  $valueHeader = Read-BerHeader -Buffer $response -Offset ($nameHeader.valueOffset + $nameHeader.length)
  $value = ConvertFrom-BerValue -Buffer $response -Offset $valueHeader.valueOffset `
    -Length $valueHeader.length -Tag $valueHeader.tag

  return @{ oid = $name; valueType = $value.type; valueText = [string]$value.value }
}

function Invoke-SnmpWalk {
  param([string] $Root, [int] $MaxRows = 30)
  $results = @()
  $current = $Root
  $prefix = $Root.TrimEnd('.') + '.'
  for ($i = 0; $i -lt $MaxRows; $i++) {
    $step = Invoke-SnmpGetNext -Address $PrinterAddress -CommunityName $Community -Oid $current
    if ($null -eq $step) { break }
    if ($step.ContainsKey('snmpError')) { break }
    if (-not $step.oid.StartsWith($prefix)) { break }
    if ($step.valueType -eq 'endOfMibView') { break }
    $results += $step
    $current = $step.oid
  }
  return $results
}

# ---------- the walk ----------

<#
.SYNOPSIS
  Prove the encoder and decoder agree, without a printer.

.DESCRIPTION
  Builds a GetResponse carrying a known OID and a known Counter32, decodes it
  with the same functions used against the real device, and checks both come
  back exactly. Every parse bug found in this script so far would have been
  caught here in one second rather than one round trip to the hardware.
#>
function Invoke-SelfTest {
  Write-Section 'Self-test: encoder and decoder round trip'
  $failures = 0

  # A request packet, checked byte for byte against a hand-computed SNMPv1
  # GET-NEXT for sysDescr with community "public".
  $nullTlv = New-BerTlv -Tag 0x05 -Content @()
  $binding = New-BerTlv -Tag 0x30 -Content ((New-BerOid -Oid '.1.3.6.1.2.1.1.1') + $nullTlv)
  $bindings = New-BerTlv -Tag 0x30 -Content $binding
  $pduBody = (New-BerInteger -Value 0x01020304) + (New-BerInteger -Value 0) +
             (New-BerInteger -Value 0) + $bindings
  $pdu = New-BerTlv -Tag 0xA1 -Content $pduBody
  $communityBytes = [System.Text.Encoding]::ASCII.GetBytes('public')
  $body = (New-BerInteger -Value 0) + (New-BerTlv -Tag 0x04 -Content $communityBytes) + $pdu
  $message = New-BerTlv -Tag 0x30 -Content $body
  $actual = (@($message) | ForEach-Object { ([byte]$_).ToString('X2') }) -join ''
  $expected = '302802010004067075626C6963A11B0204010203040201000201003' +
              '00D300B06072B0601020101010500'
  if ($actual -eq $expected) {
    Write-Finding 'request encoding matches the reference packet' 'good'
  } else {
    Write-Finding 'request encoding MISMATCH' 'bad'
    Write-Finding "  got      $actual"
    Write-Finding "  expected $expected"
    $failures++
  }

  # A response carrying prtMarkerLifeCount.1.1 = 12345 as a Counter32.
  $oid = '.1.3.6.1.2.1.43.10.2.1.4.1.1'
  $counter = New-BerTlv -Tag 0x41 -Content @([byte]0x30, [byte]0x39)
  $vb = New-BerTlv -Tag 0x30 -Content ((New-BerOid -Oid $oid) + $counter)
  $responsePdu = New-BerTlv -Tag 0xA2 -Content (
    (New-BerInteger -Value 1) + (New-BerInteger -Value 0) + (New-BerInteger -Value 0) +
    (New-BerTlv -Tag 0x30 -Content $vb))
  $responseBody = (New-BerInteger -Value 0) +
                  (New-BerTlv -Tag 0x04 -Content $communityBytes) + $responsePdu
  $response = [byte[]] (New-BerTlv -Tag 0x30 -Content $responseBody)

  $outer = Read-BerHeader -Buffer $response -Offset 0
  $offset = $outer.valueOffset
  $version = Read-BerHeader -Buffer $response -Offset $offset
  $offset = $version.valueOffset + $version.length
  $community = Read-BerHeader -Buffer $response -Offset $offset
  $offset = $community.valueOffset + $community.length
  $pduHeader = Read-BerHeader -Buffer $response -Offset $offset
  $offset = $pduHeader.valueOffset
  for ($skip = 1; $skip -le 3; $skip++) {
    $field = Read-BerHeader -Buffer $response -Offset $offset
    $offset = $field.valueOffset + $field.length
  }
  $list = Read-BerHeader -Buffer $response -Offset $offset
  $entry = Read-BerHeader -Buffer $response -Offset $list.valueOffset
  $nameHeader = Read-BerHeader -Buffer $response -Offset $entry.valueOffset
  $name = ConvertFrom-BerOid -Buffer $response -Offset $nameHeader.valueOffset `
    -Length $nameHeader.length
  $valueHeader = Read-BerHeader -Buffer $response -Offset ($nameHeader.valueOffset + $nameHeader.length)
  $decoded = ConvertFrom-BerValue -Buffer $response -Offset $valueHeader.valueOffset `
    -Length $valueHeader.length -Tag $valueHeader.tag

  if ($name -eq $oid) {
    Write-Finding "OID decoded correctly: $name" 'good'
  } else {
    Write-Finding "OID MISMATCH: got '$name', expected '$oid'" 'bad'
    $failures++
  }
  if ([string]$decoded.value -eq '12345') {
    Write-Finding "Counter32 decoded correctly: $($decoded.value)" 'good'
  } else {
    Write-Finding "value MISMATCH: got '$($decoded.value)', expected 12345" 'bad'
    $failures++
  }

  Write-Host ''
  if ($failures -eq 0) {
    Write-Finding 'Self-test passed. Any failure against the printer is the printer,' 'good'
    Write-Finding 'the address, the community name or a firewall -- not this decoder.' 'good'
  } else {
    Write-Finding "$failures self-test failure(s). Do not trust a walk until this passes." 'bad'
  }
}

if ($SelfTest) {
  Invoke-SelfTest
  return
}

if ([string]::IsNullOrWhiteSpace($PrinterAddress)) {
  Write-Host 'Specify -PrinterAddress <ip>, or -SelfTest to check the decoder.' -ForegroundColor Red
  return
}

Write-Host ''
Write-Host "Phase 0c SNMP MIB walk -- READ ONLY (GET-NEXT only)." -ForegroundColor White
Write-Host "target: $PrinterAddress udp/161" -ForegroundColor Gray

Write-Section 'Reachability'
$probe = Invoke-SnmpGetNext -Address $PrinterAddress -CommunityName $Community -Oid '.1.3.6.1.2.1.1.1'
if ($null -eq $probe) {
  Write-Finding 'No response to sysDescr.' 'bad'
  Write-Finding 'Check: cable, printer IP, SNMPv1 temporarily enabled, community name,' 'bad'
  Write-Finding 'the printer IP filter, and Windows Firewall outbound udp/161.' 'bad'
  return
}
if ($probe.ContainsKey('snmpError')) {
  Write-Finding "SNMP error-status $($probe.snmpError). Wrong community name?" 'bad'
  return
}
Write-Finding "reachable: $($probe.valueText)" 'good'

$targets = [ordered]@{
  'sysObjectID                ' = '.1.3.6.1.2.1.1.2'
  'hrPrinterStatus            ' = '.1.3.6.1.2.1.25.3.5.1.1'
  'hrPrinterDetectedErrorState' = '.1.3.6.1.2.1.25.3.5.1.2'
  'prtGeneralSerialNumber     ' = '.1.3.6.1.2.1.43.5.1.1.17'
  'prtMarkerLifeCount         ' = '.1.3.6.1.2.1.43.10.2.1.4'
  'prtInputCurrentLevel       ' = '.1.3.6.1.2.1.43.8.2.1.10'
  'prtInputMaxCapacity        ' = '.1.3.6.1.2.1.43.8.2.1.9'
  'prtMarkerSuppliesLevel     ' = '.1.3.6.1.2.1.43.11.1.1.9'
  'prtAlertDescription        ' = '.1.3.6.1.2.1.43.18.1.1.8'
}

Write-Section 'Objects'
$present = @{}
foreach ($label in $targets.Keys) {
  $rows = Invoke-SnmpWalk -Root $targets[$label]
  if ($rows.Count -eq 0) {
    Write-Host "  $label  -- NOT IMPLEMENTED" -ForegroundColor Red
    continue
  }
  $present[$label.Trim()] = $true
  foreach ($row in $rows) {
    Write-Host "  $label  $($row.oid) = [$($row.valueType)] $($row.valueText)"
  }
}

Write-Section 'Go / no-go'
$marker = $present.ContainsKey('prtMarkerLifeCount')
$errorState = $present.ContainsKey('hrPrinterDetectedErrorState')

if ($marker) {
  Write-Finding 'prtMarkerLifeCount IS implemented.' 'good'
  Write-Finding 'Now run a known job and re-run this. The value must rise by the number' 'warn'
  Write-Finding 'of sides printed. If it does not move, it is useless to us.' 'warn'
} else {
  Write-Finding 'prtMarkerLifeCount NOT implemented -- no way to prove physical output.' 'bad'
}

if ($errorState) {
  Write-Finding 'hrPrinterDetectedErrorState IS implemented.' 'good'
  Write-Finding 'Pull the paper tray and re-run. Byte 0 bit 1 (0x40 in the first hex byte)' 'warn'
  Write-Finding 'must set for noPaper. Bits: 0 lowPaper 1 noPaper 2 lowToner 3 noToner' 'warn'
  Write-Finding '4 doorOpen 5 jammed -- read most-significant-bit first.' 'warn'
} else {
  Write-Finding 'hrPrinterDetectedErrorState NOT implemented -- no fault detection.' 'bad'
}

Write-Host ''
if ($marker -and $errorState) {
  Write-Finding 'Both present. Confirm they actually move, then confirm SNMPv3' 'good'
  Write-Finding 'Authentication+Encryption works, then the build can proceed.' 'good'
} else {
  Write-Finding 'STOP. Without both, Ethernet buys diagnostics we cannot act on, at the' 'bad'
  Write-Finding 'cost of a second network interface on an unattended public machine.' 'bad'
}
Write-Host ''
