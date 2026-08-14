import { createHash } from "node:crypto";

import {
  PRICING_PREVIEW_BASKETS,
  PRICING_PUBLISH_COLOR_MODE,
  PRICING_PUBLISH_PAPER_SIZE,
  PRICING_PUBLISH_PRIORITY,
  PRICING_PUBLISH_SCOPE,
  PRICING_PUBLISH_SCOPE_REF,
  PRICING_PUBLISH_SERVICE,
  canonicalPricingPublishText,
  type AdminChange,
  type ChangePayload,
  type ChangePreview,
  type PreviewChangeBody,
  type PreviewChangeResponse,
  type PricingPublishPayload,
  type PublishChangeBody,
  type PublishChangeResponse
} from "@printing-kiosk/admin-access";
import { calculateQuote, PricingError } from "@printing-kiosk/pricing";

import type { Clock, RandomSource } from "../sessions/crypto.js";
import { ApiError } from "../sessions/errors.js";
import { writeAdminAuditEvent, type AdminAuditMetadataValue } from "./audit.js";
import type { AdminPricingDatabase } from "./pricing-database.js";
import type { AdminReadDatabase } from "./read-database.js";
import type { AuthenticatedAdmin } from "./service.js";

/**
 * Publishing a tariff: the widest-reaching thing an Admin can do.
 *
 * The flow is deliberately one step. An Admin previews the change — which prices
 * four representative jobs with the same pure function the kiosk quotes with —
 * confirms with a security key, and the publication happens in a single
 * transaction. There is no proposal, no pending queue, and no second approver:
 * this system has one Admin, and a rule that waited for a colleague who does not
 * exist would stop the business rather than protect it.
 *
 * What stands in for the second person is evidence rather than prevention, and
 * three of the four pieces are outside this file on purpose:
 *
 *   - the **preview** returns the digest of the tariff it priced, and publishing
 *     requires echoing it back, so a form edited after the numbers were read
 *     publishes nothing;
 *   - the **baseline digest** is compared against the tariff actually in force,
 *     so a publication written against prices that have since moved is refused
 *     rather than applied on top;
 *   - a **deferred database trigger** recomputes the canonical digest from the
 *     rows that were written and refuses at COMMIT unless an append-only record
 *     accounts for exactly those numbers;
 *   - the **pricing pool** is the only connection in the system that can write a
 *     tariff at all, and it can neither edit one nor delete the record of who
 *     published it.
 *
 * The accepted risk is stated rather than hidden: a compromised Admin session
 * can change the prices. What it cannot do is change them without leaving a
 * record it is unable to alter afterwards.
 */

/** How long a publication's transaction may hold the database. */
const PUBLICATION_TRANSACTION_TIMEOUT_MILLISECONDS = 5_000;

/** The most changes the panel will list. Publishing is rare; this is generous. */
const CHANGE_PAGE_SIZE = 50;

export interface AdminChangeServiceOptions {
  /** Publishes. The only connection in this system that can. */
  pricing: AdminPricingDatabase;
  /** Reads the tariff in force and the change log, for the preview and the panel. */
  read: AdminReadDatabase;
  clock: Clock;
  random: RandomSource;
}

export class AdminChangeService {
  public constructor(private readonly options: AdminChangeServiceOptions) {}

  /**
   * What the prices would do, without doing it.
   *
   * Writes nothing, and its answer carries the two digests the publish call has
   * to echo. Splitting it out is what makes "review, then confirm" a real step
   * rather than a label on a button: the panel cannot offer to publish numbers
   * it has not priced out.
   */
  public async preview(body: PreviewChangeBody): Promise<PreviewChangeResponse> {
    const current = await this.currentTariff();
    if (!current) {
      throw new ApiError(
        409,
        "PRICING_NOT_PUBLISHED",
        "No tariff is published, so there is nothing to replace."
      );
    }
    return {
      preview: this.previewOf(current, body.payload.pricing),
      published: false as const
    };
  }

