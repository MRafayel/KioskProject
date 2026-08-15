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
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$StateDirectory = Join-Path $env:ProgramData 'PrintingKiosk\device-host'
$RenderDirectory = Join-Path $StateDirectory 'render'
$DiagnosticDirectory = Join-Path $env:LOCALAPPDATA 'PrintingKiosk\device-host'
$DiagnosticPath = Join-Path $DiagnosticDirectory 'diagnostics.jsonl'
$DiagnosticArchivePath = Join-Path $DiagnosticDirectory 'diagnostics.previous.jsonl'
$DiagnosticMaxBytes = 1MB
$SupportedDriverName = 'Canon Generic Plus UFR II'
$MaximumCopies = 10
$MaximumSelectedPages = 200
$RenderLongEdgePixels = 3508 # A4 at 300 DPI.
$script:SubmissionTouched = $false
$script:DiagnosticOperation = 'startup'
$script:DiagnosticOperationId = $null
$script:DiagnosticStage = 'startup'

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

    public static bool SupportsDuplex(string queueName)
    {
        PrinterSettings printer = new PrinterSettings();
        printer.PrinterName = queueName;
        return printer.IsValid && printer.CanDuplex;
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
  Write-Output (ConvertTo-Json @{ ok = $false; error = @{ code = $Code; ambiguous = $Ambiguous } } -Compress)
  exit 0
}

function Write-LocalDiagnostic {
  param(
    [Parameter(Mandatory = $true)][System.Management.Automation.ErrorRecord] $ErrorRecord,
    [string] $Stage = $script:DiagnosticStage
  )

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

    $record = [ordered]@{
      timestamp = (Get-Date).ToUniversalTime().ToString('o')
      operation = $script:DiagnosticOperation
      operationId = $script:DiagnosticOperationId
      stage = $Stage
      submissionTouched = [bool]$script:SubmissionTouched
      errorId = [string]$ErrorRecord.FullyQualifiedErrorId
      category = [string]$ErrorRecord.CategoryInfo.Category
      exceptions = $exceptions
    }
    Add-Content -LiteralPath $DiagnosticPath `
      -Value (ConvertTo-Json $record -Depth 8 -Compress) -Encoding UTF8
  } catch {
    # The protocol and safety decision are more important than diagnostics.
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

function ConvertTo-QueueState {
  param($Printer)
  $status = [string]$Printer.PrinterStatus
  if ($Printer.PrinterStatus -eq 'Normal' -or $status -eq 'Idle') { return 'READY' }
  if ($status -match 'Paused|Pending') { return 'PAUSED' }
  if ($status -match 'Offline|NotAvailable|PowerSave') { return 'OFFLINE' }
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

function Write-OperationState {
  param([string] $OperationId, $State)
  Set-Content -Path (Get-StatePath -OperationId $OperationId) `
    -Value (ConvertTo-Json $State -Depth 8) -Encoding UTF8
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
  $configuration = Get-QueueConfiguration -QueueName $printer.Name
  $a4Ready = Test-A4MonochromeConfiguration -Configuration $configuration
  $duplex = [DriverRenderedPrintJob]::SupportsDuplex($printer.Name)
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
  if ($state -ne 'READY' -or -not (Test-A4MonochromeConfiguration -Configuration $configuration)) {
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

function Invoke-Submit {
  param($Request)
  $script:DiagnosticStage = 'submit.queue'
  $printer = Get-QueueOrFail -QueueName $Request.queue
  if ((ConvertTo-QueueState -Printer $printer) -ne 'READY') {
    Write-Failure -Code 'PRINTER_OFFLINE' -Ambiguous $false
  }
  $script:DiagnosticStage = 'submit.configuration'
  if (-not (Test-A4MonochromeConfiguration -Configuration (Get-QueueConfiguration $printer.Name))) {
    Write-Failure -Code 'DEVICE_ERROR' -Ambiguous $false
  }
  $script:DiagnosticStage = 'submit.manifest'
  if ([string]$Request.media -ne 'iso_a4_210x297mm' -or [string]$Request.colorMode -ne 'monochrome') {
    Write-Failure -Code 'MANIFEST_INVALID' -Ambiguous $false
  }
  if ($null -eq $Request.documents -or @($Request.documents).Count -lt 1 -or @($Request.documents).Count -gt 10) {
    Write-Failure -Code 'MANIFEST_INVALID' -Ambiguous $false
  }

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
        $script:DiagnosticStage = "submit.document.$position.persist-job"
        $state.jobs += @{
          position       = [int]$item.document.position
          jobId          = $job.JobId
          jobName        = [string]$item.document.jobName
          expectedPages  = [int]$item.expectedPages
          expectedSheets = [int]$item.expectedSheets
          pagesPrinted   = 0
          completed      = $false
        }
        Write-OperationState -OperationId $Request.operationId -State $state

        $script:DiagnosticStage = "submit.document.$position.draw-pages"
        for ($copy = 0; $copy -lt $item.copies; $copy++) {
          foreach ($path in $item.paths) { $job.PrintImage($path) }
          if ($item.duplex -and $item.selectedPages % 2 -eq 1 -and $copy -lt $item.copies - 1) {
            # Keep odd-length copies from sharing a duplex sheet.
            $job.PrintBlankPage()
          }
        }
        $script:DiagnosticStage = "submit.document.$position.end-doc"
        $job.Complete()
      } catch {
        Write-LocalDiagnostic -ErrorRecord $_
        Write-Failure -Code 'DEVICE_ERROR' -Ambiguous ($submitted -gt 0)
      } finally {
        if ($null -ne $job) { $job.Dispose() }
      }
    }

    $script:DiagnosticStage = 'submit.observe'
    Write-Result -Result (Get-OperationReport -OperationId $Request.operationId `
      -QueueName $printer.Name -WaitForCompletion $true)
  } finally {
    Remove-Item -LiteralPath $renderPath -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Invoke-Status {
  param($Request)
  [void](Get-QueueOrFail -QueueName $Request.queue)
  Write-Result -Result (Get-OperationReport -OperationId $Request.operationId `
    -QueueName $Request.queue -WaitForCompletion $false)
}

