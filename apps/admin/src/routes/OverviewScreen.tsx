import { useCallback } from "react";

import { useSession } from "../features/auth/SessionProvider.js";
import {
  SECTION_CAPABILITY,
  useAdminNavigation,
  type AdminDestination
} from "../features/navigation.js";
import { observabilityApi } from "../features/observability/api.js";
import { CounterGroup, Panel, type CounterItem } from "../features/observability/components.js";
import { useAdminData } from "../features/observability/useAdminData.js";

/**
 * What needs a person, and what the system is doing.
 *
 * The worklist comes first and everything else is context. Each entry names a
 * state the system deliberately refuses to resolve on its own — an undeleted
 * document, an unconfirmed print, an unsettled refund — because those are the
 * only numbers on this page that are actually somebody's job.
 *
 * Nothing here is a dead end. A person who notices a number is one keystroke
 * from the rows behind it, already filtered, because the gap between spotting a
 * problem and finding it is where an operations dashboard usually fails.
 */

interface AttentionEntry {
  label: string;
  /** The rows behind this count, and the filter that isolates them. */
  destination: AdminDestination;
  /** What the operator will be looking at when they arrive. */
  openLabel: string;
}

const ATTENTION: Readonly<Record<string, AttentionEntry>> = {
  RETENTION_DEAD_LETTERED: {
    label: "Document deletions that gave up",
    destination: { section: "retention", retentionProblemsOnly: true },
    openLabel: "Show the retention runs that failed."
  },
  RETENTION_OVERDUE: {
    label: "Sessions past their deletion deadline",
    destination: { section: "retention", retentionProblemsOnly: true },
    openLabel: "Show the retention runs that failed."
  },
  PRINT_RECOVERY_REQUIRED: {
    label: "Paid prints awaiting a human decision",
    destination: { section: "printing", printStatus: "RECOVERY_REQUIRED" },
    openLabel: "Show the prints waiting for a person."
  },
  REFUND_UNSETTLED: {
    label: "Refunds owed and not yet returned",
    destination: { section: "money", moneyFocus: "refunds" },
    openLabel: "Show the money owed back."
  },
  PRINT_OVERDUE: {
    label: "Print jobs past their deadline",
    destination: { section: "printing" },
    openLabel: "Show print jobs."
  },
  DOCUMENT_PROCESSING_FAILED: {
    label: "Uploads that failed processing",
    destination: { section: "errors" },
    openLabel: "Show recent failure groups."
  },
  KIOSK_OFFLINE: {
    label: "Kiosks not heard from",
    destination: { section: "kiosks" },
    openLabel: "Show kiosk status."
  },
  PAYMENT_EXPIRED_UNRESOLVED: {
    label: "Expired payment intents",
    destination: { section: "money" },
    openLabel: "Show the payment ledger."
  }
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

  const counter = useCallback(
    (
      label: string,
      value: number,
      options: { alarming?: boolean; to?: AdminDestination; openLabel?: string } = {}
    ): CounterItem => ({
      label,
      value,
      ...(options.alarming === undefined ? {} : { alarming: options.alarming }),
      ...(options.openLabel === undefined ? {} : { openLabel: options.openLabel }),
      onOpen: options.to ? opener(options.to) : undefined
    }),
    [opener]
  );

  return (
    <>
      <Panel
        title="Needs attention"
        state={state}
        actions={
          <button type="button" onClick={state.reload} disabled={state.loading}>
            Refresh
          </button>
        }
        hint={
          overview?.scoped
            ? "Counts cover the kiosks assigned to you."
            : "Counts cover every kiosk."
        }
      >
        {overview ? (
          overview.attention.length === 0 ? (
            <p className="attention__calm">
              Nothing is waiting on a person. Documents are being deleted on time, no paid print is
              unresolved, and no refund is outstanding.
            </p>
          ) : (
            <ul className="attention">
              {overview.attention.map((item) => {
                const entry = ATTENTION[item.code];
                const open = entry ? opener(entry.destination) : undefined;
                const label = entry?.label ?? item.code;
                const className = `attention__item attention__item--${item.severity.toLowerCase()}`;

                if (!open) {
                  return (
                    <li key={item.code} className={className}>
                      <span className="attention__count">{item.count}</span>
                      <span className="attention__label">{label}</span>
                    </li>
                  );
                }

                return (
                  <li key={item.code} className={`${className} is-navigable`}>
                    <button
                      type="button"
                      className="attention__open"
                      onClick={open}
                      aria-label={`${label}: ${item.count}. ${entry?.openLabel ?? "View details."}`}
                    >
                      <span className="attention__count">{item.count}</span>
                      <span className="attention__label">{label}</span>
                      <span className="attention__go" aria-hidden="true">
                        View details →
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )
        ) : null}
      </Panel>

      {overview ? (
        <section className="panel" aria-labelledby="overview-numbers">
          <div className="panel__heading">
            <h2 id="overview-numbers">The numbers behind it</h2>
          </div>
          <p className="panel__hint">
            Groups with nothing in them collapse to a single line, so what is left on this page is
            what is actually happening.
          </p>

          <CounterGroup
            title="Kiosks"
            quiet="No kiosks are registered yet."
            items={[
              counter("Online", overview.kiosks.online, {
                to: { section: "kiosks" },
                openLabel: "Show kiosk status."
              }),
              counter("Degraded", overview.kiosks.degraded, {
                alarming: true,
                to: { section: "kiosks" },
                openLabel: "Show kiosk status."
              }),
              counter("Offline", overview.kiosks.offline, {
                alarming: true,
                to: { section: "kiosks" },
                openLabel: "Show kiosk status."
              }),
              counter("Not active", overview.kiosks.notActive, {
                to: { section: "kiosks" },
                openLabel: "Show kiosk status."
              }),
              counter("Total", overview.kiosks.total, {
                to: { section: "kiosks" },
                openLabel: "Show every kiosk."
              })
            ]}
          />

          <CounterGroup
            title="Sessions"
            quiet="Nothing live right now."
            items={[
              counter("Live", overview.sessions.live, {
                to: { section: "sessions" },
                openLabel: "Show sessions."
              }),
              counter("Awaiting payment", overview.sessions.awaitingPayment, {
                to: { section: "sessions", sessionState: "AWAITING_PAYMENT" },
                openLabel: "Show sessions awaiting payment."
              }),
              counter("Printing", overview.sessions.printing, {
                to: { section: "sessions", sessionState: "PRINTING" },
                openLabel: "Show sessions that are printing."
              }),
              counter("Recovery required", overview.sessions.recoveryRequired, {
                alarming: true,
                to: { section: "sessions", sessionState: "RECOVERY_REQUIRED" },
                openLabel: "Show sessions needing recovery."
              })
            ]}
          />

          <CounterGroup
            title="Printing"
            quiet="No print job needs anything."
            items={[
              counter("Open", overview.printing.open, {
                to: { section: "printing" },
                openLabel: "Show print jobs."
              }),
              // The number a person works through, next to the number that
              // reached this state. Watching the first go down is what makes
              // recording an observation feel like doing the job rather than
              // filing a form.
              counter("Waiting for a person", overview.printing.recoveryUnresolved, {
                alarming: true,
                to: { section: "printing", printStatus: "RECOVERY_REQUIRED" },
                openLabel: "Show the prints waiting for a person."
              }),
              counter("In recovery", overview.printing.recoveryRequired, {
                to: { section: "printing", printStatus: "RECOVERY_REQUIRED" },
                openLabel: "Show prints in recovery."
              }),
              counter("Overdue", overview.printing.overdue, {
                alarming: true,
                to: { section: "printing" },
                openLabel: "Show print jobs."
              }),
              counter("Failed (24h)", overview.printing.failedRecently, {
                alarming: true,
                to: { section: "printing", printStatus: "FAILED" },
                openLabel: "Show failed print jobs."
              }),
              counter("Unconfirmed (24h)", overview.printing.unconfirmedRecently, {
                alarming: true,
                to: { section: "printing" },
                openLabel: "Show print jobs."
              })
            ]}
          />

          <CounterGroup
            title="Documents and retention"
            quiet="Nothing is processing, and every deletion is on schedule."
            items={[
              // No document list exists to link to, and none should: the panel
              // may see that a file was processed, never what was in it.
              counter("Processing", overview.documents.processing),
              counter("Awaiting scan", overview.documents.awaitingScan),
              counter("Failed", overview.documents.failed, {
                alarming: true,
                to: { section: "errors" },
                openLabel: "Show recent failure groups."
              }),
              counter("Deletion pending", overview.retention.pending, {
                to: { section: "retention", retentionProblemsOnly: false },
                openLabel: "Show every retention run."
              }),
              counter("Deletion overdue", overview.retention.overdue, {
                alarming: true,
                to: { section: "retention", retentionProblemsOnly: true },
                openLabel: "Show the retention runs that failed."
              }),
              counter("Deletion gave up", overview.retention.deadLettered, {
                alarming: true,
                to: { section: "retention", retentionProblemsOnly: true },
                openLabel: "Show the retention runs that failed."
              })
            ]}
          />

          <CounterGroup
            title="Money"
            quiet="Nothing is owed and no payment is stuck."
            items={[
              counter("Open payments", overview.money.openPayments, {
                to: { section: "money" },
                openLabel: "Show the payment ledger."
              }),
              counter("Expired intents", overview.money.expiredPayments, {
                to: { section: "money" },
                openLabel: "Show the payment ledger."
              }),
              counter("Unsettled refunds", overview.money.unsettledRefunds, {
                alarming: true,
                to: { section: "money", moneyFocus: "refunds" },
                openLabel: "Show the money owed back."
              })
            ]}
          />

          <p className="panel__hint">
            Snapshot taken {new Date(overview.generatedAt).toLocaleTimeString()}
            {overview.snapshotAgeMilliseconds > 0
              ? `, ${Math.round(overview.snapshotAgeMilliseconds / 1000)}s ago`
              : ""}
            . Counts are cached for a few seconds so that a wall of open dashboards cannot compete
            with printing for the database.
          </p>

          {session.identity && session.identity.kioskScopes.length === 0 && overview.scoped ? (
            <p className="panel__hint">
              You have no kiosk assigned, so there is nothing for you to see yet. Ask an
              administrator to assign one.
            </p>
          ) : null}
        </section>
      ) : null}
    </>
  );
}
