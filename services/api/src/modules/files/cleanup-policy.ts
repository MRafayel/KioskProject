/**
 * The retention timings and the terminal-session cleanup transition live with
 * the database helpers, so the API, the janitor and the print settlement path
 * cannot drift apart about when a finished session's artifacts become
 * deletable. This module keeps the local import path the files module uses.
 */
export {
  processingArtifactCleanupDueAt,
  scheduleSessionFilesForCleanup,
  PROCESSING_ARTIFACT_SETTLE_MILLISECONDS
} from "@printing-kiosk/database";
