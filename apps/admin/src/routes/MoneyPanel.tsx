import { useCallback, useEffect, useState } from "react";

import type { AdminPaymentsResponse, AdminRefundsResponse } from "@printing-kiosk/admin-access";

import { useSession } from "../features/auth/SessionProvider.js";
import { observabilityApi } from "../features/observability/api.js";
import {
  Empty,
  Identifier,
  Money,
  Pagination,
  Panel,
  RowWhen,
  StateBadge,
  Table,
  When,
  humanizeState
} from "../features/observability/components.js";
import {
  Distribution,
  Headline,
  Kpi,
  KpiRow,
  Module,
  Section,
  StatusPill,
  type DistributionRow,
  type Tone
} from "../features/observability/surfaces.js";
import { useAdminData } from "../features/observability/useAdminData.js";
import { usePageTrail } from "../features/observability/usePageTrail.js";
import { RefundQueue } from "./RefundQueue.js";

type Payment = AdminPaymentsResponse["items"][number];
type Refund = AdminRefundsResponse["items"][number];

const PAYMENT_STATUSES = ["CAPTURED", "AUTHORIZED", "PENDING", "FAILED", "EXPIRED"] as const;
const KNOWN_STATUSES = new Set<string>(PAYMENT_STATUSES);

/** A payment that took the customer's money. */
const PAID = new Set(["CAPTURED", "SUCCEEDED", "PAID"]);

/**
 * A payment that has not finished either way yet.
 *
 * The same two states the server calls open, so "still open" on this page and
 * "open payments" on the overview snapshot are one definition rather than two
 * that happen to agree today.
 */
const OPEN = new Set(["PENDING", "AUTHORIZED"]);

/** Stable empty pages, so an unchanged response does not look like a new one. */
const NO_PAYMENTS: readonly Payment[] = [];
const NO_REFUNDS: readonly Refund[] = [];

/**
 * The three things money can be, kept apart.
 *
 * They are different stages of one story and merging them would produce a
 * table where a row might be a question, a fact or a debt. A decision is
 * undecided work; a payment is something that already happened; an owed refund
 * is an obligation this panel created and cannot discharge. An administrator
 * arriving at this page is doing exactly one of those three things.
 */
type ViewId = "decisions" | "payments" | "refunds";

const VIEW_LABELS: Readonly<Record<ViewId, string>> = {
  decisions: "Needs decision",
  payments: "Payments",
  refunds: "Unsettled refunds"
};

/**
 * Money: what needs deciding, what is happening now, and what is still owed.
 *
 * The page reads top to bottom as four answers to four questions, and the order
 * is the design:
 *
 *  1. **A sentence.** Whether anything here needs a person right now.
 *  2. **Four numbers.** Three of them are the server's own totals covering
 *     everything; the fourth is counted off the page below and says so.
 *  3. **One reading with its working, and one breakdown beside it.** What the
 *     recent payments did, and where they were taken.
 *  4. **The rows.** The ledger itself, filtered by anything pressed above it.
 *
 * The two rules that decide what may be drawn here are worth stating because
 * everything on the page obeys them.
 *
 * **A number says what it counted.** The reads behind this screen are keyset
 * pages of fifty rows, and no endpoint aggregates payments. So the success rate,
 * the amounts and the kiosk split are properties of *the page that loaded*, said
 * that way in words every time, and the tiles that carry a whole-system total
 * are the ones the server actually counted: the decision queue's totals, the
 * unsettled refund count, and the open payments on the overview snapshot. There
 * is no comparison against a previous period anywhere on this page, because
 * nothing in the system stores one.
 *
 * **The three stages stay apart.** The page opens on the decision queue because
 * it is the only thing here anybody has to act on, and it is the one place in
 * the whole control plane where a click costs real money. The ledger and the
 * unsettled refunds are records — worth reading, never urgent — so they sit behind a
 * segmented control rather than stacked underneath a form somebody is filling
 * in. That stacking was the specific problem: an Admin typing a refund amount
 * had the entire payment history scrolling below their hands.
 *
 * The one action lives in the queue and its safety text lives with it. This
 * screen authorizes an obligation; nothing on it settles one. Settlement runs
 * against the payment provider by something holding a provider credential, and
 * no part of the panel holds one.
 */
