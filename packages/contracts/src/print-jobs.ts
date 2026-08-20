import { z } from "zod";

/**
 * Print jobs.
 *
 * A print job is created only from a capture that already paid for the exact
 * settings revision it prints, and it never carries a customer filename. The
 * kiosk sees a status; the local agent sees an immutable manifest and opaque
 * document identifiers; neither can propose what should be printed.
 */

export const printJobStatusSchema = z.enum([
  "QUEUED",
  "DISPATCHED",
  "PRINTING",
  "COMPLETED",
  "FAILED",
  "CANCELED",
  /** The device may or may not have produced paper. An operator decides. */
  "RECOVERY_REQUIRED"
]);

/** How much the device was willing to promise about the result. */
export const printResultConfidenceSchema = z.enum(["UNKNOWN", "CONFIRMED", "UNCONFIRMED"]);

export const printOperationStateSchema = z.enum([
  "NOT_SUBMITTED",
  "SUBMITTED",
  "PRINTING",
  "COMPLETED",
  "FAILED",
  "CANCELED",
  "UNKNOWN"
]);

/**
 * Why a print job stopped short of a completed output. The set is closed so a
 * device string can never be echoed into an event payload or onto the screen.
 */
export const printFailureCodeSchema = z.enum([
  "PRINTER_OFFLINE",
  "PAPER_JAM",
  "OUT_OF_PAPER",
  "COVER_OPEN",
  "DEVICE_TIMEOUT",
  "DEVICE_ERROR",
  "CANCELED_AT_DEVICE",
  "CANCELED_BEFORE_SUBMIT",
  "CANCELED_BY_CUSTOMER",
  "SUBMISSION_UNCONFIRMED",
  "OUTPUT_WRITE_FAILED",
  "ARTIFACT_UNAVAILABLE",
  "PRINTER_UNAVAILABLE",
  "JOB_DEADLINE_EXCEEDED"
]);

export const printWarningCodeSchema = z.enum(["TONER_LOW", "PAPER_LOW", "OUTPUT_TRAY_FULL"]);

/** The deterministic device behaviour a development kiosk may ask for. */
export const simulatedPrintOutcomeSchema = z.enum([
  "SUCCESS",
  "WARNING",
  "OFFLINE",
  "PAPER_JAM",
  "OUT_OF_PAPER",
  "CANCELED",
  "TIMEOUT",
  "UNKNOWN_AFTER_SUBMIT"
]);

const sheetCountSchema = z.number().int().min(0).max(100_000);

export const printJobSnapshotSchema = z
  .object({
    id: z.string().uuid(),
    sessionId: z.string().uuid(),
    quoteId: z.string().uuid(),
    paymentId: z.string().uuid(),
    settingsRevision: z.number().int().positive(),
    status: printJobStatusSchema,
    resultConfidence: printResultConfidenceSchema,
    failureCode: printFailureCodeSchema.nullable(),
    warningCode: printWarningCodeSchema.nullable(),
    copies: z.number().int().positive(),
    printedSides: z.number().int().positive(),
    physicalSheets: z.number().int().positive(),
    sheetsProduced: sheetCountSchema.nullable(),
    createdAt: z.string().datetime(),
    deadlineAt: z.string().datetime(),
    completedAt: z.string().datetime().nullable()
  })
  .strict();

/**
 * Starting a print names the capture that paid for it. There is no field for
 * settings or documents: the job is built from the stored settings revision the
 * payment was bound to, so a browser cannot ask for something else to print.
 */
export const createPrintJobBodySchema = z
  .object({
    paymentId: z.string().uuid(),
    /**
     * Development only. The API refuses this field unless the deployment has
     * explicitly enabled the deterministic device scenarios outside production.
     */
    simulatedOutcome: simulatedPrintOutcomeSchema.optional()
  })
  .strict();

