import { useCallback } from "react";

import type {
  AdminAttentionCode,
  AdminAttentionSeverity,
  AdminOverviewResponse
} from "@printing-kiosk/admin-access";

import { useSession } from "../features/auth/SessionProvider.js";
import {
  SECTION_CAPABILITY,
  useAdminNavigation,
  type AdminDestination
} from "../features/navigation.js";
import { observabilityApi } from "../features/observability/api.js";
import {
  HealthyNote,
  Kpi,
  KpiRow,
  Module,
  ModuleGrid,
  Section,
  Stat,
  StatList,
  StatusPill,
  type Tone
} from "../features/observability/surfaces.js";
import { useAdminData } from "../features/observability/useAdminData.js";

/**
 * What needs a person, and what the system is doing.
 *
 * The page answers one question before any other: is anything wrong. That
 * answer is a sentence at the top, then a worklist, and only then numbers —
 * because a dashboard that opens with twenty equally-weighted counts makes the
 * reader do the triage the page was built to do for them.
 *
 * The ranking below is deliberate and is the whole design:
 *
 *  1. **A sentence.** "2 items need attention", or that nothing does.
 *  2. **The worklist.** Each entry names a state the system deliberately
 *     refuses to resolve on its own — an undeleted document, an unconfirmed
 *     print, an unsettled refund — because those are the only numbers on this
 *     page that are actually somebody's job.
 *  3. **Four headline numbers**, one of which lifts above the others when it
 *     has something to say.
 *  4. **Modules**, each led by a plain sentence, with healthy zeros present but
 *     quiet.
 *
 * Nothing here is a dead end. A person who notices a number is one keystroke
 * from the rows behind it, already filtered, because the gap between spotting a
 * problem and finding it is where an operations dashboard usually fails.
 *
 * Every number on this page comes from one cached read. Nothing is derived that
 * the server did not send, and nothing is estimated.
 */

interface AttentionEntry {
  label: string;
  /** One line on what the state actually means, for somebody who has not met it. */
  detail: string;
  /** The rows behind this count, and the filter that isolates them. */
  destination: AdminDestination;
  /** The visible action on the card. */
  action: string;
  /** What the operator will be looking at when they arrive. */
  openLabel: string;
}

/**
 * Total over the attention codes on purpose. A code the server can send and
 * this table has no copy for is a compile error rather than a card reading
 * `RETENTION_DEAD_LETTERED` at somebody during an incident.
 */
const ATTENTION: Readonly<Record<AdminAttentionCode, AttentionEntry>> = {
  RETENTION_DEAD_LETTERED: {
    label: "Document deletions that gave up",
    detail: "Retention stopped retrying and the documents still exist.",
    destination: { section: "retention", retentionProblemsOnly: true },
    action: "Review retention",
    openLabel: "Show the retention runs that failed."
  },
  RETENTION_OVERDUE: {
    label: "Sessions past their deletion deadline",
    detail: "Documents are being kept longer than the policy allows.",
    destination: { section: "retention", retentionProblemsOnly: true },
    action: "Review retention",
    openLabel: "Show the retention runs that failed."
  },
  PRINT_RECOVERY_REQUIRED: {
    label: "Paid prints awaiting a human decision",
    detail: "Somebody paid and the system will not decide whether they got their paper.",
    destination: { section: "printing", printStatus: "RECOVERY_REQUIRED" },
    action: "Review printing",
    openLabel: "Show the prints waiting for a person."
  },
  REFUND_UNSETTLED: {
    label: "Refunds owed and not yet returned",
    detail: "The obligation is recorded and the money has not gone back yet.",
    destination: { section: "money", moneyFocus: "refunds" },
    action: "Review refunds",
    openLabel: "Show the money owed back."
  },
  PRINT_OVERDUE: {
    label: "Print jobs past their deadline",
    detail: "These jobs have run past the time they should have finished by.",
    destination: { section: "printing" },
    action: "Review printing",
    openLabel: "Show print jobs."
  },
  DOCUMENT_PROCESSING_FAILED: {
    label: "Uploads that failed processing",
    detail: "Files reached the system and could not be processed.",
    destination: { section: "errors" },
    action: "Review errors",
    openLabel: "Show recent failure groups."
  },
  KIOSK_OFFLINE: {
    label: "Kiosks not heard from",
    detail: "No heartbeat inside the expected window.",
    destination: { section: "kiosks" },
    action: "View kiosks",
    openLabel: "Show kiosk status."
  },
  PAYMENT_EXPIRED_UNRESOLVED: {
    label: "Expired payment intents",
    detail: "Payment intents ran out of time without resolving.",
    destination: { section: "money" },
    action: "View payments",
    openLabel: "Show the payment ledger."
  }
};

