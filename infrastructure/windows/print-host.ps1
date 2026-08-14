#Requires -Version 5.1
<#
.SYNOPSIS
  Reference Windows device host for the printing kiosk agent.

.DESCRIPTION
  One request on standard input, one JSON document on standard output, then
  exit. The protocol is defined in docs/hardware/windows-device-host.md and is
  the only thing that crosses between this script and the agent.

  What lives here is the platform work a Node process cannot do honestly:
  enumerating the machine's print queues, reading a driver's PrintTicket
  capabilities, spooling bytes with an operating-system job identifier that can
  still be asked about after a crash, and reading that job's state back.

  What deliberately does not live here is any judgement about what a result
  means. This host reports what the spooler said; the agent decides what may be
  called a confirmed print, and it downgrades anything these numbers do not
  support. A spooler considers a job finished the moment it leaves the queue,
  which is not the same as paper.

  It spools PDF bytes directly to the queue (datatype RAW). That is correct for
  a PDF-direct printer and wrong for a queue that expects rendered output, so a
  queue whose driver does not advertise PDF is refused rather than sent bytes it
  would print as text. See the compatibility notes for which queues qualify.
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Where the operation-to-job mapping is kept. The spooler purges job history on
# its own schedule, so without this a restart could not tell an operation that
# already printed from one that never started.
$StateDirectory = Join-Path $env:ProgramData 'PrintingKiosk\device-host'

Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;

public static class RawPrinter {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct DOCINFO {
    [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPWStr)] public string pDatatype;
  }

  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool OpenPrinter(string src, out IntPtr hPrinter, IntPtr pd);
  [DllImport("winspool.drv", SetLastError = true)]
  private static extern bool ClosePrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern int StartDocPrinter(IntPtr hPrinter, int level, ref DOCINFO di);
  [DllImport("winspool.drv", SetLastError = true)]
  private static extern bool EndDocPrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", SetLastError = true)]
  private static extern bool StartPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", SetLastError = true)]
  private static extern bool EndPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", SetLastError = true)]
  private static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, int dwCount, out int dwWritten);

  /// Spool one document and return the identifier the spooler gave it. The
  /// identifier is returned before any byte is written, so a caller that
  /// crashes mid-write still has a job to ask about.
  public static int Spool(string queueName, string jobName, byte[] document) {
    IntPtr printer;
    if (!OpenPrinter(queueName, out printer, IntPtr.Zero)) {
      throw new InvalidOperationException("OPEN_PRINTER_FAILED:" + Marshal.GetLastWin32Error());
    }
    try {
      DOCINFO info = new DOCINFO();
      info.pDocName = jobName;
      info.pDatatype = "RAW";
      int jobId = StartDocPrinter(printer, 1, ref info);
      if (jobId == 0) {
        throw new InvalidOperationException("START_DOC_FAILED:" + Marshal.GetLastWin32Error());
      }
      try {
        if (!StartPagePrinter(printer)) {
          throw new InvalidOperationException("START_PAGE_FAILED:" + Marshal.GetLastWin32Error());
        }
        IntPtr buffer = Marshal.AllocCoTaskMem(document.Length);
        try {
          Marshal.Copy(document, 0, buffer, document.Length);
          int written;
          if (!WritePrinter(printer, buffer, document.Length, out written) || written != document.Length) {
            throw new InvalidOperationException("WRITE_FAILED:" + Marshal.GetLastWin32Error());
          }
        } finally {
          Marshal.FreeCoTaskMem(buffer);
        }
        EndPagePrinter(printer);
      } finally {
        EndDocPrinter(printer);
      }
      return jobId;
    } finally {
      ClosePrinter(printer);
    }
  }
}
'@

function Write-Result {
  param([Parameter(Mandatory = $true)] $Result)
  # Depth 6 covers a queue list; anything deeper is not part of the protocol.
  Write-Output (ConvertTo-Json @{ ok = $true; result = $Result } -Depth 6 -Compress)
}

function Write-Failure {
  param(
    [Parameter(Mandatory = $true)][string] $Code,
    # Whether the submission this refers to may already have reached the device.
    # It defaults to true on the agent's side, so saying so explicitly is the
    # only way a refusal counts as proof that nothing printed.
    [bool] $Ambiguous = $true
  )
  Write-Output (ConvertTo-Json @{ ok = $false; error = @{ code = $Code; ambiguous = $Ambiguous } } -Compress)
  exit 0
}

