# ADR 0001: platform boundaries and MVP defaults

Status: Proposed  
Date: 2026-07-12

## Context

The product must accept private files from phones, coordinate payment, and
operate Windows printer and payment-terminal hardware. Development begins without
hardware, must stay manageable for one developer, and should later support many
kiosks and short network outages.

## Decisions

1. Use a TypeScript pnpm monorepo and a modular monolith for cloud business
   logic. Run asynchronous workers separately but do not create independent
   microservices yet.
2. Use React/Vite for kiosk, phone upload, and later admin frontends; Fastify
   for API; PostgreSQL for durable truth; Redis/BullMQ for ephemeral
   coordination; private S3-compatible storage for documents; Socket.IO for
   notifications with REST snapshot recovery.
3. Maintain a local kiosk agent boundary from the first mock. The agent owns
   hardware and a SQLite command/event ledger. It makes outbound cloud
   connections only.
4. Keep the touchscreen unprivileged. It cannot read device credentials,
   arbitrary local files, card data, or hardware APIs.
5. Normalize PDF/JPEG/PNG input to a print-ready PDF. Preserve the original only
   for the short transaction retention period and keep previews separate.
6. Use immutable, versioned settings and price quotes, integer minor-unit
   money, transactional outbox events, and idempotency for payment/print/
   cleanup boundaries.
7. Use a 256-bit fragment QR grant exchanged for a scoped secure cookie. Store
   only digests. A numeric fallback needs kiosk confirmation in production.
8. Distinguish queue acceptance, device observation, verified completion, and
   uncertain physical output. Never automatically reprint an uncertain job.
9. Customer document bytes and names do not enter logs, administration,
   ordinary backups, analytics, or crash reporting. Cleanup is durable and
   retryable.
10. Full offline phone upload, real payments, and real devices are outside the
    MVP. Document scanning, photocopying/xerox, and color printing are outside
    the product scope.

## Consequences

- The MVP has more explicit boundaries than a single browser/server demo, but
  it avoids rewriting the security and device architecture for Windows.
- PostgreSQL and an outbox add operational components, but payment and print
  recovery can be reasoned about.
- Phone upload cannot start when the public service is unavailable. Already
  cached, paid jobs can eventually finish through the local agent.
- Printer procurement and refund rules must account for cases where the
  operating system cannot prove physical paper delivery.
- PDF renderer, virtual-driver, font, and vendor SDK licensing must be reviewed
  before commercial distribution.

## Revisit triggers

- Pilot load proves a module needs independent scaling or deployment.
- A payment provider mandates a different terminal topology.
- Selected hardware cannot expose required status through spooler/IPP and a
  vendor SDK changes the local device-host design.
- A validated business requirement justifies local-LAN mobile upload.
- Privacy law, tax, receipt, data-residency, or retention requirements differ
  in the launch jurisdiction.
