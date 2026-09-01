# Windows device host protocol

The agent is a Node process. Driving the Windows print subsystem is not
something a Node process can do honestly: enumerating queues, reading a driver's
PrintTicket, spooling bytes under an operating-system job identifier, and
reading that job's state back are all Win32 calls. Reaching them through a shell
`Print` verb would give up the one thing this phase exists to establish — a job
identifier that can still be asked about after a crash.

So the platform work lives in a small host program, and this document is the
whole of what crosses between them.

## Shape

One process invocation per request. The request is a single JSON document on
standard input; the answer is a single JSON document on standard output; the
process then exits with status `0`. Standard error is never parsed — a host may
write diagnostics there and nothing it says can change what the agent decides.

Process-per-request costs a few hundred milliseconds and buys two properties: a
host that wedges cannot wedge the agent, and the host holds nothing in memory
between calls, which forces it to persist the operation-to-job mapping that a
restart has to be resolved from.

```
{"protocol":1,"op":"health","queue":"Kiosk A4"}
→ {"ok":true,"result":{"state":"READY","warningCode":null}}
```

A refusal:

```
→ {"ok":false,"error":{"code":"PRINTER_OFFLINE","ambiguous":false}}
```

`ambiguous` says whether the submission this refers to may already have reached
the device. **It defaults to `true` on the agent's side.** A host that does not
say is assumed to have left work at a printer, because the alternative is a
duplicate print. Saying `false` is a claim, and it is only true when the host
knows nothing was sent.

A refusal may also carry `stage` — a fixed internal identifier naming where the
host gave up, such as `submit.document.0.render`. It reaches the control plane
with the failure, because `DEVICE_ERROR` alone cannot separate a busy queue from
a document that would not render. It is never a path, a filename, or anything a
customer supplied.

Error codes: `PRINTER_OFFLINE`, `OPERATION_ID_INVALID`, `MANIFEST_INVALID`,
`ARTIFACT_UNAVAILABLE`, `OUTPUT_WRITE_FAILED`, `SUBMISSION_UNCONFIRMED`,
`QUEUE_NOT_FOUND`, `QUEUE_NOT_APPROVED`, `DEVICE_UNREACHABLE`, `DEVICE_ERROR`.
Anything else the agent reads as `DEVICE_ERROR`.

## Operations

### `list-queues`

Every print queue the machine offers, not only the certified one — an operator
certifying a kiosk has to see what is installed on it.

```json
{ "protocol": 1, "op": "list-queues" }
```

Result: an array of
`{ queueName, deviceUri, driverName, portName, state, isDefault, shared }`.
`state` is `READY` | `PAUSED` | `OFFLINE` | `ERROR`. A state the agent does not
recognise becomes `ERROR`, and a queue that does not say whether it is `shared`
is treated as shared, so the approval policy has to be told explicitly to accept
it.

### `describe`

`{ deviceId, makeAndModel, driverName, driverVersion, firmware }`, each
nullable. This is the record a printer/driver combination is certified against,
and the four identity fields are deliberately distinct:

| Field | What it is |
| --- | --- |
| `makeAndModel` | The **physical printer**, from the device tree — e.g. `Canon LBP361/362` |
| `driverName` | The installed driver — e.g. `Canon Generic Plus UFR II` |
| `driverVersion` | That driver's version |
| `firmware` | The device's own firmware, `null` on Windows GDI queues |

The host previously reported the driver name as the make and model, and the
driver version as the firmware. Both were wrong in the same direction: one
driver serves most of a product line, so the certification record could not name
the machine an operator actually certified.

`makeAndModel` answers `null` when the device tree offers more than one present
printer, because a certification record is worth nothing if it is a guess.

### `capabilities`

What the driver says the queue can do, in the driver's own vocabulary:
`{ mediaSizes, sides, colorModes, maxCopies, duplexSupported }`. The agent maps
it — `A4` and `iso_a4_210x297mm` are one option, `TwoSidedLongEdge` and
`two-sided-long-edge` are one option — and offers nothing it does not recognise.

Orientation and scaling are not asked for. The document processor bakes both
into the print-ready PDF before a queue ever sees it.

### `health`

`{ state, warningCode }` where `state` is `READY` | `WARNING` | `OFFLINE`.
Anything else is read as `OFFLINE`, because a printer the agent cannot classify
is not one a customer may be sold a job on.

### `submit`