  /**
   * Publish the tariff, in one transaction.
   *
   * Every refusal below is thrown inside the try, so each one is audited the
   * same way rather than depending on where in the method it was noticed. The
   * transaction rolls back first and the refusal is recorded after, on a
   * connection that is no longer inside it.
   */
  public async publish(
    admin: AuthenticatedAdmin,
    body: PublishChangeBody,
    requestId: string
  ): Promise<PublishChangeResponse> {
    const now = this.options.clock.now();
    const payload = body.payload.pricing;

    try {
      const result = await this.options.pricing.$transaction(
        async (transaction) => {
          // The tariff in force, re-read on the connection that is about to
          // replace it rather than taken from the screen.
          const current = await transaction.pricingRuleSet.findFirst({
            where: {
              status: "PUBLISHED",
              scope: PRICING_PUBLISH_SCOPE,
              scopeRef: PRICING_PUBLISH_SCOPE_REF
            },
            select: TARIFF_FIELDS
          });
          if (!current) {
            throw new RefusedChange(
              new ApiError(
                409,
                "PRICING_NOT_PUBLISHED",
                "No tariff is published, so there is nothing to replace."
              ),
              { failureCode: "NO_BASELINE", reason: body.reason }
            );
          }

          const rules = await transaction.pricingRule.findMany({
            where: { ruleSetId: current.id },
            select: RULE_FIELDS
          });
          const live: CurrentTariff = { ...current, rule: rules[0] ?? null };

          // What the Admin was shown, recomputed here. They differ only if the
          // form changed after the preview — which is precisely the case worth
          // refusing, because it means the numbers on screen are not these ones.
          const payloadDigest = digestOfPricingPayload(live, payload);
          if (payloadDigest !== body.payloadDigest) {
            throw new RefusedChange(
              new ApiError(
                409,
                "CHANGE_NOT_PREVIEWED",
                "These numbers are not the ones that were priced out. Preview them again before publishing."
              ),
              { failureCode: "DIGEST_MISMATCH", reason: body.reason, payloadDigest }
            );
          }

          // Somebody published between the preview and this call. The change was
          // reasoned about against a tariff that is no longer in force, so this
          // is a refusal rather than an application on top of it.
          const baselineDigest = digestOfCurrentTariff(live);
          if (baselineDigest !== body.baselineDigest) {
            throw new RefusedChange(
              new ApiError(
                409,
                "CHANGE_BASELINE_MOVED",
                "The tariff has changed since this was priced out. Reload and read the current prices again."
              ),
              { failureCode: "BASELINE_MOVED", reason: body.reason, baselineDigest }
            );
          }

          if (payload.version === current.version) {
            throw new RefusedChange(
              new ApiError(
                409,
                "PRICING_VERSION_TAKEN",
                "That version name is already in use. Give this tariff a name of its own."
              ),
              { failureCode: "VERSION_TAKEN", reason: body.reason }
            );
          }

          // A publication is written in the order the schema insists on: the
          // draft, then its rules, then the archival of what it replaces, then
          // the publication itself. Rules may only be attached while the set is
          // a draft — a published tariff's numbers are immutable, by a trigger
          // that predates this workflow — and the archival has to land before
          // the publication because the published-per-scope unique index permits
          // exactly one. Every step is in this transaction, so no committed row
          // ever rests in a draft state.
          const ruleSetId = this.options.random.uuid(now);
          await transaction.pricingRuleSet.create({
            data: {
              id: ruleSetId,
              version: payload.version,
              scope: PRICING_PUBLISH_SCOPE,
              scopeRef: PRICING_PUBLISH_SCOPE_REF,
              // Never from the payload. A tariff change that could redenominate
              // the money would make every historical price mean something else.
              currency: current.currency,
              currencyExponent: current.currencyExponent,
              status: "DRAFT",
              rounding: current.rounding,
              taxMode: current.taxMode,
              minimumApplication: current.minimumApplication,
              // In force from the instant this commits. Anything later would
              // leave a window in which no tariff covers `now`, and the quote
              // path answers that with a 503 — a priced-out kiosk is a stopped
              // kiosk.
              validFrom: now,
              validUntil: null,
              // Written here rather than at the publishing update, because this
              // role holds no grant on the column. A publication cannot arrive
              // undated even if this code tried.
              publishedAt: now,
              createdAt: now,
              updatedAt: now
            },
            select: { id: true }
          });

          await transaction.pricingRule.create({
            data: {
              id: this.options.random.uuid(now),
              ruleSetId,
              service: PRICING_PUBLISH_SERVICE,
              paperSize: PRICING_PUBLISH_PAPER_SIZE,
              colorMode: PRICING_PUBLISH_COLOR_MODE,
              unitAmountMinor: payload.unitAmountMinor,
              duplexAdjustmentBasisPoints: payload.duplexAdjustmentBasisPoints,
              serviceFeeMinor: payload.serviceFeeMinor,
              minimumAmountMinor: payload.minimumAmountMinor,
              taxBasisPoints: payload.taxBasisPoints,
              priority: PRICING_PUBLISH_PRIORITY,
              createdAt: now
            },
            select: { id: true }
          });

          // Conditional, and the row count is the answer: the predicate is what
          // this publication was authorized against, so a zero means somebody
          // moved the tariff between the read above and this write.
          const archived = await transaction.pricingRuleSet.updateMany({
            where: { id: current.id, status: "PUBLISHED" },
            data: { status: "ARCHIVED", archivedAt: now }
          });
          if (archived.count !== 1) {
            throw new RefusedChange(
              new ApiError(
                409,
                "CHANGE_BASELINE_MOVED",
                "The tariff changed while this was being published. Nothing was published."
              ),
              { failureCode: "BASELINE_RACED", reason: body.reason }
            );
          }

          const published = await transaction.pricingRuleSet.updateMany({
            where: { id: ruleSetId, status: "DRAFT" },
            data: { status: "PUBLISHED", updatedAt: now }
          });
          if (published.count !== 1) {
            throw new RefusedChange(
              new ApiError(
                409,
                "CHANGE_BASELINE_MOVED",
                "The tariff changed while this was being published. Nothing was published."
              ),
              { failureCode: "PUBLISH_RACED", reason: body.reason }
            );
          }

          // The record, last, because it names the tariff it produced. A
          // deferred trigger checks at COMMIT that this row exists and that the
          // digest it carries is the digest of what was actually written — so
          // publishing something other than what was confirmed is not a thing
          // this code can do wrong.
          const execution = await transaction.adminChangeExecution.create({
            data: {
              id: this.options.random.uuid(now),
              kind: "PRICING_PUBLISH",
              payload: body.payload,
              payloadDigest,
              baselineDigest,
              reason: body.reason,
              publishedByAdminId: admin.adminUserId,
              publishedByRole: admin.role,
              resultRuleSetId: ruleSetId,
              resultRef: payload.version,
              replacedRef: current.version,
              createdAt: now
            },
            select: EXECUTION_FIELDS
          });

          await writeAdminAuditEvent(transaction, {
            id: this.options.random.uuid(now),
            occurredAt: now,
            actorId: admin.adminUserId,
            action: "admin.change.publish",
            outcome: "SUCCESS",
            requestId,
            metadata: {
              role: admin.role,
              capability: "pricing.publish",
              risk: "R2",
              stepUpFresh: true,
              changeId: execution.id,
              changeKind: "PRICING_PUBLISH",
              payloadDigest,
              baselineDigest,
              reason: body.reason,
              pricingVersion: payload.version,
              replacedPricingVersion: current.version,
              unitAmountMinor: payload.unitAmountMinor,
              serviceFeeMinor: payload.serviceFeeMinor,
              minimumAmountMinor: payload.minimumAmountMinor,
              taxBasisPoints: payload.taxBasisPoints,
              duplexAdjustmentBasisPoints: payload.duplexAdjustmentBasisPoints,
              currency: current.currency
            }
          });

          return { execution, replacedVersion: current.version };
        },
        { timeout: PUBLICATION_TRANSACTION_TIMEOUT_MILLISECONDS }
      );

      return {
        change: await this.present(result.execution, result.execution.resultRuleSetId),
        publishedVersion: payload.version,
        replacedVersion: result.replacedVersion,
        published: true as const
      };
    } catch (error) {
      if (error instanceof RefusedChange) {
        await this.auditRefusal(admin, requestId, now, error.details);
        throw error.response;
      }
      throw error;
    }
  }

