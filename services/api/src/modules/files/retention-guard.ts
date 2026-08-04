import type { PrismaClient } from "@printing-kiosk/database";

import { ApiError } from "../sessions/errors.js";

/**
 * A session whose documents retention has deleted answers `410`, not `404`.
 *
 * The difference matters to the caller: `404` invites a retry against a
 * resource that might appear, while `410` says the bytes existed, were the
 * customer's, and are permanently gone. It is only ever returned to a caller
 * that has already been authorized for the session, so it discloses nothing
 * about a session somebody does not own.
 */
export function sessionFilesDeleted(): ApiError {
  return new ApiError(410, "SESSION_FILES_DELETED", "These documents have been deleted.");
}

/** Throw `410` when the named session has already been emptied by retention. */
export async function assertSessionDocumentsAvailable(
  database: PrismaClient,
  sessionId: string
): Promise<void> {
  const session = await database.printSession.findUnique({
    where: { id: sessionId },
    select: { filesDeletedAt: true }
  });
  if (session?.filesDeletedAt) throw sessionFilesDeleted();
}
