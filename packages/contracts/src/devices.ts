import { z } from "zod";

/**
 * The kiosk agent's own device plane.
 *
 * A kiosk opens no inbound port, so everything here is the agent talking
 * outward under its device credential: it says which machine and which printer
 * it is, it says so again on a heartbeat, and it reports what the printer can
 * do so the control plane can offer a customer only that.
 *
 * Nothing on this channel is customer data. It carries queue names, driver and
 * firmware strings, and health codes — the record a fleet is supported from and
 * a printer/driver/firmware combination is certified against.
 */

/** A queue name as the operating system knows it, bounded and printable. */
export const printerQueueNameSchema = z
  .string()
  .min(1)
  .max(220)
  // Control characters would end up in logs, an operator console and a support
  // ticket. A queue name that contains one is not a queue anybody configured.
  .regex(/^[^\p{Cc}\p{Cf}]+$/u);

const deviceTextSchema = z
  .string()
  .min(1)
  .max(400)
  .regex(/^[^\p{Cc}\p{Cf}]+$/u);

export const printerAdapterKindSchema = z.enum(["MOCK", "IPP", "WINDOWS"]);
export const printerQueueStateSchema = z.enum(["READY", "PAUSED", "OFFLINE", "ERROR"]);
export const printerHealthStateSchema = z.enum(["READY", "WARNING", "OFFLINE"]);

/**
 * Why a discovered queue is not the one being printed to. It is a closed set so
 * an operator console can explain a kiosk that will not print without a device
 * string ever reaching a screen.
 */
export const printerApprovalStateSchema = z.enum([
  "APPROVED",
  "NOT_APPROVED",
  "SHARED",
  "AMBIGUOUS"
]);

export const printerCapabilitySnapshotSchema = z
  .object({
    version: z.number().int().positive().max(1_000),
    paperSizes: z.array(z.enum(["A4"])).max(8),
    duplexModes: z.array(z.enum(["SIMPLEX", "LONG_EDGE", "SHORT_EDGE"])).max(8),
    colorModes: z.array(z.enum(["MONOCHROME"])).max(4),
    orientations: z.array(z.enum(["AUTO", "PORTRAIT", "LANDSCAPE"])).max(4),
    scalingModes: z.array(z.enum(["FIT", "ACTUAL_SIZE"])).max(4),
    maxCopies: z.number().int().positive().max(1_000)
  })
  .strict();

/** One queue the kiosk machine can see, as the agent found it. */
export const discoveredPrinterQueueSchema = z
  .object({
    queueName: printerQueueNameSchema,
    deviceUri: deviceTextSchema.nullable(),
    driverName: deviceTextSchema.nullable(),
    portName: deviceTextSchema.nullable(),
    state: printerQueueStateSchema,
    isDefault: z.boolean(),
    shared: z.boolean()
  })
  .strict();

/**
 * Registration. The agent says which machine it is and which printer it is
 * bound to; the control plane answers with the approval policy it must hold
 * itself to and the capability version the kiosk is currently serving.
 */
export const registerAgentBodySchema = z
  .object({
    /** Stable per installation, so a restarted agent is the same agent. */
    agentId: z.string().uuid(),
    agentVersion: deviceTextSchema,
    platform: z.enum(["win32", "linux", "darwin"]),
    /** The operating-system release, for the support and certification record. */
    platformRelease: deviceTextSchema.nullable(),
    adapter: printerAdapterKindSchema,
    /** Absent when the agent has not been able to bind an approved queue. */
    queueName: printerQueueNameSchema.nullable()
  })
  .strict();

export const agentRegistrationSchema = z
  .object({
    kioskId: z.string().min(1).max(64),
    agentId: z.string().uuid(),
    /** Seconds. The agent heartbeats at least this often. */
    heartbeatIntervalSeconds: z.number().int().min(5).max(3_600),
    /** Queue names the operator certified for this kiosk. */
    approvedQueues: z.array(printerQueueNameSchema).max(16),
    /** The capability version customers are currently being offered. */
    capabilityVersion: z.number().int().positive(),
    registeredAt: z.string().datetime()
  })
  .strict();

export const registerAgentResponseSchema = z
  .object({ registration: agentRegistrationSchema })
  .strict();

