import { z } from "zod";

/**
 * Changing what every customer is charged.
 *
 * Every other action an Admin performs is bounded to one thing: one print, one
 * session, one obligation, one colleague's account. Publishing a tariff is not
 * bounded to anything — it changes what every future customer pays, at every
 * kiosk, from the moment it commits, and the person paying cannot see that it
 * changed. So it gets more care than a refund does. It does not get a second
 * person: this system has one Admin, and a workflow that waits for a colleague
 * who does not exist is a workflow that never runs.
 *
 * What replaces the second person is not weaker, but it is different in kind. A
 * second approver would have *prevented* a bad publication. What is here instead
 * makes one impossible to perform quietly or to disown afterwards:
 *
 *   1. **You publish what you were shown.** The preview returns the digest of
 *      the exact tariff it priced out, and publishing requires echoing it back.
 *      A form edited between reading the numbers and pressing the button
 *      publishes nothing.
 *   2. **The database will not publish an unrecorded tariff.** A deferred
 *      constraint trigger recomputes the canonical digest from the rows actually
 *      written and refuses at COMMIT unless a publication record names that rule
 *      set with that digest. "Publish something other than what was confirmed"
 *      is not a bug that can happen.
 *   3. **The record is append-only and names a person.** Who published it, when,
 *      why, against which previous tariff, and what it produced — on a row no
 *      connection in this system can edit or delete.
 *
 * The accepted risk is stated plainly because it should be: a compromised Admin
 * session can change the prices. What it cannot do is change them without
 * leaving a record it cannot alter.
 */

// ---------------------------------------------------------------------------
// What may be published
// ---------------------------------------------------------------------------

/**
 * The kinds of change this workflow carries.
 *
 * A closed vocabulary, mirrored by a check constraint. One entry today, and the
 * list is short on purpose: a change log with many kinds is one where nobody can
 * say what a row in it means.
 */
export const CHANGE_KINDS = ["PRICING_PUBLISH"] as const;

export type ChangeKind = (typeof CHANGE_KINDS)[number];

/**
 * A reason, and a real one.
 *
 * Nobody reviews this at the time — there is nobody else to. It is written for
 * the person reading the change log in six months asking why the price of a page
 * went up in August, and that person is usually the one who wrote it.
 */
export const changeReasonSchema = z
  .string()
  .trim()
  .min(8, "Say why — at least a few words.")
  .max(280);

/**
 * A published tariff, as a person may write it.
 *
 * Every bound here is the database's own, restated so that an impossible number
 * is refused with a message rather than a constraint violation. What is *not*
 * here matters more:
 *
 *   - **No currency and no exponent.** They are read from the tariff being
 *     replaced. A tariff change that could redenominate the money would be able
 *     to make every historical price mean something else.
 *   - **No scope.** `GLOBAL` with an empty scope ref is the only scope this
 *     system prices in, and the published-per-scope unique index is what makes
 *     "one tariff in force" true.
 *   - **No validity window.** A published tariff takes effect when it commits
 *     and stays in force until the next one replaces it. Anything else needs a
 *     window in which no tariff covers `now`, and the quote path answers that
 *     with a 503 — a priced-out kiosk is a stopped kiosk.
 *   - **No rule list.** The database pins service, paper size and colour mode to
 *     one value each, so a tariff is exactly one rule and the form is the rule.
 */
export const pricingPublishPayloadSchema = z
  .object({
    /**
     * The version string customers' quotes will carry. Supplied rather than
     * generated: it is what somebody will say out loud when asked which prices
     * were in force, and a generated one would be a UUID nobody can say.
     */
    version: z
      .string()
      .trim()
      .min(3)
      .max(40)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u, "Letters, digits, dot, dash and underscore only."),
    /** Charged per printed side. Duplex changes paper, not ink. */
    unitAmountMinor: z.number().int().min(0).max(100_000_000),
    /** Signed, applied to the print charge when the output is double-sided. */
    duplexAdjustmentBasisPoints: z.number().int().min(-10_000).max(10_000),
    serviceFeeMinor: z.number().int().min(0).max(100_000_000),
    minimumAmountMinor: z.number().int().min(0).max(100_000_000),
    taxBasisPoints: z.number().int().min(0).max(10_000)
  })
  .strict();

export type PricingPublishPayload = z.infer<typeof pricingPublishPayloadSchema>;

/**
 * The payload of a change, discriminated by its kind.
 *
 * A union of one today. Written as a union anyway so that a second kind is a new
 * member rather than a rewrite of every signature that carries one.
 */
