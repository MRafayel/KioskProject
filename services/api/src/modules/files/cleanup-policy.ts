/**
 * Worker artifact uploads have a hard 30-second storage-operation deadline.
 * Once a processing claim is revoked, keep its ledger discoverable for one
 * additional safety window before deleting keys or rows. This lets an in-flight
 * PUT finish/abort and makes a late object visible to the durable janitor.
 */
export const PROCESSING_ARTIFACT_SETTLE_MILLISECONDS = 35_000;

export function processingArtifactCleanupDueAt(now: Date): Date {
  return new Date(now.getTime() + PROCESSING_ARTIFACT_SETTLE_MILLISECONDS);
}
