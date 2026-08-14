# Phase 10 status

- Date: 2026-08-10
- Status: Canon USB rendering path implemented; physical certification outstanding
- Scope: a kiosk drives a real printer through the same contract the simulated
  one used, prints only to a queue an operator certified, and publishes what
  that printer can actually do as the settings a customer may choose

"Complete" here means the device plane is implemented, integrated, migration-
safe and covered by automated gates. It does not mean any printer has been
certified: certification is a physical act on a Windows test machine against a
specific printer, driver and firmware, and the items under
[Known boundaries](#known-boundaries) are exactly what is left.

## What Phase 10 adds

1. The printer is no longer a directory. The deployable real adapter is
   `WINDOWS`, driving a local USB printer through a small device host. Network
   printer selection is disabled. The runner, the
   retention watchdog and the capability reporter all hold a `PrinterAdapter`
   and cannot tell which one it is.
2. A kiosk prints only to a queue an operator certified by name. A machine sees
   every queue its operating system knows about — a PDF writer, a queue somebody
   shared from a laptop — and an empty allowlist approves none of them. Two
   certified queues and no stated preference is a refusal, not a coin toss.
3. Approval is checked in two independent places. The agent enforces the
   machine's own allowlist; the control plane re-derives approval from the
   kiosk's record and drops capabilities for anything else. An agent that
   labelled a queue approved cannot make it so, which is what a swapped printer
   would claim.
4. What a customer is offered now comes from the device. The agent reads the
   printer's capabilities, maps two vocabularies onto one — `iso_a4_210x297mm`
   and `A4` are one option, `two-sided-long-edge` and `TwoSidedLongEdge` are one
   option — and publishes them. A term it does not recognise is not offered,
   because a capability guessed at is one a paid quote can promise and the
   hardware can refuse.
5. Only a change bumps the capability version. The snapshot is hashed, and the
   digest travels on every heartbeat, so a printer that was reconfigured or
   replaced is noticed within one beat rather than at the next paid print — and
   a device that answered in a different attribute order does not look like a
   device that was swapped.
6. One operation becomes one Windows spooler job per document, named
   `<operationId>#<position>of<count>`. Copies and duplex belong to a document
   in this product and to a Windows spooler job, so a manifest whose documents
   differ could not have travelled as one job. The name
   is the durable link: a bare queue listing tells a complete operation from a
   partial one after a restart on either side.
7. A local journal is written before any device is touched. A spooler purges job
   history on its own schedule, and a purged queue answers a status query
   exactly the way a queue that never saw the job does. Believing that answer is
   how one paid job becomes two printed jobs, so an operation the journal knows
   about and the device cannot account for is reported `UNKNOWN` — never
   `NOT_SUBMITTED`.
8. Nothing outside this process gets to declare a success. A device host or a
   spooler may report `CONFIRMED`; the agent clamps it against the numbers that
   came with it. A completion is confirmed only with a sheet count above zero,
   and a failure only when it proved no sheet was produced. Everything else is
   settled by a person.
9. Asking is free and submitting is not, so the order is always ask, record,
   submit. A stopped queue, a queue not accepting jobs, and a queue that cannot
   take PDF are all found before a byte is sent — the only point at which a
   refusal proves nothing was printed and the capture is refundable rather than
   in operator recovery.
10. The kiosk has an outbound identity. An installation identifier is written
    once on the machine and belongs to one kiosk; a second kiosk presenting it
    is refused rather than allowed to take it over. Heartbeats carry printer
    health and the number of operations the agent is holding, so a kiosk that is
    quiet because it is printing is distinguishable from one that is stuck.
11. The agent runs as a Windows service under a virtual account, restarts
    indefinitely on failure, and keeps its local state under `ProgramData` with
    an ACL that admits only itself and administrators.

Phase 10 does not add an operator interface for the fleet it now records, a
rendering device host for XPS-only queues, or per-device credentials — those are
Phase 11.

## The device plane

```text
kiosk machine                             control plane
─────────────                             ─────────────
listQueues()  ──▶ allowlist ──▶ selection
     │                              │
     │  no certified queue ─────────┼──▶ PUT /v1/agent/printers
     │                              │      approval NOT_APPROVED, no capabilities
     ▼                              │      (the kiosk keeps what it was offering)
getHealth() + getCapabilities()     │
     │                              │
     ├── hash ──▶ POST /v1/agent/heartbeat
     │              └── capabilityReportRequired? ──┐
     │                                              │
     └── describe() ──▶ PUT /v1/agent/printers ◀────┘
                            │  re-derives approval from the kiosk's own list
                            ▼
                        printers row (one APPROVED per kiosk, enforced by index)
                            │  capability digest changed?
                            ▼
                        kiosks.capabilities + capabilities_version + 1
                            │
                            ▼
                   GET /v1/sessions/:id/print-capabilities
```

Registration happens once per start; the beat is `AGENT_HEARTBEAT_SECONDS` and
must be shorter than a print command lease.

## Printing to a real device

```text
command claimed ──▶ manifest hash re-checked ──▶ documents spooled
                                                      │
                       ask: printer state, accepting jobs, takes PDF?
                                     │
                     refused here ───┴──▶ PRINTER_OFFLINE / DEVICE_ERROR
                                          confirmed, nothing printed, refundable
                                     │
                        journal written (operation → jobs)
                                     │
                    one device job per document, in position order
                                     │
                        poll until every job is terminal
                                     │
        ┌────────────────────────────┼────────────────────────────┐
        ▼                            ▼                            ▼
  all completed +             any aborted /              queue cannot account
  sheets > 0                  canceled                   for every document
        │                            │                            │
   COMPLETED                  FAILED / CANCELED                UNKNOWN
   CONFIRMED             CONFIRMED only if sheets = 0        UNCONFIRMED
```

Every branch that is not the first ends at `RECOVERY_REQUIRED` through the
Phase 8 settlement reducer, which is unchanged.

## Database additions

- `printers` — one row per queue the machine offers, not only the certified one:
  an operator certifying a kiosk needs to see what is installed on it. A partial
  unique index permits **one** approved printer per kiosk, and a check
  constraint ties capabilities to approval in both directions — an uncertified
  queue cannot publish them, and a certified one cannot be left without them. A
  queue name carrying a control character is refused, because it reaches an
  operator console and a support ticket verbatim.
- `kiosk_agents` — one row per installation, with a globally unique installation
  identifier, the platform and version it is running, the queue it says it is
  bound to, printer health, the capability digest it is running on, and the last
  heartbeat.

Both tables are new and cascade from the kiosk. Nothing existing is altered, so
a database written before this migration simply has no device rows — which is
what a kiosk nobody has certified a printer for should look like.

## Configuration

```text
PRINTER_ADAPTER=mock|windows            # production refuses mock
PRINTER_QUEUE_ALLOWLIST=CanonLBP361_UFR_II
PRINTER_QUEUE_NAME=CanonLBP361_UFR_II
PRINTER_ALLOW_SHARED_QUEUE=false
PRINTER_WINDOWS_HOST_PATH=C:\\PrintingKiosk\\infrastructure\\windows\\print-host.ps1
PRINTER_DEVICE_JOURNAL_DIR=./.tmp/kiosk-agent-device
AGENT_HEARTBEAT_SECONDS=30              # < PRINT_COMMAND_LEASE_SECONDS
```

Configuration validation refuses: the simulated printer in production, a
Windows adapter whose host is not named, a real adapter with no certified queue,
a preference that is not itself certified, and a heartbeat that could outlive a
print command lease.

The operator's certification also lives on the kiosk row, as `approvedQueues`
inside `capabilities`. The two lists must name the same queue; the machine's
copy is what the agent enforces and the kiosk row is what the control plane
enforces, and a queue only publishes when both agree.

## Run locally

From the repository root:

```bash
pnpm infra:up
pnpm db:migrate
pnpm db:seed
pnpm dev:kiosk
```

The development seed certifies `Mock Kiosk Printer`, so the simulated device
goes through the same discovery, approval and publication path a Windows kiosk
does rather than around it. Watch the agent log `kiosk agent registered` and
then `printer capabilities published`, and confirm the row:

```sql
SELECT queue_name, approval, health, capability_hash FROM printers;
SELECT agent_id, adapter, printer_health, last_heartbeat_at FROM kiosk_agents;
```

Remove `Mock Kiosk Printer` from `PRINTER_QUEUE_ALLOWLIST` and restart the
agent: the printer is still discovered, its row still appears, and it publishes
nothing.

## Tests

- `packages/printer-adapters` — the IPP wire format against truncated,
  over-declared and unterminated messages; the adapter against a device that
  decodes the bytes it is actually sent; capability mapping in both vocabularies;
  approval refusing an empty allowlist, a shared queue and an ambiguous machine;
  the journal telling a purged queue from one that never saw the job.
- `services/kiosk-agent` — the reporter registering, beating, publishing on
  change only, withdrawing approval when the printer stops answering, and
  re-registering after a control plane that forgot it.
- `tests/integration/device-plane.test.ts` — registration, heartbeat and
  capability publication end to end, including a discovered printer's duplex
  options reaching a customer session's settings, and a certified-queue mismatch
  publishing nothing.
- `pnpm db:verify-phase10-upgrade` — a Phase 9 database upgraded in place, then
  the invariants: one approved printer per kiosk, capabilities only with
  approval, an installation identifier no second kiosk can claim.
- The Windows device-host suite is skipped unless it is running on Windows with
  `PRINTER_WINDOWS_HOST_PATH` set, rather than passing vacuously off-platform.

## Known boundaries

These are the items between this phase and a certified kiosk. They are hardware
and fleet work, not gaps in the code above.

- **No printer has been certified.** Certification is a physical exercise
  against one printer, driver version and firmware version, using the matrix in
  `docs/hardware/printer-compatibility.md`. The two rows that matter most are
  the restart cases: a combination that passes everything else and duplicates
  output after a spooler restart is not certified.
- **Hardware execution remains outstanding.** The host now renders selected PDF
  pages with `Windows.Data.Pdf` and sends them through the Canon UFR II driver,
  but this repository cannot exercise Windows, the driver or physical paper.
  Run the Canon USB certification checklist before calling the combination
  certified.
- **The reference host is unexercised on hardware.** It is written against the
  documented Win32 and PowerShell surfaces and has no automated coverage,
  because there is no Windows machine in this repository's test path. Treat it
  as a starting point to certify, not as a certified component.
- **Windows capability reading is coarse.** `Get-PrintConfiguration` reports the
  current configuration rather than the driver's full PrintTicket capability
  set, so the host reports one paper size and a conservative duplex list. A
  device whose full capabilities matter needs `System.Printing`
  `GetPrintCapabilities` in the host.
- **The fleet has no operator interface.** The rows exist and are queryable; a
  screen that shows a kiosk offline, a printer uncertified, or an agent silent
  belongs with the Phase 11 admin surface.
- **Device credentials are still the shared kiosk key.** Per-device
  certificates and rotation are Phase 11; until then an agent's identity is only
  as strong as `DEV_KIOSK_API_KEY`.
- **A shared queue is refused by policy, not prevented.** Setting
  `PRINTER_ALLOW_SHARED_QUEUE=true` permits one, and nothing then verifies that
  the machine on the other end is under the same control.
- **Capability withdrawal is deliberately partial.** When an agent can no longer
  bind a printer, the approval is withdrawn but the kiosk's published
  capabilities stay. That keeps a customer mid-session from having their choices
  changed by a printer that was briefly unreachable; it also means a kiosk whose
  printer is permanently gone keeps offering settings until an operator acts on
  the fleet record.
