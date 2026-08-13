import type { PrismaClient } from "@printing-kiosk/database";

/**
 * The database as the control plane is allowed to change what a customer pays.
 *
 * The fifth of these, and the only one that can change what a customer pays.
 *
 * The narrowing follows `people-database.ts`, because this is the second surface
 * that has to change a row rather than add one: `updateMany` is the only
 * mutating method on `pricingRuleSet`, so archiving the tariff being replaced
 * carries the predicate it was authorized against — "archive this tariff **if it
 * is still the published one**" — and the row count answers whether the world
 * was still what the Admin confirmed against. A publication that raced another
 * publication loses rather than wins.
 *
 * What is absent:
 *
 *   - There is no `update`, `upsert` or `delete` on the publication record. What
 *     was published, by whom, cannot be rewritten by the connection that wrote
 *     it — nor by any other, the database refuses it outright.
 *   - There is no `update` on `pricingRule`, and no `delete` anywhere. A
 *     published tariff is replaced, never edited and never removed.
 *   - There is no `priceQuote` at all. What a customer was already told they
 *     would pay is evidence, and a new tariff does not reach backwards.
 *   - There is no `payment` and no `refund`. Changing a price is not a money
 *     movement and touches no ledger.
 */

/** Reads used to revalidate a publication inside the transaction that writes. */
type ReadOnly<TDelegate> = Pick<
  TDelegate,
  Extract<keyof TDelegate, "findFirst" | "findUnique" | "findMany" | "count">
>;

/** A table a publication may add a row to, and nothing else. */
type Appendable<TDelegate> = ReadOnly<TDelegate> &
  Pick<TDelegate, Extract<keyof TDelegate, "create">>;

/**
 * A table whose existing rows may be changed, but only through a conditional
 * write. `update` and `upsert` are excluded on purpose — see the note above.
 */
type ConditionallyUpdatable<TDelegate> = ReadOnly<TDelegate> &
  Pick<TDelegate, Extract<keyof TDelegate, "updateMany">>;

export interface AdminPricingDatabase {
  /**
   * The new tariff, and the archival of the one it replaces. `create` for the
   * successor, `updateMany` for the predecessor: three columns of it, in
   * practice, because that is all the role's grant covers.
   */
  pricingRuleSet: ConditionallyUpdatable<PrismaClient["pricingRuleSet"]> &
    Appendable<PrismaClient["pricingRuleSet"]>;
  /** The numbers. Exactly one row per tariff, and never updatable. */
  pricingRule: Appendable<PrismaClient["pricingRule"]>;
  /**
   * Who published this tariff, and why. A trigger refuses a row naming anybody
   * but an active Admin, and a deferred trigger refuses at COMMIT any tariff
   * this row does not match byte for byte.
   */
  adminChangeExecution: Appendable<PrismaClient["adminChangeExecution"]>;
  /** Every publication records itself, including the ones that were refused. */
  auditEvent: Appendable<PrismaClient["auditEvent"]>;

  /** Read-only, so the record names a person rather than a UUID. */
  adminUser: ReadOnly<PrismaClient["adminUser"]>;

  $transaction<TResult>(
    handler: (transaction: AdminPricingTransaction) => Promise<TResult>,
    options?: { timeout?: number; maxWait?: number }
  ): Promise<TResult>;
}

/** The same surface inside a transaction, written out for the usual reason. */
export interface AdminPricingTransaction {
  pricingRuleSet: ConditionallyUpdatable<PrismaClient["pricingRuleSet"]> &
    Appendable<PrismaClient["pricingRuleSet"]>;
  pricingRule: Appendable<PrismaClient["pricingRule"]>;
  adminChangeExecution: Appendable<PrismaClient["adminChangeExecution"]>;
  auditEvent: Appendable<PrismaClient["auditEvent"]>;
  adminUser: ReadOnly<PrismaClient["adminUser"]>;
}

/**
 * Narrow the full client to the publication surface.
 *
 * The cast is the one place the wider client is discarded, and it is why the
 * pricing pool must be constructed with `createAdminPricingClient` and pointed
 * at the pricing role: this function removes methods from the *type*, not
 * privileges from the connection.
 */
export function asAdminPricingDatabase(client: PrismaClient): AdminPricingDatabase {
  return client;
}
