import type { PrismaClient } from "@printing-kiosk/database";

/**
 * The database as the control plane is allowed to change a person in it.
 *
 * Its three siblings narrow the client to "cannot write" (`read-database.ts`),
 * "can append operator facts" (`write-database.ts`) and "can raise one monetary
 * obligation" (`refund-database.ts`). This one is the first that has to allow an
 * edit, so the narrowing works differently: `update` is absent everywhere, and
 * the only mutating method exposed is `updateMany`.
 *
 * That is not a style preference. `updateMany` takes a `where` clause, so every
 * change on this connection is written as a conditional write — "suspend this
 * account **if it is still ACTIVE and still an Operator**" — and the row count
 * is the answer to whether the state was still what the caller had authorized
 * against. `update({ where: { id } })` would let a request that raced a
 * suspension, a role check or a logout win anyway. Phase 1's identity code
 * already writes this way; here the type makes it the only option.
 *
 * What is absent matters more than what is present:
 *
 *   - There is no `create` on `adminUser`, `adminAuthenticator` or
 *     `adminSession`. This connection cannot bring an account, a credential or a
 *     session into existence — only end one.
 *   - There is no `delete` or `deleteMany` anywhere. Retiring a key, ending a
 *     session and taking a kiosk away are timestamps on rows that stay.
 *   - There is no `adminWebAuthnChallenge` and no `adminBreakGlassCredential` at
 *     all, so nothing here can stand in the middle of somebody's ceremony or
 *     touch the sealed recovery path.
 *   - There is no product model of any kind. No print job, no payment, no
 *     refund, no document. Administering people and touching the printing system
 *     are different jobs, and this connection can only do one of them.
 *
 * This is the third statement of the phase gate. The people role's grants refuse
 * the statement at the database — column by column, so `admin_users.role` is
 * unreachable even though `admin_users.status` is not. The triggers refuse the
 * row. This refuses the code.
 */

/** Reads used to revalidate a people action inside the transaction that writes. */
type ReadOnly<TDelegate> = Pick<
  TDelegate,
  Extract<keyof TDelegate, "findFirst" | "findUnique" | "findMany" | "count">
>;

/** A table this connection may add a row to, and nothing else. */
type Appendable<TDelegate> = ReadOnly<TDelegate> &
  Pick<TDelegate, Extract<keyof TDelegate, "create">>;

/**
 * A table whose existing rows may be changed, but only through a conditional
 * write. `update` and `upsert` are excluded on purpose — see the note above.
 */
type ConditionallyUpdatable<TDelegate> = ReadOnly<TDelegate> &
  Pick<TDelegate, Extract<keyof TDelegate, "updateMany">>;

export interface AdminPeopleDatabase {
  /**
   * Status only, in practice: the role's grant covers four columns and `role`
   * is not one of them, so a call that tried to write it fails at the database
   * rather than at review.
   */
  adminUser: ConditionallyUpdatable<PrismaClient["adminUser"]>;
  /** Retiring a key. There is no `create`: enrolment needs a ceremony. */
  adminAuthenticator: ConditionallyUpdatable<PrismaClient["adminAuthenticator"]>;
  /** Ending a session. There is no `create`: signing in is not a people action. */
  adminSession: ConditionallyUpdatable<PrismaClient["adminSession"]>;
  /**
   * Assigning a kiosk, and taking one back. Both: a first assignment appends,
   * and every change after that sets or clears `revokedAt` on the row already
   * there, so the pair never accumulates duplicates.
   */
  adminKioskScope: ConditionallyUpdatable<PrismaClient["adminKioskScope"]> &
    Appendable<PrismaClient["adminKioskScope"]>;
  /**
   * Authorising one enrolment ceremony. Appendable only — a ticket is marked
   * consumed by the redemption path on the application connection, which is the
   * only one that can match a presented code against the stored digest.
   */
  adminEnrollmentTicket: Appendable<PrismaClient["adminEnrollmentTicket"]>;
  /** Every people action records itself, including the ones that were refused. */
  auditEvent: Appendable<PrismaClient["auditEvent"]>;

  /** Read-only: an assignment must name a kiosk that exists. */
  kiosk: ReadOnly<PrismaClient["kiosk"]>;

  $transaction<TResult>(
    handler: (transaction: AdminPeopleTransaction) => Promise<TResult>,
    options?: { timeout?: number; maxWait?: number }
  ): Promise<TResult>;
}

/**
 * The same surface inside a transaction.
 *
 * Written out rather than derived from `Prisma.TransactionClient` for the same
 * reason as its siblings: a transaction handle typed as the full client would
 * hand back every model and every method the moment an action opened one, which
 * is exactly when the narrowing matters most.
 */
export interface AdminPeopleTransaction {
  adminUser: ConditionallyUpdatable<PrismaClient["adminUser"]>;
  adminAuthenticator: ConditionallyUpdatable<PrismaClient["adminAuthenticator"]>;
  adminSession: ConditionallyUpdatable<PrismaClient["adminSession"]>;
  adminKioskScope: ConditionallyUpdatable<PrismaClient["adminKioskScope"]> &
    Appendable<PrismaClient["adminKioskScope"]>;
  adminEnrollmentTicket: Appendable<PrismaClient["adminEnrollmentTicket"]>;
  auditEvent: Appendable<PrismaClient["auditEvent"]>;
  kiosk: ReadOnly<PrismaClient["kiosk"]>;
}

/**
 * Narrow the full client to the people surface.
 *
 * The cast is the one place the wider client is discarded, and it is why the
 * people pool must be constructed with `createAdminPeopleClient` and pointed at
 * the people role: this function removes methods from the *type*, not privileges
 * from the connection.
 */
export function asAdminPeopleDatabase(client: PrismaClient): AdminPeopleDatabase {
  return client;
}
