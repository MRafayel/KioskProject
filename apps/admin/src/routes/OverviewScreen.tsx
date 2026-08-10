import { useCallback } from "react";

import { useSession } from "../features/auth/SessionProvider.js";
import { observabilityApi } from "../features/observability/api.js";
import { Counters, Panel } from "../features/observability/components.js";
import { useAdminData } from "../features/observability/useAdminData.js";

/**
 * What needs a person, and what the system is doing.
 *
 * The worklist comes first and everything else is context. Each entry names a
 * state the system deliberately refuses to resolve on its own — an undeleted
 * document, an unconfirmed print, an unsettled refund — because those are the
 * only numbers on this page that are actually somebody's job.
 */

const ATTENTION_LABELS: Record<string, string> = {
  RETENTION_DEAD_LETTERED: "Document deletions that gave up",
  RETENTION_OVERDUE: "Sessions past their deletion deadline",
  PRINT_RECOVERY_REQUIRED: "Paid prints awaiting a human decision",
  REFUND_UNSETTLED: "Refunds owed and not yet returned",
  PRINT_OVERDUE: "Print jobs past their deadline",
  DOCUMENT_PROCESSING_FAILED: "Uploads that failed processing",
  KIOSK_OFFLINE: "Kiosks not heard from",
  PAYMENT_EXPIRED_UNRESOLVED: "Expired payment intents"
};

export function OverviewScreen() {
  const load = useCallback(() => observabilityApi.overview(), []);
  const state = useAdminData(load, { refreshMilliseconds: 15_000 });
  const overview = state.data;
  const session = useSession();

  return (
    <Panel
      title="Overview"
      state={state}
      actions={
        <button type="button" onClick={state.reload} disabled={state.loading}>
          Refresh
        </button>
      }
      hint={
        overview?.scoped ? "Counts cover the kiosks assigned to you." : "Counts cover every kiosk."
      }
    >
      {overview ? (
        <>
          <h3>Needs attention</h3>
          {overview.attention.length === 0 ? (
            <p className="panel__status">
              Nothing is waiting on a person. Documents are being deleted on time, no paid print is
              unresolved, and no refund is outstanding.
            </p>
          ) : (
            <ul className="attention">
              {overview.attention.map((item) => (
                <li
                  key={item.code}
                  className={`attention__item attention__item--${item.severity.toLowerCase()}`}
                >
                  <span className="attention__count">{item.count}</span>
                  <span>{ATTENTION_LABELS[item.code] ?? item.code}</span>
                </li>
              ))}
            </ul>
          )}

          <h3>Kiosks</h3>
          <Counters
            items={[
              { label: "Online", value: overview.kiosks.online },
              { label: "Degraded", value: overview.kiosks.degraded, alarming: true },
              { label: "Offline", value: overview.kiosks.offline, alarming: true },
              { label: "Not active", value: overview.kiosks.notActive },
              { label: "Total", value: overview.kiosks.total }
            ]}
          />

          <h3>Sessions</h3>
          <Counters
            items={[
              { label: "Live", value: overview.sessions.live },
              { label: "Awaiting payment", value: overview.sessions.awaitingPayment },
              { label: "Printing", value: overview.sessions.printing },
              {
                label: "Recovery required",
                value: overview.sessions.recoveryRequired,
                alarming: true
              }
            ]}
          />

          <h3>Printing</h3>
          <Counters
            items={[
              { label: "Open", value: overview.printing.open },
              // The number a person works through, next to the number that
              // reached this state. Watching the first go down is what makes
              // recording an observation feel like doing the job rather than
              // filing a form.
              {
                label: "Waiting for a person",
                value: overview.printing.recoveryUnresolved,
                alarming: true
              },
              { label: "In recovery", value: overview.printing.recoveryRequired },
              { label: "Overdue", value: overview.printing.overdue, alarming: true },
              { label: "Failed (24h)", value: overview.printing.failedRecently, alarming: true },
              {
                label: "Unconfirmed (24h)",
                value: overview.printing.unconfirmedRecently,
                alarming: true
              }
            ]}
          />

          <h3>Documents and retention</h3>
          <Counters
            items={[
              { label: "Processing", value: overview.documents.processing },
              { label: "Awaiting scan", value: overview.documents.awaitingScan },
              { label: "Failed", value: overview.documents.failed, alarming: true },
              { label: "Deletion pending", value: overview.retention.pending },
              { label: "Deletion overdue", value: overview.retention.overdue, alarming: true },
              { label: "Deletion gave up", value: overview.retention.deadLettered, alarming: true }
            ]}
          />

          <h3>Money</h3>
          <Counters
            items={[
              { label: "Open payments", value: overview.money.openPayments },
              { label: "Expired intents", value: overview.money.expiredPayments },
              {
                label: "Unsettled refunds",
                value: overview.money.unsettledRefunds,
                alarming: true
              }
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
        </>
      ) : null}
    </Panel>
  );
}
