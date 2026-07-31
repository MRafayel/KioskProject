import { Prisma } from "@printing-kiosk/database";

/**
 * Whether a failed transaction was a concurrency conflict that the caller may
 * simply run again.
 *
 * Every module that locks a session with `SELECT ... FOR UPDATE` inside a
 * serializable transaction needs this exact judgement, and getting it wrong is
 * not a cosmetic mistake: a conflict that is not recognised here surfaces to a
 * customer as a 500 instead of the retry or the version conflict the API
 * contract promises. It lives in one place so the modules cannot disagree.
 */
export function isRetryableTransactionError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) {
    // The driver adapter reports a serializable conflict as its own error type
    // rather than a Prisma code.
    return (
      error instanceof Error &&
      error.name === "DriverAdapterError" &&
      error.message === "TransactionWriteConflict"
    );
  }

  const code = Reflect.get(error, "code");
  if (code === "P2034") return true;

  // Prisma surfaces a PostgreSQL serialization failure raised by a raw
  // SELECT ... FOR UPDATE as P2010 instead of P2034. Retry only the two
  // PostgreSQL transaction-conflict SQLSTATEs; every other raw-query error must
  // stay visible rather than being mistaken for a safe concurrency retry.
  if (code !== "P2010" || !("meta" in error)) return false;
  const databaseCode = getDriverDatabaseCode(Reflect.get(error, "meta"));
  return databaseCode === "40001" || databaseCode === "40P01";
}

/** A unique-constraint violation, whatever the constraint was. */
export function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function getDriverDatabaseCode(meta: unknown): unknown {
  if (!meta || typeof meta !== "object" || !("driverAdapterError" in meta)) return undefined;
  const driverAdapterError = Reflect.get(meta, "driverAdapterError");
  if (
    !driverAdapterError ||
    typeof driverAdapterError !== "object" ||
    !("cause" in driverAdapterError)
  ) {
    return undefined;
  }
  const cause = Reflect.get(driverAdapterError, "cause");
  if (!cause || typeof cause !== "object" || !("originalCode" in cause)) return undefined;
  return Reflect.get(cause, "originalCode");
}
