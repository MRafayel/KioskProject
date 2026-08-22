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

## 0e — prove SNMPv3 authPriv (the last gate)

`verify-printer-snmp.ps1` speaks SNMPv1 only, deliberately: a hand-rolled USM
implementation in PowerShell would have been a great deal of untested
cryptography. So the authenticated, encrypted mode we intend to ship is proven
by the client that will ship it — `packages/printer-telemetry`.

**Printer first** (Remote UI → Settings → Network → SNMP Settings):

1. `Use SNMPv3` **on**. Add one user, `Enable User` on.
2. `MIB Access Permission` → **Read Only**. This is the one that matters: a
   stolen credential can then change nothing.
3. `Security Settings` → **Authentication On / Encryption On**. Set two
   *different* passphrases, each at least 8 characters.
4. Note which algorithms the firmware actually offers. Canon of this generation
   often lists less than the manual implies.
5. Leave SNMPv1 on **for now** — turn it off only once v3 is proven working, or
   you will have no way back in over the network.

**Then, from the repository:**

```powershell
$env:PRINTER_TELEMETRY_SNMP_AUTH_KEY = "<auth passphrase>"
$env:PRINTER_TELEMETRY_SNMP_PRIV_KEY = "<privacy passphrase>"
pnpm --filter @printing-kiosk/printer-telemetry probe -- `
  --host 192.168.253.2 --user <snmpv3 user> --serial PKQA002495
```

Keys come from the environment, never from arguments — a command line is visible
to every process on the machine and lands in shell history. Nothing the probe
prints contains a key.

If it reports a timeout, the message lists what to check and in what order. The
most likely cause is an algorithm mismatch, so try the pairs the printer offers
before concluding the firmware cannot do it:

```powershell
# ... --auth sha --priv des        # the common Canon fallback
# ... --auth sha256 --priv aes     # the default, and what to prefer
```

Add `--watch 90` once a single read works, then send a job of known length: the
same measurement as before, now over the channel that will ship.

**Go:** a snapshot with a serial and a marker count. **No-go:** no algorithm pair
authenticates — stop and re-decide the security posture before building further,
because the fallback is SNMPv1 in clear text and that is a different decision.

### RESULT: 0e passed — SNMPv3 authPriv works (21 Aug 2026)

`SHA2-256` / `AES-128`, MIB access Read Only. Phase 0 is complete.

| Signal | Over SNMPv3 |
| --- | --- |
| Identity | `PKQA002495`, matched the pin |
| `marker` | 112, unit **IMPRESSIONS** — confirming the duplex finding |
| Faults | `LOW_PAPER`/`NO_PAPER` set and cleared exactly as over v1 |
| Supplies | three consumables at 99/100/100% |

Two 90-second watches repeated the Phase 0 experiments over the shipping
channel and reproduced them exactly:

- **No paper**: `LOW_PAPER` throughout, `NO_PAPER` asserting for the 21 seconds
  the job was blocked, and the counter **unmoved at 112** across the whole failed
  job. The negative control holds over v3.
- **One sheet, one page**: 112 → 113 at 20:30:11, *while the engine was still
  `PRINTING`* and two seconds before it returned to `IDLE`. The counter leads the
  engine state, so it is the better completion signal of the two.

Two new observations:

**`IDLE` and `OTHER` are awake and asleep.** Over v1 the resting state read
`other(1)`; under a 1-second poll it reads `idle(3)`, and the single read taken
before the watch began read `OTHER`. The polling is keeping the printer awake.
Neither state means "finished" — only the counter does — but at the Phase 2 poll
interval the printer will sleep between reads and `OTHER` will be normal again.

**Retries are absorbing the drop rate.** No reading failed, but the timestamps
skip a second roughly every eighth row. That is a dropped request being retried
inside the budget and succeeding — the ~1-in-8 loss measured over v1 is still
there, and it is no longer visible to a caller.

## Is `hrPrinterStatus = other(1)` a fault? — tested, and no

Worth recording because the correlation is real and the conclusion is still no.

The hypothesis came from a genuine observation: with no paper, the printer beeped,
blinked its Error lamp, went `IDLE` → `OTHER`, and returned to `IDLE` the moment
the job was cancelled. In that run `OTHER` tracked the fault exactly.

Checked against every recorded run, it is neither necessary nor sufficient:

| Run | Engine | Faults | Outcome |
| --- | --- | --- | --- |
| 19:47:47–19:48:37 | `OTHER` for 50s | none | job **succeeded** |
| 11:58:52–11:59:06 | `OTHER` for 14s | none | before any job |
| 19:49:41–19:50:07 | `OTHER` for 26s | none | before any job |
| 12:04:43–12:05:42 | `OTHER` for 60s | `lowPaper` | job **succeeded** |
| 20:28:08–23 | **`IDLE`** | `LOW_PAPER` | fault present, engine idle |
| 20:30:13–37 | **`IDLE`** for 24s | `LOW_PAPER` | after a successful job |
| 20:28:24–45 | `OTHER` | `LOW_PAPER, NO_PAPER` | job blocked |

`OTHER` appears with no fault at all, faults appear while the engine reads
`IDLE`, and `OTHER` appears with a fault on jobs that printed perfectly. In the
one run where it did coincide with a blocked job, it was **co-timed to the same
sample** as `noPaper` asserting *and* clearing — so it carried nothing that bit
had not already said.

Treating `OTHER` as a fault would have marked at least two successful prints as
faulted. It is RFC 2790's "none of the above", covering at least sleep and
blocked-job on this device, and it is not consulted for any decision.

## Still open

- **The kiosk is still on SNMPv1 with community `public` as well.** Turn v1 off
  now that v3 is proven. The printer-side lockdown in the plan is not yet applied.
- **Nothing in the product gates on printer health.** `health` is stored, shown
  in the admin Kiosks panel, and sets `queueState`/`lastHealthyAt` — but no
  session, quote, payment or print path reads it. Phase 2 makes physical state
  *visible* and *reportable*; the refusal-before-payment described in the plan
  needs a gate that does not exist yet and is a change to the customer path.
- **The progress UI still runs on a timer.** Feeding it real marker counts needs
  the counter to reach the browser, which is a new API surface.

## RESULT: the gate did not fire on an empty tray (22 Aug 2026)

The first live test of the readiness gate: tray physically empty, printer panel
showing **No Paper**, SNMPv3 confirmed working by the probe. **Start Printing
still opened a session, and the print still reported success.**

The gate was not bypassed. It ran, and it passed, because the value it reads was
wrong:

```
 queue_name          | approval | health | warning_code | age
 CanonLBP361_UFR_II  | APPROVED | READY  |              | 00:19:35