```json
{
  "protocol": 1,
  "op": "submit",
  "queue": "Kiosk A4",
  "operationId": "…uuid…",
  "media": "iso_a4_210x297mm",
  "colorMode": "monochrome",
  "documents": [
    {
      "position": 0,
      "path": "C:\\ProgramData\\PrintingKiosk\\spool\\…\\a1b2.pdf",
      "copies": 3,
      "pageRanges": [
        [1, 2],
        [5, 5]
      ],
      "sides": "two-sided-long-edge",
      "jobName": "…uuid…#000of002"
    }
  ],
  "waitSeconds": 240
}
```

Page ranges, copies and duplex are per document: one job may print selected
pages as three double-sided copies of the first document and one single-sided
copy of the next. Ranges are one-based, inclusive, ordered and non-overlapping.

`waitSeconds` is how long the host may watch the queue before answering
`PRINTING`. It is sent rather than assumed because the agent is the side that
knows when it will stop listening: a host still watching when the transport
timeout fires is killed mid-answer, and a submission killed mid-answer is
ambiguous rather than failed. The agent derives it from its own submission
timeout, leaving the rest of the budget for process start, type compilation,
rasterisation and drawing. The host clamps it to 5…1500 seconds and falls back
to 240 when it is absent.

**`submit` is idempotent per `operationId`.** A repeated call never draws the
pages again; it answers from the state the first call persisted. The state file
is written before the spooler is touched, so its presence means work may already
be at a printer — including when it names no jobs, because a host killed between
`StartDoc` and the line that records the identifier leaves exactly that.

`jobName` is the durable link between the operation and the spooler's own jobs.
It carries the operation identifier, the document's position, and how many
documents the operation has, so a bare queue listing is enough to tell a
complete operation from a partial one after a restart on either side. The host
must submit under exactly this name. It contains no customer filename — the
host never receives one — and the operation identifier is random, so nothing in
it is legible to somebody reading the printer's display.

The host must persist `operationId → [{position, jobId, jobName}]` **before**
the first byte reaches the spooler. A host killed on the next line still has to
leave evidence that something may have reached a printer.

Result: an operation report (below).

### `status` and `cancel`

`{ protocol, op, queue, operationId }`, both answering with an operation report.
`cancel` stops what it can and then reports what it found.

### `discard`

`{ protocol, op: "discard", before: "<ISO 8601>" }` → `{ discarded: <count> }`.
Drop the host's record of operations last touched before the cutoff. By age
rather than wholesale: nothing a live job owns is older than the job's own
deadline.

## The operation report

```json
{
  "state": "COMPLETED",
  "confidence": "CONFIRMED",
  "failureCode": null,
  "warningCode": null,
  "sheetsProduced": 6,
  "diagnostics": {
    "queue": "Kiosk A4",
    "pollCount": 1,
    "processStartMs": 812,
    "phaseMs": { "queueResolved": 40, "prepared": 120, "firstPageDrawn": 1400, "document.0.endDoc": 4200 },
    "jobs": [
      {
        "position": 0,
        "jobId": 20,
        "present": false,
        "observed": true,
        "completed": true,
        "faulted": false,
        "status": "",
        "pagesPrinted": 0,
        "expectedPages": 6,
        "expectedSheets": 6
      }
    ]
  }
}
```

`diagnostics` is **evidence, never a decision.** The state, the confidence and
the sheet count above are the whole outcome; nothing downstream reads this to
settle a job or a refund, so a device cannot move its own result by what it
claims to have seen. It exists so the control plane — not a file on the kiosk —
holds the spooler job identifier, the evidence a completion was confirmed from,
and where the host spent its time.

The agent re-types and caps every field before forwarding it (16 jobs, 40 phase
marks, bounded strings), and the control plane stores it in
`print_job_events.device_detail`: a column granted to the operator role on its
own terms, rather than in the free-form `detail` that no reader may see.

Everything in it is operational — identifiers the operating system assigned, the
raw status words it produced, counts and elapsed milliseconds. No path, no
filename, and nothing a customer supplied; the device side never receives any of
those.

`state` is one of `NOT_SUBMITTED`, `SUBMITTED`, `PRINTING`, `COMPLETED`,
`FAILED`, `CANCELED`, `UNKNOWN`. A report the agent cannot read a state from is
treated as unknown, not as a state.

Two rules the host does not get to bend:

1. **The spooler emptying its queue is not evidence about paper.** A host may
   report `confidence: "CONFIRMED"`, but the agent clamps it: a completion is
   only confirmed when a sheet count above zero came with it, and a failure or
   refusal is only confirmed when it proved no sheet was produced. Everything
   else becomes unconfirmed and is settled by a person.
2. **`NOT_SUBMITTED` is a claim about the spooler, not about the world.** When
   the agent's own journal says a submission started and the host answers
   `NOT_SUBMITTED`, the agent reports `UNKNOWN`. A purged job history and a job
   that never existed look identical from the queue, and only the journal
   separates them.

### What the host may call a confirmed completion

Software cannot prove a sheet physically left a printer, and the host does not
claim to. What it can attest is the strongest evidence Windows offers, and the
rule is deliberately narrow:

> A job is complete when this host **saw that exact job alive in the queue** and
> the job later left the queue without the spooler reporting a fault.

Both halves matter. Windows deletes a finished document from the queue
immediately, so "absent" is the ordinary shape of success — but it is also what
a job that never existed looks like, so absence alone proves nothing. The host
therefore looks for the job right after `StartDoc`, where it is guaranteed to
exist, and records that sighting durably. Identity is checked as well as
presence: a spooler restart renumbers jobs from one, so the job's `DocumentName`
must equal the `jobName` it was submitted under.

Anything else stays unconfirmed and reaches an operator:

| Situation | Result |
| --- | --- |
| Watched, then retired with no fault, printer healthy after | `COMPLETED` / `CONFIRMED`, sheets counted |
| Watched, then retired, but the printer faulted right after | `FAILED` / `UNCONFIRMED`, no sheet count |
| Still `Printed` in the queue | `COMPLETED` / `CONFIRMED`, sheets counted |
| Absent, never seen alive | `COMPLETED` / `UNCONFIRMED`, no sheet count |
| Absent after a `cancel` was requested | `COMPLETED` / `UNCONFIRMED`, no sheet count |
| A fault was recorded for it at any point | `FAILED` / `CANCELED`, sticky |
| Fault with no page counted anywhere | `FAILED` / `CONFIRMED`, zero sheets |
| A sibling document still open or unaccounted for | never confirmed |

The spooler's own `PagesPrinted` counter is **not** part of the rule. Drivers
report it inconsistently and some never move it off zero; gating on it made every
successful print unconfirmable. It is kept as positive evidence only — a job that
moved pages can never be called a proven-zero failure.

### The settle watch

A queue emptying proves the **data** reached the device, not that **paper** did.
A USB laser accepts a small job into its own memory in well under a second and
the spooler retires it immediately; the device then prints from that buffer, and
can run out of paper afterwards with nothing left in the queue to say so.

That is a real observed failure: a two-sheet operation whose spooler jobs both
retired cleanly, on a printer holding one sheet, reported `COMPLETED` /
`CONFIRMED` with `sheetsProduced: 2`.

That question is no longer asked here, because this host cannot answer it.

A three-second watch of `PrinterStatus` used to sit before every confirmed
completion, latching any fault it saw into the operation's state file. It never
saw one. Across every recorded run it returned `printerStatuses: ["Normal"]` —
identically on the two operations that printed short and on the ones that
printed in full — while costing every job three seconds to learn nothing. The
driver simply does not surface the print engine's state through that field.

The claim it was trying to check — that paper actually came out — is now checked
by the agent against `prtMarkerLifeCount`, the print engine's own page counter,
read over the printer's telemetry link either side of the operation. That is
evidence about paper rather than about a queue, and it enforces the same
downgrade-only rule: a counter short of what the job needed removes a success
claim, and a healthy counter grants nothing. See
[printer-telemetry-verification.md](printer-telemetry-verification.md).

What remains here is what this host can still see better than anything else: the
queue's own state, the identity and fate of each spooled job, and whether the
device accepted the work at all.

### Queue state

`PrinterStatus` mixes three unrelated things and the host classifies by
precedence: faults (`PaperJam`, `PaperOut`, `NoToner`, `DoorOpen`,
`UserInterventionRequired`, `OutOfMemory`, …) → `ERROR`; `Offline`,
`NotAvailable`, `PowerSave` → `OFFLINE`; `Paused`, `PendingDeletion` → `PAUSED`;
ordinary activity and consumable warnings (`Normal`, `Idle`, `Printing`, `Busy`,
`IOActive`, `Processing`, `Waiting`, `Initializing`, `WarmingUp`, `TonerLow`,
`PaperLow`, `OutputBinFull`) → `READY`. A status the host does not recognise is
`ERROR`, and both callers that can refuse work over it record the raw string.