  /** Every published change, newest first, beside the tariff in force. */
  public async list(): Promise<{
    changes: AdminChange[];
    current: (CurrentTariffSummary & { baselineDigest: string }) | null;
  }> {
    const executions = await this.options.read.adminChangeExecution.findMany({
      orderBy: { createdAt: "desc" },
      take: CHANGE_PAGE_SIZE,
      select: EXECUTION_FIELDS
    });

    const current = await this.currentTariff();
    const changes: AdminChange[] = [];
    for (const execution of executions) {
      changes.push(await this.present(execution, current?.id ?? null));
    }

    return {
      changes,
      current: current
        ? { ...summarizeTariff(current), baselineDigest: digestOfCurrentTariff(current) }
        : null
    };
  }

  /**
   * Record that somebody without the capability asked to change the prices.
   *
   * The same hook the money route uses, and here for the same reason: an account
   * probing the endpoint that sets every price in the estate is telling you
   * something whether or not it succeeds. Best-effort, so a failure to record it
   * cannot turn a 403 into a 500.
   */
  public async recordForbiddenAttempt(
    admin: AuthenticatedAdmin,
    capability: string,
    action: string,
    requestId: string
  ): Promise<void> {
    const now = this.options.clock.now();
    try {
      await writeAdminAuditEvent(this.options.pricing, {
        id: this.options.random.uuid(now),
        occurredAt: now,
        actorId: admin.adminUserId,
        action,
        outcome: "DENIED",
        requestId,
        metadata: { role: admin.role, capability, failureCode: "CAPABILITY_NOT_HELD" }
      });
    } catch {
      // Deliberately swallowed. The request is refused either way, and the
      // alternative is a 500 that tells the caller their probe hit something.
    }
  }