export const changePayloadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("PRICING_PUBLISH"), pricing: pricingPublishPayloadSchema }).strict()
]);

export type ChangePayload = z.infer<typeof changePayloadSchema>;

// ---------------------------------------------------------------------------
// The digest that makes a confirmation mean something
// ---------------------------------------------------------------------------

/**
 * The exact text a change's digest is taken over.
 *
 * This function is the contract between three parties that must agree or the
 * confirmation is theatre: the payload sent, the numbers the Admin was shown,
 * and the rows that end up in `pricing_rule_sets`. The database recomputes this
 * same string from what was actually written and refuses at COMMIT if the digest
 * does not match the publication record — so "confirm one tariff, publish
 * another" is not a bug that can happen, rather than one that has not happened
 * yet.
 *
 * The format is chosen to be reproducible in SQL without a single decision:
 * fixed line order, no optional fields, no floating point, integers rendered the
 * one way both languages render them, and a separator (`|`) that none of the
 * values can contain — the version is regex-bounded and every other field is a
 * number or a fixed vocabulary word.
 *
 * Changing this format changes every digest. It is versioned in its own first
 * line for exactly that reason: a v2 is a new line, not a silent reinterpretation
 * of the rows a v1 record accounts for.
 */
export function canonicalPricingPublishText(input: {
  scope: string;
  scopeRef: string;
  currency: string;
  currencyExponent: number;
  rounding: string;
  taxMode: string;
  minimumApplication: string;
  payload: PricingPublishPayload;
}): string {
  const { payload } = input;
  return [
    "pricing.publish/v1",
    `version=${payload.version}`,
    [
      `scope=${input.scope}`,
      `ref=${input.scopeRef}`,
      `currency=${input.currency}`,
      `exponent=${input.currencyExponent}`,
      `rounding=${input.rounding}`,
      `tax=${input.taxMode}`,
      `minimum=${input.minimumApplication}`
    ].join("|"),
    [
      "rule=PRINT",
      "A4",
      "MONOCHROME",
      String(payload.unitAmountMinor),
      String(payload.duplexAdjustmentBasisPoints),
      String(payload.serviceFeeMinor),
      String(payload.minimumAmountMinor),
      String(payload.taxBasisPoints),
      "0"
    ].join("|")
  ].join("\n");
}

/** The fixed vocabulary the one rule a tariff may contain is pinned to. */
export const PRICING_PUBLISH_SERVICE = "PRINT";
export const PRICING_PUBLISH_PAPER_SIZE = "A4";
export const PRICING_PUBLISH_COLOR_MODE = "MONOCHROME";
export const PRICING_PUBLISH_SCOPE = "GLOBAL";
export const PRICING_PUBLISH_SCOPE_REF = "";
/** Every rule in a one-rule tariff has the same priority, and it is not a choice. */
export const PRICING_PUBLISH_PRIORITY = 0;

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/**
 * Price a change out without making it.
 *
 * Writes nothing. Its only job is to turn basis points into money an Admin can
 * read, and to hand back the two digests the publish call has to echo. Confirming
 * a set of basis points nobody has multiplied out is how a review becomes a
 * rubber stamp, so the panel cannot offer the button until this has answered.
 */
export const previewChangeBodySchema = z.object({ payload: changePayloadSchema }).strict();

export type PreviewChangeBody = z.infer<typeof previewChangeBodySchema>;

export const publishChangeBodySchema = z
  .object({
    payload: changePayloadSchema,
    /**
     * The digest of the tariff the Admin was shown priced out.
     *
     * Recomputed from `payload` on arrival and compared. They disagree only if
     * the form changed after the preview, which is exactly the case worth
     * refusing: it means the numbers on screen are not the numbers being
     * published.
     */
    payloadDigest: digestSchema,
    /**
     * The digest of the tariff that was in force when the preview was taken.
     *
     * Compared with the live one before anything is written. It differs only if
     * the prices moved in between — a second browser tab, another session — and
     * that is a refusal rather than a publication on top of numbers nobody
     * compared against.
     */
    baselineDigest: digestSchema,
    reason: changeReasonSchema
  })
  .strict();

export type PublishChangeBody = z.infer<typeof publishChangeBodySchema>;

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

/**
 * One line of the effect a change would have.
 *
 * Computed by the server from the pure pricing functions the kiosk itself quotes
 * with, so an Admin is shown the arithmetic rather than the parameters.
 */
export const pricingPreviewRowSchema = z.object({
  label: z.string().max(60),
  currentTotalMinor: z.number().int().nonnegative().nullable(),
  proposedTotalMinor: z.number().int().nonnegative(),
  differenceMinor: z.number().int()
});

