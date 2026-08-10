import { useCallback, useState } from "react";

import { useSession } from "../features/auth/SessionProvider.js";
import { observabilityApi } from "../features/observability/api.js";
import {
  Empty,
  Identifier,
  Panel,
  StateBadge,
  Table,
  When
} from "../features/observability/components.js";
import { useAdminData } from "../features/observability/useAdminData.js";

/**
 * Print jobs, and what the device actually said.
 *
 * `UNCONFIRMED` is shown as itself and never rounded up to a success. The
 * system refuses to guess whether paper came out, and a dashboard that quietly
 * decided otherwise would undo the one property that makes a paid print
 * trustworthy.
 */
export function PrintingPanel() {
  const session = useSession();
  const [status, setStatus] = useState("");
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback(
    () => observabilityApi.printJobs({ status: status || undefined }),
    [status]
  );
  const list = useAdminData(load, { refreshMilliseconds: 15_000 });

  return (
    <>
      <Panel
        title="Printing"
        state={list}
        hint={list.data?.scoped ? "Showing jobs on the kiosks assigned to you." : undefined}
        actions={
          <>
            <label className="inline-field">
              Status
              <select value={status} onChange={(event) => setStatus(event.target.value)}>
                <option value="">Any</option>
                {[
                  "QUEUED",
                  "DISPATCHED",
                  "PRINTING",
                  "COMPLETED",
                  "FAILED",
                  "RECOVERY_REQUIRED"
                ].map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" onClick={list.reload} disabled={list.loading}>
              Refresh
            </button>
          </>
        }
      >
        {list.data && list.data.items.length === 0 ? <Empty>No print jobs match.</Empty> : null}

        {list.data && list.data.items.length > 0 ? (
          <Table columns={["Job", "Kiosk", "Status", "Result", "Sheets", "Attempts", "Created"]}>
            {list.data.items.map((job) => (
              <tr
                key={job.id}
                className={selected === job.id ? "is-selected" : undefined}
                onClick={() => setSelected(selected === job.id ? null : job.id)}
              >
                <td>
                  <button type="button" className="button-link">
                    <Identifier value={job.id} />
                  </button>
                </td>
                <td>{job.kioskId}</td>
                <td>
                  <StateBadge value={job.status} />
                  {job.overdue ? <span className="badge badge--bad">overdue</span> : null}
                </td>
                <td>
                  <StateBadge value={job.resultConfidence} />
                  {job.failureCode ? (
                    <span className="key-list__meta">{job.failureCode}</span>
                  ) : null}
                </td>
                <td>
                  {job.sheetsProduced ?? "—"} / {job.physicalSheets}
                </td>
                <td>{job.dispatchAttempts}</td>
                <td>
                  <When value={job.createdAt} />
                </td>
              </tr>
            ))}
          </Table>
        ) : null}
      </Panel>

      {selected ? (
        <PrintJobDetail
          printJobId={selected}
          canSeeDiagnostics={session.can("print.diagnostics.read")}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </>
  );
}

function PrintJobDetail({
  printJobId,
  canSeeDiagnostics,
  onClose
}: {
  printJobId: string;
  canSeeDiagnostics: boolean;
  onClose: () => void;
}) {
  const load = useCallback(() => observabilityApi.printJob(printJobId), [printJobId]);
  const detail = useAdminData(load);

  return (
    <Panel
      title="Print job detail"
      state={detail}
      actions={
        <button type="button" onClick={onClose}>
          Close
        </button>
      }
    >
      {detail.data ? (
        <>
          <dl className="detail-grid">
            <div>
              <dt>Session</dt>
              <dd>
                <code>{detail.data.job.sessionId}</code>
              </dd>
            </div>
            <div>
              <dt>Dispatched</dt>
              <dd>
                <When value={detail.data.job.dispatchedAt} />
              </dd>
            </div>
            <div>
              <dt>Started</dt>
              <dd>
                <When value={detail.data.job.startedAt} />
              </dd>
            </div>
            <div>
              <dt>Settled</dt>
              <dd>
                <When value={detail.data.job.completedAt ?? detail.data.job.failedAt} />
              </dd>
            </div>
            <div>
              <dt>Manifest redacted</dt>
              <dd>
                <When value={detail.data.job.manifestRedactedAt} />
              </dd>
            </div>
          </dl>

          {detail.data.command ? (
            <>
              <h3>Kiosk command</h3>
              <p className="panel__status">
                <StateBadge value={detail.data.command.status} /> after{" "}
                {detail.data.command.attempts} attempt
                {detail.data.command.attempts === 1 ? "" : "s"}
                {detail.data.command.resultCode ? (
                  <>
                    {" — "}
                    <code>{detail.data.command.resultCode}</code>
                  </>
                ) : null}
              </p>
            </>
          ) : null}

          <h3>Device ledger</h3>
          {!canSeeDiagnostics ? (
            <Empty>
              Deep diagnostics are a Technical Admin capability. The job&apos;s own outcome above is
              what your role sees.
            </Empty>
          ) : detail.data.ledger && detail.data.ledger.length > 0 ? (
            <Table columns={["#", "Event", "Status", "Confidence", "Code", "When"]}>
              {detail.data.ledger.map((event) => (
                <tr key={event.sequence}>
                  <td>{event.sequence}</td>
                  <td>
                    <code>{event.type}</code>
                  </td>
                  <td>
                    <StateBadge value={event.status} />
                  </td>
                  <td>
                    <StateBadge value={event.confidence} />
                  </td>
                  <td>{event.failureCode ?? event.warningCode ?? "—"}</td>
                  <td>
                    <When value={event.createdAt} />
                  </td>
                </tr>
              ))}
            </Table>
          ) : (
            <Empty>No ledger entries.</Empty>
          )}
        </>
      ) : null}
    </Panel>
  );
}