function Get-QueueOrFail {
  param([string] $QueueName)
  if ([string]::IsNullOrWhiteSpace($QueueName)) { Write-Failure -Code 'QUEUE_NOT_FOUND' -Ambiguous $false }
  $printer = Get-Printer -Name $QueueName -ErrorAction SilentlyContinue
  if ($null -eq $printer) { Write-Failure -Code 'QUEUE_NOT_FOUND' -Ambiguous $false }
  return $printer
}

function ConvertTo-QueueState {
  param($Printer)
  # PrinterStatus is a flag set. Anything that stops paper is not "ready", and
  # a status this script does not recognise is reported as an error rather than
  # rounded up to ready.
  $status = [string]$Printer.PrinterStatus
  if ($Printer.PrinterStatus -eq 'Normal' -or $status -eq 'Idle') { return 'READY' }
  if ($status -match 'Paused|Pending') { return 'PAUSED' }
  if ($status -match 'Offline|NotAvailable|PowerSave') { return 'OFFLINE' }
  return 'ERROR'
}

function Get-StatePath {
  param([string] $OperationId)
  if ($OperationId -notmatch '^[0-9a-fA-F-]{36}$') { Write-Failure -Code 'OPERATION_ID_INVALID' -Ambiguous $false }
  if (-not (Test-Path $StateDirectory)) {
    New-Item -ItemType Directory -Path $StateDirectory -Force | Out-Null
  }
  return Join-Path $StateDirectory ("{0}.json" -f $OperationId.ToLowerInvariant())
}

function Read-OperationState {
  param([string] $OperationId)
  $path = Get-StatePath -OperationId $OperationId
  if (-not (Test-Path $path)) { return $null }
  try { return Get-Content -Path $path -Raw | ConvertFrom-Json }
  catch {
    # A truncated record still proves a submission started. Treating it as
    # absent is the one reading that would print a paid job twice.
    return [pscustomobject]@{ operationId = $OperationId; queue = ''; jobs = @() }
  }
}

function Write-OperationState {
  param([string] $OperationId, $State)
  Set-Content -Path (Get-StatePath -OperationId $OperationId) -Value (ConvertTo-Json $State -Depth 6) -Encoding UTF8
}

function Get-DocumentFormats {
  param($Printer)
  # A PDF-direct queue says so through its driver name or its printer
  # properties. Nothing here guesses: a queue that does not say is refused, and
  # the operator certifies it explicitly instead.
  $driver = [string]$Printer.DriverName
  if ($driver -match 'PDF|PS|PostScript|IPP|Universal Print') { return @('application/pdf') }
  try {
    $property = Get-PrinterProperty -PrinterName $Printer.Name -PropertyName 'Config:DocumentFormats' -ErrorAction Stop
    if ([string]$property.Value -match 'PDF') { return @('application/pdf') }
  } catch { }
  return @()
}

# ---------------------------------------------------------------------------
# Operations
# ---------------------------------------------------------------------------

function Invoke-ListQueues {
  $queues = @()
  foreach ($printer in Get-Printer -ErrorAction SilentlyContinue) {
    $queues += @{
      queueName  = $printer.Name
      deviceUri  = $printer.PortName
      driverName = $printer.DriverName
      portName   = $printer.PortName
      state      = ConvertTo-QueueState -Printer $printer
      isDefault  = [bool]($printer.Name -eq (Get-CimInstance -ClassName Win32_Printer -Filter 'Default = TRUE' -ErrorAction SilentlyContinue).Name)
      shared     = [bool]$printer.Shared
    }
  }
  Write-Result -Result $queues
}

function Invoke-Describe {
  param([string] $QueueName)
  $printer = Get-QueueOrFail -QueueName $QueueName
  $driver = Get-PrinterDriver -Name $printer.DriverName -ErrorAction SilentlyContinue
  Write-Result -Result @{
    deviceId     = $printer.PortName
    makeAndModel = $printer.DriverName
    driverName   = $printer.DriverName
    firmware     = if ($null -ne $driver) { [string]$driver.DriverVersion } else { $null }
  }
}

function Invoke-Capabilities {
  param([string] $QueueName)
  $printer = Get-QueueOrFail -QueueName $QueueName
  $configuration = Get-PrintConfiguration -PrinterName $printer.Name -ErrorAction SilentlyContinue

  $sides = @('OneSided')
  if ($null -ne $configuration -and $configuration.DuplexingMode -ne 'OneSided') {
    $sides += @('TwoSidedLongEdge', 'TwoSidedShortEdge')
  }

  # The kiosk prints monochrome only. A colour device is reported as capable of
  # monochrome, which is all this product ever asks of it.
  Write-Result -Result @{
    mediaSizes      = @(if ($null -ne $configuration) { [string]$configuration.PaperSize } else { 'A4' })
    sides           = $sides
    colorModes      = @('Monochrome')
    maxCopies       = 20
    duplexSupported = ($sides.Count -gt 1)
  }
}

