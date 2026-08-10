import type { Prisma, PrismaClient } from "@printing-kiosk/database";

/**
 * Recording what an administrator did.
 *
 * `audit_events` is append-only — a trigger refuses UPDATE and DELETE — so
 * every call here is permanent. That is the point: an actor who could rewrite
 * this table could erase the evidence of everything else they did.
 *
 * The metadata allow-list below is the privacy boundary. Admin actions happen
 * near customer sessions, and it would be easy for a later caller to pass a
 * filename or an error message "for context". Only known-safe keys survive, so
 * that mistake cannot reach durable storage.
 */

/** The actor type for a human in the control plane. */
export const ADMIN_ACTOR_TYPE = "ADMIN_USER";

/**
 * The actor for an unauthenticated admin request — a failed login, a consumed
 * recovery credential. There is no account to attribute it to yet, and
 * inventing one would put an attacker's claim into the audit trail.
 */
export const ANONYMOUS_ADMIN_ACTOR_ID = "anonymous";

export type AdminAuditOutcome = "SUCCESS" | "FAILURE" | "DENIED";

/**
 * Keys an admin audit event may carry. Anything else is dropped rather than
 * stored, and the drop is silent by design: a caller passing an unexpected key
 * has made a privacy mistake, not a functional one, and failing the request
 * would turn that into an outage.
 */
const ALLOWED_METADATA_KEYS = new Set([
  "role",
  "capability",
  "risk",
  "reason",
  "authenticatorId",
  "authenticatorLabel",
  "targetAdminUserId",
  "sessionId",
  "ceremonyPurpose",
  "failureCode",
  "previousState",
  "resultingState",
  "stepUpFresh",
  // Operator actions. The device's own numbers are recorded beside the human's
  // on purpose: the gap between what a printer reported and what a person
  // counted at the tray is the whole reason a recovery observation exists, and
  // an audit row that carried only one of them would settle nothing later.
  "printJobId",
  // Not "outcome": an audit row already has an `outcome` column meaning
  // SUCCESS or DENIED, and two fields of that name on one screen is how a log
  // gets misread during the incident it was kept for.
  "recoveryOutcome",
  "refundSuggested",
  "observedSheets",
  "sheetsProduced",
  "confidence",
  // Acknowledging a group in the error centre.
  "subsystem",
  "incidentCode"
]);

export type AdminAuditMetadataValue = string | number | boolean | null;

export interface WriteAdminAuditEventInput {
  id: string;
  occurredAt: Date;
  actorId: string;
  action: string;
  outcome: AdminAuditOutcome;
  requestId?: string | undefined;
  kioskId?: string | undefined;
  metadata?: Readonly<Record<string, AdminAuditMetadataValue>> | undefined;
}

/**
 * Anything that can append one audit row.
 *
 * Structural rather than the full client, because the callers are deliberately
 * narrow types: an admin action's connection exposes two tables and the `create`
 * method, and requiring a `PrismaClient` here would have forced it to widen the
 * one place where being narrow is the point.
 */
export type AuditEventWriter =
  | PrismaClient
  | Prisma.TransactionClient
  | { auditEvent: Pick<PrismaClient["auditEvent"], "create"> };

export async function writeAdminAuditEvent(
  client: AuditEventWriter,
  input: WriteAdminAuditEventInput
): Promise<void> {
  await client.auditEvent.create({
    data: {
      id: input.id,
      occurredAt: input.occurredAt,
      actorType: ADMIN_ACTOR_TYPE,
      actorId: input.actorId,
      action: input.action,
      outcome: input.outcome,
      ...(input.requestId ? { requestId: input.requestId } : {}),
      ...(input.kioskId ? { kioskId: input.kioskId } : {}),
      ...(input.metadata ? { metadata: sanitizeMetadata(input.metadata) } : {})
    }
  });
}

export function sanitizeMetadata(
  metadata: Readonly<Record<string, AdminAuditMetadataValue>>
): Record<string, AdminAuditMetadataValue> {
  const safe: Record<string, AdminAuditMetadataValue> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!ALLOWED_METADATA_KEYS.has(key)) continue;
    if (typeof value === "string") {
      // A reason is operator-written free text. Bounding it here keeps an
      // accidental paste out of durable storage.
      safe[key] = value.slice(0, 200);
      continue;
    }
    safe[key] = value;
  }
  return safe;
}

/**
 * Keys the audit viewer may display, for events written by any actor.
 *
 * The allow-list above governs what an admin action is permitted to *write*,
 * and it did not exist when the kiosk, phone, worker and payment paths started
 * writing to this table. Those callers are careful — they record identifiers,
 * counts and states — but "careful when I last looked" is not a property a log
 * viewer should depend on, and a viewer is exactly where an unnoticed filename
 * would end up on a screen.
 *
 * So the read side has its own list. It is a superset of the write list because
 * it covers other subsystems' vocabulary, and every entry is a field whose
 * meaning was checked against what actually writes it.
 */
const READABLE_METADATA_KEYS = new Set([
  ...ALLOWED_METADATA_KEYS,
  // Upload and document processing.
  "fileId",
  "fileCount",
  "kind",
  "sizeBytes",
  "pageCount",
  "rejectionCode",
  "previousStatus",
  "processingRevision",
  "attempt",
  "attempts",
  // Sessions and their lifecycle.
  "state",
  "terminalReason",
  "settingsRevision",
  "quoteId",
  // Money. Amounts and states only; no provider secret has ever been written
  // here and none may start being displayed if one is.
  "paymentId",
  "refundId",
  "amountMinor",
  "currency",
  "provider",
  "status",
  // Printing.
  "printJobId",
  "operationId",
  "confidence",
  "sheetsProduced",
  "warningCode",
  // Retention.
  "checkpoint",
  "objectsDeleted",
  "orphanObjectsDeleted",
  "multipartUploadsAborted",
  "deadLettered"
]);

export interface ProjectedAuditMetadata {
  metadata: Record<string, string | number | boolean>;
  /** Names of the keys that were withheld, so nothing is hidden silently. */
  redactedKeys: string[];
}

/**
 * Project a stored metadata blob into what the viewer may show.
 *
 * Unknown keys are reported by name rather than dropped invisibly: an operator
 * chasing an incident should be able to see that a field exists and ask for it
 * to be allow-listed, instead of concluding the system never recorded it.
 * The name of a key is safe to show; the value it holds is what is not.
 *
 * Nested objects and arrays are refused whatever their key. A structured value
 * is how an entire file record gets carried along by a caller that only meant
 * to add context, and there is no operational question that needs one.
 */
export function projectAuditMetadata(stored: unknown): ProjectedAuditMetadata {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
    return { metadata: {}, redactedKeys: [] };
  }

  const metadata: Record<string, string | number | boolean> = {};
  const redactedKeys: string[] = [];

  for (const [key, value] of Object.entries(stored as Record<string, unknown>)) {
    if (value === null || value === undefined) continue;
    const displayable =
      typeof value === "string" || typeof value === "number" || typeof value === "boolean";
    if (!READABLE_METADATA_KEYS.has(key) || !displayable) {
      // Bound the key name too: it comes from stored JSON, not from this file.
      redactedKeys.push(key.slice(0, 60));
      continue;
    }
    metadata[key] = typeof value === "string" ? value.slice(0, 200) : value;
  }

  return { metadata, redactedKeys };
}
