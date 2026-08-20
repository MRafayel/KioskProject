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

## RESULT: 0a and 0b failed — the USB path is blind (20 Aug 2026)

Recorded here because it is the evidence the whole Ethernet decision rests on.

**Canon's own driver settles it.** Printer Properties → Device Settings →
retrieve device information returns:

> Could not retrieve the device information.
> **This device does not support information retrieval via USB connection.**

That is Canon's driver, on Canon's own channel, saying the hardware cannot do
it. Supporting evidence from `verify-printer-telemetry.ps1`:

| Check | Result |
| --- | --- |
| Bidirectional support | **On** — `EnableBIDI = True`, `Attributes = 0xa00` contains `ENABLE_BIDI` (0x800) |
| Port monitor | `Dynamic Print Monitor` on `USB001` |
| `diagnostics.jsonl` (30 KB) | **No** fault or `health.unavailable` events of any kind |
| `PrinterStatus` | `Normal` in every sample |
| `DetectedErrorState` | **`0 = Unknown`**, not `2 = No Error` |
| `ExtendedPrinterStatus` | `2 = Unknown` |
| `ExtendedDetectedErrorState` | `0` |

The distinction that matters: the driver does not report "the printer is fine",
it reports *nothing at all*. Every status field is Unknown.

So the three cheap outcomes that would have cancelled this project are all
closed: it is not a settle window that looked too early, not a disabled bidi
checkbox, and not a Windows API we failed to ask. **Proceed to 0c.**

## 0a + 0b — the USB checks (kept for reference and re-testing)

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

Only if 0a and 0b came back empty. A plain straight-through Ethernet cable is
fine: any gigabit port auto-negotiates the crossover, so no special cable is
needed for a direct PC-to-printer link.

**Keep USB connected throughout.** Printing continues over USB and does not
change. Ethernet carries telemetry only.

1. Cable straight from the PC's Ethernet port to the printer's. No switch, no
   router, nothing else on the segment.
2. **Printer** (control panel → Menu → Preferences → Network → TCP/IP Settings
   → IPv4 Settings): turn *Auto Acquire / DHCP* **off**, then set
   `192.168.253.2`, mask `255.255.255.0`, gateway blank. A `/24` is used for
   the test because some firmware rejects a `/30`; production tightens this.
3. **PC** adapter: static `192.168.253.1`, mask `255.255.255.0`, **gateway and
   DNS blank**. Set the network profile to **Public** and turn **Network
   Discovery off** — see the hazard below.
4. Confirm the link: `ping 192.168.253.2`
5. Printer SNMP: `Use SNMPv1` is **on by default** on this Canon family, so it
   most likely already works. Note the community name (default `public`).

### Hazard: a second printer queue

Once the printer is reachable over the network, Windows may auto-install a
*second* queue for the same physical device via WSD or mDNS. That queue would
fail `Test-QueueApproved` and could never print — but two queues matching the
allowlist make `selectApprovedQueue` return `AMBIGUOUS`, which withdraws
approval and **stops the kiosk printing at all**. Failure-safe, but an outage.

Turn Network Discovery off on that adapter before connecting, and check
afterwards:

```powershell
Get-Printer | Select-Object Name, Type, PortName, DriverName
```

Only the original `USB001` queue should be present. Remove any new one.

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
