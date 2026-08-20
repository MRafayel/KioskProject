# Phase 0 — is Ethernet/SNMP telemetry worth its attack surface?

Read-only evidence gathering. Nothing here changes a setting on the kiosk or the
printer. Run it before buying a network adapter: two cheaper explanations for
what we have observed are still open, and either would make the whole Ethernet
project unnecessary.

## Why

Two paid jobs were reported as confirmed successes while the printer was
physically out of paper:

| Date | Job | Loaded | Requested | Reported |
| --- | --- | --- | --- | --- |
| 19 Aug | `01a01aef` | 1 sheet | 2 | `COMPLETED`/`CONFIRMED`, `sheetsProduced: 2` |
| 20 Aug | `01a01e75` | 4 sheets | 5 | `COMPLETED`/`CONFIRMED`, `sheetsProduced: 5` |

The three-second settle window added after the first failure worked — it read
the printer about thirteen times (`settleMs: 3090`) — and returned
`printerStatuses: ["Normal"]`. The same answer came back on healthy jobs.
Windows also reported `"Normal"` while paper was visibly emerging, so
`PrinterStatus` does not appear to track the print engine at all on this driver.

Separately, spooler retirement is flat at ~1.3s whether the job is 1, 2 or 5
pages, which proves retirement measures the data handoff and not paper.

**But we have not proven Windows is blind — only that it was silent in a
three-second window.** That is what this phase settles.

## 0a + 0b — the USB checks (do these first)

Nothing needs to be plugged in or reconfigured.

1. Put the printer into a **real physical fault**: pull the paper tray out, or
   leave one sheet and send a two-page job so it stalls. Wait for the error
   light.
2. While it is still stalled:

```powershell
cd C:\path\to\PrintingKiosk\infrastructure\windows
Set-ExecutionPolicy -Scope Process Bypass -Force
.\verify-printer-telemetry.ps1 -Samples 10
```

Run it as the account the agent service uses, or as an administrator —
`diagnostics.jsonl` lives under an ACL'd path.

If anything looks wrong, check that the file parses before blaming the printer.
This reports syntax errors without executing a line:

```powershell
$e = $null
[void][System.Management.Automation.PSParser]::Tokenize(
  (Get-Content -Raw .\verify-printer-telemetry.ps1), [ref]$e)
$e   # empty output means the file is fine
```

### What the output decides

| Finding | Meaning |
| --- | --- |
| A `health.unavailable` line carrying `PaperOut` | **Windows does learn of the fault**, we just looked too early. A longer or later poll fixes this with no Ethernet. |
| `EnableBIDI = False` | The driver is not allowed to report status at all. Tick **Printer Properties → Ports → Enable bidirectional support**, then repeat this test. Free fix. |
| `DetectedErrorState = 4 (No Paper)` | The fault *is* in WMI, just not in the field the host reads. A small change to the existing settle window fixes it. |
| Every sample `Normal`, no fault events, bidi on | The USB path genuinely carries no physical status. Proceed to 0c. |

Any of the first three means **stop** — the cheap fix wins and the Ethernet work
is not justified.

## 0c — the MIB walk

Only if 0a and 0b came back empty. Needs a temporary direct cable.

1. Second NIC on the kiosk: static `192.168.253.1`, mask `255.255.255.252`, **no
   gateway, no DNS**.
2. Printer: static `192.168.253.2/30`, no gateway. Temporarily enable **SNMPv1**
   read-only with a throwaway community name.
3. Direct cable, no switch.

```powershell
.\verify-printer-snmp.ps1 -PrinterAddress 192.168.253.2 -Community <throwaway>
```

This is a **separate script** on purpose: the SNMP walk is the part that cannot
be tested away from the hardware, and it must not be able to stop 0a/0b from
running. It carries its own minimal SNMP client, so Net-SNMP does not need to be
installed. It sends GET-NEXT only and has no code path that can write a value.

### Go / no-go

| OID | Needed for | Pass condition |
| --- | --- | --- |
| `prtMarkerLifeCount` | **the decisive one** | present, and advances by the right number after a known job |
| `hrPrinterDetectedErrorState` | fault detection | byte 0 bit 1 (`noPaper`) sets when the tray is pulled |
| `prtInputCurrentLevel` | tray level | a real sheet count, not `-1`/`-2`/`-3` |
| `prtGeneralSerialNumber` | identity pinning | present and stable |

Read the error-state bitmask as: bit 0 `lowPaper`, 1 `noPaper`, 2 `lowToner`,
3 `noToner`, 4 `doorOpen`, 5 `jammed`.

**If the marker counter and the error state both fail, stop.** Without them
Ethernet buys diagnostics we cannot act on, at the cost of a second network
interface on an unattended public machine.

4. Also confirm **SNMPv3 with Authentication On/Encryption On** actually works on
   this firmware — nothing ships on SNMPv1, which sends its community name in
   plaintext.
5. Turn SNMPv1 back off when finished.

## 0d — measure the completion gap

Send a ten-page job and time it with a stopwatch: when paper starts, when it
stops. Compare against `document.0.endDoc` in the job's `device_detail`.

This settles whether the printer streams pages as they arrive or buffers the job
and prints afterwards — the difference between a ~2s and a ~50-75s gap on a
50-page job, and therefore how urgent the confirmation change is.

## What happens next

Passing 0c unlocks the staged build: a telemetry client, then advisory use
(tray warnings, pre-payment refusal, real progress), then downgrade-only
confirmation from the engine page counter. Telemetry may never *raise*
confidence — only remove a success claim or refuse a job before payment — so the
worst case from a faulty or spoofed telemetry source is denial of service, never
a false success or a duplicate print.
