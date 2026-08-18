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

`{ deviceId, makeAndModel, driverName, firmware }`, each nullable. This is the
record a printer/driver/firmware combination is certified against.

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
  "confidence": "UNCONFIRMED",
  "failureCode": null,
  "warningCode": null,
  "sheetsProduced": 6
}
```

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
| Watched, then retired with no fault | `COMPLETED` / `CONFIRMED`, sheets counted |
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
`Get-Printer`, `Get-PrintConfiguration`, `Get-PrintJob`, `Windows.Data.Pdf` and
a GDI printer device context. The selected PDF pages are rendered locally, then
drawn through the installed Canon UFR II driver. `StartDoc` supplies the
operating-system job identifier before the first rendered page is drawn.

The reference profile refuses anything except a local, non-shared `USBnnn`
queue using `Canon Generic Plus UFR II`. It also refuses a queue whose current
defaults are not A4 and monochrome. The queue name is deployment data, so
another certified installation of the same printer may use `USB002` or a
different operator-chosen queue name.

The **driver name and the port pattern are still source-code constants**
(`$SupportedDriverName`, `'^USB\d+$'`). Approving a second printer model today
means editing this script, which is not where that decision belongs — it is
operator certification, like the queue allowlist. Moving both into a
configuration-driven profile is outstanding work. Until then, an unsupported
printer must still fail the way it does now: `QUEUE_NOT_APPROVED`, explicitly,
never a crash and never a silent fall-back to another queue.

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
%LOCALAPPDATA%\PrintingKiosk\device-host\diagnostics.jsonl
```

At 1 MiB the current file is rotated to `diagnostics.previous.jsonl`, so at most
two diagnostic files are retained. Logging is best-effort and can never change
the protocol response or the host's submission-confidence decision.

Read the newest entries locally with:

```powershell
Get-Content "$env:LOCALAPPDATA\PrintingKiosk\device-host\diagnostics.jsonl" -Tail 20
```

Follow one operation across the host and the agent by its `operationId`, and
across the host and the Windows queue by the `jobId` in `submit.document-spooled`
— the same identifier the `PrintService` event log and the queue window show.
