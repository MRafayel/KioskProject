#Requires -Version 5.1
<#
.SYNOPSIS
  USB-only Windows device host for the printing kiosk agent.

.DESCRIPTION
  One request is read from standard input, one JSON document is written to
  standard output, and the process exits. The protocol is documented in
  docs/hardware/windows-device-host.md.

  The host accepts only a local, non-shared USB queue using the certified Canon
  Generic Plus UFR II driver. It renders the paid PDF page selection with the
  Windows PDF renderer, then draws those pages through a printer device context.
  That makes the installed Canon driver produce the UFR II spool data; PDF bytes
  are never sent to the printer as RAW data.

  Every device job has an operating-system job identifier. It is persisted as
  soon as StartDoc returns, before a page is drawn, so a process or service
  restart cannot turn a possibly printed operation into a safe retry.

  The printing runtime — the PDF renderer and the inline printing type — is
  loaded only by `submit`. It is the most expensive thing this script does and
  nothing else needs it, so a health check or a status poll no longer pays for
  a C# compilation it will not use.

.PARAMETER AsLibrary
  Define the host's functions and return without touching a device, a queue or
  standard input. It exists so the decision this host makes about whether a
  submission printed can be driven directly by print-host.tests.ps1 — that
  decision is the difference between a paid job settling and a customer being
  sent to an operator, and asserting on the source text is not a test of it.
  The agent never passes it: the transport launches this script with -File and
  no arguments.
#>

param([switch] $AsLibrary)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# On Windows both of these are always set, so the paths below are unchanged.
# The fallback exists only so a library load can define the host's functions on
# a machine that has PowerShell but not Windows, which is what lets the decision
# tests run somewhere other than the kiosk itself.
$StateRoot = if ($env:ProgramData) { $env:ProgramData } else { [System.IO.Path]::GetTempPath() }

$StateDirectory = Join-Path $StateRoot 'PrintingKiosk\device-host'
$RenderDirectory = Join-Path $StateDirectory 'render'
# Under the state tree rather than the account's local profile. The installer
# locks that tree down to the service account and administrators; a kiosk is a
# machine strangers stand in front of, and a user-profile path is not a place to
# leave an operational record of what the device did.
$DiagnosticDirectory = Join-Path $StateDirectory 'diagnostics'
$DiagnosticPath = Join-Path $DiagnosticDirectory 'diagnostics.jsonl'
$DiagnosticArchivePath = Join-Path $DiagnosticDirectory 'diagnostics.previous.jsonl'
# Small on purpose. The operation's own evidence now travels to the control
# plane inside the protocol response, so this file is only a fallback for what
# could not be reported — a host killed mid-request, or a machine that lost
# power. Two files of this size is the whole local footprint.
$DiagnosticMaxBytes = 256KB
$DiagnosticMaxAgeHours = 48
$SupportedDriverName = 'Canon Generic Plus UFR II'
$MaximumCopies = 10
$MaximumSelectedPages = 200
$RenderLongEdgePixels = 3508 # A4 at 300 DPI.
# How long the host watches a submission before answering `PRINTING`. The caller
# supplies its own budget on the request; these only bound what it may ask for,
# so the host and the agent's transport timeout cannot disagree by construction.
$DefaultObserveSeconds = 240
$MinimumObserveSeconds = 5
$MaximumObserveSeconds = 1500
# How hard the host looks for a job the spooler has just been given. StartDoc has
# already returned, so the job exists; this only covers the moment before the
# spooler publishes it to Get-PrintJob.
$JobPresenceAttempts = 10
$JobPresenceDelayMilliseconds = 100
$script:SubmissionTouched = $false
$script:DiagnosticOperation = 'startup'
$script:DiagnosticOperationId = $null
$script:DiagnosticStage = 'startup'
$script:PrintingRuntimeReady = $false

# Where the time goes. The host is a short-lived child process, so the only way
# to find out whether a slow print was the renderer, the driver or PowerShell's
# own start-up is to record it here — one process's stopwatch, reported once.
$script:PhaseWatch = [System.Diagnostics.Stopwatch]::StartNew()
$script:PhaseMarks = [ordered]@{}
# PowerShell has already been running for a while by the time the first line of
# this script executes. That interval is invisible to the stopwatch above and is
# paid on every single request, so it is measured separately.
$script:ProcessStartMilliseconds = try {
  [int]((Get-Date) - [System.Diagnostics.Process]::GetCurrentProcess().StartTime).TotalMilliseconds
} catch {
  -1
}

function Add-PhaseMark {
  param([Parameter(Mandatory = $true)][string] $Name)
  $script:PhaseMarks[$Name] = [int]$script:PhaseWatch.ElapsedMilliseconds
}

<#
.SYNOPSIS
  Load the printing runtime. Only `submit` needs it.

.DESCRIPTION
  `Add-Type -TypeDefinition` runs the C# compiler, and the WinRT loads pull in
  the PDF renderer. Together they are the most expensive thing this script does,
  and the transport starts a fresh process per request — so paying for them on a
  health check or a status poll bought nothing and was charged every 30 seconds
  by the heartbeat, and again on every poll of a job in progress.

  Nothing outside printing needs either. Queue discovery, health, capabilities,
  status, cancel and discard use the print spooler cmdlets and plain
  System.Drawing, which is an assembly load rather than a compilation.