  /**
   * What the prices would do, in money rather than in basis points.
   *
   * Computed with `calculateQuote` — the same pure function the kiosk quotes
   * with — so the numbers on the screen are the numbers a customer will be
   * charged, not an approximation of them. Confirming a set of basis points
   * nobody has multiplied out is how a review becomes a rubber stamp.
   */
  private previewOf(current: CurrentTariff, payload: PricingPublishPayload): ChangePreview {
    const proposedSet = {
      id: "proposed",
      version: payload.version,
      currency: current.currency,
      currencyExponent: current.currencyExponent,
      rounding: current.rounding as "HALF_UP",
      taxMode: current.taxMode as "EXCLUSIVE",
      minimumApplication: current.minimumApplication as "BEFORE_TAX",
      rules: [
        {
          service: PRICING_PUBLISH_SERVICE,
          paperSize: PRICING_PUBLISH_PAPER_SIZE,
          colorMode: PRICING_PUBLISH_COLOR_MODE,
          unitAmountMinor: payload.unitAmountMinor,
          duplexAdjustmentBasisPoints: payload.duplexAdjustmentBasisPoints,
          serviceFeeMinor: payload.serviceFeeMinor,
          minimumAmountMinor: payload.minimumAmountMinor,
          taxBasisPoints: payload.taxBasisPoints,
          priority: PRICING_PUBLISH_PRIORITY
        }
      ]
    };

    const currentSet = current.rule
      ? { ...proposedSet, version: current.version, rules: [{ ...current.rule }] }
      : null;

    const rows = PRICING_PREVIEW_BASKETS.map((basket) => {
      const usage = {
        service: PRICING_PUBLISH_SERVICE,
        paperSize: PRICING_PUBLISH_PAPER_SIZE,
        colorMode: PRICING_PUBLISH_COLOR_MODE,
        documents: [{ duplex: basket.duplex, printedSides: basket.printedSides }],
        selectedPages: basket.selectedPages,
        printedSides: basket.printedSides,
        physicalSheets: basket.physicalSheets
      };
      const proposedTotalMinor = priceOrThrow(proposedSet, usage);
      const currentTotalMinor = currentSet ? safePrice(currentSet, usage) : null;
      return {
        label: basket.label,
        currentTotalMinor,
        proposedTotalMinor,
        differenceMinor:
          currentTotalMinor === null ? proposedTotalMinor : proposedTotalMinor - currentTotalMinor
      };
    });

    return {
      kind: "PRICING_PUBLISH" as const,
      currency: current.currency,
      currencyExponent: current.currencyExponent,
      currentVersion: current.version,
      rows,
      payloadDigest: digestOfPricingPayload(current, payload),
      baselineDigest: digestOfCurrentTariff(current)
    };
  }

  /** The tariff in force, on the read pool, with its single rule. */
  private async currentTariff(): Promise<CurrentTariff | null> {
    const ruleSet = await this.options.read.pricingRuleSet.findFirst({
      where: {
        status: "PUBLISHED",
        scope: PRICING_PUBLISH_SCOPE,
        scopeRef: PRICING_PUBLISH_SCOPE_REF
      },
      select: TARIFF_FIELDS
    });
    if (!ruleSet) return null;

    const rules = await this.options.read.pricingRule.findMany({
      where: { ruleSetId: ruleSet.id },
      select: RULE_FIELDS
    });
    return { ...ruleSet, rule: rules[0] ?? null };
  }