export const createPrintJobResponseSchema = z.object({ printJob: printJobSnapshotSchema }).strict();
export const getPrintJobResponseSchema = z.object({ printJob: printJobSnapshotSchema }).strict();
export const cancelPrintJobResponseSchema = z.object({ printJob: printJobSnapshotSchema }).strict();

const pageRangeSchema = z.tuple([z.number().int().positive(), z.number().int().positive()]);

export const printJobDocumentSchema = z
  .object({
    documentId: z.string().uuid(),
    position: z.number().int().min(0).max(999),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    sizeBytes: z.number().int().positive(),
    pageCount: z.number().int().positive(),
    pageRanges: z.array(pageRangeSchema).min(1).max(50),
    selectedPages: z.number().int().positive(),
    // How this document is printed. Copies, sides and orientation belong to a
    // document, so the device is told them per document rather than once for
    // a run that may mix them.
    copies: z.number().int().positive().max(100),
    duplex: z.enum(["SIMPLEX", "LONG_EDGE", "SHORT_EDGE"]),
    orientation: z.enum(["AUTO", "PORTRAIT", "LANDSCAPE"]),
    printedSides: z.number().int().positive(),
    physicalSheets: z.number().int().positive()
  })
  .strict()
  .superRefine((document, context) => {
    if (document.printedSides !== document.selectedPages * document.copies) {
      context.addIssue({
        code: "custom",
        path: ["printedSides"],
        message: "A document's side total must match its pages and copies."
      });
    }
    const sheetsPerCopy =
      document.duplex === "SIMPLEX"
        ? document.selectedPages
        : Math.ceil(document.selectedPages / 2);
    if (document.physicalSheets !== sheetsPerCopy * document.copies) {
      context.addIssue({
        code: "custom",
        path: ["physicalSheets"],
        message: "A document's sheet total must match its pages, sides and copies."
      });
    }
  });

/**
 * The immutable job manifest. It is hashed once and never edited: the control
 * plane, the local agent, and the device all read the same bytes.
 */
export const printJobManifestSchema = z
  .object({
    manifestVersion: z.literal(2),
    printJobId: z.string().uuid(),
    sessionId: z.string().uuid(),
    settingsRevision: z.number().int().positive(),
    settingsManifestHash: z.string().regex(/^[0-9a-f]{64}$/),
    quoteId: z.string().uuid(),
    paymentId: z.string().uuid(),
    paperSize: z.enum(["A4"]),
    scaling: z.enum(["FIT", "ACTUAL_SIZE"]),
    collate: z.boolean(),
    colorMode: z.enum(["MONOCHROME"]),
    selectedPages: z.number().int().positive(),
    printedSides: z.number().int().positive(),
    physicalSheets: z.number().int().positive(),
    documents: z.array(printJobDocumentSchema).min(1).max(10)
  })
  .strict()
  .superRefine((manifest, context) => {
    const documentIds = new Set<string>();
    const positions = new Set<number>();
    let selectedPages = 0;
    let printedSides = 0;
    let physicalSheets = 0;
    for (const [index, document] of manifest.documents.entries()) {
      if (documentIds.has(document.documentId)) {
        context.addIssue({
          code: "custom",
          path: ["documents", index, "documentId"],
          message: "A print manifest cannot contain the same document twice."
        });
      }
      if (positions.has(document.position)) {
        context.addIssue({
          code: "custom",
          path: ["documents", index, "position"],
          message: "Every print manifest position must be unique."
        });
      }
      documentIds.add(document.documentId);
      positions.add(document.position);
      selectedPages += document.selectedPages;
      printedSides += document.printedSides;
      physicalSheets += document.physicalSheets;
    }

    if (selectedPages !== manifest.selectedPages) {
      context.addIssue({
        code: "custom",
        path: ["selectedPages"],
        message: "The print manifest page total must match its documents."
      });
    }
    // Copies are per document, so the job totals are the sum of what each
    // document produces rather than one multiplication over the whole run.
    if (printedSides !== manifest.printedSides) {
      context.addIssue({
        code: "custom",
        path: ["printedSides"],
        message: "The print manifest side total must match its documents."
      });
    }
    if (physicalSheets !== manifest.physicalSheets) {
      context.addIssue({
        code: "custom",
        path: ["physicalSheets"],
        message: "The print manifest sheet total must match its documents."
      });
    }
  });