function Invoke-Cancel {
  param($Request)
  [void](Get-QueueOrFail -QueueName $Request.queue)
  $state = Read-OperationState -OperationId $Request.operationId
  if ($null -eq $state) {
    Write-Result -Result @{
      state = 'NOT_SUBMITTED'; confidence = 'CONFIRMED'; failureCode = $null
      warningCode = $null; sheetsProduced = 0
    }
    return
  }
  foreach ($job in @($state.jobs)) {
    Remove-PrintJob -PrinterName $Request.queue -ID $job.jobId -ErrorAction SilentlyContinue
  }
  Write-Result -Result (Get-OperationReport -OperationId $Request.operationId `
    -QueueName $Request.queue -WaitForCompletion $false)
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
  if (Test-Path $RenderDirectory) {
    foreach ($directory in Get-ChildItem -Path $RenderDirectory -Directory) {
      if ($directory.LastWriteTimeUtc -lt $cutoff) {
        Remove-Item -LiteralPath $directory.FullName -Recurse -Force
      }
    }
  }
  Write-Result -Result @{ discarded = $discarded }
}

function Get-OperationReport {
  param([string] $OperationId, [string] $QueueName, [bool] $WaitForCompletion)

  $state = Read-OperationState -OperationId $OperationId
  if ($null -eq $state -or @($state.jobs).Count -eq 0) {
    return @{
      state = 'NOT_SUBMITTED'; confidence = 'CONFIRMED'; failureCode = $null
      warningCode = $null; sheetsProduced = 0
    }
  }

  $deadline = (Get-Date).AddMinutes(4)
  while ($true) {
    $open = 0
    $failed = $null
    $knownSheets = 0
    $allCompletedKnown = $true
    $anyReportedPage = $false
    $stateChanged = $false

    foreach ($job in @($state.jobs)) {
      $current = Get-PrintJob -PrinterName $QueueName -ID $job.jobId -ErrorAction SilentlyContinue
      if ($null -eq $current) {
        if ([bool]$job.completed -or [int]$job.pagesPrinted -ge [int]$job.expectedPages) {
          $knownSheets += [int]$job.expectedSheets
        } else {
          $allCompletedKnown = $false
        }
        continue
      }

      $status = [string]$current.JobStatus
      $pagesPrinted = if ($null -ne $current.PagesPrinted) { [int]$current.PagesPrinted } else { 0 }
      if ($pagesPrinted -gt [int]$job.pagesPrinted) {
        $job.pagesPrinted = $pagesPrinted
        $stateChanged = $true
      }
      if ([int]$job.pagesPrinted -gt 0) { $anyReportedPage = $true }

      if ($status -match 'PaperOut') { $failed = 'OUT_OF_PAPER' }
      elseif ($status -match 'Error|Blocked') { $failed = 'DEVICE_ERROR' }
      elseif ($status -match 'Deleted|Deleting') { $failed = 'CANCELED_AT_DEVICE' }
      elseif ($status -match 'Paused|Offline') { $failed = 'PRINTER_OFFLINE' }
      elseif ($status -match 'Printed|Completed') {
        if ([int]$job.pagesPrinted -ge [int]$job.expectedPages) {
          if (-not [bool]$job.completed) {
            $job.completed = $true
            $stateChanged = $true
          }
          $knownSheets += [int]$job.expectedSheets
        } else {
          $allCompletedKnown = $false
        }
      } else {
        $open++
        $allCompletedKnown = $false
      }
    }

    if ($stateChanged) { Write-OperationState -OperationId $OperationId -State $state }

    if ($null -ne $failed) {
      $provedZero = -not $anyReportedPage -and $knownSheets -eq 0
      return @{
        state = if ($failed -eq 'CANCELED_AT_DEVICE') { 'CANCELED' } else { 'FAILED' }
        confidence = if ($provedZero) { 'CONFIRMED' } else { 'UNCONFIRMED' }
        failureCode = $failed
        warningCode = $null
        sheetsProduced = if ($provedZero) { 0 } else { $null }
      }
    }
    if ($open -eq 0) {
      return @{
        state = 'COMPLETED'
        confidence = if ($allCompletedKnown) { 'CONFIRMED' } else { 'UNCONFIRMED' }
        failureCode = $null
        warningCode = $null
        sheetsProduced = if ($allCompletedKnown) { $knownSheets } else { $null }
      }
    }
    if (-not $WaitForCompletion -or (Get-Date) -ge $deadline) {
      return @{
        state = 'PRINTING'; confidence = 'UNCONFIRMED'; failureCode = $null
        warningCode = $null; sheetsProduced = $null
      }
    }
    Start-Sleep -Seconds 1
  }
}

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