  /** Put a name on a stored record, and say whether its tariff is the live one. */
  private async present(
    execution: StoredExecution,
    liveRuleSetId: string | null
  ): Promise<AdminChange> {
    const person = await this.options.read.adminUser.findUnique({
      where: { id: execution.publishedByAdminId },
      select: { displayName: true }
    });

    return {
      id: execution.id,
      kind: "PRICING_PUBLISH",
      payload: execution.payload as ChangePayload,
      payloadDigest: execution.payloadDigest,
      baselineDigest: execution.baselineDigest,
      reason: execution.reason,
      publishedByAdminUserId: execution.publishedByAdminId,
      publishedByDisplayName: person?.displayName ?? null,
      publishedByRole: execution.publishedByRole,
      publishedAt: execution.createdAt.toISOString(),
      resultRef: execution.resultRef ?? "",
      replacedRef: execution.replacedRef,
      // Derived from the tariff actually in force rather than stored, so nothing
      // has to write a "no longer current" flag and nothing can fail to.
      inForce: liveRuleSetId !== null && execution.resultRuleSetId === liveRuleSetId
    };
  }

  /** Record that somebody tried to change the prices, and was told no. */
  private async auditRefusal(
    admin: AuthenticatedAdmin,
    requestId: string,
    now: Date,
    details: RefusalDetails
  ): Promise<void> {
    await writeAdminAuditEvent(this.options.pricing, {
      id: this.options.random.uuid(now),
      occurredAt: now,
      actorId: admin.adminUserId,
      action: "admin.change.publish",
      outcome: "DENIED",
      requestId,
      metadata: {
        role: admin.role,
        capability: "pricing.publish",
        failureCode: details.failureCode,
        reason: details.reason,
        ...(details.payloadDigest ? { payloadDigest: details.payloadDigest } : {}),
        ...(details.baselineDigest ? { baselineDigest: details.baselineDigest } : {})
      } satisfies Record<string, AdminAuditMetadataValue>
    });
  }
}

const EXECUTION_FIELDS = {
  id: true,
  kind: true,
  payload: true,
  payloadDigest: true,
  baselineDigest: true,
  reason: true,
  publishedByAdminId: true,
  publishedByRole: true,
  resultRuleSetId: true,
  resultRef: true,
  replacedRef: true,
  createdAt: true
} as const;

const TARIFF_FIELDS = {
  id: true,
  version: true,
  currency: true,
  currencyExponent: true,
  rounding: true,
  taxMode: true,
  minimumApplication: true,
  publishedAt: true
} as const;

const RULE_FIELDS = {
  service: true,
  paperSize: true,
  colorMode: true,
  unitAmountMinor: true,
  duplexAdjustmentBasisPoints: true,
  serviceFeeMinor: true,
  minimumAmountMinor: true,
  taxBasisPoints: true,
  priority: true
} as const;

interface StoredExecution {
  id: string;
  kind: string;
  payload: unknown;
  payloadDigest: string;
  baselineDigest: string;
  reason: string;
  publishedByAdminId: string;
  publishedByRole: string;
  resultRuleSetId: string | null;
  resultRef: string | null;
  replacedRef: string | null;
  createdAt: Date;
}

interface TariffRule {
  service: string;
  paperSize: string;
  colorMode: string;
  unitAmountMinor: number;
  duplexAdjustmentBasisPoints: number;
  serviceFeeMinor: number;
  minimumAmountMinor: number;
  taxBasisPoints: number;
  priority: number;
}

interface CurrentTariff {
  id: string;
  version: string;
  currency: string;
  currencyExponent: number;
  rounding: string;
  taxMode: string;
  minimumApplication: string;
  publishedAt: Date | null;
  rule: TariffRule | null;
}

export interface CurrentTariffSummary {
  version: string;
  currency: string;
  currencyExponent: number;
  unitAmountMinor: number;
  duplexAdjustmentBasisPoints: number;
  serviceFeeMinor: number;
  minimumAmountMinor: number;
  taxBasisPoints: number;
  publishedAt: string | null;
}