```

`READY`, with no paper in the machine. Approval was intact, the row was fresh
when the session was created, idempotency was not involved, and the "no printer
rows" exception was not taken — rows existed and one was approved.

### Cause

`PRINTER_TELEMETRY_ENABLED` was never set on the kiosk, and it defaults to
`false`. `createPrinterTelemetrySource` then returns a stub whose verdict is
`DISABLED`, `applyPrinterTelemetry` returns the reading unchanged, and the
reported health is whatever the Windows driver says — which is `Normal` with an
empty tray, exactly as 0a and 0b established. Every layer above behaved
correctly on a value that had never been near the printer.

The SNMPv3 credentials from 0e were set as `$env:` variables in the PowerShell
session used to run the probe. They were never in the agent's environment file,
and the 15 `PRINTER_TELEMETRY_*` keys had not been added to `.env.example`, so
there was no template to configure them from.

### Why nothing showed it

A kiosk with telemetry off produced **no log line of any kind** distinguishing it
from a kiosk whose telemetry was working. The disabled branch returned silently
and the gate decided silently. That is now closed at both ends:

- the agent logs `printer telemetry is off; printer health is driver-reported
  only` at `warn` on start, or `printer telemetry polling` with host, port, poll
  interval and `required` when it is on — never the keys, user or serial;
- the API logs every gate decision — `debug` on pass, `warn` on refusal — with
  the approval, health, warning code, reading age and silence budget behind it.

### Not a cause: the print reporting success

Separate and expected at this phase. Confirmation still comes from spooler
retirement, which measures the data handoff and not paper, so a job submitted to
an empty printer retires in ~1.3 s and settles `CONFIRMED`. Only Phase 3 —
downgrade-only confirmation from `prtMarkerLifeCount` — changes that, and it is
not built. Telemetry at Phase 2 gates the *next* customer; it never revisits a
job that was already submitted.

## Phase 3 — the engine's counter decides, in one direction (22 Aug 2026)

`prtMarkerLifeCount` is now read either side of every operation that claims a
success, and a counter short of what the job needed withdraws that claim.

**Unit.** `prtMarkerCounterUnit` decides which of the job's two counts applies:
`impressions(7)` → `printedSides`, `sheets(8)` → `physicalSheets`, anything else
→ no comparison. The certified Canon reports impressions, proved by the duplex
run of 21 Aug — `97 → 98 → 99` for a two-page duplex job that pulled a single
sheet, with the tray level moving once. Reading the wrong column would be
*quietly* wrong: on simplex the two counts are equal and every test passes, and
the error would first appear as a healthy duplex job sent to recovery.

**Waiting.** The comparison cannot be made when the print host returns, because
retirement measures the data hand-off — flat at ~1.3 s for 1, 2 and 5 pages. The
counter is followed at 3 s intervals until it reaches the expected figure, until
it sits still for three consecutive readings, or until the job's own deadline.
An explicit fault (`noPaper`, jam, door, toner, output full) ends the wait early,
but never decides the outcome on its own — this printer asserts `noPaper` on the
last sheet of jobs that printed in full.

**What each outcome does.**

| Counter | Verdict | Effect |
|---|---|---|
| moved < expected, engine stopped | `SHORTFALL` | `confidence: UNCONFIRMED`, `sheetsProduced: null` → `RECOVERY_REQUIRED`, no refund owed |
| moved ≥ expected | `SUFFICIENT` | **nothing** — recorded, never promoted |
| no reading, no baseline, unit unknown or changed, counter regressed, still advancing at deadline | `UNKNOWN` | **nothing** — the host's answer stands |

There is deliberately no branch that raises confidence, sets `COMPLETED`, or
fills in a sheet count. A device that lies, is impersonated, or simply resets its
counter can cause unnecessary operator recovery and can never manufacture a
success.

**Residual risk, accepted:** the counter is device-global, so a foreign job
printing concurrently inflates the delta and could mask a shortfall. On a
USB-only kiosk with every network print protocol disabled there is no path for
one, and guarding against it would mean attributing marks to jobs, which the MIB
does not support.

## RESULT: paper removed before payment still sold (22 Aug 2026)

Healthy session started, all paper removed on the way to checkout, payment
allowed. Not a fault in the health logic — a propagation delay.

`printers.last_seen_at` refreshes on every heartbeat whether or not the printer
answered, so it measures *agent* liveness and cannot tell a one-second-old SNMP
reading from a one-minute-old one. The gate had no way to know the reading it
trusted predated the customer. The window was the sum of two independent timers:
up to `PRINTER_TELEMETRY_POLL_SECONDS` to notice, then up to
`AGENT_HEARTBEAT_SECONDS` to say so — 60 s on the defaults.

**Closed in two parts.** `telemetry_at` now records when SNMP was actually read
and travels on every heartbeat; and the agent brings its next beat forward the
moment a reading changes anything the health fold decides on. Faults and tray
presence trigger a beat; the marker counter and engine state do not, or a
fifty-page job would send a beat per page.

The payment gate is `strict` and refuses `PRINTER_TELEMETRY_STALE` past
`PRINTER_TELEMETRY_MAX_AGE_SECONDS`; session start is not, because refusing a
customer at the welcome screen over a poll that is merely due costs a print and
prevents nothing. Startup refuses a ceiling below poll + heartbeat, since that
configuration makes healthy kiosks refuse payments on a schedule.

**The residual window is one SNMP poll**, and that is a floor, not an oversight:
nothing can know a tray is empty sooner than it looks. Lowering
`PRINTER_TELEMETRY_POLL_SECONDS` is the direct knob. SNMP traps would remove it
entirely and are rejected — they need an inbound listener on NIC2, which the
threat model forbids.