export function MoneyPanel({ focus }: { focus?: "refunds" | undefined } = {}) {
  const session = useSession();
  const canSeeRefunds = session.can("refund.obligation.read");
  const canAuthorizeRefunds = session.can("refund.authorize");
  const canReconcile = session.can("payment.reconcile.read");
  const canSeeSnapshot = session.can("dashboard.read");

  // Arriving from "unsettled refunds" on the overview opens that view. Everyone else
  // lands on the work.
  const [view, setView] = useState<ViewId>(
    focus === "refunds" && canSeeRefunds ? "refunds" : canSeeRefunds ? "decisions" : "payments"
  );

  const [paymentStatus, setPaymentStatus] = useState("");
  const paymentPages = usePageTrail();
  const paymentCursor = paymentPages.cursor;
  const loadPayments = useCallback(
    () => observabilityApi.payments({ status: paymentStatus || undefined, cursor: paymentCursor }),
    [paymentStatus, paymentCursor]
  );
  const payments = useAdminData(loadPayments, { refreshMilliseconds: 30_000 });

  /** Owed only, or every refund ever raised. The `Returned` column needs both. */
  const [owedOnly, setOwedOnly] = useState(true);
  const refundPages = usePageTrail();
  const refundCursor = refundPages.cursor;
  const loadRefunds = useCallback(
    () => observabilityApi.refunds(owedOnly, refundCursor),
    [owedOnly, refundCursor]
  );
  const refunds = useAdminData(loadRefunds, {
    refreshMilliseconds: 30_000,
    enabled: canSeeRefunds
  });

  /**
   * The whole-system money counts, from the snapshot the overview already reads.
   *
   * The only figures on this page that cover every payment rather than a page of
   * them, and the reason the top row is not four numbers counted off fifty rows.
   * It costs almost nothing: the server caches this snapshot per scope for a few
   * seconds, so a room full of dashboards is one query.
   */
  const loadSnapshot = useCallback(() => observabilityApi.overview(), []);
  const snapshot = useAdminData(loadSnapshot, {
    refreshMilliseconds: 30_000,
    enabled: canSeeSnapshot
  });
  const moneyNow = snapshot.data?.money ?? null;

  // The "needs decision" tile is drawn whichever view is open, but the queue
  // below reports its own totals when it is mounted — so this only asks when
  // nothing else is already asking.
  // Null until something has actually counted. "Nothing to decide" and "we have
  // not asked yet" are different statements, and on a money screen the first one
  // said too early is somebody closing the tab.
  const [queueTotals, setQueueTotals] = useState<{
    suggested: number;
    unresolvable: number;
  } | null>(null);
  const loadQueue = useCallback(() => observabilityApi.refundQueue(), []);
  const queueSummary = useAdminData(loadQueue, {
    enabled: canSeeRefunds && view !== "decisions"
  });
  const summaryData = queueSummary.data;
  useEffect(() => {
    if (summaryData) setQueueTotals(summaryData.totals);
  }, [summaryData]);

  const needsDecision =
    queueTotals === null ? null : queueTotals.suggested + queueTotals.unresolvable;
  const owedCount = refunds.data?.unsettledCount ?? null;
  const counted = needsDecision !== null;
  const expired = moneyNow?.expiredPayments ?? 0;

  const paymentItems = payments.data?.items ?? NO_PAYMENTS;
  const refundItems = refunds.data?.items ?? NO_REFUNDS;
  const money = summarizePayments(paymentItems);
  const owed = summarizeRefunds(refundItems);

  /** True while the server has narrowed the ledger to one status. */
  const filtered = paymentStatus !== "";
  /** The page cannot say how many failed while it is filtered to something else. */
  const failedUnknown = filtered && paymentStatus !== "FAILED";

  const views: readonly ViewId[] = canSeeRefunds
    ? ["decisions", "payments", "refunds"]
    : ["payments"];

  const showPayments = useCallback(
    (status: string) => {
      setPaymentStatus(status);
      paymentPages.reset();
      setView("payments");
    },
    [paymentPages]
  );

  /**
   * Pressing a status anywhere above the table filters the table to it, and
   * pressing the one already on clears it — the same behaviour the tiles on
   * Sessions and Printing have, so a status is a status wherever it is pressed.
   */
  const chooseStatus = useCallback(
    (status: string) => showPayments(paymentStatus === status ? "" : status),
    [paymentStatus, showPayments]
  );

  const clearStatus = useCallback(() => showPayments(""), [showPayments]);

  return (
    <>
      <header className="page-head">
        <div className="page-head__lead">
          <p
            className={`page-head__summary page-head__summary--${
              needsDecision && needsDecision > 0
                ? "critical"
                : (owedCount && owedCount > 0) || expired > 0
                  ? "busy"
                  : "calm"
            }`}
          >
            <span className="page-head__dot" aria-hidden="true" />
            {canSeeRefunds && !counted
              ? "Checking what needs deciding…"
              : needsDecision && needsDecision > 0
                ? needsDecision === 1
                  ? "1 print needs a money decision"
                  : `${needsDecision} prints need a money decision`
                : owedCount && owedCount > 0
                  ? `Nothing to decide · ${owedCount} refund${owedCount === 1 ? "" : "s"} still to return`
                  : expired > 0
                    ? `${canSeeRefunds ? "Nothing to decide · " : ""}${expired} payment${
                        expired === 1 ? "" : "s"
                      } ran out of time`
                    : canSeeRefunds
                      ? "Nothing to decide and nothing owed"
                      : "The payment ledger"}
          </p>
          <p className="page-head__meta">
            {VIEW_LABELS[view]}
            {view === "payments" && filtered ? ` · ${humanizeState(paymentStatus)}` : ""}
            {view === "refunds" && !owedOnly ? " · every refund" : ""}
            {payments.data?.scoped ? " · your assigned kiosks" : ""}
            {view === "payments" && filtered ? (
              <button type="button" className="button-link page-head__clear" onClick={clearStatus}>
                Show all
              </button>
            ) : null}
          </p>
        </div>

        <div className="page-head__actions">
          {payments.loading && payments.data ? (
            <span className="page-head__refreshing" role="status">
              Refreshing…
            </span>
          ) : null}
          <button
            type="button"
            className="button-primary"
            onClick={() => {
              payments.reload();
              if (canSeeSnapshot) snapshot.reload();
              if (canSeeRefunds) {
                refunds.reload();
                queueSummary.reload();
              }
            }}
            disabled={payments.loading}
          >
            Refresh
          </button>
        </div>
      </header>

      {/* Three of these four are totals the server counted over everything; the
          fourth is counted from the page below. Saying which is which on the
          tile is the whole difference between a summary and a number somebody
          will quote in a meeting. */}
      <KpiRow>
        {canSeeRefunds ? (
          <Kpi
            label="Needs decision"
            value={needsDecision ?? "—"}
            foot={
              queueTotals === null
                ? "Counting…"
                : needsDecision === 0
                  ? "No print is waiting on you"
                  : `${queueTotals.suggested} missing pages, ${queueTotals.unresolvable} unclear`
            }
            tone={needsDecision && needsDecision > 0 ? "critical" : undefined}
            elevated={Boolean(needsDecision && needsDecision > 0)}
            onOpen={() => setView("decisions")}
            behavior="view"
            openLabel="Open the decision queue."
          />
        ) : null}
        {canSeeRefunds ? (
          <Kpi
            label="Unsettled refunds"
            value={owedCount ?? "—"}
            foot={
              owedCount === null
                ? "Counting…"
                : owedCount === 0
                  ? "Everything authorized has been returned"
                  : "Authorized, not yet returned"
            }
            tone={owedCount && owedCount > 0 ? "warn" : undefined}
            onOpen={() => {
              setOwedOnly(true);
              refundPages.reset();
              setView("refunds");
            }}
            behavior="view"
            openLabel="Show the refunds still owed."
          />
        ) : null}
        {canSeeSnapshot ? (
          // No way in, deliberately. "Open" is two statuses and the filter below
          // takes one, so a tile that opened the ledger would show a different
          // set of rows than the number it was pressed for.
          <Kpi
            label="Open payments"
            value={moneyNow ? moneyNow.openPayments : "—"}
            foot={
              moneyNow === null
                ? "Counting…"
                : expired > 0
                  ? `${expired} ran out of time`
                  : moneyNow.openPayments === 0
                    ? "Nothing part-way through"
                    : "Started, not finished yet"
            }
            tone={expired > 0 ? "warn" : undefined}
          />
        ) : null}
        {/* A dash rather than a zero while somebody else's filter is on: "none
            failed" and "we did not ask about failures" are different statements
            and only one of them is true. */}
        <Kpi
          label="Failed payments"
          value={failedUnknown ? "—" : money.failed}
          foot={
            paymentStatus === "FAILED"
              ? "Showing only these — select again to clear"
              : failedUnknown
                ? "Not counted while filtered"
                : money.failed === 0
                  ? "None failed on this page"
                  : // Deliberately narrower than the card below, which counts
                    // everything that finished without a capture. This tile
                    // filters to the `FAILED` status and must say only that.
                    "On this page of the ledger"
          }
          tone={!failedUnknown && money.failed > 0 ? "warn" : undefined}
          pressed={paymentStatus === "FAILED"}
          onOpen={() => chooseStatus("FAILED")}
          openLabel={
            paymentStatus === "FAILED"
              ? "Showing only these. Select to clear the filter."
              : "Show only failed payments."
          }
        />
      </KpiRow>

      {views.length > 1 ? (
        <div className="segmented" role="group" aria-label="Money views">
          {views.map((id) => (
            <button
              key={id}
              type="button"
              className={id === view ? "segmented__option is-active" : "segmented__option"}
              aria-pressed={id === view}
              onClick={() => setView(id)}
            >
              {VIEW_LABELS[id]}
              {id === "decisions" && needsDecision ? (
                <span className="segmented__count">{needsDecision}</span>
              ) : null}
              {id === "refunds" && owedCount ? (
                <span className="segmented__count">{owedCount}</span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}

      {view === "decisions" && canSeeRefunds ? (
        <RefundQueue
          canAuthorize={canAuthorizeRefunds}
          onTotals={setQueueTotals}
          onAuthorized={() => {
            refunds.reload();
            payments.reload();
            queueSummary.reload();
            if (canSeeSnapshot) snapshot.reload();
          }}
        />
      ) : null}

      {view === "payments" ? (
        <>
          {/* Drawn only once rows have actually loaded. A success rate over an
              empty page is 0%, and a dashboard that says 0% while it is still
              asking is worse than one that says nothing yet. */}
          {paymentItems.length > 0 ? (
            <Section id="money-payment-activity" title="Payment activity">
              <div className="insight-grid">
                <PaymentReading
                  money={money}
                  status={paymentStatus}
                  onChoose={chooseStatus}
                  onClear={clearStatus}
                />
                <KioskBreakdown money={money} status={paymentStatus} />
              </div>
            </Section>
          ) : null}

          <Panel
            title="Payments"
            state={payments}
            emptyMessage="No payments yet."
            hint={
              canReconcile
                ? "Provider references are shown because your role reconciles against the provider's ledger."
                : "Provider references are withheld from your role."
            }
            actions={
              <label className="inline-field">
                Status
                <select
                  value={paymentStatus}
                  onChange={(event) => {
                    setPaymentStatus(event.target.value);
                    paymentPages.reset();
                  }}
                >
                  <option value="">Any</option>
                  {PAYMENT_STATUSES.map((value) => (
                    <option key={value} value={value}>
                      {humanizeState(value)}
                    </option>
                  ))}
                </select>
              </label>
            }
          >
            {payments.data && paymentItems.length === 0 ? (
              <Empty>
                {filtered ? (
                  <>
                    No {humanizeState(paymentStatus).toLowerCase()} payments.{" "}
                    <button type="button" className="button-link" onClick={clearStatus}>
                      Clear the filter
                    </button>
                  </>
                ) : (
                  "No payments yet."
                )}
              </Empty>
            ) : null}

            {paymentItems.length > 0 ? (
              <Table
                className="data-table"
                pane
                paneClassName="data-pane"
                columns={[
                  "Created",
                  "Amount",
                  "Status",
                  "Kiosk",
                  "Attempts",
                  "Payment",
                  ...(canReconcile ? ["Provider reference"] : [])
                ]}
              >
                {paymentItems.map((payment) => (
                  <tr
                    key={payment.id}
                    className={PAID.has(payment.status) ? undefined : "is-quiet-row"}
                  >
                    <td data-label="Created">
                      <RowWhen value={payment.createdAt} />
                    </td>
                    <td data-label="Amount">
                      <Money
                        minor={payment.amountMinor}
                        currency={payment.currency}
                        exponent={payment.currencyExponent}
                      />
                    </td>
                    <td data-label="Status">
                      <StateBadge
                        value={payment.status}
                        humanize
                        quiet={PAID.has(payment.status)}
                      />
                      {payment.failureCode ? (
                        <span className="row-flags">
                          <StatusPill tone="critical">{payment.failureCode}</StatusPill>
                        </span>
                      ) : null}
                      {/* True only when this capture is what moved the session to
                          paid — worth saying, and not the same as "captured". */}
                      {payment.appliedToSession ? (
                        <span className="key-list__meta">Paid for the session</span>
                      ) : null}
                    </td>
                    <td data-label="Kiosk">{payment.kioskId}</td>
                    <td data-label="Attempts">{payment.attempts}</td>
                    <td data-label="Payment">
                      <Identifier value={payment.id} />
                    </td>
                    {canReconcile ? (
                      <td data-label="Provider reference">
                        {payment.providerIntentId ? (
                          <code>{payment.providerIntentId}</code>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </Table>
            ) : null}

            <Pagination
              label="Payment pages"
              page={paymentPages.page}
              pageCount={paymentPages.pageCount}
              hasNext={paymentPages.hasNext(payments.data?.nextCursor)}
              onGo={(target) => paymentPages.go(target, payments.data?.nextCursor)}
            />
          </Panel>
        </>
      ) : null}

      {view === "refunds" && canSeeRefunds ? (
        <>
          {refundItems.length > 0 ? (
            <Section id="money-refund-activity" title="Refund activity">
              <div className="insight-grid">
                <RefundReading owed={owed} owedInTotal={owedCount} owedOnly={owedOnly} />
                <RefundReasons owed={owed} />
              </div>
            </Section>
          ) : null}

          <Panel
            title="Unsettled refunds"
            state={refunds}
            emptyMessage="No unsettled refunds."
            hint="Authorized here, returned by the payment provider. This panel cannot settle one."
            actions={
              <label className="inline-field">
                Show
                <select
                  value={owedOnly ? "owed" : "all"}
                  onChange={(event) => {
                    setOwedOnly(event.target.value === "owed");
                    refundPages.reset();
                  }}
                >
                  <option value="owed">Still owed</option>
                  <option value="all">Every refund</option>
                </select>
              </label>
            }
          >
            {refunds.data && refundItems.length === 0 ? (
              <Empty>
                {owedOnly ? (
                  <>
                    Nothing is owed. Every authorized refund has been returned.{" "}
                    <button
                      type="button"
                      className="button-link"
                      onClick={() => {
                        setOwedOnly(false);
                        refundPages.reset();
                      }}
                    >
                      Show every refund
                    </button>
                  </>
                ) : (
                  "No refunds have been raised."
                )}
              </Empty>
            ) : null}

            {refundItems.length > 0 ? (
              <Table
                className="data-table"
                pane
                paneClassName="data-pane"
                columns={[
                  "Created",
                  "Amount",
                  "Status",
                  "Owed for",
                  "Returned",
                  "Reason",
                  "Authorized by",
                  "Session"
                ]}
              >
                {refundItems.map((refund) => (
                  <tr key={refund.id} className={rowToneFor(refund)}>
                    <td data-label="Created">
                      <RowWhen value={refund.createdAt} />
                    </td>
                    <td data-label="Amount">
                      <Money
                        minor={refund.amountMinor}
                        currency={refund.currency}
                        exponent={refund.currencyExponent}
                      />
                    </td>
                    <td data-label="Status">
                      <StateBadge
                        value={refund.status}
                        humanize
                        quiet={refund.completedAt !== null}
                      />
                      {agedFlag(refund) ? (
                        <span className="row-flags">
                          <StatusPill tone="critical">{agedFlag(refund)}</StatusPill>
                        </span>
                      ) : null}
                    </td>
                    <td data-label="Owed for">
                      {refund.completedAt !== null ? (
                        <span className="muted">—</span>
                      ) : refund.outstandingHours === null ? (
                        <span className="muted">—</span>
                      ) : (
                        formatHours(refund.outstandingHours)
                      )}
                    </td>
                    <td data-label="Returned">
                      {refund.completedAt ? (
                        <When value={refund.completedAt} />
                      ) : (
                        <span className="muted">Not yet</span>
                      )}
                    </td>
                    <td data-label="Reason">
                      <StateBadge value={refund.reason} humanize quiet />
                    </td>
                    <td data-label="Authorized by">
                      {/* Null means the payment path raised this on its own. "The
                          system noticed" and "a named person decided" are
                          different claims on the same ledger and must not look
                          alike. */}
                      {refund.authorizedByDisplayName ?? (
                        <span className="key-list__meta">System</span>
                      )}
                      {refund.authorizationReason ? (
                        <span className="key-list__meta">{refund.authorizationReason}</span>
                      ) : null}
                    </td>
                    <td data-label="Session">
                      <Identifier value={refund.sessionId} />
                    </td>
                  </tr>
                ))}
              </Table>
            ) : null}

            <Pagination
              label="Refund pages"
              page={refundPages.page}
              pageCount={refundPages.pageCount}
              hasNext={refundPages.hasNext(refunds.data?.nextCursor)}
              onGo={(target) => refundPages.go(target, refunds.data?.nextCursor)}
            />
          </Panel>
        </>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// The reading, and the breakdown beside it
// ---------------------------------------------------------------------------

/**
 * What the payments on this page did, and what they were worth.
 *
 * The success rate is the one derived number on the screen and it is deliberately
 * narrow: captured as a share of the payments on this page that *finished*.
 * Payments still in flight are excluded rather than counted as failures, because
 * a customer half-way through paying is not a customer whose payment failed —
 * counting them in would make a busy minute look like an outage. The count of
 * them is printed beside the rate so the denominator is never a mystery.
 *
 * While a status filter is on there is no mix to show — the server sent one
 * status — so the card stops claiming a rate and says what it is showing
 * instead. A ring on one bar and 100% beside it would be a statistic about a
 * dropdown.
 */
function PaymentReading({
  money,
  status,
  onChoose,
  onClear
}: {
  money: PaymentFacts;
  status: string;
  onChoose: (status: string) => void;
  onClear: () => void;
}) {
  const filtered = status !== "";
  const rows: DistributionRow[] = money.statuses.map((entry) => ({
    id: entry.status,
    label: humanizeState(entry.status),
    value: entry.value,
    tone: statusTone(entry.status),
    pressed: status === entry.status,
    onOpen: () => onChoose(entry.status),
    openLabel:
      status === entry.status
        ? "Showing only these. Select to clear the filter."
        : `Show only ${humanizeState(entry.status).toLowerCase()} payments.`
  }));

  return (
    <Module
      title={filtered ? `${humanizeState(status)} payments` : "How payments finished"}
      pill={
        filtered ? (
          <StatusPill>Filtered</StatusPill>
        ) : money.notThrough > 0 ? (
          <StatusPill tone="warn">{money.notThrough} did not go through</StatusPill>
        ) : (
          <StatusPill tone="good">All went through</StatusPill>
        )
      }
    >
      {filtered ? (
        <>
          <Headline
            label="Payments shown"
            value={money.loaded}
            note={`Only ${humanizeState(status).toLowerCase()} payments are loaded, so there is no mix to compare.`}
          />
          <p>
            <button type="button" className="button-link" onClick={onClear}>
              Show every status
            </button>
          </p>
        </>
      ) : (
        <>
          {/* The number itself stays in ink whatever it says. Tinting it below
              some rate would be an emphasis that is on almost every day — and a
              threshold nothing in the system enforces. The pill above carries
              the fact, once. */}
          <Headline
            label="Success rate"
            value={money.successRate === null ? "—" : `${money.successRate}%`}
            note={
              money.successRate === null
                ? "None of the payments on this page have finished yet."
                : `${money.captured} of ${money.finished} finished payments on this page went through${
                    money.stillOpen > 0
                      ? `. ${money.stillOpen} still open, not counted either way.`
                      : "."
                  }`
            }
          />
          <Distribution
            label="Payments on this page by status"
            rows={rows}
            total={money.loaded}
            scope={`Share of the ${money.loaded} payments on this page. Select one to filter the table.`}
          />
        </>
      )}

      <dl className="fact-row">
        <div className="fact">
          {/* Its own scope on its own label: the rate above is a share of the
              finished rows, this is a sum of the captured ones, and a reader
              landing on the amount alone must not take it for a day's takings. */}
          <dt className="fact__label">Taken on this page</dt>
          <dd className="fact__value">
            <Amounts totals={money.capturedAmounts} />
          </dd>
        </div>
        <div className="fact">
          <dt className="fact__label">These rows cover</dt>
          <dd className="fact__value">
            <Window earliest={money.earliest} latest={money.latest} />
          </dd>
        </div>
        {money.retried > 0 ? (
          <div className="fact">
            <dt className="fact__label">Needed more than one try</dt>
            <dd className="fact__value">{money.retried}</dd>
          </div>
        ) : null}
      </dl>
    </Module>
  );
}

/** How many kiosks to name before the rest become one row. */
const NAMED_KIOSKS = 5;

/**
 * Where the payments on this page were taken.
 *
 * The smaller question beside the larger one, and the one that turns "three
 * failed" into somewhere to send an engineer. Kiosks past the fifth collapse
 * into a single row rather than being dropped, so the shares still add up to the
 * page and the list cannot quietly become a top-five presented as everything.
 */
function KioskBreakdown({ money, status }: { money: PaymentFacts; status: string }) {
  const named = money.kiosks.slice(0, NAMED_KIOSKS);
  const rest = money.kiosks.slice(NAMED_KIOSKS);
  const restTotal = rest.reduce((sum, kiosk) => sum + kiosk.value, 0);
  const restStuck = rest.reduce((sum, kiosk) => sum + kiosk.notThrough, 0);

  const rows: DistributionRow[] = named.map((kiosk) => ({
    id: kiosk.kioskId,
    label: kiosk.kioskId,
    value: kiosk.value,
    tone: kiosk.notThrough > 0 ? "warn" : "neutral",
    note:
      kiosk.notThrough > 0
        ? `${kiosk.notThrough} did not go through`
        : status === ""
          ? "All went through"
          : undefined
  }));

  if (rest.length > 0) {
    rows.push({
      id: "__rest",
      label: `${rest.length} other kiosk${rest.length === 1 ? "" : "s"}`,
      value: restTotal,
      tone: restStuck > 0 ? "warn" : "neutral",
      note: restStuck > 0 ? `${restStuck} did not go through` : undefined
    });
  }

  return (
    <Module
      title="By kiosk"
      summary={
        money.kiosks.length === 1
          ? "Every payment on this page was taken at one kiosk."
          : `Spread across ${money.kiosks.length} kiosks.`
      }
    >
      <Distribution
        label="Payments on this page by kiosk"
        rows={rows}
        total={money.loaded}
        scope={`Counted from the ${money.loaded} payments on this page${
          status === "" ? "" : `, ${humanizeState(status).toLowerCase()} only`
        }.`}
      />
    </Module>
  );
}

/**
 * What is still owed, and how long it has been owed.
 *
 * The count is the server's, over everything; the amount is this page's, and the
 * two are printed together precisely so the difference between them is visible.
 * There is no endpoint that sums outstanding obligations, and an amount labelled
 * as though there were would be the most quotable wrong number on the screen.
 */
function RefundReading({
  owed,
  owedInTotal,
  owedOnly
}: {
  owed: RefundFacts;
  owedInTotal: number | null;
  owedOnly: boolean;
}) {
  return (
    <Module
      title="Still to return"
      pill={
        owed.aged > 0 ? (
          <StatusPill tone="critical">{owed.aged} over a day</StatusPill>
        ) : owed.owed > 0 ? (
          <StatusPill tone="warn">{owed.owed} waiting</StatusPill>
        ) : (
          <StatusPill tone="good">Nothing owed here</StatusPill>
        )
      }
    >
      <Headline
        label="Amount owed"
        value={<Amounts totals={owed.owedAmounts} />}
        note={
          owed.owed === 0
            ? "Every refund on this page has been returned."
            : `Across the ${owed.owed} unreturned refund${owed.owed === 1 ? "" : "s"} on this page${
                owedInTotal !== null && owedInTotal > owed.owed
                  ? `, of ${owedInTotal} owed in total.`
                  : "."
              }`
        }
      />

      <dl className="fact-row">
        <div className="fact">
          <dt className="fact__label">Waiting longest</dt>
          <dd className="fact__value">
            {owed.longestHours === null ? "—" : formatHours(owed.longestHours)}
          </dd>
        </div>
        <div className="fact">
          <dt className="fact__label">Owed a day or more</dt>
          <dd className="fact__value">{owed.aged}</dd>
        </div>
        {owedOnly ? null : (
          <div className="fact">
            <dt className="fact__label">Already returned</dt>
            <dd className="fact__value">{owed.returned}</dd>
          </div>
        )}
      </dl>
    </Module>
  );
}

/** Why money was given back, over the refunds on this page. */
function RefundReasons({ owed }: { owed: RefundFacts }) {
  const rows: DistributionRow[] = owed.reasons.map((entry) => ({
    id: entry.reason,
    label: humanizeState(entry.reason),
    value: entry.value
  }));

  return (
    <Module
      title="Why refunds were raised"
      summary={
        owed.reasons.length === 1
          ? "Every refund on this page was raised for one reason."
          : `${owed.reasons.length} different reasons on this page.`
      }
    >
      <Distribution
        label="Refunds on this page by reason"
        rows={rows}
        total={owed.loaded}
        scope={`Share of the ${owed.loaded} refund${owed.loaded === 1 ? "" : "s"} on this page.`}
      />
    </Module>
  );
}

/**
 * Money, by currency, never across them.
 *
 * Two currencies added together is not a total of anything, so amounts are kept
 * apart and printed side by side. In practice there is one; the code is written
 * for the day there is not, because that is the day a single figure would be
 * wrong and nobody would be able to tell by looking.
 */
function Amounts({ totals }: { totals: readonly CurrencyTotal[] }) {
  if (totals.length === 0) return <span className="muted">—</span>;
  return (
    <>
      {totals.map((total, index) => (
        <span key={total.currency}>
          {index > 0 ? <span aria-hidden="true"> · </span> : null}
          <Money minor={total.minor} currency={total.currency} exponent={total.exponent} />
        </span>
      ))}
    </>
  );
}

/** The stretch of time the loaded rows actually came from. Stated, never implied. */
function Window({ earliest, latest }: { earliest: string | null; latest: string | null }) {
  if (!earliest || !latest) return <span className="muted">—</span>;
  const from = new Date(earliest);
  const to = new Date(latest);
  const sameDay = from.toDateString() === to.toDateString();
  const day = (value: Date) =>
    value.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  const clock = (value: Date) =>
    value.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

  return (
    <time dateTime={earliest} title={`${from.toLocaleString()} — ${to.toLocaleString()}`}>
      {sameDay
        ? `${day(from)}, ${clock(from)}–${clock(to)}`
        : `${day(from)} ${clock(from)} – ${day(to)} ${clock(to)}`}
    </time>
  );
}

// ---------------------------------------------------------------------------
// What one page of rows says about itself
// ---------------------------------------------------------------------------

export interface CurrencyTotal {
  currency: string;
  exponent: number;
  minor: number;
}

export interface PaymentFacts {
  /** How many rows this was counted from. Every share below is out of this. */
  loaded: number;
  captured: number;
  failed: number;
  /**
   * Finished without taking the money — failed, expired, or anything else that
   * ended without a capture.
   *
   * Kept apart from `failed` because they are not the same claim and the wider
   * one is what "all went through" has to be tested against: a page holding one
   * expired intent and no failures is not a page where everything went through.
   */
  notThrough: number;
  /** Still in flight: not a success and not a failure. */
  stillOpen: number;
  finished: number;
  /** Captured as a share of the finished rows. Null when none have finished. */
  successRate: number | null;
  statuses: readonly { status: string; value: number }[];
  kiosks: readonly { kioskId: string; value: number; notThrough: number }[];
  /** What was actually taken, by currency. Never summed across currencies. */
  capturedAmounts: readonly CurrencyTotal[];
  retried: number;
  earliest: string | null;
  latest: string | null;
}

/**
 * Everything the loaded payments say, counted once.
 *
 * Nothing in here reaches past the rows it was given, and the type says so: this
 * takes a page and returns facts about that page. The screen is what adds "on
 * this page" to every sentence, and the reason it can do that honestly is that
 * there is nowhere in this function for a whole-system number to come from.
 */
export function summarizePayments(items: readonly Payment[]): PaymentFacts {
  const byStatus = new Map<string, number>();
  const byKiosk = new Map<string, { value: number; notThrough: number }>();
  const byCurrency = new Map<string, CurrencyTotal>();

  let captured = 0;
  let failed = 0;
  let stillOpen = 0;
  let retried = 0;
  let earliest: string | null = null;
  let latest: string | null = null;

  for (const payment of items) {
    byStatus.set(payment.status, (byStatus.get(payment.status) ?? 0) + 1);

    const kiosk = byKiosk.get(payment.kioskId) ?? { value: 0, notThrough: 0 };
    kiosk.value += 1;
    if (!PAID.has(payment.status) && !OPEN.has(payment.status)) kiosk.notThrough += 1;
    byKiosk.set(payment.kioskId, kiosk);

    if (PAID.has(payment.status)) {
      captured += 1;
      const total = byCurrency.get(payment.currency) ?? {
        currency: payment.currency,
        exponent: payment.currencyExponent,
        minor: 0
      };
      total.minor += payment.amountMinor;
      byCurrency.set(payment.currency, total);
    }
    if (payment.status === "FAILED") failed += 1;
    if (OPEN.has(payment.status)) stillOpen += 1;
    // The row shows the number of attempts; this is the count of payments that
    // took more than one, which is the version worth a line on a summary.
    if (payment.attempts > 1) retried += 1;

    const at = Date.parse(payment.createdAt);
    if (Number.isFinite(at)) {
      if (earliest === null || at < Date.parse(earliest)) earliest = payment.createdAt;
      if (latest === null || at > Date.parse(latest)) latest = payment.createdAt;
    }
  }

  const finished = items.length - stillOpen;

  return {
    loaded: items.length,
    captured,
    failed,
    notThrough: finished - captured,
    stillOpen,
    finished,
    successRate: finished > 0 ? Math.round((captured / finished) * 100) : null,
    // Lifecycle order rather than size order, so a bar does not change places
    // under somebody between two polls. A status this build has not met is kept
    // and shown last rather than folded into an "other" that hides it.
    statuses: [
      ...PAYMENT_STATUSES.filter((status) => byStatus.has(status)),
      ...[...byStatus.keys()].filter((status) => !KNOWN_STATUSES.has(status)).sort()
    ].map((status) => ({ status, value: byStatus.get(status) ?? 0 })),
    kiosks: [...byKiosk.entries()]
      .map(([kioskId, counts]) => ({ kioskId, ...counts }))
      .sort((left, right) => right.value - left.value || left.kioskId.localeCompare(right.kioskId)),
    capturedAmounts: [...byCurrency.values()].sort((left, right) =>
      left.currency.localeCompare(right.currency)
    ),
    retried,
    earliest,
    latest
  };
}

export interface RefundFacts {
  loaded: number;
  /** Authorized and not yet returned, among the rows on this page. */
  owed: number;
  returned: number;
  owedAmounts: readonly CurrencyTotal[];
  /** Owed for a day or more. */
  aged: number;
  longestHours: number | null;
  reasons: readonly { reason: string; value: number }[];
}

export function summarizeRefunds(items: readonly Refund[]): RefundFacts {
  const byReason = new Map<string, number>();
  const byCurrency = new Map<string, CurrencyTotal>();

  let owed = 0;
  let returned = 0;
  let aged = 0;
  let longestHours: number | null = null;

  for (const refund of items) {
    byReason.set(refund.reason, (byReason.get(refund.reason) ?? 0) + 1);

    if (refund.completedAt !== null) {
      returned += 1;
      continue;
    }

    owed += 1;
    const total = byCurrency.get(refund.currency) ?? {
      currency: refund.currency,
      exponent: refund.currencyExponent,
      minor: 0
    };
    total.minor += refund.amountMinor;
    byCurrency.set(refund.currency, total);

    if (refund.outstandingHours !== null) {
      if (refund.outstandingHours >= STALE_HOURS) aged += 1;
      if (longestHours === null || refund.outstandingHours > longestHours) {
        longestHours = refund.outstandingHours;
      }
    }
  }

  return {
    loaded: items.length,
    owed,
    returned,
    aged,
    longestHours,
    owedAmounts: [...byCurrency.values()].sort((left, right) =>
      left.currency.localeCompare(right.currency)
    ),
    reasons: [...byReason.entries()]
      .map(([reason, value]) => ({ reason, value }))
      .sort((left, right) => right.value - left.value || left.reason.localeCompare(right.reason))
  };
}

/**
 * The reading a status gets, in the tone vocabulary the bars use.
 *
 * Deliberately the same verdict the badge on the row gives: captured is good,
 * failed is the bad one, pending and expired are waiting, and a state this build
 * has not met stays neutral rather than being guessed at. A colour must not mean
 * one thing in a bar and another thing in the table under it.
 */
function statusTone(status: string): Tone {
  if (PAID.has(status)) return "good";
  if (status === "FAILED") return "critical";
  if (status === "PENDING" || status === "EXPIRED") return "warn";
  return "neutral";
}

/**
 * A day is the point at which "waiting on the provider" stops being routine.
 *
 * Not a threshold the server enforces — nothing here changes because of it. It
 * is a reading aid on a column of hours, so that a debt three days old does not
 * look like one raised this morning.
 */
const STALE_HOURS = 24;

function agedFlag(refund: Refund): string | null {
  if (refund.completedAt !== null) return null;
  if (refund.outstandingHours === null) return null;
  if (refund.outstandingHours < STALE_HOURS) return null;
  return "Still owed";
}

function rowToneFor(refund: Refund): string | undefined {
  if (agedFlag(refund)) return "is-alarming-row";
  if (refund.completedAt === null) return "is-quiet-row";
  return undefined;
}

/** Hours, said the way a person would say them. */
function formatHours(hours: number): string {
  if (hours < 1) return "under an hour";
  if (hours < 24) return `${hours} h`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}