#>
function Initialize-PrintingRuntime {
  if ($script:PrintingRuntimeReady) { return }

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Runtime.WindowsRuntime

# Load the WinRT PDF types before the async helper reflects over their methods.
[void][Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
[void][Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
[void][Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]
[void][Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType = WindowsRuntime]
[void][Windows.Data.Pdf.PdfPageRenderOptions, Windows.Data.Pdf, ContentType = WindowsRuntime]

Add-Type -ReferencedAssemblies 'System.Drawing.dll' -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Printing;
using System.Runtime.InteropServices;

public sealed class DriverRenderedPrintJob : IDisposable
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct DOCINFO
    {
        public int cbSize;
        [MarshalAs(UnmanagedType.LPWStr)] public string lpszDocName;
        [MarshalAs(UnmanagedType.LPWStr)] public string lpszOutput;
        [MarshalAs(UnmanagedType.LPWStr)] public string lpszDatatype;
        public int fwType;
    }

    [DllImport("gdi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateDC(string driver, string device, string output, IntPtr devMode);
    [DllImport("gdi32.dll", SetLastError = true)]
    private static extern bool DeleteDC(IntPtr hdc);
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode, EntryPoint = "StartDocW", SetLastError = true)]
    private static extern int StartDoc(IntPtr hdc, ref DOCINFO docInfo);
    [DllImport("gdi32.dll", SetLastError = true)]
    private static extern int EndDoc(IntPtr hdc);
    [DllImport("gdi32.dll", SetLastError = true)]
    private static extern int AbortDoc(IntPtr hdc);
    [DllImport("gdi32.dll", SetLastError = true)]
    private static extern int StartPage(IntPtr hdc);
    [DllImport("gdi32.dll", SetLastError = true)]
    private static extern int EndPage(IntPtr hdc);
    [DllImport("gdi32.dll")]
    private static extern int GetDeviceCaps(IntPtr hdc, int index);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GlobalLock(IntPtr memory);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GlobalUnlock(IntPtr memory);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GlobalFree(IntPtr memory);

    private const int HORZRES = 8;
    private const int VERTRES = 10;

    private IntPtr deviceContext = IntPtr.Zero;
    private bool active;

    public int JobId { get; private set; }

    public DriverRenderedPrintJob(string queueName, string jobName, bool longEdgeDuplex)
    {
        PrinterSettings printer = new PrinterSettings();
        printer.PrinterName = queueName;
        if (!printer.IsValid)
            throw new InvalidOperationException("PRINTER_SETTINGS_INVALID");
        if (longEdgeDuplex && !printer.CanDuplex)
            throw new InvalidOperationException("DUPLEX_UNAVAILABLE");

        PaperSize a4 = null;
        foreach (PaperSize paper in printer.PaperSizes)
        {
            if (paper.Kind == PaperKind.A4)
            {
                a4 = paper;
                break;
            }
        }
        if (a4 == null)
            throw new InvalidOperationException("A4_UNAVAILABLE");

        printer.Copies = 1;
        printer.Collate = true;
        printer.Duplex = longEdgeDuplex ? Duplex.Vertical : Duplex.Simplex;

        PageSettings page = printer.DefaultPageSettings;
        page.PaperSize = a4;
        page.Color = false;
        page.Landscape = false;

        IntPtr devModeHandle = IntPtr.Zero;
        IntPtr devMode = IntPtr.Zero;
        try
        {
            devModeHandle = printer.GetHdevmode(page);
            devMode = GlobalLock(devModeHandle);
            if (devMode == IntPtr.Zero)
                throw new InvalidOperationException("DEVMODE_LOCK_FAILED:" + Marshal.GetLastWin32Error());

            deviceContext = CreateDC("WINSPOOL", queueName, null, devMode);
            if (deviceContext == IntPtr.Zero)
                throw new InvalidOperationException("CREATE_DC_FAILED:" + Marshal.GetLastWin32Error());
        }
        finally
        {
            if (devMode != IntPtr.Zero) GlobalUnlock(devModeHandle);
            if (devModeHandle != IntPtr.Zero) GlobalFree(devModeHandle);
        }

        DOCINFO info = new DOCINFO();
        info.cbSize = Marshal.SizeOf(typeof(DOCINFO));
        info.lpszDocName = jobName;
        int jobId = StartDoc(deviceContext, ref info);
        if (jobId <= 0)
        {
            int error = Marshal.GetLastWin32Error();
            DeleteDC(deviceContext);
            deviceContext = IntPtr.Zero;
            throw new InvalidOperationException("START_DOC_FAILED:" + error);
        }

        JobId = jobId;
        active = true;
    }

    public void PrintImage(string path)
    {
        EnsureActive();
        if (StartPage(deviceContext) <= 0)
            throw new InvalidOperationException("START_PAGE_FAILED:" + Marshal.GetLastWin32Error());

        bool ended = false;
        try
        {
            int width = GetDeviceCaps(deviceContext, HORZRES);
            int height = GetDeviceCaps(deviceContext, VERTRES);
            if (width <= 0 || height <= 0)
                throw new InvalidOperationException("PRINTABLE_AREA_UNAVAILABLE");

            using (Image image = Image.FromFile(path))
            using (Graphics graphics = Graphics.FromHdc(deviceContext))
            {
                // HORZRES and VERTRES are device pixels. Printer Graphics
                // defaults to display units (normally 1/100 inch), so make the
                // drawing rectangle use the same units as the driver metrics.
                graphics.PageUnit = GraphicsUnit.Pixel;
                graphics.PageScale = 1.0f;

                // The physical medium is always A4, but source pages may be
                // portrait or landscape. Rotate when their orientations differ
                // so the selected page uses the printable area automatically.
                if ((image.Width > image.Height) != (width > height))
                    image.RotateFlip(RotateFlipType.Rotate90FlipNone);

                graphics.Clear(Color.White);
                graphics.CompositingQuality = CompositingQuality.HighQuality;
                graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
                graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
                graphics.SmoothingMode = SmoothingMode.HighQuality;

                double scale = Math.Min((double)width / image.Width, (double)height / image.Height);
                int targetWidth = Math.Max(1, (int)Math.Round(image.Width * scale));
                int targetHeight = Math.Max(1, (int)Math.Round(image.Height * scale));
                int left = (width - targetWidth) / 2;
                int top = (height - targetHeight) / 2;
                graphics.DrawImage(image, new Rectangle(left, top, targetWidth, targetHeight));
            }

            if (EndPage(deviceContext) <= 0)
                throw new InvalidOperationException("END_PAGE_FAILED:" + Marshal.GetLastWin32Error());
            ended = true;
        }
        finally
        {
            if (!ended)
            {
                AbortDoc(deviceContext);
                active = false;
            }
        }
    }

    public void PrintBlankPage()
    {
        EnsureActive();
        if (StartPage(deviceContext) <= 0)
            throw new InvalidOperationException("START_PAGE_FAILED:" + Marshal.GetLastWin32Error());
        if (EndPage(deviceContext) <= 0)
        {
            AbortDoc(deviceContext);
            active = false;
            throw new InvalidOperationException("END_PAGE_FAILED:" + Marshal.GetLastWin32Error());
        }
    }

    public void Complete()
    {
        EnsureActive();
        if (EndDoc(deviceContext) <= 0)
            throw new InvalidOperationException("END_DOC_FAILED:" + Marshal.GetLastWin32Error());
        active = false;
    }

    private void EnsureActive()
    {
        if (!active || deviceContext == IntPtr.Zero)
            throw new ObjectDisposedException("DriverRenderedPrintJob");
    }

    public void Dispose()
    {
        if (active && deviceContext != IntPtr.Zero)
        {
            AbortDoc(deviceContext);
            active = false;
        }
        if (deviceContext != IntPtr.Zero)
        {
            DeleteDC(deviceContext);
            deviceContext = IntPtr.Zero;
        }
    }
}
'@

$script:AsTaskOperationMethod = [System.WindowsRuntimeSystemExtensions].GetMethods() |
  Where-Object {
    $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and
    $_.GetGenericArguments().Count -eq 1 -and $_.GetParameters().Count -eq 1
  } |
  Select-Object -First 1
$script:AsTaskActionMethod = [System.WindowsRuntimeSystemExtensions].GetMethods() |
  Where-Object {
    $_.Name -eq 'AsTask' -and -not $_.IsGenericMethod -and
    $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction'
  } |
  Select-Object -First 1

  $script:PrintingRuntimeReady = $true
  Add-PhaseMark -Name 'printingRuntimeReady'
}

function Complete-WinRtOperation {
  param($Operation, [Type] $ResultType)
  $method = $script:AsTaskOperationMethod.MakeGenericMethod([Type[]]@($ResultType))
  $task = $method.Invoke($null, @($Operation))
  return $task.GetAwaiter().GetResult()
}

function Complete-WinRtAction {
  param($Action)
  $task = $script:AsTaskActionMethod.Invoke($null, @($Action))
  # PowerShell dispatches against the task's runtime Task<VoidTaskResult> type,
  # so GetResult emits a value even though IAsyncAction is logically void. If
  # that value escapes, Render-PdfSelection returns an array of completion
  # values plus its result object and strict-mode property access fails.
  [void]$task.GetAwaiter().GetResult()
}

function Write-Result {
  param([Parameter(Mandatory = $true)] $Result)
  Write-Output (ConvertTo-Json @{ ok = $true; result = $Result } -Depth 8 -Compress)
}

function Write-Failure {
  param(
    [Parameter(Mandatory = $true)][string] $Code,
    [bool] $Ambiguous = $true
  )
  # The stage says where in the host the refusal happened. It is a fixed
  # internal identifier — never a path, a filename or anything a customer
  # supplied — and it is what turns a bare DEVICE_ERROR in the control plane
  # into something an operator can act on without opening the kiosk.
  Write-Output (ConvertTo-Json @{
    ok = $false
    error = @{ code = $Code; ambiguous = $Ambiguous; stage = $script:DiagnosticStage }
  } -Compress)
  exit 0
}

function Add-DiagnosticRecord {
  param([Parameter(Mandatory = $true)] $Record)

  # Diagnostics are deliberately best-effort and local. A logging failure must
  # never change the host's protocol answer or its submission ambiguity.
  try {
    if (-not (Test-Path $DiagnosticDirectory)) {
      New-Item -ItemType Directory -Path $DiagnosticDirectory -Force | Out-Null
    }
    if (Test-Path $DiagnosticPath) {
      $diagnosticFile = Get-Item -LiteralPath $DiagnosticPath
      if ($diagnosticFile.Length -ge $DiagnosticMaxBytes) {
        Move-Item -LiteralPath $DiagnosticPath -Destination $DiagnosticArchivePath -Force
      }
    }
    Add-Content -LiteralPath $DiagnosticPath `
      -Value (ConvertTo-Json $Record -Depth 8 -Compress) -Encoding UTF8
  } catch {
    # The protocol and safety decision are more important than diagnostics.
  }
}

# The fields every diagnostic line carries, so one operation can be followed
# across the host's stages without correlating on timestamps alone.
function New-DiagnosticRecord {
  # Not named $Event: that is a PowerShell automatic variable, and binding a
  # parameter over one is the kind of subtlety this host has already been bitten
  # by once.
  param([string] $Level, [string] $EventName, [string] $Stage)
  return [ordered]@{
    timestamp = (Get-Date).ToUniversalTime().ToString('o')
    level = $Level
    event = $EventName
    operation = $script:DiagnosticOperation
    operationId = $script:DiagnosticOperationId
    stage = $Stage
    submissionTouched = [bool]$script:SubmissionTouched
  }
}

<#
.SYNOPSIS
  Record something the host did, not only something that went wrong.

.DESCRIPTION
  A submission that printed but could not be confirmed used to leave no trace at
  all, which is the single hardest failure to diagnose after the fact. Fields are
  restricted to operational metadata — queue, spooler job identifier, job name,
  raw Windows status strings, counts and durations. Document paths, page content
  and customer filenames never reach this file.
#>
function Write-LocalEvent {
  param(
    [Parameter(Mandatory = $true)][string] $EventName,
    [ValidateSet('info', 'warn', 'error')][string] $Level = 'info',
    [hashtable] $Fields = @{},
    [string] $Stage = $script:DiagnosticStage
  )
  $record = New-DiagnosticRecord -Level $Level -EventName $EventName -Stage $Stage
  foreach ($key in $Fields.Keys) { $record[[string]$key] = $Fields[$key] }
  Add-DiagnosticRecord -Record $record
}

function Write-LocalDiagnostic {
  param(
    [Parameter(Mandatory = $true)][System.Management.Automation.ErrorRecord] $ErrorRecord,
    [string] $Stage = $script:DiagnosticStage
  )

  try {
    $exceptions = @()
    $current = $ErrorRecord.Exception
    while ($null -ne $current) {
      $message = ([string]$current.Message -replace '[\r\n]+', ' ').Trim()
      if ($message.Length -gt 512) { $message = $message.Substring(0, 512) }
      $exceptions += @{
        type = $current.GetType().FullName
        hresult = '0x{0}' -f $current.HResult.ToString('X8')
        message = $message
      }
      $current = $current.InnerException
    }

    $record = New-DiagnosticRecord -Level 'error' -Event 'exception' -Stage $Stage
    $record['errorId'] = [string]$ErrorRecord.FullyQualifiedErrorId
    $record['category'] = [string]$ErrorRecord.CategoryInfo.Category
    $record['exceptions'] = $exceptions
    Add-DiagnosticRecord -Record $record
  } catch {
    # The protocol and safety decision are more important than diagnostics.
  }
}

<#
.SYNOPSIS
  Read a property that an older state file may not carry.

.DESCRIPTION
  State files outlive the version of the host that wrote them, and this script
  runs under `Set-StrictMode -Version Latest`, where reading a property that does
  not exist is a terminating error. Every read of persisted state goes through
  here so adding a field cannot turn an in-flight operation into a DEVICE_ERROR.
#>
function Get-Field {
  param($Source, [Parameter(Mandatory = $true)][string] $Name, $Default = $null)
  if ($null -eq $Source) { return $Default }
  $property = $Source.PSObject.Properties[$Name]
  if ($null -eq $property -or $null -eq $property.Value) { return $Default }
  return $property.Value
}

function Set-Field {
  param($Target, [Parameter(Mandatory = $true)][string] $Name, $Value)
  if ($null -eq $Target.PSObject.Properties[$Name]) {
    Add-Member -InputObject $Target -MemberType NoteProperty -Name $Name -Value $Value -Force
  } else {
    $Target.$Name = $Value
  }
}

function Get-QueueOrFail {
  param([string] $QueueName, [bool] $RequireCertifiedUsb = $true)
  if ([string]::IsNullOrWhiteSpace($QueueName)) {
    Write-Failure -Code 'QUEUE_NOT_FOUND' -Ambiguous $false
  }
  $printer = Get-Printer -Name $QueueName -ErrorAction SilentlyContinue
  if ($null -eq $printer) { Write-Failure -Code 'QUEUE_NOT_FOUND' -Ambiguous $false }

  if ($RequireCertifiedUsb) {
    $isLocal = [string]$printer.Type -eq 'Local'
    $isUsb = [string]$printer.PortName -match '^USB\d+$'
    $isDriver = [string]$printer.DriverName -eq $SupportedDriverName
    if (-not $isLocal -or -not $isUsb -or [bool]$printer.Shared -or -not $isDriver) {
      Write-Failure -Code 'QUEUE_NOT_APPROVED' -Ambiguous $false
    }
  }
  return $printer
}

# Windows reports one status string that mixes three unrelated things: real
# faults, ordinary activity, and consumable warnings. Only the first two mean a
# customer cannot be served. Reading `Printing`, `WarmingUp` or `TonerLow` as an
# unusable printer is what made a healthy queue refuse paid work and made the
# warning codes below unreachable.
$QueueFaultPattern =
  'PaperJam|PaperOut|NoToner|DoorOpen|UserInterventionRequired|OutOfMemory|PaperProblem|ManualFeed|PagePunt|ServerUnknown|Error'
$QueueOfflinePattern = 'Offline|NotAvailable|PowerSave'
$QueuePausedPattern = 'Paused|PendingDeletion'
$QueueOperationalPattern =
  'Normal|Idle|Printing|Busy|IOActive|Processing|Waiting|Initializing|WarmingUp|TonerLow|PaperLow|OutputBinFull'

function ConvertTo-QueueState {
  param($Printer)
  # The status may carry several flags at once, so order is the classification:
  # a fault outranks whatever else the queue happens to be doing.
  $status = [string]$Printer.PrinterStatus
  if ($status -match $QueueFaultPattern) { return 'ERROR' }
  if ($status -match $QueueOfflinePattern) { return 'OFFLINE' }
  if ($status -match $QueuePausedPattern) { return 'PAUSED' }
  if ($status -match $QueueOperationalPattern) { return 'READY' }
  # A status this host has never seen is not a printer to sell a job on. It is
  # not logged here — this runs once per queue on every heartbeat — but both
  # callers that can refuse work over it record the raw status when they do, so
  # an unsupported device fails visibly rather than looking unplugged.
  return 'ERROR'
}

function Get-StatePath {
  param([string] $OperationId)
  if ($OperationId -notmatch '^[0-9a-fA-F-]{36}$') {
    Write-Failure -Code 'OPERATION_ID_INVALID' -Ambiguous $false
  }
  if (-not (Test-Path $StateDirectory)) {
    New-Item -ItemType Directory -Path $StateDirectory -Force | Out-Null
  }
  return Join-Path $StateDirectory ("{0}.json" -f $OperationId.ToLowerInvariant())
}

function Get-RenderPath {
  param([string] $OperationId)
  [void](Get-StatePath -OperationId $OperationId)
  if (-not (Test-Path $RenderDirectory)) {
    New-Item -ItemType Directory -Path $RenderDirectory -Force | Out-Null
  }
  return Join-Path $RenderDirectory $OperationId.ToLowerInvariant()
}

function Read-OperationState {
  param([string] $OperationId)
  $path = Get-StatePath -OperationId $OperationId
  if (-not (Test-Path $path)) { return $null }
  try { return Get-Content -Path $path -Raw | ConvertFrom-Json }
  catch {
    return [pscustomobject]@{ operationId = $OperationId; queue = ''; jobs = @() }
  }
}

# Written through a temporary file and renamed into place. This file is the only
# record that separates "already sent to a printer" from "never submitted", so a
# host killed mid-write must leave the previous record intact rather than a
# truncated one that reads as an operation with no jobs.
function Write-OperationState {
  param([string] $OperationId, $State)
  $path = Get-StatePath -OperationId $OperationId
  $temporaryPath = "$path.tmp"
  Set-Content -LiteralPath $temporaryPath -Value (ConvertTo-Json $State -Depth 8) -Encoding UTF8
  Move-Item -LiteralPath $temporaryPath -Destination $path -Force
}

function Get-SelectedPageNumbers {
  param($PageRanges, [int] $PageCount)
  if ($null -eq $PageRanges -or @($PageRanges).Count -eq 0) {
    Write-Failure -Code 'MANIFEST_INVALID' -Ambiguous $false
  }

  $pages = New-Object 'System.Collections.Generic.List[int]'
  $previous = 0
  foreach ($range in @($PageRanges)) {
    if ($null -eq $range -or @($range).Count -ne 2) {
      Write-Failure -Code 'MANIFEST_INVALID' -Ambiguous $false
    }
    $start = [int]$range[0]
    $end = [int]$range[1]
    if ($start -lt 1 -or $end -lt $start -or $end -gt $PageCount -or $start -le $previous) {
      Write-Failure -Code 'MANIFEST_INVALID' -Ambiguous $false
    }
    for ($page = $start; $page -le $end; $page++) {
      $pages.Add($page)
      if ($pages.Count -gt $MaximumSelectedPages) {
        Write-Failure -Code 'MANIFEST_INVALID' -Ambiguous $false
      }
    }
    $previous = $end
  }
  return $pages.ToArray()
}

function Render-PdfSelection {
  param([string] $Path, $PageRanges, [string] $TargetDirectory, [int] $Position)

  $script:DiagnosticStage = "submit.document.$Position.pdf-open"
  $fileOperation = [Windows.Storage.StorageFile]::GetFileFromPathAsync($Path)
  $file = Complete-WinRtOperation -Operation $fileOperation -ResultType ([Windows.Storage.StorageFile])
  $script:DiagnosticStage = "submit.document.$Position.pdf-load"
  $pdfOperation = [Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)
  $pdf = Complete-WinRtOperation -Operation $pdfOperation -ResultType ([Windows.Data.Pdf.PdfDocument])
  $script:DiagnosticStage = "submit.document.$Position.page-selection"
  $pageNumbers = @(Get-SelectedPageNumbers -PageRanges $PageRanges -PageCount ([int]$pdf.PageCount))
  $paths = @()

  for ($index = 0; $index -lt $pageNumbers.Count; $index++) {
    $script:DiagnosticStage = "submit.document.$Position.page.$index.open"
    $pageNumber = [int]$pageNumbers[$index]
    $page = $pdf.GetPage([uint32]($pageNumber - 1))
    $stream = [Windows.Storage.Streams.InMemoryRandomAccessStream]::new()
    $reader = $null
    try {
      $options = [Windows.Data.Pdf.PdfPageRenderOptions]::new()
      $width = [double]$page.Size.Width
      $height = [double]$page.Size.Height
      if ($width -ge $height) {
        $renderWidth = $RenderLongEdgePixels
        $renderHeight = [Math]::Max(1, [int][Math]::Round($RenderLongEdgePixels * $height / $width))
      } else {
        $renderHeight = $RenderLongEdgePixels
        $renderWidth = [Math]::Max(1, [int][Math]::Round($RenderLongEdgePixels * $width / $height))
      }
      $options.DestinationWidth = [uint32]$renderWidth
      $options.DestinationHeight = [uint32]$renderHeight

      $script:DiagnosticStage = "submit.document.$Position.page.$index.render"
      Complete-WinRtAction -Action ($page.RenderToStreamAsync($stream, $options))
      $stream.Seek(0)
      $script:DiagnosticStage = "submit.document.$Position.page.$index.read"
      $reader = [Windows.Storage.Streams.DataReader]::new($stream.GetInputStreamAt(0))
      [void](Complete-WinRtOperation -Operation ($reader.LoadAsync([uint32]$stream.Size)) -ResultType ([uint32]))
      $bytes = New-Object byte[] ([int]$stream.Size)
      $reader.ReadBytes($bytes)

      $outputPath = Join-Path $TargetDirectory ("{0:D3}-{1:D4}.png" -f $Position, $index)
      $script:DiagnosticStage = "submit.document.$Position.page.$index.write"
      [System.IO.File]::WriteAllBytes($outputPath, $bytes)
      $paths += $outputPath
    } finally {
      if ($null -ne $reader) { $reader.Dispose() }
      $stream.Dispose()
      $page.Dispose()
    }
  }

  return [pscustomobject]@{ paths = $paths; selectedPages = $pageNumbers.Count }
}

function Get-QueueConfiguration {
  param([string] $QueueName)
  return Get-PrintConfiguration -PrinterName $QueueName -ErrorAction SilentlyContinue
}

<#
.SYNOPSIS
  Whether the driver reports a duplex unit.

.DESCRIPTION
  Deliberately plain System.Drawing rather than the printing type: loading an
  assembly costs milliseconds, compiling one costs seconds, and this is asked on
  every heartbeat. It reads the same driver capability the printing path does.
#>
function Test-QueueDuplex {
  param([string] $QueueName)
  Add-Type -AssemblyName System.Drawing
  $settings = New-Object System.Drawing.Printing.PrinterSettings
  $settings.PrinterName = $QueueName
  return ([bool]$settings.IsValid -and [bool]$settings.CanDuplex)
}

function Test-A4MonochromeConfiguration {
  param($Configuration)
  return $null -ne $Configuration -and
    [string]$Configuration.PaperSize -eq 'A4' -and
    $Configuration.Color -eq $false
}

function Invoke-ListQueues {
  $queues = @()
  $default = (Get-CimInstance -ClassName Win32_Printer -Filter 'Default = TRUE' -ErrorAction SilentlyContinue).Name
  foreach ($printer in Get-Printer -ErrorAction SilentlyContinue) {
    $queues += @{
      queueName  = $printer.Name
      deviceUri  = $printer.PortName
      driverName = $printer.DriverName
      portName   = $printer.PortName
      state      = ConvertTo-QueueState -Printer $printer
      isDefault  = [bool]($printer.Name -eq $default)
      shared     = [bool]$printer.Shared
    }
  }
  Write-Result -Result $queues
}

<#
.SYNOPSIS
  The model of the printer that is physically attached, if it can be known.

.DESCRIPTION
  A driver name is not a printer. `Canon Generic Plus UFR II` drives most of a
  product line, so recording it as the make and model left the certification
  record unable to say which machine was certified.

  Windows does not hand a GDI print queue its device's model, so this asks the
  device tree instead. The kiosk profile is a single local USB printer, so one
  present printer device is unambiguous. More than one, or none, answers null —
  a certification record is worth nothing if it is a guess.
#>
function Get-PhysicalPrinterModel {
  try {
    $devices = @(
      Get-PnpDevice -Class 'Printer' -PresentOnly -ErrorAction SilentlyContinue |
        Where-Object {
          $_.Status -eq 'OK' -and -not [string]::IsNullOrWhiteSpace([string]$_.FriendlyName)
        }
    )
    if ($devices.Count -eq 1) { return [string]$devices[0].FriendlyName }
    Write-LocalEvent -EventName 'describe.model-ambiguous' -Level 'warn' -Fields @{
      candidates = $devices.Count
      friendlyNames = @($devices | ForEach-Object { [string]$_.FriendlyName })
    }
  } catch {
    Write-LocalDiagnostic -ErrorRecord $_
  }
  return $null
}

function Invoke-Describe {
  param([string] $QueueName)
  $printer = Get-QueueOrFail -QueueName $QueueName
  $driver = Get-PrinterDriver -Name $printer.DriverName -ErrorAction SilentlyContinue
  Write-Result -Result @{
    deviceId      = $printer.PortName
    makeAndModel  = Get-PhysicalPrinterModel
    driverName    = $printer.DriverName
    driverVersion = if ($null -ne $driver) { [string]$driver.DriverVersion } else { $null }
    # Windows does not expose device firmware for a GDI USB queue. It was
    # previously filled with the driver version, which made the two
    # indistinguishable in the certification record.
    firmware      = $null
  }
}

function Invoke-Capabilities {
  param([string] $QueueName)
  $printer = Get-QueueOrFail -QueueName $QueueName
  $configuration = Get-QueueConfiguration -QueueName $printer.Name
  $a4Ready = Test-A4MonochromeConfiguration -Configuration $configuration
  $duplex = Test-QueueDuplex -QueueName $printer.Name
  Write-Result -Result @{
    mediaSizes      = @(if ($a4Ready) { 'A4' })
    sides           = @(if ($duplex) { 'OneSided'; 'TwoSidedLongEdge' } else { 'OneSided' })
    colorModes      = @('Monochrome')
    maxCopies       = $MaximumCopies
    duplexSupported = $duplex
  }
}

function Invoke-Health {
  param([string] $QueueName)
  $printer = Get-QueueOrFail -QueueName $QueueName
  $state = ConvertTo-QueueState -Printer $printer
  $configuration = Get-QueueConfiguration -QueueName $printer.Name
  $configurationReady = Test-A4MonochromeConfiguration -Configuration $configuration
  if ($state -ne 'READY' -or -not $configurationReady) {
    # `OFFLINE` is the only health value the protocol has for "do not sell a job
    # on this", so an unplugged printer and a queue whose defaults were changed
    # arrive at the same answer. Record which one it was: they need different
    # fixes and the protocol cannot tell them apart.
    Write-LocalEvent -EventName 'health.unavailable' -Level 'warn' -Fields @{
      queueState = $state
      printerStatus = [string]$printer.PrinterStatus
      configurationReady = [bool]$configurationReady
    }
    Write-Result -Result @{ state = 'OFFLINE'; warningCode = $null }
    return
  }
  $warning = $null
  if ([string]$printer.PrinterStatus -match 'TonerLow') { $warning = 'TONER_LOW' }
  elseif ([string]$printer.PrinterStatus -match 'PaperLow') { $warning = 'PAPER_LOW' }
  elseif ([string]$printer.PrinterStatus -match 'OutputBinFull') { $warning = 'OUTPUT_TRAY_FULL' }
  Write-Result -Result @{
    state = if ($null -eq $warning) { 'READY' } else { 'WARNING' }
    warningCode = $warning
  }
}

function Get-RequestedWaitSeconds {
  param($Request)
  $requested = [int](Get-Field -Source $Request -Name 'waitSeconds' -Default $DefaultObserveSeconds)
  if ($requested -lt $MinimumObserveSeconds) { return $MinimumObserveSeconds }
  if ($requested -gt $MaximumObserveSeconds) { return $MaximumObserveSeconds }
  return $requested
}

function Invoke-Submit {
  param($Request)
  $script:DiagnosticStage = 'submit.queue'
  $waitSeconds = Get-RequestedWaitSeconds -Request $Request
  # The queue is resolved before anything else so the name handed to the spooler
  # below is one the operator certified, never one the request supplied.
  $printer = Get-QueueOrFail -QueueName $Request.queue
  Add-PhaseMark -Name 'queueResolved'

  $script:DiagnosticStage = 'submit.idempotency'
  # A submission is identified by its operation, and an operation is printed at
  # most once. A repeated call is answered from what the first one left behind,
  # never by drawing the pages again: the state file is written before the
  # spooler is touched, so its presence means work may already be at a printer.
  # `jobs = []` counts, because a host killed between StartDoc and the line that
  # records the job identifier leaves exactly that.
  $existing = Read-OperationState -OperationId $Request.operationId
  if ($null -ne $existing) {
    Write-LocalEvent -EventName 'submit.already-submitted' -Level 'warn' -Fields @{
      queue = $printer.Name
      knownJobs = @($existing.jobs).Count
    }
    Write-Result -Result (Get-OperationReport -OperationId $Request.operationId `
      -QueueName $printer.Name -WaitForCompletion $true -WaitSeconds $waitSeconds)
    return
  }

  $script:DiagnosticStage = 'submit.queue-state'
  $queueState = ConvertTo-QueueState -Printer $printer
  if ($queueState -ne 'READY') {
    Write-LocalEvent -EventName 'submit.queue-not-ready' -Level 'warn' -Fields @{
      queue = $printer.Name; queueState = $queueState
      printerStatus = [string]$printer.PrinterStatus
    }
    Write-Failure -Code 'PRINTER_OFFLINE' -Ambiguous $false
  }
  $script:DiagnosticStage = 'submit.configuration'
  $configuration = Get-QueueConfiguration $printer.Name
  if (-not (Test-A4MonochromeConfiguration -Configuration $configuration)) {
    # The protocol has one code for this and it says nothing about which of the
    # two causes it was. Somebody changed the queue's defaults, or the queue
    # could not be read at all, and those need opposite fixes.
    Write-LocalEvent -EventName 'submit.configuration-rejected' -Level 'warn' -Fields @{
      queue = $printer.Name
      configurationReadable = [bool]($null -ne $configuration)
      paperSize = if ($null -ne $configuration) { [string]$configuration.PaperSize } else { $null }
      color = if ($null -ne $configuration) { [bool]$configuration.Color } else { $null }
    }
    Write-Failure -Code 'DEVICE_ERROR' -Ambiguous $false
  }
  $script:DiagnosticStage = 'submit.manifest'
  if ([string]$Request.media -ne 'iso_a4_210x297mm' -or [string]$Request.colorMode -ne 'monochrome') {
    Write-Failure -Code 'MANIFEST_INVALID' -Ambiguous $false
  }
  if ($null -eq $Request.documents -or @($Request.documents).Count -lt 1 -or @($Request.documents).Count -gt 10) {
    Write-Failure -Code 'MANIFEST_INVALID' -Ambiguous $false
  }

  # Nothing above this point needs the PDF renderer or the printing type, and
  # everything above it can refuse the request. Paying for the compiler only
  # here keeps a rejected submission as cheap as a health check.
  $script:DiagnosticStage = 'submit.runtime'
  Initialize-PrintingRuntime

  $script:DiagnosticStage = 'submit.render-directory'
  $renderPath = Get-RenderPath -OperationId $Request.operationId
  if (Test-Path $renderPath) { Remove-Item -LiteralPath $renderPath -Recurse -Force }
  New-Item -ItemType Directory -Path $renderPath -Force | Out-Null

  $prepared = @()
  try {
    foreach ($document in @($Request.documents)) {
      $position = [int]$document.position
      $script:DiagnosticStage = "submit.document.$position.validation"
      $copies = [int]$document.copies
      $sides = [string]$document.sides
      if ($copies -lt 1 -or $copies -gt $MaximumCopies -or
          @('one-sided', 'two-sided-long-edge') -notcontains $sides) {
        Write-Failure -Code 'MANIFEST_INVALID' -Ambiguous $false
      }
      if (-not [System.IO.Path]::IsPathRooted([string]$document.path) -or
          -not (Test-Path -LiteralPath $document.path -PathType Leaf)) {
        Write-Failure -Code 'ARTIFACT_UNAVAILABLE' -Ambiguous $false
      }

      $script:DiagnosticStage = "submit.document.$position.render"
      $rendered = Render-PdfSelection -Path $document.path -PageRanges $document.pageRanges `
        -TargetDirectory $renderPath -Position $position
      $isDuplex = $sides -eq 'two-sided-long-edge'
      $blankSeparators = if ($isDuplex -and $rendered.selectedPages % 2 -eq 1) { $copies - 1 } else { 0 }
      $expectedPages = ($rendered.selectedPages * $copies) + $blankSeparators
      $expectedSheets = if ($isDuplex) {
        [int][Math]::Ceiling($rendered.selectedPages / 2.0) * $copies
      } else {
        $rendered.selectedPages * $copies
      }
      $prepared += [pscustomobject]@{
        document = $document
        paths = @($rendered.paths)
        copies = $copies
        duplex = $isDuplex
        selectedPages = $rendered.selectedPages
        expectedPages = $expectedPages
        expectedSheets = $expectedSheets
      }
    }
    Add-PhaseMark -Name 'rendered'

    $script:DiagnosticStage = 'submit.state.initialize'
    $state = [pscustomobject]@{
      operationId = $Request.operationId
      queue       = $printer.Name
      submittedAt = (Get-Date).ToUniversalTime().ToString('o')
      jobs        = @()
    }
    Write-OperationState -OperationId $Request.operationId -State $state

    $submitted = 0
    foreach ($item in $prepared) {
      $job = $null
      $position = [int]$item.document.position
      try {
        $script:DiagnosticStage = "submit.document.$position.start-doc"
        $job = [DriverRenderedPrintJob]::new(
          $printer.Name,
          [string]$item.document.jobName,
          [bool]$item.duplex
        )
        $script:SubmissionTouched = $true
        $submitted++
        Add-PhaseMark -Name "document.$position.startDoc"
        $script:DiagnosticStage = "submit.document.$position.persist-job"
        $entry = [pscustomobject]@{
          position       = [int]$item.document.position
          jobId          = $job.JobId
          jobName        = [string]$item.document.jobName
          expectedPages  = [int]$item.expectedPages
          expectedSheets = [int]$item.expectedSheets
          pagesPrinted   = 0
          completed      = $false
          # Whether this host ever saw this exact job alive in the queue. It is
          # the difference between a job that finished and one that never ran:
          # both are absent from the queue afterwards.
          observed       = $false
          faulted        = $false
          faultCode      = ''
          lastStatus     = ''
        }
        $state.jobs += $entry
        Write-OperationState -OperationId $Request.operationId -State $state

        # Look for the job now, while it certainly still exists. StartDoc has
        # returned, so the spooler owns it and the document is not finished, so
        # nothing can have deleted it yet. Once the pages are drawn and EndDoc
        # returns, a healthy spooler removes a completed job immediately, and a
        # job nobody ever saw cannot afterwards be told apart from one that was
        # never created — which is what made every successful print unconfirmable.
        $script:DiagnosticStage = "submit.document.$position.observe-job"
        if (Confirm-DeviceJob -QueueName $printer.Name -JobId $job.JobId `
            -JobName ([string]$item.document.jobName)) {
          $entry.observed = $true
          Write-OperationState -OperationId $Request.operationId -State $state
        } else {
          # Not fatal: the pages are still drawn and the operation still runs.
          # It only means this operation cannot end in a confirmed completion,
          # which is the honest answer when the evidence was never available.
          Write-LocalEvent -EventName 'submit.job-not-observed' -Level 'warn' -Fields @{
            queue = $printer.Name; jobId = $job.JobId; position = $position
          }
        }
        Add-PhaseMark -Name "document.$position.jobObserved"

        $script:DiagnosticStage = "submit.document.$position.draw-pages"
        for ($copy = 0; $copy -lt $item.copies; $copy++) {
          foreach ($path in $item.paths) { $job.PrintImage($path) }
          if ($item.duplex -and $item.selectedPages % 2 -eq 1 -and $copy -lt $item.copies - 1) {
            # Keep odd-length copies from sharing a duplex sheet.
            $job.PrintBlankPage()
          }
        }
        Add-PhaseMark -Name "document.$position.drawn"
        $script:DiagnosticStage = "submit.document.$position.end-doc"
        $job.Complete()
        Add-PhaseMark -Name "document.$position.endDoc"
        Write-LocalEvent -EventName 'submit.document-spooled' -Fields @{
          queue = $printer.Name; jobId = $job.JobId; position = $position
          expectedPages = [int]$item.expectedPages; expectedSheets = [int]$item.expectedSheets
        }
      } catch {
        Write-LocalDiagnostic -ErrorRecord $_
        Write-Failure -Code 'DEVICE_ERROR' -Ambiguous ($submitted -gt 0)
      } finally {
        if ($null -ne $job) { $job.Dispose() }
      }
    }

    $script:DiagnosticStage = 'submit.observe'
    Write-Result -Result (Get-OperationReport -OperationId $Request.operationId `
      -QueueName $printer.Name -WaitForCompletion $true -WaitSeconds $waitSeconds)
  } finally {
    Remove-Item -LiteralPath $renderPath -Recurse -Force -ErrorAction SilentlyContinue
  }
}

<#
.SYNOPSIS
  Prove that a job this host just created is really in the queue, and is ours.

.DESCRIPTION
  Called immediately after StartDoc, where the job is guaranteed to exist: the
  only thing being waited on is the spooler publishing it to Get-PrintJob. The
  document name is checked as well as the identifier, because a spooler restart
  renumbers jobs from one and an identifier alone would eventually name somebody
  else's work.
#>
function Confirm-DeviceJob {
  param([string] $QueueName, [int] $JobId, [string] $JobName)
  for ($attempt = 0; $attempt -lt $JobPresenceAttempts; $attempt++) {
    $current = Get-PrintJob -PrinterName $QueueName -ID $JobId -ErrorAction SilentlyContinue
    if ($null -ne $current -and
        [string](Get-Field -Source $current -Name 'DocumentName' -Default '') -eq $JobName) {
      return $true
    }
    Start-Sleep -Milliseconds $JobPresenceDelayMilliseconds
  }
  return $false
}

function Invoke-Status {
  param($Request)
  $printer = Get-QueueOrFail -QueueName $Request.queue
  Write-Result -Result (Get-OperationReport -OperationId $Request.operationId `
    -QueueName $printer.Name -WaitForCompletion $false)
}

