import { isAbsolute } from "node:path";

import { PrinterAdapterError, type PrintOperationStatus, type PrintSubmission } from "./types.js";

export const OPERATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/**
 * What every adapter checks before a device is touched.
 *
 * The control plane already validated the manifest, and the agent already
 * verified each artifact's digest against it. This is the third check, and it
 * exists because it is the last one before bytes leave for hardware: a manifest
 * and a set of artifacts that disagree about which document is which must fail
 * here rather than print the wrong page count under a paid quote.
 */
export function assertSubmittable(submission: PrintSubmission): void {
  if (!OPERATION_ID_PATTERN.test(submission.operationId)) {
    throw new PrinterAdapterError("OPERATION_ID_INVALID");
  }

  const manifest = submission.manifest;
  if (
    manifest.documents.length !== submission.artifacts.length ||
    submission.artifacts.length === 0 ||
    manifest.physicalSheets < 1 ||
    // Every document carries its own copy count, so a job is submittable only
    // when each of them asks for at least one copy.
    manifest.documents.some((document) => document.copies < 1)
  ) {
    throw new PrinterAdapterError("MANIFEST_INVALID");
  }

  const expectedByDocument = new Map(
    manifest.documents.map((document) => [document.documentId, document] as const)
  );
  if (expectedByDocument.size !== manifest.documents.length) {
    throw new PrinterAdapterError("MANIFEST_INVALID");
  }

  const seenDocuments = new Set<string>();
  const seenPositions = new Set<number>();
  for (const artifact of submission.artifacts) {
    const expected = expectedByDocument.get(artifact.documentId);
    if (
      !expected ||
      seenDocuments.has(artifact.documentId) ||
      seenPositions.has(artifact.position) ||
      expected.position !== artifact.position ||
      expected.sha256 !== artifact.sha256 ||
      expected.sizeBytes !== artifact.sizeBytes ||
      !isAbsolute(artifact.path) ||
      artifact.sizeBytes < 1 ||
      !/^[0-9a-f]{64}$/u.test(artifact.sha256) ||
      !Number.isSafeInteger(artifact.position) ||
      artifact.position < 0 ||
      artifact.position > 999
    ) {
      throw new PrinterAdapterError("ARTIFACT_UNAVAILABLE");
    }
    seenDocuments.add(artifact.documentId);
    seenPositions.add(artifact.position);
  }
}

/** Fill in the fields every adapter reports the same way. */
export function operationStatus(
  operationId: string,
  input: Omit<PrintOperationStatus, "operationId" | "warningCode"> &
    Partial<Pick<PrintOperationStatus, "warningCode">>
): PrintOperationStatus {
  return {
    operationId,
    state: input.state,
    confidence: input.confidence,
    failureCode: input.failureCode,
    warningCode: input.warningCode ?? null,
    sheetsProduced: input.sheetsProduced
  };
}

/**
 * Downgrade a claim the numbers do not support.
 *
 * An adapter that talks to something outside this process — a device host, a
 * queue, a driver — is repeating somebody else's account of what happened. That
 * account may say `CONFIRMED` because the software believes the job left the
 * spooler, which is not the same as paper. Only two shapes survive as confirmed
 * here: a completion the device counted sheets for, and a failure or refusal
 * that proved no sheet was produced. Everything else becomes unconfirmed and is
 * settled by a person rather than by a status column.
 */
export function withHonestConfidence(status: PrintOperationStatus): PrintOperationStatus {
  if (status.confidence !== "CONFIRMED") return status;

  const confirmable =
    status.state === "COMPLETED"
      ? status.sheetsProduced !== null && status.sheetsProduced > 0
      : status.sheetsProduced === 0 &&
        (status.state === "FAILED" ||
          status.state === "CANCELED" ||
          status.state === "NOT_SUBMITTED");

  return confirmable ? status : { ...status, confidence: "UNCONFIRMED" };
}

/**
 * A device that reached the end of the work without saying what came out.
 *
 * Reported as unknown on purpose: this is precisely the state a blind retry
 * would turn into a second printed job, and the one the settlement reducer
 * routes to a person instead of guessing at.
 */
export function unknownStatus(operationId: string): PrintOperationStatus {
  return operationStatus(operationId, {
    state: "UNKNOWN",
    confidence: "UNCONFIRMED",
    failureCode: "SUBMISSION_UNCONFIRMED",
    sheetsProduced: null
  });
}
