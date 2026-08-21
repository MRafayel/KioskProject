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

## RESULT: 0c passed — the engine counter is real (20 Aug 2026)

Two `-Watch` runs at 1s, SNMPv1, direct cable to `192.168.253.2`.

**Run A — one page, printed successfully.**

| Time | `hrPrinterStatus` | `prtMarkerLifeCount` |
| --- | --- | --- |
| 19:47:37–39 | `other(1)` | 95 |
| 19:47:40 | `idle(3)` | 95 |
| 19:47:41–46 | **`printing(4)`** | 95 |
| 19:47:47 onward | `other(1)` | **96** |

**Run B — paper pulled, job sent, error, job cancelled.**

| Time | `prtInputCurrentLevel` | `hrPrinterDetectedErrorState` | `prtMarkerLifeCount` |
| --- | --- | --- | --- |
| 19:49:38–19:50:07 | `0 / -3` | (none) | 96 |
| 19:50:08 | `0 / 0` | (none) | 96 |
| 19:50:10–19:50:26 | `0 / 0` | **`lowPaper, noPaper`** | 96 |
| 19:50:27 onward | `0 / 0` | `lowPaper` | **96** |

| OID | Verdict | Evidence |
| --- | --- | --- |
| `prtMarkerLifeCount` | **PASS — decisive** | +1 on a 1-page job, at the same sample the engine left `printing(4)`. Unmoved across a whole failed job. The negative control is what makes it trustworthy. |
| `hrPrinterDetectedErrorState` | **PASS** | `noPaper` set 2s after the tray emptied, cleared on cancel. |
| `prtInputCurrentLevel` | **Presence only** | `-3` loaded, `0` empty. Never a sheet count. Gates "can we print at all", never "are there enough sheets". |
| `prtGeneralSerialNumber` | **PASS** | `PKQA002495`, stable. |
| SNMPv3 authPriv | **NOT YET TESTED** | Needs a real v3 client; the verification script is v1-only by design. Gates Phase 1. |

Three findings that shape the build:

**`other(1)` is this printer's resting state, not `idle(3)`.** Idle appears only
transiently around activity. A sleeping printer and a finished printer read
identically, so *leaving* `printing(4)` can never by itself mean "done" — it
would also fire if the engine paused mid-job. Only the counter reaching the
expected value may end the wait. Engine status is a hint for when to stop
waiting, never proof of delivery.

**The counter's unit is device-defined and still unpinned.** A 1-page simplex job
is +1 whether `prtMarkerCounterUnit` says impressions(7) or sheets(8). This
matters because duplex is a priced, first-class option here
([settings.ts:4](packages/contracts/src/settings.ts#L4)) — on a 10-page duplex
job the two readings differ by a factor of two, and expecting impressions from a
sheet-counting engine would downgrade a job that printed perfectly. No new
contract field is needed: `printDocumentSchema` already carries both
`printedSides` and `physicalSheets`, cross-validated
([print-jobs.ts:135-153](packages/contracts/src/print-jobs.ts#L135-L153)).
Read the unit, pick the matching total, and if the unit is unreadable skip the
delta check rather than guessing.

**The agent drops roughly one request in eight** — 7 of ~96 samples returned no
answer, in Run B on a near-regular ~7.5s cadence, each costing one timeout. So a
single silent poll must never read as a fault, and one retry after a short
backoff covers it. Poll in one batched GET rather than four round trips; the
observed loss may partly be self-inflicted by this script's 4 requests/second.

## 0d — measure the completion gap (no longer a gate)

Originally a stopwatch test to decide how urgent the confirmation change was.
0c makes it cheap instead: the counter timestamps every page as the engine marks
it, so the gap between `EndDoc` and the last increment is now *measured per job*
rather than estimated once. Collect it from telemetry during Phase 2 alongside
everything else.

The 50-page projection stands until then: retirement is flat at ~1.3s regardless
of page count, and Run A shows a 1-page job still marking paper ~6s after the
engine woke.

## What happens next

0c passed, so the staged build is unlocked: a telemetry client, then advisory
use (tray warnings, pre-payment refusal, real progress), then downgrade-only
confirmation from the engine page counter. Telemetry may never *raise*
confidence — only remove a success claim or refuse a job before payment — so the
worst case from a faulty or spoofed telemetry source is denial of service, never
a false success or a duplicate print.

Two things are still open and both belong to Phase 1:

- **SNMPv3 authPriv is unproven on this firmware.** Only a real v3 client can
  settle it, so it is proven by the Phase 1 client rather than by another
  verification script. If v3 turns out not to work here, stop and re-decide the
  security posture before any of this touches the print path.
- **The kiosk is presently on SNMPv1 with community `public`.** Acceptable on a
  point-to-point cable with no gateway for bench work; not shippable. The
  printer-side lockdown in the plan is not yet applied.