A printer that is merely busy, warming up or low on toner is a printer that can
still be sold a job. Treating those as unusable refused paid work on healthy
hardware and made the warning codes unreachable.

## The reference host

`infrastructure/windows/print-host.ps1` implements this protocol with
`Get-Printer`, `Get-PrintJob`, `Windows.Data.Pdf` and a GDI printer device
context. Each selected PDF page is rendered locally and drawn through the installed
Canon UFR II driver as soon as it exists. `StartDoc` supplies the
operating-system job identifier before the first rendered page is drawn.

The reference profile refuses anything except a local, non-shared `USBnnn`
queue using `Canon Generic Plus UFR II`. The queue name is deployment data, so
another certified installation of the same printer may use `USB002` or a
different operator-chosen queue name.

### One source of truth for media and colour

The print path builds its own DEVMODE — A4, monochrome, portrait, explicit
duplex — and hands it to `CreateDC`, so it decides what comes out regardless of
what the queue's stored defaults say.

The host used to *also* read those defaults through `Get-PrintConfiguration` and
report `OFFLINE` unless they were A4 and monochrome. That check was wrong in
both directions: a stored default of A4 does not mean the driver offers A4, and
a perfectly good printer went offline whenever somebody opened printer
preferences or a driver update reset them — a kiosk that stops earning over a
setting that was never used.

What is checked now is **capability**: does the driver offer A4 at all
(`Test-QueueA4`), and does it have a duplex unit (`Test-QueueDuplex`). The
printing type asserts the same two again before any device context exists
(`A4_UNAVAILABLE`, `DUPLEX_UNAVAILABLE`), and those are reported as
`QUEUE_NOT_APPROVED` — definitely, since nothing reached the spooler — rather
than as a generic `DEVICE_ERROR`.

### Render resolution

Pages are rasterised to the printable area the driver reports for itself
(`GetDeviceCaps` `HORZRES`/`VERTRES`), which maps one rendered pixel to one
device pixel and leaves GDI nothing to rescale. It was previously fixed at A4
300 DPI, which upscaled on a 600 DPI device and wasted work on a coarser one.

It is clamped to 2480…4960 pixels on the long edge (roughly 212…424 DPI on A4)
because the cost is quadratic in that number: doubling it quadruples both the
rasterise and the draw, measured at ~1.4 s and ~2.4 s respectively at 3508 px on
the reference printer. A driver that will not describe its surface falls back to
3508. The measured values are recorded locally as `submit.surface`.

### Page at a time

A page is rasterised immediately before it is drawn, not with the rest of its
document beforehand. The printer therefore starts on page one while page two is
still being prepared, instead of waiting out the whole document in silence. At
~1.4 s to rasterise a page that is about a second on a two-page job and about
seven minutes on a two-hundred-sheet one; total job time is unchanged, because
the same pages are prepared either way, but nothing is idle while it happens.

What deliberately did **not** move past `StartDoc` is the part that can refuse
the submission. Opening each document, reading its page count and resolving the
requested ranges all happen first, for every document, before a spooler is
touched — so a manifest naming a page that does not exist, or a file that will
not open, is still a definite refusal with nothing submitted. Only the pixel
rendering of pages two onward now happens after a job exists, and a failure
there is reported as ambiguous, which the marker comparison then resolves.

That ordering is safe here because of what the kiosk actually prints. The
document processor has already rasterised every page with `pdftoppm` to build
the canonical PDF, so a page that cannot be rendered never reaches a kiosk, and
the agent verifies the file's SHA-256 before the first page is drawn.

One rendered page exists on disk at a time when a document prints once; a
document printing several copies keeps its pages for the copies that follow, so
the rasterising work is the same either way.

The driver name and the port pattern are **deployment configuration**, sent on
every request as `profiles`. Approving a second printer model is an operator
certification decision, like the queue allowlist, and it must not mean editing
this script on every kiosk:

```dotenv
PRINTER_DEVICE_PROFILES=[{"driverName":"Canon Generic Plus UFR II","portPattern":"^USB\\d+$"}]
```

Empty keeps the reference profile above, so a deployment that configures nothing
behaves exactly as it does today. Configuration that cannot be read is refused
at startup rather than defaulted — falling back to the reference printer would
print a paid job on a model nobody certified.

