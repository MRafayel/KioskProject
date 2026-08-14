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
  ]
}
```

Page ranges, copies and duplex are per document: one job may print selected
pages as three double-sided copies of the first document and one single-sided
copy of the next. Ranges are one-based, inclusive, ordered and non-overlapping.

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

## The reference host

`infrastructure/windows/print-host.ps1` implements this protocol with
`Get-Printer`, `Get-PrintConfiguration`, `Get-PrintJob`, `Windows.Data.Pdf` and
a GDI printer device context. The selected PDF pages are rendered locally, then
drawn through the installed Canon UFR II driver. `StartDoc` supplies the
operating-system job identifier before the first rendered page is drawn.

The reference profile refuses anything except a local, non-shared `USBnnn`
queue using `Canon Generic Plus UFR II`. It also refuses a queue whose current
defaults are not A4 and monochrome. The exact queue name and USB port number are
deployment data, not source-code constants, so another certified installation
of the same printer may use `USB002` or a different operator-chosen queue name.