export const agentHeartbeatBodySchema = z
  .object({
    agentId: z.string().uuid(),
    /** The queue the agent is bound to now, which may have changed. */
    queueName: printerQueueNameSchema.nullable(),
    printerHealth: printerHealthStateSchema,
    /**
     * The digest of the capability snapshot the agent last reported. The
     * control plane compares it with what it stored and asks for a fresh
     * report when they differ, so a swapped printer is noticed within one
     * heartbeat rather than at the next print.
     */
    capabilityHash: z.string().regex(/^[0-9a-f]{64}$/),
    /** Open print operations this agent believes it is holding. */
    activeOperations: z.number().int().min(0).max(64),
    /**
     * When the reading behind `printerHealth` was actually taken from the
     * printer, rather than when this beat was sent.
     *
     * The two are not the same and the difference is what payment turns on: an
     * agent polls its printer on one schedule and reports on another, so a beat
     * sent now can be carrying a reading from a minute ago. Null when this
     * kiosk has no telemetry link, which is not staleness — it is a printer
     * nobody can ask, and the gate treats it as absent rather than as expired.
     */
    telemetryAt: z.string().datetime().nullable().optional()
  })
  .strict();

export const agentHeartbeatResponseSchema = z
  .object({
    acknowledgedAt: z.string().datetime(),
    /** True when the stored snapshot does not match what the agent reported. */
    capabilityReportRequired: z.boolean(),
    approvedQueues: z.array(printerQueueNameSchema).max(16),
    capabilityVersion: z.number().int().positive()
  })
  .strict();

/**
 * The capability and health report.
 *
 * It carries every queue the machine offers, not only the approved one. An
 * operator certifying a kiosk needs to see what is actually installed on it,
 * and a queue that appeared without anybody adding it is exactly the thing a
 * fleet view should be able to show.
 */
export const reportPrinterStateBodySchema = z
  .object({
    agentId: z.string().uuid(),
    adapter: printerAdapterKindSchema,
    queueName: printerQueueNameSchema.nullable(),
    approval: printerApprovalStateSchema,
    deviceId: deviceTextSchema.nullable(),
    /** The physical printer, not the driver that happens to drive it. */
    makeAndModel: deviceTextSchema.nullable(),
    driverName: deviceTextSchema.nullable(),
    driverVersion: deviceTextSchema.nullable().optional(),
    firmware: deviceTextSchema.nullable(),
    health: printerHealthStateSchema,
    warningCode: z.enum(["TONER_LOW", "PAPER_LOW", "OUTPUT_TRAY_FULL"]).nullable(),
    capabilities: printerCapabilitySnapshotSchema.nullable(),
    capabilityHash: z.string().regex(/^[0-9a-f]{64}$/),
    discovered: z.array(discoveredPrinterQueueSchema).max(64)
  })
  .strict()
  .superRefine((report, context) => {
    // An approved binding without a capability snapshot is a report that would
    // leave the kiosk offering settings nothing answered for.
    if (report.approval === "APPROVED" && (!report.queueName || !report.capabilities)) {
      context.addIssue({
        code: "custom",
        path: ["capabilities"],
        message: "An approved printer must report the queue it bound and what it can do."
      });
    }
    if (report.approval !== "APPROVED" && report.capabilities) {
      context.addIssue({
        code: "custom",
        path: ["capabilities"],
        message: "Only an approved printer may publish capabilities."
      });
    }
  });

export const reportPrinterStateResponseSchema = z
  .object({
    /** True when this report changed what customers are offered. */
    capabilitiesUpdated: z.boolean(),
    capabilityVersion: z.number().int().positive(),
    acceptedAt: z.string().datetime()
  })
  .strict();

export type PrinterAdapterKindValue = z.infer<typeof printerAdapterKindSchema>;
export type PrinterQueueStateValue = z.infer<typeof printerQueueStateSchema>;
export type PrinterHealthStateValue = z.infer<typeof printerHealthStateSchema>;
export type PrinterApprovalState = z.infer<typeof printerApprovalStateSchema>;
export type PrinterCapabilitySnapshotContract = z.infer<typeof printerCapabilitySnapshotSchema>;
export type DiscoveredPrinterQueue = z.infer<typeof discoveredPrinterQueueSchema>;
export type RegisterAgentBody = z.infer<typeof registerAgentBodySchema>;
export type AgentRegistration = z.infer<typeof agentRegistrationSchema>;
export type RegisterAgentResponse = z.infer<typeof registerAgentResponseSchema>;
export type AgentHeartbeatBody = z.infer<typeof agentHeartbeatBodySchema>;
export type AgentHeartbeatResponse = z.infer<typeof agentHeartbeatResponseSchema>;
export type ReportPrinterStateBody = z.infer<typeof reportPrinterStateBodySchema>;
export type ReportPrinterStateResponse = z.infer<typeof reportPrinterStateResponseSchema>;