function summarizeTariff(current: CurrentTariff): CurrentTariffSummary {
  return {
    version: current.version,
    currency: current.currency,
    currencyExponent: current.currencyExponent,
    unitAmountMinor: current.rule?.unitAmountMinor ?? 0,
    duplexAdjustmentBasisPoints: current.rule?.duplexAdjustmentBasisPoints ?? 0,
    serviceFeeMinor: current.rule?.serviceFeeMinor ?? 0,
    minimumAmountMinor: current.rule?.minimumAmountMinor ?? 0,
    taxBasisPoints: current.rule?.taxBasisPoints ?? 0,
    publishedAt: current.publishedAt?.toISOString() ?? null
  };
}

/**
 * The digest of a change, over the tariff it would produce.
 *
 * Note what goes in beside the payload: the currency, the exponent and the three
 * policy fields, all taken from the tariff in force rather than from the
 * request. The digest is therefore over the whole published row, which is what
 * lets the database recompute it from what was written and compare.
 */
function digestOfPricingPayload(current: CurrentTariff, payload: PricingPublishPayload): string {
  return sha256(
    canonicalPricingPublishText({
      scope: PRICING_PUBLISH_SCOPE,
      scopeRef: PRICING_PUBLISH_SCOPE_REF,
      currency: current.currency,
      currencyExponent: current.currencyExponent,
      rounding: current.rounding,
      taxMode: current.taxMode,
      minimumApplication: current.minimumApplication,
      payload
    })
  );
}

/**
 * The digest of the tariff in force, in the same format.
 *
 * Handed out with a preview and compared again at publication time, so
 * "somebody published while this was on screen" becomes a refusal rather than a
 * silent application on top of numbers nobody read.
 */
function digestOfCurrentTariff(current: CurrentTariff): string {
  return sha256(
    canonicalPricingPublishText({
      scope: PRICING_PUBLISH_SCOPE,
      scopeRef: PRICING_PUBLISH_SCOPE_REF,
      currency: current.currency,
      currencyExponent: current.currencyExponent,
      rounding: current.rounding,
      taxMode: current.taxMode,
      minimumApplication: current.minimumApplication,
      payload: {
        version: current.version,
        unitAmountMinor: current.rule?.unitAmountMinor ?? 0,
        duplexAdjustmentBasisPoints: current.rule?.duplexAdjustmentBasisPoints ?? 0,
        serviceFeeMinor: current.rule?.serviceFeeMinor ?? 0,
        minimumAmountMinor: current.rule?.minimumAmountMinor ?? 0,
        taxBasisPoints: current.rule?.taxBasisPoints ?? 0
      }
    })
  );
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

type PriceableSet = Parameters<typeof calculateQuote>[0]["ruleSet"];
type PriceableUsage = Parameters<typeof calculateQuote>[0]["usage"];

/** A tariff that cannot be priced is one nobody should be able to publish. */
function priceOrThrow(ruleSet: PriceableSet, usage: PriceableUsage): number {
  try {
    return calculateQuote({ ruleSet, usage }).totalMinor;
  } catch (error) {
    if (error instanceof PricingError) {
      throw new ApiError(
        422,
        "PRICING_PROPOSAL_INVALID",
        "These numbers do not produce a valid price. Check the amounts."
      );
    }
    throw error;
  }
}

/**
 * The same, for the tariff already in force.
 *
 * Null rather than an error: a tariff that cannot be priced today is a problem,
 * but it is not this change's problem, and refusing to show the comparison would
 * hide the fix from the person who could make it.
 */
function safePrice(ruleSet: PriceableSet, usage: PriceableUsage): number | null {
  try {
    return calculateQuote({ ruleSet, usage }).totalMinor;
  } catch {
    return null;
  }
}

interface RefusalDetails {
  failureCode: string;
  reason: string;
  payloadDigest?: string;
  baselineDigest?: string;
}

/**
 * A refusal, carried out of the transaction so the transaction can roll back
 * before the refusal is recorded.
 *
 * Not an `ApiError` itself, for the same reason as its counterparts in
 * `operations.ts` and `refunds.ts`: this type cannot reach the client, so the
 * only way to resolve it is through the handler that writes the audit row.
 */
class RefusedChange extends Error {
  public constructor(
    public readonly response: ApiError,
    public readonly details: RefusalDetails
  ) {
    super(details.failureCode);
    this.name = "RefusedChange";
  }
}