What is **not** configurable is the boundary itself: `Test-QueueApproved`
refuses a shared or non-local queue whatever a profile says. This host prints
over a cable to a machine standing beside it, and no configuration may open a
network path. A queue matching no profile fails the way it always has —
`QUEUE_NOT_APPROVED`, explicitly, never a crash and never a silent fall-back to
another queue.

### Finding a job when the state file is gone

`status` reads what this host wrote down. If that record is lost — a wiped state
directory, a disk that lost it, a process killed between `StartDoc` and the
write — it answers `NOT_SUBMITTED` for work that may be printing in plain sight,
and a healthy job settles into operator recovery.

The `find` operation is the second witness. Every job is created under a name
derived from its operation (`{operationId}#000of001`), so the queue itself
carries the link:

```json
{ "op": "find", "queue": "...", "operationId": "..." }
→ { "jobs": [{ "position": 0, "jobId": 23, "status": "Printing", "faulted": false }] }
```

The adapter asks only on that branch. A match that is not faulted means the work
is still open, so the caller keeps waiting instead of giving up on it.

**It cannot answer the opposite question.** Windows deletes a job the moment it
retires, so an empty queue looks identical whether the paper came out or the job
never existed. That reading stays `UNKNOWN`. This narrows the recovery cases; it
does not remove them, and `find` never reconstructs the lost state file — that
would mean inventing how many sheets were expected.

### Running the host's tests

The decisions above are covered by `infrastructure/windows/print-host.tests.ps1`,
which loads this script with `-AsLibrary` — defining its functions without
touching a device, a queue or standard input — and drives them directly.

```powershell
Install-Module Pester -Scope CurrentUser   # once
Invoke-Pester -Path infrastructure/windows/print-host.tests.ps1
```

`packages/printer-adapters` runs the same suite automatically when a PowerShell
interpreter and Pester are present, and reports loudly when it skipped them.

### Local diagnostics

Unexpected host exceptions remain `DEVICE_ERROR` on standard output; internal
exception details never cross the device protocol or enter the control-plane
ledger. The reference host writes a bounded JSON-lines diagnostic log for the
Windows account running the agent instead.

It records what the host *did*, not only what went wrong — a submission that
printed but could not be confirmed used to leave no trace at all, which is the
hardest failure to diagnose afterwards. Every line carries `timestamp`, `level`,
`event`, `operation`, `operationId`, `stage` and `submissionTouched`. The events:

| Event | When |
| --- | --- |
| `submit.already-submitted` | a repeated `submit` was answered without printing |
| `submit.queue-not-ready` | work refused over queue state, with the raw status |
| `submit.configuration-rejected` | refused over A4/monochrome, with what was read |
| `submit.job-not-observed` | `StartDoc` returned but the job never appeared |
| `submit.document-spooled` | `EndDoc` returned, with the spooler job identifier |
| `job.identity-mismatch` | a queue entry under our identifier is not our job |
| `operation.cancel-requested` | before the first `Remove-PrintJob` |
| `operation.report` | every answer, with each job's evidence |
| `health.unavailable` | why a queue was reported `OFFLINE` |
| `exception` | an unexpected failure, with a bounded exception chain |

Fields are restricted to operational metadata — queue name, spooler job
identifier, job name, raw Windows status strings, counts and durations. The log
never contains the request, document bytes, page content, customer filenames or
spool paths.

```text
%ProgramData%\PrintingKiosk\device-host\diagnostics\diagnostics.jsonl
```

It lives under the state tree, not in an account's profile, so the installer's
restrictive ACL covers it: a kiosk is a machine strangers stand in front of.

**It is a fallback, not the record.** An operation's own evidence now travels to
the control plane inside the protocol response (below), so this file exists for
what could not be reported — a host killed mid-request, or a machine that lost
power. It is bounded on both axes: 256 KiB rotated once to
`diagnostics.previous.jsonl`, and nothing older than 48 hours survives the
retention sweep. Logging is best-effort and can never change the protocol
response or the host's submission-confidence decision.

Read the newest entries locally with:

```powershell
Get-Content "$env:ProgramData\PrintingKiosk\device-host\diagnostics\diagnostics.jsonl" -Tail 20
```

Follow one operation across the host and the agent by its `operationId`, and
across the host and the Windows queue by the `jobId` in `submit.document-spooled`
— the same identifier the `PrintService` event log and the queue window show.
