import type { Prisma } from "./generated/prisma/client.js";

/**
 * Why a price stopped being payable. These values are also the database
 * constraint's allowed set for `price_quotes.invalidation_reason`.
 */
export type QuoteInvalidationReason =
  "SETTINGS_CHANGED" | "DOCUMENTS_CHANGED" | "SUPERSEDED" | "SESSION_TERMINAL";

export interface SessionPricingInvalidation {
  /**
   * The event sequence the caller must persist on the session. It advances
   * only when an invalidation event was actually written.
   */
  nextSequence: number;
  invalidatedQuoteId: string | null;
}

/**
 * Retire the session's active quote inside the caller's transaction.
 *
 * A price is a promise about an exact ordered document set and an exact
 * settings revision. The moment either changes — a document is added, removed,
 * reprocessed, or the customer edits their choices — the promise is void. This
 * is deliberately one shared implementation: the API and the document worker
 * both change the priced material, and the two must not drift into disagreeing
 * about when a total stops being payable.
 *
 * The caller is responsible for writing `nextSequence` onto the session row
 * together with whatever other events it emits.
 */
export async function invalidateSessionPricing(
  transaction: Prisma.TransactionClient,
  input: {
    sessionId: string;
    reason: QuoteInvalidationReason;
    now: Date;
    startingSequence: number;
    newEventId: () => string;
    clearSettingsRevision: boolean;
  }
): Promise<SessionPricingInvalidation> {
  const active = await transaction.priceQuote.findFirst({
    where: { sessionId: input.sessionId, status: "ACTIVE" },
    select: { id: true }
  });

  await transaction.printSession.update({
    where: { id: input.sessionId },
    data: {
      activeQuoteId: null,
      ...(input.clearSettingsRevision ? { currentSettingsRevision: null } : {})
    }
  });

  if (!active) {
    return { nextSequence: input.startingSequence, invalidatedQuoteId: null };
  }

  const retired = await transaction.priceQuote.updateMany({
    where: { id: active.id, sessionId: input.sessionId, status: "ACTIVE" },
    data: {
      status: "INVALIDATED",
      invalidatedAt: input.now,
      invalidationReason: input.reason
    }
  });
  if (retired.count !== 1) {
    return { nextSequence: input.startingSequence, invalidatedQuoteId: null };
  }

  const sequence = input.startingSequence + 1;
  await transaction.outboxEvent.create({
    data: {
      id: input.newEventId(),
      aggregateType: "PRINT_SESSION",
      aggregateId: input.sessionId,
      sequence,
      type: "quote.invalidated",
      payload: { sessionId: input.sessionId, quoteId: active.id, reason: input.reason }
    }
  });

  return { nextSequence: sequence, invalidatedQuoteId: active.id };
}