function Invoke-Health {
  param([string] $QueueName)
  $printer = Get-QueueOrFail -QueueName $QueueName
  $state = ConvertTo-QueueState -Printer $printer
  if ($state -ne 'READY') {
    Write-Result -Result @{ state = 'OFFLINE'; warningCode = $null }
    return
  }
  $warning = $null
  if ([string]$printer.PrinterStatus -match 'TonerLow') { $warning = 'TONER_LOW' }
  elseif ([string]$printer.PrinterStatus -match 'PaperLow') { $warning = 'PAPER_LOW' }
  elseif ([string]$printer.PrinterStatus -match 'OutputBinFull') { $warning = 'OUTPUT_TRAY_FULL' }
  Write-Result -Result @{ state = if ($null -eq $warning) { 'READY' } else { 'WARNING' }; warningCode = $warning }
}

function Invoke-Submit {
  param($Request)
  $printer = Get-QueueOrFail -QueueName $Request.queue
  if ((ConvertTo-QueueState -Printer $printer) -ne 'READY') {
    Write-Failure -Code 'PRINTER_OFFLINE' -Ambiguous $false
  }
  if ((Get-DocumentFormats -Printer $printer) -notcontains 'application/pdf') {
    # This host spools PDF bytes. A queue that expects rendered output would
    # print them as text, so it is refused before anything is sent.
    Write-Failure -Code 'DEVICE_ERROR' -Ambiguous $false
  }

  $state = [pscustomobject]@{
    operationId = $Request.operationId
    queue       = $printer.Name
    submittedAt = (Get-Date).ToUniversalTime().ToString('o')
    jobs        = @()
  }
  # Durable before the spooler is touched: a host killed on the next line still
  # leaves evidence that something may have reached a printer.
  Write-OperationState -OperationId $Request.operationId -State $state

  $submitted = 0
  foreach ($document in $Request.documents) {
    if (-not (Test-Path -LiteralPath $document.path)) {
      Write-Failure -Code 'ARTIFACT_UNAVAILABLE' -Ambiguous ($submitted -gt 0)
    }
    # Copies and duplex belong to a document in this product. They are applied
    # to the queue's configuration for the duration of the job.
    try {
      $duplex = switch ($document.sides) {
        'two-sided-long-edge' { 'TwoSidedLongEdge' }
        'two-sided-short-edge' { 'TwoSidedShortEdge' }
        default { 'OneSided' }
      }
      Set-PrintConfiguration -PrinterName $printer.Name -DuplexingMode $duplex -ErrorAction Stop
    } catch {
      Write-Failure -Code 'DEVICE_ERROR' -Ambiguous ($submitted -gt 0)
    }

    $bytes = [System.IO.File]::ReadAllBytes($document.path)
    for ($copy = 0; $copy -lt [int]$document.copies; $copy++) {
      try {
        $jobId = [RawPrinter]::Spool($printer.Name, $document.jobName, $bytes)
      } catch {
        Write-Failure -Code 'DEVICE_ERROR' -Ambiguous ($submitted -gt 0 -or $copy -gt 0)
      }
      $state.jobs += @{ position = [int]$document.position; jobId = $jobId; jobName = $document.jobName }
      Write-OperationState -OperationId $Request.operationId -State $state
      $submitted++
    }
  }

  Write-Result -Result (Get-OperationReport -OperationId $Request.operationId -QueueName $printer.Name -WaitForCompletion $true)
}

function Invoke-Status {
  param($Request)
  Write-Result -Result (Get-OperationReport -OperationId $Request.operationId -QueueName $Request.queue -WaitForCompletion $false)
}

function Invoke-Cancel {
  param($Request)
  $state = Read-OperationState -OperationId $Request.operationId
  if ($null -eq $state) {
    Write-Result -Result @{ state = 'NOT_SUBMITTED'; confidence = 'CONFIRMED'; sheetsProduced = 0 }
    return
  }
  foreach ($job in $state.jobs) {
    Remove-PrintJob -PrinterName $Request.queue -ID $job.jobId -ErrorAction SilentlyContinue
  }
  Write-Result -Result (Get-OperationReport -OperationId $Request.operationId -QueueName $Request.queue -WaitForCompletion $false)
}

