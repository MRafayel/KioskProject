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
  "stepUpFresh"
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

type TransactionClient = PrismaClient | Prisma.TransactionClient;

export async function writeAdminAuditEvent(
  client: TransactionClient,
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
