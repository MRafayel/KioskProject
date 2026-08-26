import { useCallback, useEffect, useState } from "react";

import {
  CAPTURED_PAYMENT_STATUSES,
  UNFINISHED_PAYMENT_STATUSES,
  type AdminMoneySummaryResponse,
  type AdminRefundsResponse,
  type CurrencyAmount,
  type MoneyWindow
} from "@printing-kiosk/admin-access";

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
  formatMoney,
  humanizeState
} from "../features/observability/components.js";
import {
  Choices,
  Delta,
  Distribution,
  Headline,
  Module,
  Section,
  StatusPill,
  TrendBars,
  type DistributionRow,
  type Tone,
  type TrendBar
} from "../features/observability/surfaces.js";
import { useAdminData } from "../features/observability/useAdminData.js";
import { usePageTrail } from "../features/observability/usePageTrail.js";
import { RefundQueue } from "./RefundQueue.js";

type Refund = AdminRefundsResponse["items"][number];
type MoneyPeriod = AdminMoneySummaryResponse["current"];

const PAYMENT_STATUSES = ["CAPTURED", "AUTHORIZED", "PENDING", "FAILED", "EXPIRED"] as const;

/** The two statuses the server sums and counts by, so both sides agree. */
const CAPTURED = new Set<string>(CAPTURED_PAYMENT_STATUSES);
const UNFINISHED = new Set<string>(UNFINISHED_PAYMENT_STATUSES);

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

/** How each window is named, in the three places it has to be said. */
const WINDOWS: Readonly<Record<MoneyWindow, { tab: string; span: string; previous: string }>> = {
  DAY: { tab: "Day", span: "last 24 hours", previous: "the previous 24 hours" },
  WEEK: { tab: "Week", span: "last 7 days", previous: "the previous 7 days" },
  MONTH: { tab: "Month", span: "last 30 days", previous: "the previous 30 days" }
};

/** What the bars are counting. The headline above them does not change with it. */
type Series = "AMOUNT" | "COUNT";

/**
 * Money: how the business is doing, and the three things a person can do about it.
 *
 * The page is two halves and the split is the design.
 *
 * **Above**, a dashboard. Every figure on it is aggregated by the database over
 * a chosen window — money taken, how it compares with the window before, the
 * shape of the payments inside it, what is owed right now. Nothing up there is
 * counted from a page of rows, which is what earlier versions of this screen did
 * and what made a success rate a statement about fifty payments dressed as a
 * statement about the business.
 *
 * **Below**, the work. Three views that must not be merged, because they are
 * different stages of one story: a decision is undecided work, a payment is
 * something that already happened, and an owed refund is an obligation this
 * panel created and cannot discharge. A single table holding all three would
 * have rows that are variously a question, a fact and a debt.
 *
 * Two rules decide what may be drawn here.
 *
 * **A comparison is only drawn when there is something to compare against.**
 * The endpoint returns two periods of identical length, and where the earlier
 * one is empty the panel says so instead of dividing by it. There is no
 * percentage anywhere on this page that was not computed from two server-side
 * totals.
 *
 * **What needs a person is separated from what merely happened.** The strip
 * under the heading is the actionable half and it is absent entirely on a quiet
 * day; the cards under it are the historical half and are always the same shape.
 * Emphasis that is permanently on is emphasis nobody sees.
 *
 * The one act that costs money lives in the decision queue with its safety text.
 * This screen authorizes an obligation; nothing on it settles one. Settlement
 * runs against the payment provider by something holding a provider credential,
 * and no part of the panel holds one.
 */