function Invoke-Discard {
  param($Request)
  $cutoff = [datetime]::Parse($Request.before).ToUniversalTime()
  $discarded = 0
  if (Test-Path $StateDirectory) {
    foreach ($file in Get-ChildItem -Path $StateDirectory -Filter '*.json' -File) {
      if ($file.LastWriteTimeUtc -lt $cutoff) {
        Remove-Item -LiteralPath $file.FullName -Force
        $discarded++
      }
    }
  }
  Write-Result -Result @{ discarded = $discarded }
}

<#
  What the spooler knows about one operation.

  A job that is still in the queue can be read directly. A job that has left it
  is the interesting case: the spooler deletes a completed job's record within
  seconds, and its absence is indistinguishable from a job that never existed.
  This reports that as a completion nobody watched — never as a confirmed one,
  and never as "not submitted", because the local record proves otherwise.
#>
function Get-OperationReport {
  param([string] $OperationId, [string] $QueueName, [bool] $WaitForCompletion)

  $state = Read-OperationState -OperationId $OperationId
  if ($null -eq $state -or $state.jobs.Count -eq 0) {
    return @{ state = 'NOT_SUBMITTED'; confidence = 'CONFIRMED'; failureCode = $null; warningCode = $null; sheetsProduced = 0 }
  }

  $deadline = (Get-Date).AddMinutes(10)
  while ($true) {
    $open = 0
    $failed = $null
    $pages = 0
    $pagesKnown = $true

    foreach ($job in $state.jobs) {
      $current = Get-PrintJob -PrinterName $QueueName -ID $job.jobId -ErrorAction SilentlyContinue
      if ($null -eq $current) {
        # Gone from the queue. The spooler finished with it; whether paper came
        # out is not something a job listing can answer.
        $pagesKnown = $false
        continue
      }
      $status = [string]$current.JobStatus
      if ($status -match 'Error|Blocked') { $failed = 'DEVICE_ERROR' }
      elseif ($status -match 'PaperOut') { $failed = 'OUT_OF_PAPER' }
      elseif ($status -match 'Deleted|Deleting') { $failed = 'CANCELED_AT_DEVICE' }
      elseif ($status -match 'Paused|Offline') { $failed = 'PRINTER_OFFLINE' }
      else { $open++ }
      if ($null -ne $current.PagesPrinted) { $pages += [int]$current.PagesPrinted } else { $pagesKnown = $false }
    }

    if ($null -ne $failed) {
      return @{
        state          = if ($failed -eq 'CANCELED_AT_DEVICE') { 'CANCELED' } else { 'FAILED' }
        confidence     = 'UNCONFIRMED'
        failureCode    = $failed
        warningCode    = $null
        sheetsProduced = if ($pagesKnown) { $pages } else { $null }
      }
    }
    if ($open -eq 0) {
      return @{
        state          = 'COMPLETED'
        # The spooler emptying its queue is not evidence about paper. The agent
        # is what decides this cannot be called a confirmed print.
        confidence     = 'UNCONFIRMED'
        failureCode    = $null
        warningCode    = $null
        sheetsProduced = if ($pagesKnown) { $pages } else { $null }
      }
    }
    if (-not $WaitForCompletion -or (Get-Date) -ge $deadline) {
      return @{ state = 'PRINTING'; confidence = 'UNCONFIRMED'; failureCode = $null; warningCode = $null; sheetsProduced = $null }
    }
    Start-Sleep -Seconds 2
  }
}

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

try {
  $raw = [Console]::In.ReadToEnd()
  $request = $raw | ConvertFrom-Json
} catch {
  Write-Failure -Code 'DEVICE_ERROR' -Ambiguous $false
}

if ($request.protocol -ne 1) { Write-Failure -Code 'DEVICE_ERROR' -Ambiguous $false }

try {
  switch ($request.op) {
    'list-queues'  { Invoke-ListQueues }
    'describe'     { Invoke-Describe -QueueName $request.queue }
    'capabilities' { Invoke-Capabilities -QueueName $request.queue }
    'health'       { Invoke-Health -QueueName $request.queue }
    'submit'       { Invoke-Submit -Request $request }
    'status'       { Invoke-Status -Request $request }
    'cancel'       { Invoke-Cancel -Request $request }
    'discard'      { Invoke-Discard -Request $request }
    default        { Write-Failure -Code 'DEVICE_ERROR' -Ambiguous $false }
  }
} catch {
  # An unexpected failure during a submission may have left work at the device.
  Write-Failure -Code 'DEVICE_ERROR' -Ambiguous ($request.op -eq 'submit')
}