/**
 * One durable command leased by the kiosk agent. The kiosk opens no inbound
 * port: it claims work over its own outbound connection and holds a lease.
 */
export const agentPrintCommandSchema = z
  .object({
    operationId: z.string().uuid(),
    type: z.literal("PRINT"),
    printJobId: z.string().uuid(),
    sessionId: z.string().uuid(),
    claimToken: z.string().uuid(),
    manifest: printJobManifestSchema,
    manifestHash: z.string().regex(/^[0-9a-f]{64}$/),
    leaseExpiresAt: z.string().datetime(),
    deadlineAt: z.string().datetime(),
    /**
     * True when this operation was handed out before. The agent must ask the
     * device what it already did with it rather than submitting again.
     */
    redelivered: z.boolean(),
    simulatedOutcome: simulatedPrintOutcomeSchema.nullable()
  })
  .strict();

export const claimAgentCommandsBodySchema = z
  .object({ max: z.number().int().min(1).max(4).default(1) })
  .strict();

export const claimAgentCommandsResponseSchema = z
  .object({ commands: z.array(agentPrintCommandSchema).max(4) })
  .strict();

export const reportAgentCommandProgressBodySchema = z
  .object({
    claimToken: z.string().uuid(),
    /** PREPARING renews a lease without claiming that the device saw the job. */
    state: z.enum(["PREPARING", "SUBMITTED", "PRINTING"])
  })
  .strict();

/**
 * What the device saw, kept alongside the outcome it reported.
 *
 * It is evidence, never a decision — the settlement reducer never reads it —
 * and it is bounded on every axis because it crosses from a kiosk into the
 * control plane. Deliberately restricted to operational facts: identifiers the
 * operating system assigned, the raw status strings it produced, counts and
 * elapsed milliseconds. A document's name, its contents and any local path are
 * absent by construction, because the device side never receives them.
 */
export const deviceJobEvidenceSchema = z
  .object({
    position: z.number().int().min(0).max(999),
    /** The operating system's own job identifier for this document. */
    jobId: z.number().int().min(0).max(4_294_967_295),
    present: z.boolean(),
    observed: z.boolean(),
    completed: z.boolean(),
    faulted: z.boolean(),
    /** The device's raw status word, so an unrecognised one is still legible. */
    status: z.string().max(120).nullable(),
    pagesPrinted: z.number().int().min(0).max(100_000),
    expectedPages: z.number().int().min(0).max(100_000),
    expectedSheets: z.number().int().min(0).max(100_000)
  })
  .strict();

export const deviceDiagnosticsSchema = z
  .object({
    queueName: z.string().max(220).nullable().optional(),
    /** Where the device refused, when it named a stage. */
    stage: z.string().max(120).nullable().optional(),
    processStartMs: z.number().int().min(0).max(3_600_000).nullable().optional(),
    pollCount: z.number().int().min(0).max(100_000).nullable().optional(),
    phaseMs: z.record(z.string().max(64), z.number().int().min(0).max(3_600_000)).optional(),
    jobs: z.array(deviceJobEvidenceSchema).max(16).optional(),
    /** How long the device was watched after its queue emptied. */
    settleMs: z.number().int().min(0).max(3_600_000).nullable().optional(),
    /**
     * The distinct printer-level status words seen during that watch. Recorded
     * even when none of them was a fault: which statuses a given driver will and
     * will not raise is otherwise unknowable without standing at the machine.
     */
    printerStatuses: z.array(z.string().max(120)).max(8).optional(),
    /** The fault the watch attributed to this operation, if any. */
    deviceFaultCode: z.string().max(48).nullable().optional()
  })
  .strict();