/** The worklist's own severity vocabulary, said in words on every card. */
const SEVERITY: Readonly<
  Record<AdminAttentionSeverity, { word: string; tone: Tone; className: string }>
> = {
  CRITICAL: { word: "Critical", tone: "critical", className: "attention__item--critical" },
  WARNING: { word: "Warning", tone: "warn", className: "attention__item--warning" },
  INFO: { word: "Info", tone: "neutral", className: "attention__item--info" }
};

export function OverviewScreen() {
  const load = useCallback(() => observabilityApi.overview(), []);
  const state = useAdminData(load, { refreshMilliseconds: 15_000 });
  const overview = state.data;
  const session = useSession();
  const navigate = useAdminNavigation();

  /**
   * A counter only becomes a link if this account may open the destination.
   * The server refuses regardless, so this is presentation — but a door that
   * opens onto a refusal is worse than no door.
   */
  const opener = useCallback(
    (destination: AdminDestination): (() => void) | undefined =>
      session.can(SECTION_CAPABILITY[destination.section])
        ? () => navigate(destination)
        : undefined,
    [navigate, session]
  );

  // The first load is the only one allowed to show nothing. Every refresh after
  // it keeps the previous numbers on screen, because blanking a dashboard to
  // fetch values it already has is how somebody loses their place mid-incident.
  if (!overview) {
    return (
      <section className="panel">
        {state.error ? (
          <div className="panel__error" role="alert">
            <span className="panel__error-text">{state.error}</span>
            <button type="button" onClick={state.reload}>
              Try again
            </button>
          </div>
        ) : (
          <p className="panel__status" role="status">
            Loading the overview…
          </p>
        )}
      </section>
    );
  }

  const attention = overview.attention;
  const worst = attention.some((item) => item.severity === "CRITICAL") ? "critical" : "busy";
  const summaryTone = attention.length === 0 ? "calm" : worst;

  return (
    <>
      <header className="page-head">
        <div className="page-head__lead">
          <p className={`page-head__summary page-head__summary--${summaryTone}`}>
            <span className="page-head__dot" aria-hidden="true" />
            {attention.length === 0
              ? "All systems operating normally"
              : `${attention.length} ${attention.length === 1 ? "item needs" : "items need"} attention`}
          </p>
          <p className="page-head__meta">
            Updated {new Date(overview.generatedAt).toLocaleTimeString()}
            {overview.snapshotAgeMilliseconds > 0
              ? ` · ${Math.round(overview.snapshotAgeMilliseconds / 1000)}s ago`
              : ""}
            {overview.scoped ? " · your assigned kiosks" : " · every kiosk"}
          </p>
        </div>

        <div className="page-head__actions">
          {state.loading ? (
            <span className="page-head__refreshing" role="status">
              Refreshing…
            </span>
          ) : null}
          <button
            type="button"
            className="button-primary"
            onClick={state.reload}
            disabled={state.loading}
          >
            Refresh
          </button>
        </div>
      </header>

      {/* A refresh that fails leaves the last good numbers up and says they are
          stale, rather than replacing a working page with an error. */}
      {state.error ? (
        <div className="panel__error" role="alert">
          <span className="panel__error-text">
            {state.error} Showing the last numbers that loaded.
          </span>
          <button type="button" onClick={state.reload}>
            Try again
          </button>
        </div>
      ) : null}

      <Section id="overview-attention" title="Needs attention">
        {attention.length === 0 ? (
          <div className="module">
            <HealthyNote>Nothing is waiting on a person.</HealthyNote>
            <p className="module__summary">
              Documents are being deleted on time, no paid print is unresolved, and no refund is
              outstanding.
            </p>
          </div>
        ) : (
          <ul className="attention">
            {attention.map((item) => {
              const entry = ATTENTION[item.code];
              const severity = SEVERITY[item.severity];
              const open = opener(entry.destination);

              const inner = (
                <span className="attention__inner">
                  <span className="attention__top">
                    <span className="attention__count">{item.count}</span>
                    <StatusPill tone={severity.tone}>{severity.word}</StatusPill>
                  </span>
                  <span className="attention__label">{entry.label}</span>
                  <span className="attention__detail">{entry.detail}</span>
                  {open ? (
                    <span className="attention__go" aria-hidden="true">
                      {entry.action} →
                    </span>
                  ) : null}
                </span>
              );

              const className = `attention__item ${severity.className}`;

              if (!open) {
                return (
                  <li key={item.code} className={className}>
                    {inner}
                  </li>
                );
              }

              return (
                <li key={item.code} className={`${className} is-navigable`}>
                  <button
                    type="button"
                    className="attention__open"
                    onClick={open}
                    aria-label={`${severity.word}. ${entry.label}: ${item.count}. ${entry.openLabel}`}
                  >
                    {inner}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <Section id="overview-snapshot" title="Operational snapshot">
        <Snapshot overview={overview} opener={opener} />
      </Section>

      <Section id="overview-detail" title="Operational detail">
        <ModuleGrid>
          <Kiosks overview={overview} opener={opener} />
          <Sessions overview={overview} opener={opener} />
          <Printing overview={overview} opener={opener} />
          <Documents overview={overview} opener={opener} />
          <MoneyModule overview={overview} opener={opener} />
        </ModuleGrid>
      </Section>

      {session.identity && session.identity.kioskScopes.length === 0 && overview.scoped ? (
        <p className="page-head__meta">
          You have no kiosk assigned, so there is nothing for you to see yet. Ask an administrator
          to assign one.
        </p>
      ) : null}

      <p className="page-head__meta">
        Counts are cached for a few seconds so that a wall of open dashboards cannot compete with
        printing for the database.
      </p>
    </>
  );
}

type Opener = (destination: AdminDestination) => (() => void) | undefined;

interface ModuleProps {
  overview: AdminOverviewResponse;
  opener: Opener;
}

/**
 * The four numbers worth knowing first.
 *
 * One of them lifts above the others, and which one is decided by what is
 * actually wrong rather than fixed in advance. Money owed back outranks a kiosk
 * that stopped answering, which outranks a queue of unscanned uploads — the
 * same ordering the worklist uses. On a quiet morning nothing lifts, which is
 * the point: permanent emphasis is emphasis nobody sees.
 */
function Snapshot({ overview, opener }: ModuleProps) {
  const { kiosks, sessions, documents, money } = overview;
  const unhealthyKiosks = kiosks.offline + kiosks.degraded;

  const elevated: "refunds" | "kiosks" | "documents" | null =
    money.unsettledRefunds > 0
      ? "refunds"
      : unhealthyKiosks > 0
        ? "kiosks"
        : documents.awaitingScan > 0
          ? "documents"
          : null;

  return (
    <KpiRow>
      <Kpi
        label="Kiosk health"
        value={kiosks.online}
        of={kiosks.total > 0 ? `of ${kiosks.total} online` : "none registered"}
        foot={
          kiosks.total === 0
            ? "No kiosks are registered yet"
            : unhealthyKiosks === 0
              ? "All kiosks reporting in"
              : `${kiosks.offline} offline, ${kiosks.degraded} degraded`
        }
        tone={unhealthyKiosks > 0 ? "warn" : undefined}
        elevated={elevated === "kiosks"}
        onOpen={opener({ section: "kiosks" })}
        openLabel="Show kiosk status."
      />

      <Kpi
        label="Live sessions"
        value={sessions.live}
        foot={
          sessions.live === 0
            ? "Nothing live right now"
            : `${sessions.awaitingPayment} awaiting payment, ${sessions.printing} printing`
        }
        onOpen={opener({ section: "sessions" })}
        openLabel="Show sessions."
      />

      <Kpi
        label="Outstanding refunds"
        value={money.unsettledRefunds}
        foot={money.unsettledRefunds === 0 ? "Nothing owed back" : "Money owed and not returned"}
        tone={money.unsettledRefunds > 0 ? "warn" : undefined}
        elevated={elevated === "refunds"}
        onOpen={opener({ section: "money", moneyFocus: "refunds" })}
        openLabel="Show the money owed back."
      />

      <Kpi
        label="Awaiting scan"
        value={documents.awaitingScan}
        foot={
          documents.awaitingScan === 0
            ? `Nothing queued, ${documents.processing} processing`
            : `${documents.processing} processing behind them`
        }
        tone={documents.awaitingScan > 0 ? "warn" : undefined}
        elevated={elevated === "documents"}
      />
    </KpiRow>
  );
}

/**
 * Kiosk health as a sentence first.
 *
 * "1 of 1 kiosks offline" tells a single-kiosk operator what they need without
 * a chart, and the same sentence still reads correctly at fifty. The breakdown
 * underneath is for the follow-up question.
 */
function Kiosks({ overview, opener }: ModuleProps) {
  const { kiosks } = overview;
  const open = opener({ section: "kiosks" });
  const unhealthy = kiosks.offline + kiosks.degraded;

  const summary =
    kiosks.total === 0
      ? "No kiosks are registered yet."
      : kiosks.offline > 0
        ? `${kiosks.offline} of ${kiosks.total} ${kiosks.total === 1 ? "kiosk" : "kiosks"} offline`
        : kiosks.degraded > 0
          ? `${kiosks.degraded} of ${kiosks.total} ${kiosks.total === 1 ? "kiosk" : "kiosks"} degraded`
          : `${kiosks.online} of ${kiosks.total} ${kiosks.total === 1 ? "kiosk" : "kiosks"} online`;

  return (
    <Module
      title="Kiosk health"
      summary={summary}
      summaryTone={kiosks.offline > 0 ? "critical" : kiosks.degraded > 0 ? "warn" : undefined}
      pill={
        kiosks.total === 0 ? (
          <StatusPill>None</StatusPill>
        ) : kiosks.offline > 0 ? (
          <StatusPill tone="critical">Offline</StatusPill>
        ) : kiosks.degraded > 0 ? (
          <StatusPill tone="warn">Degraded</StatusPill>
        ) : (
          <StatusPill tone="good">All online</StatusPill>
        )
      }
    >
      {kiosks.total === 0 ? null : (
        <StatList>
          <Stat
            label="Online"
            value={kiosks.online}
            quiet={unhealthy === 0}
            onOpen={open}
            openLabel="Show kiosk status."
          />
          <Stat
            label="Degraded"
            value={kiosks.degraded}
            problem={kiosks.degraded > 0}
            quiet={kiosks.degraded === 0}
            onOpen={open}
            openLabel="Show kiosk status."
          />
          <Stat
            label="Offline"
            value={kiosks.offline}
            problem={kiosks.offline > 0}
            critical={kiosks.offline > 0}
            quiet={kiosks.offline === 0}
            onOpen={open}
            openLabel="Show kiosk status."
          />
          <Stat
            label="Not active"
            value={kiosks.notActive}
            quiet={kiosks.notActive === 0}
            onOpen={open}
            openLabel="Show kiosk status."
          />
          <Stat label="Total" value={kiosks.total} onOpen={open} openLabel="Show every kiosk." />
        </StatList>
      )}
    </Module>
  );
}

/**
 * Sessions, where a zero has to look like a fact rather than a failure.
 *
 * "No live sessions right now" is a different statement from a blank card, and
 * on a screen somebody checks at 03:00 the difference matters: one says the
 * shop is quiet, the other says the dashboard is broken.
 */
function Sessions({ overview, opener }: ModuleProps) {
  const { sessions } = overview;

  return (
    <Module
      title="Sessions"
      summary={
        sessions.live === 0
          ? "No live sessions right now."
          : `${sessions.live} live right now${sessions.recoveryRequired > 0 ? `, ${sessions.recoveryRequired} needing recovery` : ""}`
      }
      summaryTone={sessions.recoveryRequired > 0 ? "warn" : undefined}
      pill={
        sessions.recoveryRequired > 0 ? (
          <StatusPill tone="warn">Recovery</StatusPill>
        ) : sessions.live > 0 ? (
          <StatusPill tone="good">Active</StatusPill>
        ) : (
          <StatusPill>Idle</StatusPill>
        )
      }
    >
      <StatList>
        <Stat
          label="Live"
          value={sessions.live}
          quiet={sessions.live === 0}
          onOpen={opener({ section: "sessions" })}
          openLabel="Show sessions."
        />
        <Stat
          label="Awaiting payment"
          value={sessions.awaitingPayment}
          quiet={sessions.awaitingPayment === 0}
          onOpen={opener({ section: "sessions", sessionState: "AWAITING_PAYMENT" })}
          openLabel="Show sessions awaiting payment."
        />
        <Stat
          label="Printing"
          value={sessions.printing}
          quiet={sessions.printing === 0}
          onOpen={opener({ section: "sessions", sessionState: "PRINTING" })}
          openLabel="Show sessions that are printing."
        />
        <Stat
          label="Recovery required"
          value={sessions.recoveryRequired}
          problem={sessions.recoveryRequired > 0}
          quiet={sessions.recoveryRequired === 0}
          onOpen={opener({ section: "sessions", sessionState: "RECOVERY_REQUIRED" })}
          openLabel="Show sessions needing recovery."
        />
      </StatList>
    </Module>
  );
}

/**
 * Printing, which is mostly healthy and should look it.
 *
 * When nothing is wrong this module is one line. The six counts underneath
 * only appear when one of them is non-zero, because six zeros is not more
 * information than "nothing" — it is the same information spread over enough
 * rows to train the eye to skip them.
 */
function Printing({ overview, opener }: ModuleProps) {
  const { printing } = overview;
  const needsSomebody =
    printing.recoveryUnresolved +
    printing.overdue +
    printing.failedRecently +
    printing.unconfirmedRecently;

  return (
    <Module
      title="Printing"
      summary={
        needsSomebody > 0
          ? `${printing.recoveryUnresolved} waiting for a person, ${printing.overdue} overdue`
          : undefined
      }
      summaryTone={printing.recoveryUnresolved > 0 ? "critical" : "warn"}
      pill={
        needsSomebody > 0 ? (
          <StatusPill tone={printing.recoveryUnresolved > 0 ? "critical" : "warn"}>
            Needs work
          </StatusPill>
        ) : (
          <StatusPill tone="good">Healthy</StatusPill>
        )
      }
    >
      {needsSomebody === 0 ? (
        <>
          <HealthyNote>No print jobs need attention.</HealthyNote>
          <StatList>
            <Stat
              label="Open"
              value={printing.open}
              quiet={printing.open === 0}
              onOpen={opener({ section: "printing" })}
              openLabel="Show print jobs."
            />
          </StatList>
        </>
      ) : (
        <StatList>
          <Stat
            label="Open"
            value={printing.open}
            quiet={printing.open === 0}
            onOpen={opener({ section: "printing" })}
            openLabel="Show print jobs."
          />
          {/* The number a person works through, next to the number that
              reached this state. Watching the first go down is what makes
              recording an observation feel like doing the job rather than
              filing a form. */}
          <Stat
            label="Waiting for a person"
            value={printing.recoveryUnresolved}
            problem={printing.recoveryUnresolved > 0}
            critical={printing.recoveryUnresolved > 0}
            quiet={printing.recoveryUnresolved === 0}
            onOpen={opener({ section: "printing", printStatus: "RECOVERY_REQUIRED" })}
            openLabel="Show the prints waiting for a person."
          />
          <Stat
            label="In recovery"
            value={printing.recoveryRequired}
            quiet={printing.recoveryRequired === 0}
            onOpen={opener({ section: "printing", printStatus: "RECOVERY_REQUIRED" })}
            openLabel="Show prints in recovery."
          />
          <Stat
            label="Overdue"
            value={printing.overdue}
            problem={printing.overdue > 0}
            quiet={printing.overdue === 0}
            onOpen={opener({ section: "printing" })}
            openLabel="Show print jobs."
          />
          <Stat
            label="Failed (24h)"
            value={printing.failedRecently}
            problem={printing.failedRecently > 0}
            quiet={printing.failedRecently === 0}
            onOpen={opener({ section: "printing", printStatus: "FAILED" })}
            openLabel="Show failed print jobs."
          />
          <Stat
            label="Unconfirmed (24h)"
            value={printing.unconfirmedRecently}
            problem={printing.unconfirmedRecently > 0}
            quiet={printing.unconfirmedRecently === 0}
            onOpen={opener({ section: "printing" })}
            openLabel="Show print jobs."
          />
        </StatList>
      )}
    </Module>
  );
}

/**
 * Documents and retention in one module rather than six tiles.
 *
 * The actionable states lead — an upload that failed, a deletion that is late
 * or has given up — and the two that are merely in flight sit underneath them,
 * quiet. There is no link on a document count and there should not be: the
 * panel may see that a file was processed, never what was in it.
 */
function Documents({ overview, opener }: ModuleProps) {
  const { documents, retention } = overview;
  const actionable = documents.failed + retention.overdue + retention.deadLettered;
  const retentionProblems = opener({ section: "retention", retentionProblemsOnly: true });

  return (
    <Module
      title="Documents and retention"
      summary={
        actionable === 0
          ? "Nothing has failed, and every deletion is on schedule."
          : `${retention.overdue + retention.deadLettered} deletions need attention`
      }
      summaryTone={retention.deadLettered > 0 ? "critical" : actionable > 0 ? "warn" : undefined}
      pill={
        retention.deadLettered > 0 ? (
          <StatusPill tone="critical">Gave up</StatusPill>
        ) : actionable > 0 ? (
          <StatusPill tone="warn">Late</StatusPill>
        ) : (
          <StatusPill tone="good">On schedule</StatusPill>
        )
      }
    >
      <StatList>
        <Stat
          label="Awaiting scan"
          value={documents.awaitingScan}
          problem={documents.awaitingScan > 0}
          quiet={documents.awaitingScan === 0}
        />
        <Stat
          label="Failed"
          value={documents.failed}
          problem={documents.failed > 0}
          quiet={documents.failed === 0}
          onOpen={opener({ section: "errors" })}
          openLabel="Show recent failure groups."
        />
        <Stat
          label="Deletion overdue"
          value={retention.overdue}
          problem={retention.overdue > 0}
          quiet={retention.overdue === 0}
          onOpen={retentionProblems}
          openLabel="Show the retention runs that failed."
        />
        <Stat
          label="Deletion gave up"
          value={retention.deadLettered}
          problem={retention.deadLettered > 0}
          critical={retention.deadLettered > 0}
          quiet={retention.deadLettered === 0}
          onOpen={retentionProblems}
          openLabel="Show the retention runs that failed."
        />
        <Stat label="Processing" value={documents.processing} quiet />
        <Stat
          label="Deletion pending"
          value={retention.pending}
          quiet
          onOpen={opener({ section: "retention", retentionProblemsOnly: false })}
          openLabel="Show every retention run."
        />
      </StatList>
    </Module>
  );
}

/**
 * Money, kept to what this panel can actually tell you.
 *
 * An unsettled refund is the only actionable state here, so it leads and the
 * ledger counts follow it. Nothing on this page settles anything — there is no
 * provider credential anywhere in the control plane — so this is a statement of
 * what is owed, not a place to pay it.
 */
function MoneyModule({ overview, opener }: ModuleProps) {
  const { money } = overview;
  const ledger = opener({ section: "money" });

  return (
    <Module
      title="Money"
      summary={
        money.unsettledRefunds > 0
          ? `${money.unsettledRefunds} ${money.unsettledRefunds === 1 ? "refund" : "refunds"} owed and not yet returned`
          : "Nothing is owed and no payment is stuck."
      }
      summaryTone={money.unsettledRefunds > 0 ? "warn" : undefined}
      pill={
        money.unsettledRefunds > 0 ? (
          <StatusPill tone="warn">Owed</StatusPill>
        ) : (
          <StatusPill tone="good">Settled</StatusPill>
        )
      }
    >
      <StatList>
        <Stat
          label="Unsettled refunds"
          value={money.unsettledRefunds}
          problem={money.unsettledRefunds > 0}
          quiet={money.unsettledRefunds === 0}
          onOpen={opener({ section: "money", moneyFocus: "refunds" })}
          openLabel="Show the money owed back."
        />
        <Stat
          label="Open payments"
          value={money.openPayments}
          quiet={money.openPayments === 0}
          onOpen={ledger}
          openLabel="Show the payment ledger."
        />
        <Stat
          label="Expired intents"
          value={money.expiredPayments}
          problem={money.expiredPayments > 0}
          quiet={money.expiredPayments === 0}
          onOpen={ledger}
          openLabel="Show the payment ledger."
        />
      </StatList>
    </Module>
  );
}
