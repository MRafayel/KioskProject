import { useCallback, useState } from "react";

import { adminSessionStateSchema } from "@printing-kiosk/admin-access";

import { useSession } from "../features/auth/SessionProvider.js";
import { observabilityApi } from "../features/observability/api.js";
import {
  Duration,
  Empty,
  Identifier,
  Money,
  Panel,
  StateBadge,
  Table,
  When
} from "../features/observability/components.js";
import { useAdminData } from "../features/observability/useAdminData.js";

const SESSION_STATES = adminSessionStateSchema.options;

/**
 * Sessions, and one session in full.
 *
 * The detail view is where the document-privacy rule is most visible: it shows
 * how many files there were, how big, how many pages, and what happened to
 * them — and offers no way to see one, because there is no such endpoint and
 * no grant behind it.
 */
export function SessionsPanel({ initialState }: { initialState?: string | undefined } = {}) {
  const session = useSession();
  // Opening state only; see PrintingPanel for why this is not kept in sync.
  const [state, setState] = useState<string>(initialState ?? "");
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [selected, setSelected] = useState<string | null>(null);

  const cursor = cursors[cursors.length - 1];
  const load = useCallback(
    () => observabilityApi.sessions({ state: state || undefined, cursor }),
    [state, cursor]
  );
  const list = useAdminData(load, { refreshMilliseconds: 20_000 });

  return (
    <>
      <Panel
        title="Recent sessions"
        state={list}
        hint={list.data?.scoped ? "Showing sessions on the kiosks assigned to you." : undefined}
        actions={
          <>
            <label className="inline-field">
              State
              <select
                value={state}
                onChange={(event) => {
                  setState(event.target.value);
                  setCursors([undefined]);
                }}
              >
                <option value="">Any</option>
                {SESSION_STATES.map((value) => (
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
        {list.data && list.data.items.length === 0 ? <Empty>No sessions match.</Empty> : null}

        {list.data && list.data.items.length > 0 ? (
          <>
            <Table
              columns={[
                "Session",
                "Kiosk",
                "State",
                "Files",
                "Payment",
                "Print",
                "Deletion",
                "Started"
              ]}
            >
              {list.data.items.map((item) => (
                <tr
                  key={item.id}
                  className={selected === item.id ? "is-selected" : undefined}
                  onClick={() => setSelected(selected === item.id ? null : item.id)}
                >
                  <td>
                    <button type="button" className="button-link">
                      <Identifier value={item.id} />
                    </button>
                  </td>
                  <td>{item.kioskId}</td>
                  <td>
                    <StateBadge value={item.state} />
                  </td>
                  <td>{item.documentCount}</td>
                  <td>
                    <StateBadge value={item.paymentStatus} />
                  </td>
                  <td>
                    <StateBadge value={item.printJobStatus} />
                  </td>
                  <td>
                    <StateBadge value={item.cleanupStatus} />
                  </td>
                  <td>
                    <When value={item.createdAt} />
                  </td>
                </tr>
              ))}
            </Table>

            <div className="panel__actions">
              <button
                type="button"
                disabled={cursors.length === 1}
                onClick={() => setCursors((current) => current.slice(0, -1))}
              >
                Previous
              </button>
              <button
                type="button"
                disabled={!list.data.nextCursor}
                onClick={() =>
                  setCursors((current) => [...current, list.data?.nextCursor ?? undefined])
                }
              >
                Next
              </button>
            </div>
          </>
        ) : null}
      </Panel>

      {selected ? (
        <SessionDetail
          sessionId={selected}
          canSeeTimeline={session.can("session.timeline.read")}
          canSeeDocuments={session.can("document.metadata.read")}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </>
  );
}

function SessionDetail({
  sessionId,
  canSeeTimeline,
  canSeeDocuments,
  onClose
}: {
  sessionId: string;
  canSeeTimeline: boolean;
  canSeeDocuments: boolean;
  onClose: () => void;
}) {
  const load = useCallback(() => observabilityApi.session(sessionId), [sessionId]);
  const detail = useAdminData(load);

  const loadTimeline = useCallback(() => observabilityApi.timeline(sessionId), [sessionId]);
  const timeline = useAdminData(loadTimeline, { enabled: canSeeTimeline });

  const loadDocuments = useCallback(() => observabilityApi.documents(sessionId), [sessionId]);
  const documents = useAdminData(loadDocuments, { enabled: canSeeDocuments });

  return (
    <Panel
      title="Session detail"
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
                <code>{detail.data.session.id}</code>
              </dd>
            </div>
            <div>
              <dt>Kiosk</dt>
              <dd>{detail.data.session.kioskId}</dd>
            </div>
            <div>
              <dt>State</dt>
              <dd>
                <StateBadge value={detail.data.session.state} />
              </dd>
            </div>
            <div>
              <dt>Ended because</dt>
              <dd>
                <StateBadge value={detail.data.session.terminalReason} />
              </dd>
            </div>
            <div>
              <dt>Documents deleted</dt>
              <dd>
                <When value={detail.data.session.filesDeletedAt} />
              </dd>
            </div>
            <div>
              <dt>Deletion due</dt>
              <dd>
                <When value={detail.data.session.cleanupDueAt} />
              </dd>
            </div>
          </dl>

          {detail.data.settings ? (
            <>
              <h3>What was configured</h3>
              <p className="panel__status">
                {detail.data.settings.paperSize}, {detail.data.settings.colorMode.toLowerCase()} —{" "}
                {detail.data.settings.selectedPages} pages selected across{" "}
                {detail.data.documents.total} documents, {detail.data.settings.physicalSheets}{" "}
                sheets.
                {detail.data.settings.selectionsRedactedAt
                  ? " Per-document digests have been destroyed by retention."
                  : ""}
              </p>
            </>
          ) : null}

          {detail.data.money ? (
            <>
              <h3>Money</h3>
              <p className="panel__status">
                <Money
                  minor={detail.data.money.totalMinor}
                  currency={detail.data.money.currency}
                  exponent={detail.data.money.currencyExponent}
                />{" "}
                — quote <StateBadge value={detail.data.money.quoteStatus} />, payment{" "}
                <StateBadge value={detail.data.money.paymentStatus} />
                {detail.data.money.refundStatus ? (
                  <>
                    , refund <StateBadge value={detail.data.money.refundStatus} />
                  </>
                ) : null}
                .
              </p>
            </>
          ) : null}

          <h3>Documents</h3>
          <p className="panel__hint">
            Metadata only. The control plane holds no storage credential and no route that returns a
            document, a page image or a filename.
          </p>
          {canSeeDocuments && documents.data ? (
            documents.data.items.length === 0 ? (
              <Empty>Nothing was uploaded.</Empty>
            ) : (
              <Table columns={["#", "Type", "Size", "Pages", "Scan", "State", "Deleted"]}>
                {documents.data.items.map((file) => (
                  <tr key={file.id}>
                    <td>{file.ordinal + 1}</td>
                    <td>{file.detectedMime ?? file.declaredMime ?? "—"}</td>
                    <td>
                      {file.sizeBytes === null ? "—" : `${Math.ceil(file.sizeBytes / 1024)} KB`}
                    </td>
                    <td>{file.pageCount ?? "—"}</td>
                    <td>
                      <StateBadge value={file.malwareScanStatus} />
                    </td>
                    <td>
                      <StateBadge
                        value={file.rejectionCode ?? file.processingErrorCode ?? file.status}
                      />
                    </td>
                    <td>
                      <When value={file.deletedAt} />
                    </td>
                  </tr>
                ))}
              </Table>
            )
          ) : (
            <Empty>
              {canSeeDocuments ? "Loading…" : "Your role cannot see document metadata."}
            </Empty>
          )}

          <h3>Timeline</h3>
          {canSeeTimeline && timeline.data ? (
            <ol className="timeline">
              {timeline.data.items.map((entry) => (
                <li key={entry.sequence}>
                  <code>{entry.type}</code>
                  <span className="key-list__meta">
                    <When value={entry.occurredAt} />
                    {entry.sincePreviousMilliseconds !== null ? (
                      <>
                        {" · +"}
                        <Duration milliseconds={entry.sincePreviousMilliseconds} />
                      </>
                    ) : null}
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <Empty>{canSeeTimeline ? "Loading…" : "Your role cannot see the timeline."}</Empty>
          )}
        </>
      ) : null}
    </Panel>
  );
}
