/**
 * The retention timings and the terminal-session cleanup transition live with
 * the database helpers, so the API, the janitor and the print settlement path
 * cannot drift apart about when a finished session's artifacts become
 * deletable. This module keeps the local import path the files module uses.
 */
export {
  MAX_UPLOAD_ARTIFACT_SETTLE_MILLISECONDS,
  processingArtifactCleanupDueAt,
  scheduleSessionFilesForCleanup,
  uploadArtifactCleanupDueAt,
  PROCESSING_ARTIFACT_SETTLE_MILLISECONDS,
  UPLOAD_ARTIFACT_SETTLE_PADDING_MILLISECONDS
} from "@printing-kiosk/database";
