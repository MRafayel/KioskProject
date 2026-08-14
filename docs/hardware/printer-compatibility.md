# Printer compatibility

A kiosk is certified against a printer, a driver version, and a firmware
version together. That combination is what the fleet records and what a support
ticket is answered against; "the same model" is not the same thing, because a
firmware update can change what a queue reports and a driver update can change
what it accepts.

## What the product needs from a device

| Requirement         | Why                                                                          |
| ------------------- | ---------------------------------------------------------------------------- |
| A4                  | The only paper size the product prices                                       |
| Monochrome          | The product prints monochrome only; colour is not a setting                  |
| PDF input           | The document processor produces one normalized PDF                           |
| Long-edge duplex    | Optional, but duplex pricing depends on it                                   |
| Per-job sheet count | Optional, and the difference between a confirmed print and operator recovery |

The last row is the one that surprises people. A device that accepts a job and
reports it complete without saying how many sheets it produced is not broken —
but every print through it settles as `RECOVERY_REQUIRED` rather than
`COMPLETED`, because a queue that has stopped complaining is not evidence that
paper emerged. Prefer a device that reports `job-media-sheets-completed`
(IPP) or `PagesPrinted` (Windows).

## Adapters

### IPP (`PRINTER_ADAPTER=ipp`)

The preferred path for a networked printer, and the one that works from any
operating system. It speaks IPP/1.1 directly: `Get-Printer-Attributes`,
`Print-Job`, `Get-Jobs`, `Cancel-Job`.

Requirements:

- `document-format-supported` includes `application/pdf`. A queue that does not
  is refused before anything is sent, rather than printing the file as text.
- `media-ready` reports the loaded tray. What is loaded beats what is
  supported: a model that supports A4 cannot print it out of a tray holding
  Letter, and offering it would sell a job the hardware refuses.
- `ipps://` off the kiosk machine. Print traffic carries the customer's
  document; configuration validation refuses plain `ipp://` in production unless
  the endpoint is on the kiosk's own loopback.

One IPP job is created per document, because copies and duplex belong to a
document in this product and to a job in IPP. Each is named
`<operationId>#<position>of<count>`, which is how a queue listing alone resolves
an interrupted print.

### Windows (`PRINTER_ADAPTER=windows`)

For a printer attached to a Windows kiosk through the print subsystem. The
platform work lives in a device host process; see
[windows-device-host.md](./windows-device-host.md).

The shipped reference host spools PDF bytes with datatype `RAW`. That is the
right thing for a **PDF-direct** queue — any modern network MFP, a PostScript
queue with a PDF interpreter, an IPP Everywhere or Universal Print queue — and
the wrong thing for a queue that expects rendered output.

**Microsoft Print to PDF and other GDI/XPS-only queues are not driven by the
reference host.** They accept XPS, not PDF, so printing to them requires a host
that renders the PDF into the spooler (`Windows.Data.Pdf` in a .NET host is the
intended route). The protocol does not change; only the host does. This is the
remaining hardware-side item — see the Phase 10 status document.

### Mock (`PRINTER_ADAPTER=mock`)

Writes files instead of moving paper. Development and automated tests only;
configuration validation refuses it in production, because a kiosk that takes a
customer's money and writes their document to a folder is not a kiosk.

## Approving a queue

A kiosk machine sees every queue its operating system knows about — a PDF
writer, a queue somebody shared from a laptop, whatever a driver installer
added. Printing to an arbitrary one is how a paid job ends up in a file nobody
collects. So a queue is certified by name, in two places, and both must agree:

1. `PRINTER_QUEUE_ALLOWLIST` on the kiosk machine. This is what the agent's own
   discovery and the Windows adapter enforce.
2. `approvedQueues` on the kiosk row in the control plane. This is what the
   capability report is re-checked against, so an agent that labelled a queue
   approved cannot make it so.

An empty list approves nothing. A machine offering two certified queues and no
`PRINTER_QUEUE_NAME` preference refuses rather than guessing which room the
customer's paper comes out in. A queue published to other machines is refused
unless `PRINTER_ALLOW_SHARED_QUEUE` says otherwise — a kiosk opens no other
inbound path.

## Certifying a combination

Record the printer, driver version and firmware version, then run each of these
against the real device and keep the result:

| Check                       | Expected                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------- |
| Capability report           | A4 and monochrome appear in the kiosk's settings; the duplex options match the hardware     |
| One-page simplex print      | `COMPLETED`, `CONFIRMED`, sheet count 1                                                     |
| Multi-document job          | One device job per document, per-document copies and duplex applied                         |
| Paused queue                | `PRINTER_OFFLINE` before submission; the job is refunded, not recovered                     |
| Printer switched off        | Same as above                                                                               |
| Out of paper mid-job        | `FAILED`, and `UNCONFIRMED` if any sheet was already produced                               |
| Cancel while printing       | `CANCELED`, `UNCONFIRMED` — never a claim that nothing came out                             |
| Restart the spooler mid-job | The next status read resolves the operation; it is never resubmitted                        |
| Restart the agent mid-job   | Same, via the redelivered command path                                                      |
| Retention window            | Device output and the local journal entry are gone after `PRINTER_OUTPUT_RETENTION_SECONDS` |

The two restart rows are the ones that matter most. A combination that passes
everything else and duplicates output after a spooler restart is not certified.

## Known-incompatible

| Queue                                       | Why                                                                   |
| ------------------------------------------- | --------------------------------------------------------------------- |
| Microsoft Print to PDF                      | XPS only; needs a rendering device host                               |
| Microsoft XPS Document Writer               | Same, and produces no paper                                           |
| Any shared queue on another host            | Refused by policy; the kiosk cannot certify a device it does not have |
| Colour-only devices with no monochrome mode | The product prices monochrome; nothing would be offerable             |