export const reportAgentCommandResultBodySchema = z
  .object({
    claimToken: z.string().uuid(),
    state: printOperationStateSchema,
    confidence: z.enum(["CONFIRMED", "UNCONFIRMED"]),
    failureCode: printFailureCodeSchema.nullable(),
    warningCode: printWarningCodeSchema.nullable(),
    sheetsProduced: sheetCountSchema.nullable(),
    deviceDiagnostics: deviceDiagnosticsSchema.nullable().optional()
  })
  .strict()
  .superRefine((result, context) => {
    if (
      result.state === "NOT_SUBMITTED" &&
      (result.confidence !== "CONFIRMED" || result.sheetsProduced !== 0)
    ) {
      context.addIssue({
        code: "custom",
        path: ["state"],
        message: "A not-submitted result must confirm that zero sheets were produced."
      });
    }
    if (
      result.state === "CANCELED" &&
      result.confidence === "CONFIRMED" &&
      result.sheetsProduced !== 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["sheetsProduced"],
        message: "A confirmed cancellation must report zero sheets produced."
      });
    }
    // A failure that reports zero sheets without being able to confirm it is a
    // legitimate device answer — a jam before the first sheet leaves the tray
    // is exactly that — and it is accepted here on purpose. What must never
    // happen is such a report being settled as a definite failure that owes
    // money back; the settlement reducer and the stored-outcome constraint both
    // require CONFIRMED for that, and route everything else to
    // RECOVERY_REQUIRED. Refusing the report instead only left the device
    // unable to speak and the job hanging until its lease expired.
    if (
      result.state === "COMPLETED" &&
      (result.failureCode !== null ||
        (result.confidence === "CONFIRMED" &&
          (result.sheetsProduced === null || result.sheetsProduced === 0)))
    ) {
      context.addIssue({
        code: "custom",
        path: ["state"],
        message:
          "A completion cannot include a failure code, and a confirmed completion must report produced sheets."
      });
    }
  });

export const agentCommandAckSchema = z
  .object({ accepted: z.boolean(), printJobStatus: printJobStatusSchema })
  .strict();

export const PRINT_DISPATCH_QUEUE_NAME = "print-dispatch-v1";

export const printDispatchJobSchema = z
  .object({ printJobId: z.string().uuid(), attempt: z.number().int().min(1).max(50) })
  .strict();

export type PrintJobStatus = z.infer<typeof printJobStatusSchema>;
export type PrintResultConfidenceValue = z.infer<typeof printResultConfidenceSchema>;
export type PrintOperationStateValue = z.infer<typeof printOperationStateSchema>;
export type PrintFailureCodeValue = z.infer<typeof printFailureCodeSchema>;
export type PrintWarningCodeValue = z.infer<typeof printWarningCodeSchema>;
export type SimulatedPrintOutcome = z.infer<typeof simulatedPrintOutcomeSchema>;
export type PrintJobSnapshot = z.infer<typeof printJobSnapshotSchema>;
export type CreatePrintJobBody = z.infer<typeof createPrintJobBodySchema>;
export type CreatePrintJobResponse = z.infer<typeof createPrintJobResponseSchema>;
export type GetPrintJobResponse = z.infer<typeof getPrintJobResponseSchema>;
export type CancelPrintJobResponse = z.infer<typeof cancelPrintJobResponseSchema>;
export type PrintJobManifestContract = z.infer<typeof printJobManifestSchema>;
export type AgentPrintCommand = z.infer<typeof agentPrintCommandSchema>;
export type ClaimAgentCommandsResponse = z.infer<typeof claimAgentCommandsResponseSchema>;
export type ReportAgentCommandResultBody = z.infer<typeof reportAgentCommandResultBodySchema>;
export type ReportAgentCommandProgressBody = z.infer<typeof reportAgentCommandProgressBodySchema>;
export type PrintDispatchJob = z.infer<typeof printDispatchJobSchema>;