export const changePreviewSchema = z.object({
  kind: z.literal("PRICING_PUBLISH"),
  currency: z.string().length(3),
  currencyExponent: z.number().int().min(0).max(4),
  /** The version being replaced, or null when nothing is published yet. */
  currentVersion: z.string().max(40).nullable(),
  rows: z.array(pricingPreviewRowSchema).max(8),
  /** Echoed back by the publish call. See `publishChangeBodySchema`. */
  payloadDigest: digestSchema,
  baselineDigest: digestSchema
});

export type ChangePreview = z.infer<typeof changePreviewSchema>;

export const previewChangeResponseSchema = z.object({
  preview: changePreviewSchema,
  /**
   * Restates the boundary in the response itself, the way every other action in
   * this system does. A preview changes no price.
   */
  published: z.literal(false)
});

export type PreviewChangeResponse = z.infer<typeof previewChangeResponseSchema>;

/**
 * A change that happened.
 *
 * There is no pending state and no state column, because there is nothing for a
 * change to be except done — it is written by the request that performs it, in
 * the transaction that performs it. A row here is a past tense.
 */
export const adminChangeSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(CHANGE_KINDS),
  payload: changePayloadSchema,
  payloadDigest: digestSchema,
  /** The digest of the tariff this one replaced, kept so the chain is checkable. */
  baselineDigest: digestSchema,
  reason: z.string().max(280),
  publishedByAdminUserId: z.string().uuid(),
  publishedByDisplayName: z.string().max(120).nullable(),
  publishedByRole: z.string().max(24),
  publishedAt: z.string().datetime(),
  /** The version this produced, and the one it replaced. */
  resultRef: z.string().max(64),
  replacedRef: z.string().max(64).nullable(),
  /** True for the row whose tariff is the one kiosks are quoting right now. */
  inForce: z.boolean()
});

export type AdminChange = z.infer<typeof adminChangeSchema>;

/** The tariff in force, in the same shape the form takes. */
export const currentTariffSchema = z.object({
  version: z.string().max(40),
  currency: z.string().length(3),
  currencyExponent: z.number().int().min(0).max(4),
  unitAmountMinor: z.number().int(),
  duplexAdjustmentBasisPoints: z.number().int(),
  serviceFeeMinor: z.number().int(),
  minimumAmountMinor: z.number().int(),
  taxBasisPoints: z.number().int(),
  publishedAt: z.string().datetime().nullable(),
  /** Opens the form without inventing numbers, and seeds the publish call. */
  baselineDigest: digestSchema
});

export const adminChangesResponseSchema = z.object({
  changes: z.array(adminChangeSchema).max(50),
  current: currentTariffSchema.nullable()
});

export type AdminChangesResponse = z.infer<typeof adminChangesResponseSchema>;

export const publishChangeResponseSchema = z.object({
  change: adminChangeSchema,
  publishedVersion: z.string().max(40),
  replacedVersion: z.string().max(40).nullable(),
  /**
   * True, and the only place in the control plane where a response says so. By
   * the time this is read, kiosks are quoting the new prices.
   */
  published: z.literal(true)
});

export type PublishChangeResponse = z.infer<typeof publishChangeResponseSchema>;

// ---------------------------------------------------------------------------
// The baskets the preview is computed over
// ---------------------------------------------------------------------------

/**
 * Representative jobs, chosen to show what a tariff actually does.
 *
 * One page exposes the minimum charge, which is the number people forget is
 * there. Ten single-sided is the ordinary case. Ten double-sided is the only
 * place the duplex adjustment appears at all. Fifty is where a per-side price
 * stops being small change.
 *
 * Held here rather than in the API so the panel can label a row without knowing
 * how it was computed, and so the four baskets are one list rather than two that
 * drift.
 */
export const PRICING_PREVIEW_BASKETS = [
  {
    label: "1 page, single-sided",
    selectedPages: 1,
    printedSides: 1,
    physicalSheets: 1,
    duplex: false
  },
  {
    label: "10 pages, single-sided",
    selectedPages: 10,
    printedSides: 10,
    physicalSheets: 10,
    duplex: false
  },
  {
    label: "10 pages, double-sided",
    selectedPages: 10,
    printedSides: 10,
    physicalSheets: 5,
    duplex: true
  },
  {
    label: "50 pages, double-sided",
    selectedPages: 50,
    printedSides: 50,
    physicalSheets: 25,
    duplex: true
  }
] as const;
