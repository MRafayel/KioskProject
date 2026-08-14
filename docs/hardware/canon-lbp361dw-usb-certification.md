# Canon LBP361dw USB certification

This is the physical acceptance checklist for the supported printer profile:

- Canon i-SENSYS LBP361dw
- Canon Generic Plus UFR II V3.40
- Windows 10 x64 during development; Windows 11 x64 before production
- local USB cable only
- Drawer 1: A4, 80 gsm
- monochrome
- simplex or two-sided long-edge
- automatic orientation, fit to A4
- 1–10 copies

Passing a Windows test page is a prerequisite, not certification of the product
path. The product test must start at session creation and finish at the output
tray.

## Machine configuration

Keep the queue name configurable. The example uses the name already installed
on the development PC; another kiosk may use another name or `USB002`.

```dotenv
PRINTER_ADAPTER=windows
PRINTER_QUEUE_ALLOWLIST=CanonLBP361_UFR_II
PRINTER_QUEUE_NAME=CanonLBP361_UFR_II
PRINTER_ALLOW_SHARED_QUEUE=false
PRINTER_WINDOWS_HOST_PATH=C:\PrintingKiosk\infrastructure\windows\print-host.ps1
MAX_COPIES=10
```

The host refuses the queue unless all of these are true:

- `Type` is `Local`
- `PortName` matches `USB` followed by its Windows number
- `Shared` is `False`
- `DriverName` is `Canon Generic Plus UFR II`
- the queue defaults report A4 and monochrome

Check the baseline:

```powershell
Get-Printer -Name "CanonLBP361_UFR_II" |
  Format-List Name, DriverName, PortName, Shared, Type, PrinterStatus

Get-PrintConfiguration -PrinterName "CanonLBP361_UFR_II" |
  Select-Object DuplexingMode, PaperSize, Collate, Color
```

Expected: local `USBnnn`, not shared, normal, A4 and `Color=False`.

## Host smoke test

Run these from Windows PowerShell. They exercise discovery and policy without
printing paper:

```powershell
$hostPath = "C:\PrintingKiosk\infrastructure\windows\print-host.ps1"

'{"protocol":1,"op":"list-queues"}' |
  powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $hostPath

'{"protocol":1,"op":"capabilities","queue":"CanonLBP361_UFR_II"}' |
  powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $hostPath

'{"protocol":1,"op":"health","queue":"CanonLBP361_UFR_II"}' |
  powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $hostPath
```

Capabilities must contain only A4, monochrome, one-sided, long-edge duplex and
10 copies. Health must be `READY` before a paid session is offered printing.

## Full product test

Use synthetic documents with visible page numbers and no personal data.

1. Start the API, worker, kiosk agent, kiosk UI and mock payment provider with
   the Windows printer configuration above.
   If the admin reader role already exists, rerun
   `pnpm db:admin-reader provision` once so it may read the new non-secret
   printer and agent health columns.
2. Open a session, scan its QR code, upload the numbered PDF and wait for every
   preview to become ready.
3. Select a strict subset such as pages 2–3. Choose one copy and simplex.
4. Complete mock payment and start printing.
5. Confirm only pages 2 and 3 leave Drawer 1, on A4, in monochrome.
6. Confirm the admin Kiosks screen shows the agent online and the approved queue
   ready on a `USBnnn` port with the Canon UFR II driver.
7. Confirm the Printing screen shows the job, expected sheets and the device's
   confidence. If the spooler cannot prove physical output, resolve it as an
   operator after checking the tray; do not resubmit it.

Then run this matrix:

| Test                                       | Expected physical result                                    |
| ------------------------------------------ | ----------------------------------------------------------- |
| One page, simplex                          | One A4 sheet                                                |
| Four pages, long-edge duplex               | Two A4 sheets, book binding                                 |
| Three pages × two copies, long-edge duplex | Four sheets; copy 2 never starts on copy 1's last back side |
| Pages 2–3 of a five-page PDF               | Exactly those two pages                                     |
| Portrait and landscape source pages        | Automatically fitted and readable, with nothing clipped     |
| Ten copies of a one-page PDF               | Ten sheets                                                  |
| Attempt eleven copies                      | Refused before payment                                      |

## Failure and restart checks

Run each with a new synthetic session:

| Fault                             | Required result                                           |
| --------------------------------- | --------------------------------------------------------- |
| USB unplugged before payment      | Printer unavailable; no paid submission                   |
| Queue paused before submission    | Definite refusal; nothing printed                         |
| Paper removed before submission   | Refusal or failed job with zero sheets                    |
| Paper removed mid-job             | Unconfirmed result; operator decision, no automatic retry |
| USB unplugged mid-job             | Unconfirmed result; operator decision, no automatic retry |
| Agent restarted mid-job           | Existing operation is resolved, never submitted again     |
| Windows spooler restarted mid-job | Existing operation is resolved, never submitted again     |

Repeat the complete matrix on Windows 11 x64 before deploying the production
machine. Record Windows version, driver version, printer serial/asset identity,
firmware version, date and operator with the results.