export function MoneyPanel({ focus }: { focus?: "refunds" | undefined } = {}) {
  const session = useSession();
  const canSeeRefunds = session.can("refund.obligation.read");
  const canAuthorizeRefunds = session.can("refund.authorize");
  const canReconcile = session.can("payment.reconcile.read");

  // Arriving from the overview's unsettled refunds opens that view. Everyone
  // else lands on the work.
  const [view, setView] = useState<ViewId>(
    focus === "refunds" && canSeeRefunds ? "refunds" : canSeeRefunds ? "decisions" : "payments"
  );

  const [range, setRange] = useState<MoneyWindow>("WEEK");
  const [series, setSeries] = useState<Series>("AMOUNT");

  /**
   * The dashboard itself. One request, every figure above the fold.
   *
   * A minute between polls rather than the thirty seconds the lists use. This is
   * a business reading and not an incident signal: a week's takings do not
   * change meaningfully in half a minute, and the refresh button is there for
   * the moment somebody wants to be sure.
   */
  const loadSummary = useCallback(() => observabilityApi.moneySummary(range), [range]);
  const summary = useAdminData(loadSummary, { refreshMilliseconds: 60_000 });
  const report = summary.data;

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

  // The decision count is drawn whichever view is open, but the queue below
  // reports its own totals when it is mounted — so this only asks when nothing
  // else is already asking.
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
  const owedCount = report?.liability?.unsettled ?? null;
  const expired = report?.now.expired ?? 0;

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
   * Pressing a status in the composition filters the ledger to it, and pressing
   * the one already on clears it — the same behaviour the tiles on Sessions and
   * Printing have, so a status is a status wherever it is pressed.
   */
  const chooseStatus = useCallback(
    (status: string) => showPayments(paymentStatus === status ? "" : status),
    [paymentStatus, showPayments]
  );
  const clearStatus = useCallback(() => showPayments(""), [showPayments]);

  const reloadEverything = useCallback(() => {
    summary.reload();
    payments.reload();
    if (canSeeRefunds) {
      refunds.reload();
      queueSummary.reload();
    }
  }, [canSeeRefunds, payments, queueSummary, refunds, summary]);

  const filtered = paymentStatus !== "";
  const busy = (needsDecision ?? 0) > 0 || (owedCount ?? 0) > 0 || expired > 0;

  return (
    <>
      <header className="page-head">
        <div className="page-head__lead">
          <p
            className={`page-head__summary page-head__summary--${
              needsDecision && needsDecision > 0 ? "critical" : busy ? "busy" : "calm"
            }`}
          >
            <span className="page-head__dot" aria-hidden="true" />
            {canSeeRefunds && needsDecision === null
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
            {report?.scoped ? " · your assigned kiosks" : ""}
            {report ? ` · updated ${new Date(report.generatedAt).toLocaleTimeString()}` : ""}
            {view === "payments" && filtered ? (
              <button type="button" className="button-link page-head__clear" onClick={clearStatus}>
                Show all
              </button>
            ) : null}
          </p>
        </div>

        <div className="page-head__actions">
          {summary.loading && report ? (
            <span className="page-head__refreshing" role="status">
              Refreshing…
            </span>
          ) : null}
          <button
            type="button"
            className="button-primary"
            onClick={reloadEverything}
            disabled={summary.loading}
          >
            Refresh
          </button>
        </div>
      </header>

      {/* The actionable half, and the reason it is a strip rather than a row of
          cards: on a quiet day it renders nothing at all and costs no height.
          Four permanent tiles saying zero is what this replaced. */}
      <AttentionStrip
        needsDecision={needsDecision}
        liability={report?.liability ?? null}
        expired={expired}
        canSeeRefunds={canSeeRefunds}
        onDecisions={() => setView("decisions")}
        onRefunds={() => {
          setOwedOnly(true);
          refundPages.reset();
          setView("refunds");
        }}
      />

      <Section
        id="money-performance"
        title="Business performance"
        actions={
          <Choices
            label="Time window"
            value={range}
            onChoose={setRange}
            size="small"
            options={[
              { id: "DAY", label: WINDOWS.DAY.tab, hint: "Show the last 24 hours" },
              { id: "WEEK", label: WINDOWS.WEEK.tab, hint: "Show the last 7 days" },
              { id: "MONTH", label: WINDOWS.MONTH.tab, hint: "Show the last 30 days" }
            ]}
          />
        }
      >
        {summary.error ? (
          <div className="panel__error" role="alert">
            <span className="panel__error-text">
              {summary.error}
              {report ? " Showing the last figures that loaded." : ""}
            </span>
            <button type="button" onClick={summary.reload}>
              Try again
            </button>
          </div>
        ) : null}

        {report ? (
          <div className="dashboard-grid">
            <TakingsCard
              report={report}
              range={range}
              series={series}
              onSeries={setSeries}
              filtered={filtered}
            />
            <OutcomesCard
              report={report}
              range={range}
              status={paymentStatus}
              onChoose={chooseStatus}
            />
            {report.refunds && report.liability ? (
              <RefundsCard report={report} range={range} />
            ) : null}
          </div>
        ) : (
          <p className="panel__status" role="status">
            {summary.error ? "The figures could not be loaded." : "Working out the figures…"}
          </p>
        )}
      </Section>

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
            summary.reload();
          }}
        />
      ) : null}

      {view === "payments" ? (
        <Panel
          title="Payments"
          state={payments}
          emptyMessage="No payments yet."
          hint={
            <>
              Every payment, newest first — not limited to the window above.{" "}
              {canReconcile
                ? "Provider references are shown because your role reconciles against the provider's ledger."
                : "Provider references are withheld from your role."}
            </>
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
          {payments.data && payments.data.items.length === 0 ? (
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

          {payments.data && payments.data.items.length > 0 ? (
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
              {payments.data.items.map((payment) => (
                <tr
                  key={payment.id}
                  className={CAPTURED.has(payment.status) ? undefined : "is-quiet-row"}
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
                      quiet={CAPTURED.has(payment.status)}
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
      ) : null}

      {view === "refunds" && canSeeRefunds ? (
        <Panel
          title="Unsettled refunds"
          state={refunds}
          emptyMessage="No refunds owed."
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
          {refunds.data && refunds.data.items.length === 0 ? (
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

          {refunds.data && refunds.data.items.length > 0 ? (
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
              {refunds.data.items.map((refund) => (
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
                    {refund.completedAt !== null || refund.outstandingHours === null ? (
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
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// The actionable half
// ---------------------------------------------------------------------------

/**
 * What needs a person, on one line, or nothing at all.
 *
 * This is the whole of what replaced four permanent summary cards. It carries
 * only states somebody has to act on, each one a way into the view that acts on
 * it, and when there is nothing to act on it renders nothing — so a calm morning
 * costs no vertical space at all, and anything appearing here means something.
 */
function AttentionStrip({
  needsDecision,
  liability,
  expired,
  canSeeRefunds,
  onDecisions,
  onRefunds
}: {
  needsDecision: number | null;
  liability: AdminMoneySummaryResponse["liability"];
  expired: number;
  canSeeRefunds: boolean;
  onDecisions: () => void;
  onRefunds: () => void;
}) {
  const decisions = needsDecision ?? 0;
  const owed = liability?.unsettled ?? 0;
  if (decisions === 0 && owed === 0 && expired === 0) return null;

  const waiting = liability?.oldestOutstandingHours ?? null;

  return (
    <section className="attention-strip" aria-label="Needs attention">
      <p className="attention-strip__lead">
        <span aria-hidden="true">●</span> Needs a person
      </p>
      <ul className="attention-strip__items">
        {decisions > 0 && canSeeRefunds ? (
          <li>
            <button
              type="button"
              className="attention-strip__item is-critical"
              onClick={onDecisions}
              aria-label={`${decisions} prints need a money decision. Open the decision queue.`}
            >
              <strong>{decisions}</strong> to decide
              <span className="attention-strip__note">a customer is waiting on each</span>
            </button>
          </li>
        ) : null}

        {owed > 0 && liability ? (
          <li>
            <button
              type="button"
              className="attention-strip__item"
              onClick={onRefunds}
              aria-label={`${owed} refunds are still to return. Show the refunds still owed.`}
            >
              <strong>{owed}</strong> to return
              <span className="attention-strip__note">
                <Amounts totals={liability.amounts} /> owed
                {waiting !== null && waiting >= STALE_HOURS
                  ? ` · oldest waiting ${formatHours(waiting)}`
                  : ""}
              </span>
            </button>
          </li>
        ) : null}

        {expired > 0 ? (
          // No way in: "ran out of time" is an open payment past its expiry,
          // which is not the `EXPIRED` status the ledger filter takes. A button
          // here would show a different set of rows than the number it was
          // pressed for.
          <li>
            <span className="attention-strip__item is-static">
              <strong>{expired}</strong> ran out of time
              <span className="attention-strip__note">started and never resolved</span>
            </span>
          </li>
        ) : null}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// The dashboard
// ---------------------------------------------------------------------------

/**
 * Money taken, against the window before it, with the shape of it underneath.
 *
 * The headline is the amount and stays the amount whichever series the bars are
 * showing. A headline that changed with a chart toggle would be two different
 * readings sharing one slot, and the number somebody quotes from this page
 * should not depend on which button was last pressed.
 */
function TakingsCard({
  report,
  range,
  series,
  onSeries,
  filtered
}: {
  report: AdminMoneySummaryResponse;
  range: MoneyWindow;
  series: Series;
  onSeries: (series: Series) => void;
  filtered: boolean;
}) {
  const words = WINDOWS[range];
  const current = readPeriod(report.current);
  const previous = readPeriod(report.previous);

  // One currency is the ordinary case and the only one a single line of bars can
  // honestly draw. With more than one the amount series would be adding sums
  // that are not addable, so the bars fall back to counting payments and say so.
  const single = current.amounts.length === 1 ? current.amounts[0] : undefined;
  const drawable = series === "AMOUNT" && single !== undefined;
  const showing: Series = drawable ? "AMOUNT" : "COUNT";

  return (
    <Module
      title="Money taken"
      pill={
        <Choices
          label="What the bars show"
          value={series}
          onChoose={onSeries}
          size="small"
          options={[
            { id: "AMOUNT", label: "Amount", hint: "Show the money taken per bar" },
            { id: "COUNT", label: "Volume", hint: "Show the number of payments per bar" }
          ]}
        />
      }
    >
      <Headline
        label={words.span}
        value={<Amounts totals={current.amounts} />}
        note={
          single ? (
            <Delta
              current={single.amountMinor}
              previous={amountOf(previous.amounts, single.currency)}
              compared={words.previous}
            />
          ) : current.amounts.length === 0 ? (
            `Nothing was captured in the ${words.span}.`
          ) : (
            `Several currencies, kept apart — each is compared on its own row below.`
          )
        }
      />

      {report.trendTruncated ? (
        <p className="panel__status">
          Too many payments in this window to chart. The totals above and below are still exact.
        </p>
      ) : (
        <TrendBars
          bars={barsOf(report, showing)}
          axis={axisOf(report)}
          caption={
            showing === "AMOUNT" && single
              ? `Money captured per ${intervalWord(report.interval)}, ${words.span}, in ${single.currency}. Paler bars cover less than a full ${intervalWord(report.interval)}.`
              : `Payments started per ${intervalWord(report.interval)}, ${words.span}. Red is the part that failed; paler bars cover less than a full ${intervalWord(report.interval)}.`
          }
        />
      )}

      <dl className="fact-row">
        <div className="fact">
          {/* "Started", not "taken": this is the basis every bar and every rate
              on the card is cut on, and saying so here is what makes the success
              rate beside it readable without a footnote. */}
          <dt className="fact__label">Payments started</dt>
          <dd className="fact__value">
            {current.started}
            <Delta
              current={current.started}
              previous={previous.started}
              compared={words.previous}
            />
          </dd>
        </div>
        <div className="fact">
          <dt className="fact__label">Success rate</dt>
          <dd className="fact__value">
            {current.successRate === null ? "—" : `${current.successRate.toFixed(1)}%`}
            {current.successRate !== null && previous.successRate !== null ? (
              <Delta
                current={current.successRate}
                previous={previous.successRate}
                mode="points"
                compared={words.previous}
              />
            ) : (
              <span className="delta delta--none">
                {current.successRate === null
                  ? "No payment has finished yet"
                  : `Nothing finished in ${words.previous}`}
              </span>
            )}
          </dd>
        </div>
        {filtered ? (
          <div className="fact">
            <dt className="fact__label">Table filter</dt>
            <dd className="fact__value">On — the figures above ignore it</dd>
          </div>
        ) : null}
      </dl>
    </Module>
  );
}

/**
 * What became of the payments in this window, and a way into each group.
 *
 * The composition is the server's count over the whole window, but the ledger
 * underneath is every payment ever taken. Pressing a status filters that ledger
 * rather than narrowing this card, which is why the ledger says in its own hint
 * that it is not limited to the window.
 */
function OutcomesCard({
  report,
  range,
  status,
  onChoose
}: {
  report: AdminMoneySummaryResponse;
  range: MoneyWindow;
  status: string;
  onChoose: (status: string) => void;
}) {
  const words = WINDOWS[range];
  const current = readPeriod(report.current);
  const previous = readPeriod(report.previous);

  const rows: DistributionRow[] = orderStatuses(report.current.byStatus).map((entry) => ({
    id: entry.status,
    label: humanizeState(entry.status),
    value: entry.count,
    tone: statusTone(entry.status),
    // The one status whose direction is worth knowing, and it belongs on the row
    // that already carries the count rather than repeated as a figure of its
    // own further down the card.
    ...(entry.status === "FAILED" && (entry.count > 0 || previous.failed > 0)
      ? {
          note: (
            <Delta
              current={entry.count}
              previous={previous.failed}
              direction="up-is-bad"
              compared={words.previous}
            />
          )
        }
      : {}),
    pressed: status === entry.status,
    onOpen: () => onChoose(entry.status),
    openLabel:
      status === entry.status
        ? "Showing only these. Select to clear the filter."
        : `Show only ${humanizeState(entry.status).toLowerCase()} payments in the ledger.`
  }));

  return (
    <Module
      title="How payments finished"
      pill={
        current.notThrough > 0 ? (
          <StatusPill tone="warn">{current.notThrough} did not go through</StatusPill>
        ) : (
          <StatusPill tone="good">All went through</StatusPill>
        )
      }
      summary={
        current.started === 0
          ? `No payment was started in the ${words.span}.`
          : current.unfinished > 0
            ? `${current.unfinished} of these are still in flight.`
            : "Every payment in this window has finished."
      }
    >
      <Distribution
        label={`Payments in the ${words.span} by status`}
        rows={rows}
        total={report.current.started}
        scope={`Of the ${report.current.started} payments started in the ${words.span}. Select one to filter the ledger.`}
      />
    </Module>
  );
}

/**
 * What is owed now, and whether the pile is growing.
 *
 * The amount is a liability rather than a measurement, so it is the figure that
 * leads: it is what the business owes customers at this moment, whatever window
 * is selected above. The two flows under it are window-scoped and are what say
 * whether that pile is being worked down.
 */
function RefundsCard({ report, range }: { report: AdminMoneySummaryResponse; range: MoneyWindow }) {
  const words = WINDOWS[range];
  const liability = report.liability;
  const flow = report.refunds;
  if (!liability || !flow) return null;

  const waiting = liability.oldestOutstandingHours;

  return (
    <Module
      title="Refunds"
      pill={
        liability.unsettled === 0 ? (
          <StatusPill tone="good">Nothing owed</StatusPill>
        ) : waiting !== null && waiting >= STALE_HOURS ? (
          <StatusPill tone="critical">Oldest {formatHours(waiting)}</StatusPill>
        ) : (
          <StatusPill tone="warn">{liability.unsettled} waiting</StatusPill>
        )
      }
    >
      <Headline
        label="Owed right now"
        value={<Amounts totals={liability.amounts} />}
        note={
          liability.unsettled === 0
            ? "Every authorized refund has been returned."
            : `Across ${liability.unsettled} authorized refund${
                liability.unsettled === 1 ? "" : "s"
              } the provider has not returned yet.`
        }
      />

      <dl className="fact-row">
        {/* The two flows that say whether the pile above is being worked down:
            what was newly owed in this window, and what the provider actually
            returned in it. Both carry their money as well as their count,
            because a week of nine small refunds and a week of nine large ones
            are not the same week. */}
        <div className="fact">
          <dt className="fact__label">Raised, {words.span}</dt>
          <dd className="fact__value">
            {flow.current.raised}
            <span className="fact__aside">
              <Amounts totals={flow.current.raisedAmounts} />
            </span>
            <Delta
              current={flow.current.raised}
              previous={flow.previous.raised}
              direction="up-is-bad"
              compared={words.previous}
            />
          </dd>
        </div>
        <div className="fact">
          <dt className="fact__label">Returned, {words.span}</dt>
          <dd className="fact__value">
            {flow.current.returned}
            <span className="fact__aside">
              <Amounts totals={flow.current.returnedAmounts} />
            </span>
            <Delta
              current={flow.current.returned}
              previous={flow.previous.returned}
              compared={words.previous}
            />
          </dd>
        </div>
      </dl>
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
function Amounts({ totals }: { totals: readonly CurrencyAmount[] }) {
  if (totals.length === 0) return <>0</>;
  return (
    <>
      {totals.map((total, index) => (
        <span key={total.currency}>
          {index > 0 ? <span aria-hidden="true"> · </span> : null}
          <Money
            minor={total.amountMinor}
            currency={total.currency}
            exponent={total.currencyExponent}
          />
        </span>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Reading the server's figures
// ---------------------------------------------------------------------------

interface PeriodReading {
  started: number;
  captured: number;
  failed: number;
  /** Started in the period and not finished either way. */
  unfinished: number;
  finished: number;
  /** Finished without taking the money: failed, expired, anything else. */
  notThrough: number;
  /** Captured as a share of what finished, in percent. Null when none have. */
  successRate: number | null;
  amounts: readonly CurrencyAmount[];
}

/**
 * One period's counts, read the way the page talks about them.
 *
 * The success rate excludes payments still in flight rather than counting them
 * as failures: a customer half-way through paying is not a customer whose
 * payment failed, and counting them in would make a busy hour look like an
 * outage. The count of them is on the card beside the rate.
 */
function readPeriod(period: MoneyPeriod): PeriodReading {
  let captured = 0;
  let failed = 0;
  let unfinished = 0;

  for (const row of period.byStatus) {
    if (CAPTURED.has(row.status)) captured += row.count;
    if (row.status === "FAILED") failed += row.count;
    if (UNFINISHED.has(row.status)) unfinished += row.count;
  }

  const finished = period.started - unfinished;
  return {
    started: period.started,
    captured,
    failed,
    unfinished,
    finished,
    notThrough: finished - captured,
    successRate: finished > 0 ? (captured / finished) * 100 : null,
    amounts: period.capturedAmounts
  };
}

/** Lifecycle order, with anything this build has not met kept and shown last. */
function orderStatuses(
  rows: readonly { status: string; count: number }[]
): readonly { status: string; count: number }[] {
  const rank = new Map<string, number>(PAYMENT_STATUSES.map((status, index) => [status, index]));
  return [...rows].sort(
    (left, right) =>
      (rank.get(left.status) ?? PAYMENT_STATUSES.length) -
        (rank.get(right.status) ?? PAYMENT_STATUSES.length) ||
      left.status.localeCompare(right.status)
  );
}

/** What one currency contributed to a period, or nothing. */
function amountOf(totals: readonly CurrencyAmount[], currency: string): number {
  return totals.find((total) => total.currency === currency)?.amountMinor ?? 0;
}

/** The trend, in whichever unit the chart is currently drawing. */
function barsOf(report: AdminMoneySummaryResponse, series: Series): TrendBar[] {
  return report.trend.map((point) => {
    const when = barLabel(point.startsAt, report.interval);
    const short = point.partial ? " (part of a " + intervalWord(report.interval) + ")" : "";

    if (series === "AMOUNT") {
      const taken = point.capturedAmounts[0];
      return {
        key: point.startsAt,
        value: taken?.amountMinor ?? 0,
        partial: point.partial,
        description: taken
          ? `${when}: ${formatMoney(taken.amountMinor, taken.currency, taken.currencyExponent)} from ${point.captured} payment${point.captured === 1 ? "" : "s"}${short}`
          : `${when}: nothing captured${short}`
      };
    }

    return {
      key: point.startsAt,
      value: point.started,
      bad: point.failed,
      partial: point.partial,
      description: `${when}: ${point.started} payment${point.started === 1 ? "" : "s"}, ${point.failed} failed${short}`
    };
  });
}

/** Three labels along the bottom: where it starts, the middle, and now. */
function axisOf(report: AdminMoneySummaryResponse): string[] {
  const points = report.trend;
  if (points.length === 0) return [];
  const middle = points[Math.floor(points.length / 2)];
  const labels = [
    barLabel(points[0]?.startsAt ?? "", report.interval),
    middle ? barLabel(middle.startsAt, report.interval) : "",
    "now"
  ];
  return labels.filter((label) => label !== "");
}

function barLabel(at: string, interval: AdminMoneySummaryResponse["interval"]): string {
  if (!at) return "";
  const parsed = new Date(at);
  return interval === "HOUR"
    ? parsed.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : parsed.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function intervalWord(interval: AdminMoneySummaryResponse["interval"]): string {
  return interval === "HOUR" ? "hour" : "day";
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
  if (CAPTURED.has(status)) return "good";
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