function Invoke-Cancel {
  param($Request)
  $printer = Get-QueueOrFail -QueueName $Request.queue
  $state = Read-OperationState -OperationId $Request.operationId
  if ($null -eq $state) {
    Write-Result -Result @{
      state = 'NOT_SUBMITTED'; confidence = 'CONFIRMED'; failureCode = $null
      warningCode = $null; sheetsProduced = 0
    }
    return
  }

  # Recorded before the first removal, and durable. A job this host deleted
  # leaves the queue exactly the way a job that finished does, so without this
  # marker a cancellation would afterwards read as a clean completion.
  Set-Field -Target $state -Name 'cancelRequested' -Value $true
  Write-OperationState -OperationId $Request.operationId -State $state
  Write-LocalEvent -EventName 'operation.cancel-requested' -Level 'warn' -Fields @{
    queue = $printer.Name; knownJobs = @($state.jobs).Count
  }

  foreach ($job in @($state.jobs)) {
    Remove-PrintJob -PrinterName $printer.Name -ID $job.jobId -ErrorAction SilentlyContinue
  }
  Write-Result -Result (Get-OperationReport -OperationId $Request.operationId `
    -QueueName $printer.Name -WaitForCompletion $false)
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
    # A state write that was interrupted between the temporary file and the
    # rename leaves one of these behind. It is not an operation record, so it is
    # swept rather than counted.
    foreach ($file in Get-ChildItem -Path $StateDirectory -Filter '*.json.tmp' -File) {
      if ($file.LastWriteTimeUtc -lt $cutoff) { Remove-Item -LiteralPath $file.FullName -Force }
    }
  }
  if (Test-Path $RenderDirectory) {
    foreach ($directory in Get-ChildItem -Path $RenderDirectory -Directory) {
      if ($directory.LastWriteTimeUtc -lt $cutoff) {
        Remove-Item -LiteralPath $directory.FullName -Recurse -Force
      }
    }
  }

  # Diagnostics keep their own, longer age than an operation's output: they are
  # the fallback for an outcome that never reached the control plane, and that
  # is worth a couple of days. Bounded on both axes — two files of
  # $DiagnosticMaxBytes, none older than this — so an unattended kiosk cannot
  # accumulate a record of what it printed.
  $diagnosticCutoff = (Get-Date).ToUniversalTime().AddHours(-$DiagnosticMaxAgeHours)
  foreach ($path in @($DiagnosticPath, $DiagnosticArchivePath)) {
    if (-not (Test-Path -LiteralPath $path)) { continue }
    $file = Get-Item -LiteralPath $path -ErrorAction SilentlyContinue
    if ($null -ne $file -and $file.LastWriteTimeUtc -lt $diagnosticCutoff) {
      Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
    }
  }

  Write-Result -Result @{ discarded = $discarded }
}

<#
.SYNOPSIS
  What one job's evidence means. Pure: no spooler, no clock, no state file.

.DESCRIPTION
  The rule this encodes is that a Windows job leaving the queue is the ordinary
  shape of success — the spooler deletes a document the moment it finishes — but
  it is only evidence when this host watched that exact job while it was alive.
  A job nobody ever saw is indistinguishable from one that never existed, and a
  job somebody asked to remove is not a job that printed.

  It deliberately does not gate on `PagesPrinted`. Drivers report that counter
  inconsistently and some never move it off zero, so requiring it is what made
  every successful print unconfirmable. It is kept as positive evidence only:
  a job that moved pages cannot later be called a proven-zero failure.
#>
function Resolve-JobOutcome {
  param($Observation, [bool] $CancelRequested)

  if ([bool]$Observation.completed) { return @{ outcome = 'COMPLETED'; failureCode = $null } }
  if ([bool]$Observation.faulted) {
    $code = [string]$Observation.faultCode
    if ($code.Length -eq 0) { $code = 'DEVICE_ERROR' }
    return @{ outcome = 'FAULT'; failureCode = $code }
  }

  if (-not [bool]$Observation.present) {
    if ([bool]$Observation.observed -and -not $CancelRequested) {
      return @{ outcome = 'COMPLETED'; failureCode = $null }
    }
    # Gone, and this host has nothing that says it ever ran. Something may well
    # be in the customer's hand; nobody here can say what.
    return @{ outcome = 'LOST'; failureCode = $null }
  }

  $status = [string]$Observation.status
  if ($status -match 'PaperOut') { return @{ outcome = 'FAULT'; failureCode = 'OUT_OF_PAPER' } }
  if ($status -match 'Error|Blocked') { return @{ outcome = 'FAULT'; failureCode = 'DEVICE_ERROR' } }
  if ($status -match 'Deleted|Deleting') {
    return @{ outcome = 'FAULT'; failureCode = 'CANCELED_AT_DEVICE' }
  }
  if ($status -match 'Paused|Offline') {
    return @{ outcome = 'FAULT'; failureCode = 'PRINTER_OFFLINE' }
  }
  if ($status -match 'Printed|Completed') { return @{ outcome = 'COMPLETED'; failureCode = $null } }
  return @{ outcome = 'OPEN'; failureCode = $null }
}

<#
.SYNOPSIS
  Turn every job's evidence into one operation report. Pure, and the unit the
  behavioural tests in print-host.tests.ps1 drive directly.

.DESCRIPTION
  Only two shapes may claim certainty, and they are the two the agent's own
  clamp will accept: a completion where every job was accounted for, and a
  failure that proved no page moved anywhere. Anything with a job this host
  cannot account for stays unconfirmed and is settled by a person.
#>
function Resolve-OperationOutcome {
  param($Observations, [bool] $CancelRequested)

  $open = 0
  $lost = 0
  $knownSheets = 0
  $failureCode = $null
  $anyReportedPage = $false

  foreach ($observation in @($Observations)) {
    if ([int]$observation.pagesPrinted -gt 0) { $anyReportedPage = $true }
    $resolution = Resolve-JobOutcome -Observation $observation -CancelRequested $CancelRequested
    switch ($resolution.outcome) {
      'COMPLETED' { $knownSheets += [int]$observation.expectedSheets }
      'FAULT' { if ($null -eq $failureCode) { $failureCode = [string]$resolution.failureCode } }
      'OPEN' { $open++ }
      default { $lost++ }
    }
  }

  if ($null -ne $failureCode) {
    # Nothing came out only when every job is accounted for and none of them
    # moved paper. A sibling job still printing, or one nobody can account for,
    # both leave that claim unavailable.
    $provedZero = -not $anyReportedPage -and $knownSheets -eq 0 -and $lost -eq 0 -and $open -eq 0
    return @{
      state = if ($failureCode -eq 'CANCELED_AT_DEVICE') { 'CANCELED' } else { 'FAILED' }
      confidence = if ($provedZero) { 'CONFIRMED' } else { 'UNCONFIRMED' }
      failureCode = $failureCode
      warningCode = $null
      sheetsProduced = if ($provedZero) { 0 } else { $null }
      open = 0
    }
  }

  if ($open -gt 0) {
    return @{
      state = 'PRINTING'; confidence = 'UNCONFIRMED'; failureCode = $null
      warningCode = $null; sheetsProduced = $null; open = $open
    }
  }

  if ($lost -gt 0) {
    return @{
      state = 'COMPLETED'; confidence = 'UNCONFIRMED'; failureCode = $null
      warningCode = $null; sheetsProduced = $null; open = 0
    }
  }

  return @{
    state = 'COMPLETED'; confidence = 'CONFIRMED'; failureCode = $null
    warningCode = $null; sheetsProduced = $knownSheets; open = 0
  }
}

<#
.SYNOPSIS
  Read one job's current evidence from the spooler and persist what is durable.

.DESCRIPTION
  `observed`, `faulted` and `completed` are sticky: they record something this
  host saw at a moment that will not come back. A job seen printing and then
  gone is a completion; the same job, unobserved, is only an absence.
#>
function Update-JobObservation {
  param($Job, [string] $QueueName, [ref] $Changed)

  $jobName = [string](Get-Field -Source $Job -Name 'jobName' -Default '')
  $observation = [pscustomobject]@{
    position = [int](Get-Field -Source $Job -Name 'position' -Default 0)
    jobId = [int](Get-Field -Source $Job -Name 'jobId' -Default 0)
    jobName = $jobName
    expectedPages = [int](Get-Field -Source $Job -Name 'expectedPages' -Default 0)
    expectedSheets = [int](Get-Field -Source $Job -Name 'expectedSheets' -Default 0)
    pagesPrinted = [int](Get-Field -Source $Job -Name 'pagesPrinted' -Default 0)
    observed = [bool](Get-Field -Source $Job -Name 'observed' -Default $false)
    faulted = [bool](Get-Field -Source $Job -Name 'faulted' -Default $false)
    faultCode = [string](Get-Field -Source $Job -Name 'faultCode' -Default '')
    completed = [bool](Get-Field -Source $Job -Name 'completed' -Default $false)
    present = $false
    status = ''
  }
  # A job already resolved keeps its answer. Asking the spooler again could only
  # find a different job wearing a recycled identifier.
  if ($observation.completed -or $observation.faulted) { return $observation }

  $current = Get-PrintJob -PrinterName $QueueName -ID $observation.jobId -ErrorAction SilentlyContinue
  if ($null -ne $current) {
    # A spooler restart renumbers jobs from one, so an identifier alone does not
    # name this operation's work. The document name is what makes it ours.
    $documentName = [string](Get-Field -Source $current -Name 'DocumentName' -Default '')
    if ($documentName -ne $jobName) {
      Write-LocalEvent -EventName 'job.identity-mismatch' -Level 'warn' -Fields @{
        jobId = $observation.jobId; expectedJobName = $jobName
      }
      $current = $null
    }
  }

  if ($null -eq $current) { return $observation }

  $observation.present = $true
  $observation.status = [string](Get-Field -Source $current -Name 'JobStatus' -Default '')
  if (-not $observation.observed) {
    $observation.observed = $true
    Set-Field -Target $Job -Name 'observed' -Value $true
    $Changed.Value = $true
  }

  $pagesPrinted = [int](Get-Field -Source $current -Name 'PagesPrinted' -Default 0)
  if ($pagesPrinted -gt $observation.pagesPrinted) {
    $observation.pagesPrinted = $pagesPrinted
    Set-Field -Target $Job -Name 'pagesPrinted' -Value $pagesPrinted
    $Changed.Value = $true
  }
  if ([string](Get-Field -Source $Job -Name 'lastStatus' -Default '') -ne $observation.status) {
    Set-Field -Target $Job -Name 'lastStatus' -Value $observation.status
    $Changed.Value = $true
  }
  return $observation
}

function Get-OperationReport {
  param(
    [string] $OperationId,
    [string] $QueueName,
    [bool] $WaitForCompletion,
    [int] $WaitSeconds = $DefaultObserveSeconds
  )

  $state = Read-OperationState -OperationId $OperationId
  if ($null -eq $state -or @($state.jobs).Count -eq 0) {
    return @{
      state = 'NOT_SUBMITTED'; confidence = 'CONFIRMED'; failureCode = $null
      warningCode = $null; sheetsProduced = 0
    }
  }

  # A job this host removed on request cannot be read as one that retired
  # cleanly, however it looks from the queue afterwards.
  $cancelRequested = [bool](Get-Field -Source $state -Name 'cancelRequested' -Default $false)
  $deadline = (Get-Date).AddSeconds($WaitSeconds)
  $polls = 0

  while ($true) {
    $polls++
    $stateChanged = $false
    $observations = @()
    foreach ($job in @($state.jobs)) {
      $observation = Update-JobObservation -Job $job -QueueName $QueueName -Changed ([ref]$stateChanged)
      $resolution = Resolve-JobOutcome -Observation $observation -CancelRequested $cancelRequested
      # Persist the moment a job stops being open, so the answer survives a
      # restart and a later poll cannot reach a different conclusion.
      if ($resolution.outcome -eq 'COMPLETED' -and -not $observation.completed) {
        $observation.completed = $true
        Set-Field -Target $job -Name 'completed' -Value $true
        $stateChanged = $true
      } elseif ($resolution.outcome -eq 'FAULT' -and -not $observation.faulted) {
        $observation.faulted = $true
        $observation.faultCode = [string]$resolution.failureCode
        Set-Field -Target $job -Name 'faulted' -Value $true
        Set-Field -Target $job -Name 'faultCode' -Value $observation.faultCode
        $stateChanged = $true
      }
      $observations += $observation
    }
    if ($stateChanged) { Write-OperationState -OperationId $OperationId -State $state }

    $outcome = Resolve-OperationOutcome -Observations $observations -CancelRequested $cancelRequested
    # The evidence the decision was made from, and where the time went, travel
    # back with the answer. That is what lets the control plane explain an
    # outcome without anybody opening the kiosk — and it is why the local file
    # can stay small enough to be only a fallback.
    $jobEvidence = @(@($observations) | ForEach-Object {
      @{
        position = [int]$_.position
        jobId = [int]$_.jobId
        present = [bool]$_.present
        observed = [bool]$_.observed
        completed = [bool]$_.completed
        faulted = [bool]$_.faulted
        status = [string]$_.status
        pagesPrinted = [int]$_.pagesPrinted
        expectedPages = [int]$_.expectedPages
        expectedSheets = [int]$_.expectedSheets
      }
    })
    $report = @{
      state = $outcome.state
      confidence = $outcome.confidence
      failureCode = $outcome.failureCode
      warningCode = $outcome.warningCode
      sheetsProduced = $outcome.sheetsProduced
      diagnostics = @{
        queue = $QueueName
        pollCount = $polls
        processStartMs = $script:ProcessStartMilliseconds
        phaseMs = $script:PhaseMarks
        jobs = $jobEvidence
      }
    }

    if ([int]$outcome.open -eq 0 -or -not $WaitForCompletion -or (Get-Date) -ge $deadline) {
      Add-PhaseMark -Name 'reported'
      # One line per operation, never one per poll. The same evidence the
      # response carries is written locally as well, so an answer the agent
      # never received is still recoverable from the machine.
      Write-LocalEvent -EventName 'operation.report' -Fields @{
        reportState = [string]$report.state
        confidence = [string]$report.confidence
        failureCode = [string]$report.failureCode
        sheetsProduced = $report.sheetsProduced
        openJobs = [int]$outcome.open
        diagnostics = $report.diagnostics
      }
      return $report
    }
    Start-Sleep -Seconds 1
  }
}

# A library load stops here with every function defined and nothing performed.
if ($AsLibrary) { return }

try {
  $raw = [Console]::In.ReadToEnd()
  $request = $raw | ConvertFrom-Json
} catch {
  Write-Failure -Code 'DEVICE_ERROR' -Ambiguous $false
}

$operationProperty = $request.PSObject.Properties['op']
if ($null -ne $operationProperty) { $script:DiagnosticOperation = [string]$operationProperty.Value }
$operationIdProperty = $request.PSObject.Properties['operationId']
if ($null -ne $operationIdProperty -and [string]$operationIdProperty.Value -match '^[0-9a-fA-F-]{36}$') {
  $script:DiagnosticOperationId = ([string]$operationIdProperty.Value).ToLowerInvariant()
}
$script:DiagnosticStage = "$($script:DiagnosticOperation).dispatch"
Add-PhaseMark -Name 'requestRead'

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
  Write-LocalDiagnostic -ErrorRecord $_
  Write-Failure -Code 'DEVICE_ERROR' -Ambiguous (
    $request.op -eq 'submit' -and $script:SubmissionTouched
  )
}
