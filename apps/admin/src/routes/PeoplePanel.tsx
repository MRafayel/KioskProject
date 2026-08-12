import { useCallback, useState } from "react";

import type {
  AdminPeopleResponse,
  AdminPerson,
  AdminStatusAction
} from "@printing-kiosk/admin-access";

import { useSession } from "../features/auth/SessionProvider.js";
import { observabilityApi } from "../features/observability/api.js";
import { Empty, Identifier, When } from "../features/observability/components.js";
import { useAdminAction } from "../features/observability/useAdminAction.js";
import { useAdminData } from "../features/observability/useAdminData.js";

/**
 * The Operators, and what can be done about them.
 *
 * Two capabilities feed this screen and they draw different things. An Admin
 * holds both and sees everything below. A Technical Admin holds only
 * `authenticator.manage.operator`, so it sees the same roster with the same key
 * controls and no status or kiosk controls at all — it can get somebody onto a
 * key, and it cannot decide whether they may work or where.
 *
 * The screen is written to make three things hard to do by accident. Suspending
 * somebody says how many sessions it will end before it ends them. Retiring a
 * key is refused, visibly, when it would leave an active account unable to sign
 * in. And an enrolment code is shown exactly once, on a panel that says so, next
 * to the instruction that it goes to the person by voice rather than by message.
 *
 * Only Operators appear, because the capabilities behind it reach nothing else.
 * A screen listing Admins with every control disabled would be a screen telling
 * anybody who opened it which accounts are the interesting ones.
 */

const STATUS_LABELS: Readonly<Record<string, { label: string; hint: string }>> = {
  PROVISIONING: {
    label: "Awaiting keys",
    hint: "Cannot sign in yet. Needs its security keys enrolled."
  },
  ACTIVE: { label: "Active", hint: "Can sign in and work." },
  SUSPENDED: { label: "Suspended", hint: "Cannot sign in. Access can be given back." },
  DISABLED: { label: "Disabled", hint: "Shut down permanently. This cannot be undone." }
};

export function PeoplePanel() {
  const session = useSession();
  const load = useCallback(() => observabilityApi.people(), []);
  const state = useAdminData<AdminPeopleResponse>(load);

  const canManage = session.can("operator.manage");
  const canManageKeys = session.can("authenticator.manage.operator");

  if (state.error) {
    return (
      <section className="panel">
        <p className="resolve__error" role="alert">
          {state.error}
        </p>
      </section>
    );
  }

  const data = state.data;
  if (!data) return null;

  return (
    <section className="panel">
      <header className="panel__header">
        <h2>People</h2>
        <button type="button" onClick={state.reload} disabled={state.loading}>
          Refresh
        </button>
      </header>

      {canManage ? null : (
        <p className="panel__hint">
          Your role can get an Operator onto a security key and retire one. Suspending an account
          and changing which kiosks somebody covers are held by Admins.
        </p>
      )}

      {data.items.length === 0 ? (
        <Empty>
          No Operator accounts exist yet. Accounts are created with{" "}
          <code>pnpm db:admin create</code>; this screen is where they are given a kiosk and a way
          to enrol their first key.
        </Empty>
      ) : (
        <ul className="people">
          {data.items.map((person) => (
            <PersonRow
              key={person.adminUserId}
              person={person}
              kiosks={data.kiosks}
              canManage={canManage}
              canManageKeys={canManageKeys}
              onChanged={state.reload}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function PersonRow({
  person,
  kiosks,
  canManage,
  canManageKeys,
  onChanged
}: {
  person: AdminPerson;
  kiosks: AdminPeopleResponse["kiosks"];
  canManage: boolean;
  canManageKeys: boolean;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState<"status" | "kiosks" | "sessions" | "ticket" | null>(null);
  const status = STATUS_LABELS[person.status] ?? { label: person.status, hint: "" };
  const belowMinimum = person.usableAuthenticators < person.minimumAuthenticators;

  return (
    <li className="people__item">
      <div className="people__identity">
        <p className="people__name">
          <strong>{person.displayName}</strong>
          <span className={`people__status people__status--${person.status.toLowerCase()}`}>
            {status.label}
          </span>
        </p>
        <p className="key-list__meta">{status.hint}</p>
        <p className="resolution__by">
          <Identifier value={person.adminUserId} /> &middot; created{" "}
          <When value={person.createdAt} /> &middot;{" "}
          {person.lastLoginAt ? (
            <>
              last signed in <When value={person.lastLoginAt} />
            </>
          ) : (
            "never signed in"
          )}
        </p>
      </div>

      <div className="people__facts">
        <p>
          {person.usableAuthenticators} of {person.minimumAuthenticators} security key(s)
          {belowMinimum ? " — below the minimum for this role" : ""}
        </p>
        <p className="key-list__meta">
          {person.activeSessions === 0
            ? "No live sessions."
            : `${person.activeSessions} live session(s).`}{" "}
          {person.kioskIds.length === 0
            ? "No kiosks assigned, so this account can act on none."
            : `Covers ${person.kioskIds.join(", ")}.`}
        </p>
        {person.liveEnrollmentTickets > 0 ? (
          <p className="people__ticket-warning" role="note">
            {person.liveEnrollmentTickets} enrolment ticket(s) outstanding
            {person.enrollmentTicketExpiresAt ? (
              <>
                {" "}
                until <When value={person.enrollmentTicketExpiresAt} />
              </>
            ) : null}
            . Anybody holding one can put a key on this account.
          </p>
        ) : null}
      </div>

      <div className="people__controls">
        {canManageKeys && person.status === "PROVISIONING" ? (
          <button type="button" onClick={() => setOpen(open === "ticket" ? null : "ticket")}>
            Issue an enrolment code
          </button>
        ) : null}
        {canManage && person.status !== "DISABLED" ? (
          <button type="button" onClick={() => setOpen(open === "status" ? null : "status")}>
            Change status
          </button>
        ) : null}
        {canManage ? (
          <button
            type="button"
            className="button-quiet"
            onClick={() => setOpen(open === "kiosks" ? null : "kiosks")}
          >
            Kiosks
          </button>
        ) : null}
        {canManage && person.activeSessions > 0 ? (
          <button
            type="button"
            className="button-quiet"
            onClick={() => setOpen(open === "sessions" ? null : "sessions")}
          >
            Sign out everywhere
          </button>
        ) : null}
      </div>

      {open === "ticket" ? (
        <EnrollmentTicketForm person={person} onClose={() => setOpen(null)} onIssued={onChanged} />
      ) : null}
      {open === "status" ? (
        <StatusForm
          person={person}
          onClose={() => setOpen(null)}
          onChanged={() => {
            setOpen(null);
            onChanged();
          }}
        />
      ) : null}
      {open === "kiosks" ? (
        <KioskForm
          person={person}
          kiosks={kiosks}
          onClose={() => setOpen(null)}
          onChanged={onChanged}
        />
      ) : null}
      {open === "sessions" ? (
        <SessionsForm
          person={person}
          onClose={() => setOpen(null)}
          onChanged={() => {
            setOpen(null);
            onChanged();
          }}
        />
      ) : null}

      {canManageKeys && person.authenticators.length > 0 ? (
        <ul className="people__keys">
          {person.authenticators.map((key) => (
            <KeyRow key={key.id} person={person} authenticator={key} onChanged={onChanged} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/**
 * Suspending, resuming or shutting down an account.
 *
 * The consequence is stated before the button rather than after it. Whichever
 * of the three is chosen, the sentence under the selector describes what will
 * actually happen to the sessions that are open right now.
 */
function StatusForm({
  person,
  onClose,
  onChanged
}: {
  person: AdminPerson;
  onClose: () => void;
  onChanged: () => void;
}) {
  const available = availableStatuses(person.status);
  const [status, setStatus] = useState<AdminStatusAction>(available[0] ?? "SUSPENDED");
  const [reason, setReason] = useState("");

  const action = useAdminAction<{ status: AdminStatusAction; reason: string }>(
    useCallback(
      async (input) =>
        observabilityApi.changePersonStatus(person.adminUserId, {
          status: input.status,
          reason: input.reason.trim()
        }),
      [person.adminUserId]
    )
  );

  const trimmed = reason.trim();
  const ready = available.length > 0 && trimmed.length >= 8 && !action.state.running;

  return (
    <form
      className="resolve"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready) return;
        void action.run({ status, reason }).then((done) => {
          if (done) onChanged();
        });
      }}
    >
      <h3>Change {person.displayName}&rsquo;s status</h3>

      {available.length === 0 ? (
        <p className="resolve__optional">
          There is nothing to change from here. A disabled account is not reopened; somebody coming
          back gets a new account and enrols new keys.
        </p>
      ) : (
        <>
          <label className="resolve__field">
            New status
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value as AdminStatusAction)}
            >
              {available.map((option) => (
                <option key={option} value={option}>
                  {STATUS_LABELS[option]?.label ?? option}
                </option>
              ))}
            </select>
            <small className="resolve__optional">{describeStatusChange(status, person)}</small>
          </label>

          <label className="resolve__field">
            Why
            <textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={3}
              maxLength={280}
              placeholder="Left the company on Friday; access withdrawn."
            />
            <small className="resolve__optional">
              {trimmed.length < 8
                ? "A few words at least — this is the record of why somebody lost access."
                : `${trimmed.length}/280`}
            </small>
          </label>
        </>
      )}

      {action.state.error ? (
        <p className="resolve__error" role="alert">
          {action.state.error}
        </p>
      ) : null}

      <div className="resolve__actions">
        <button type="submit" disabled={!ready}>
          {action.state.running ? "Applying…" : "Apply"}
        </button>
        <button type="button" className="button-quiet" onClick={onClose}>
          Cancel
        </button>
        <span className="resolve__optional">Permanent and attributed to you.</span>
      </div>
    </form>
  );
}

/** Which kiosks this Operator may act on. Nothing until somebody says so. */
function KioskForm({
  person,
  kiosks,
  onClose,
  onChanged
}: {
  person: AdminPerson;
  kiosks: AdminPeopleResponse["kiosks"];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [reason, setReason] = useState("");
  const assigned = new Set(person.kioskIds);

  const action = useAdminAction<{ kioskId: string; granted: boolean; reason: string }>(
    useCallback(
      async (input) =>
        observabilityApi.assignPersonKiosk(person.adminUserId, {
          kioskId: input.kioskId,
          granted: input.granted,
          reason: input.reason.trim()
        }),
      [person.adminUserId]
    )
  );

  const trimmed = reason.trim();
  const ready = trimmed.length >= 8 && !action.state.running;

  return (
    <div className="resolve">
      <h3>Kiosks {person.displayName} covers</h3>
      <p className="resolve__optional">
        An Operator can only act on a print at a kiosk they are assigned to. Taking one back stops
        them at their next action, not at their next sign-in.
      </p>

      <label className="resolve__field">
        Why
        <textarea
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          rows={2}
          maxLength={280}
          placeholder="Covering the central branch from Monday."
        />
        <small className="resolve__optional">
          {trimmed.length < 8
            ? "Needed before either button below will work."
            : `${trimmed.length}/280`}
        </small>
      </label>

      {kiosks.length === 0 ? (
        <p className="resolve__optional">No kiosks exist yet.</p>
      ) : (
        <ul className="people__kiosks">
          {kiosks.map((kiosk) => {
            const has = assigned.has(kiosk.id);
            return (
              <li key={kiosk.id} className="people__kiosk">
                <span>
                  {kiosk.name} <Identifier value={kiosk.id} />
                </span>
                <button
                  type="button"
                  className={has ? "button-quiet" : undefined}
                  disabled={!ready}
                  onClick={() => {
                    void action.run({ kioskId: kiosk.id, granted: !has, reason }).then((done) => {
                      if (done) onChanged();
                    });
                  }}
                >
                  {has ? "Take back" : "Assign"}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {action.state.error ? (
        <p className="resolve__error" role="alert">
          {action.state.error}
        </p>
      ) : null}

      <div className="resolve__actions">
        <button type="button" className="button-quiet" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  );
}

/** Ending every live session without touching the account. */
function SessionsForm({
  person,
  onClose,
  onChanged
}: {
  person: AdminPerson;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [reason, setReason] = useState("");
  const action = useAdminAction<{ reason: string }>(
    useCallback(
      async (input) =>
        observabilityApi.revokePersonSessions(person.adminUserId, {
          reason: input.reason.trim()
        }),
      [person.adminUserId]
    )
  );

  const trimmed = reason.trim();
  const ready = trimmed.length >= 8 && !action.state.running;

  return (
    <form
      className="resolve"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready) return;
        void action.run({ reason }).then((done) => {
          if (done) onChanged();
        });
      }}
    >
      <h3>Sign {person.displayName} out everywhere</h3>
      <p className="resolve__optional">
        Ends {person.activeSessions} live session(s). The account is untouched — they can sign back
        in with a key they still hold. Suspend the account instead if that is not what you want.
      </p>

      <label className="resolve__field">
        Why
        <textarea
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          rows={2}
          maxLength={280}
          placeholder="Laptop left on a train; signing the session out as a precaution."
        />
        <small className="resolve__optional">
          {trimmed.length < 8 ? "A few words at least." : `${trimmed.length}/280`}
        </small>
      </label>

      {action.state.error ? (
        <p className="resolve__error" role="alert">
          {action.state.error}
        </p>
      ) : null}

      <div className="resolve__actions">
        <button type="submit" disabled={!ready}>
          {action.state.running ? "Ending…" : "End every session"}
        </button>
        <button type="button" className="button-quiet" onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * Minting the code that lets somebody enrol their first key.
 *
 * The code appears once. Everything about this component is arranged around
 * that: it is shown on its own, in full, with the expiry beside it and an
 * instruction about how to hand it over — and once the panel is closed there is
 * no way back to it, because the server kept only a digest.
 */
function EnrollmentTicketForm({
  person,
  onClose,
  onIssued
}: {
  person: AdminPerson;
  onClose: () => void;
  onIssued: () => void;
}) {
  const [reason, setReason] = useState("");
  const [issued, setIssued] = useState<{ code: string; expiresAt: string } | null>(null);

  const action = useAdminAction<{ reason: string }>(
    useCallback(
      async (input) => {
        const ticket = await observabilityApi.issueEnrollmentTicket(person.adminUserId, {
          reason: input.reason.trim()
        });
        setIssued({ code: ticket.enrollmentCode, expiresAt: ticket.expiresAt });
        return ticket;
      },
      [person.adminUserId]
    )
  );

  const trimmed = reason.trim();
  const ready = trimmed.length >= 8 && !action.state.running;

  if (issued) {
    return (
      <div className="resolve enrollment-ticket">
        <h3>Enrolment code for {person.displayName}</h3>
        <p className="enrollment-ticket__code">
          <code>{issued.code}</code>
        </p>
        <p className="resolve__money" role="note">
          <strong>This is shown once.</strong> It cannot be looked up again — issue another if it is
          lost. Read it to {person.displayName} yourself rather than sending it, and watch them
          enrol. Anybody who has it can put a security key on this account until it expires{" "}
          <When value={issued.expiresAt} />.
        </p>
        <p className="resolve__optional">
          They enter it on the sign-in screen under &ldquo;I have an enrolment code&rdquo;. It
          enrols one key and signs nobody in; the account stays awaiting keys until it has enough.
        </p>
        <div className="resolve__actions">
          <button
            type="button"
            onClick={() => {
              setIssued(null);
              onIssued();
              onClose();
            }}
          >
            Done
          </button>
        </div>
      </div>
    );
  }

  return (
    <form
      className="resolve"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready) return;
        void action.run({ reason });
      }}
    >
      <h3>Issue an enrolment code for {person.displayName}</h3>
      <p className="resolve__optional">
        Authorises one enrolment ceremony, for fifteen minutes, on this account only. It works only
        while the account has no security key at all — a lost key is a recovery, which is the sealed
        offline procedure and not this.
      </p>

      <label className="resolve__field">
        Why
        <textarea
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          rows={2}
          maxLength={280}
          placeholder="First day; enrolling their key at the counter."
        />
        <small className="resolve__optional">
          {trimmed.length < 8 ? "A few words at least." : `${trimmed.length}/280`}
        </small>
      </label>

      {action.state.error ? (
        <p className="resolve__error" role="alert">
          {action.state.error}
        </p>
      ) : null}

      <div className="resolve__actions">
        <button type="submit" disabled={!ready}>
          {action.state.running ? "Issuing…" : "Issue the code"}
        </button>
        <button type="button" className="button-quiet" onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * One of somebody's keys, and the option to retire it.
 *
 * Disabled with a reason when the account is active and at its minimum. There
 * is no password in this system, so a revocation that leaves nothing behind is a
 * lockout rather than a cleanup — and the server refuses it either way.
 */
function KeyRow({
  person,
  authenticator,
  onChanged
}: {
  person: AdminPerson;
  authenticator: AdminPerson["authenticators"][number];
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");

  const action = useAdminAction<{ reason: string }>(
    useCallback(
      async (input) =>
        observabilityApi.revokePersonAuthenticator(person.adminUserId, authenticator.id, {
          reason: input.reason.trim()
        }),
      [person.adminUserId, authenticator.id]
    )
  );

  const wouldLockOut =
    person.status === "ACTIVE" && person.usableAuthenticators - 1 < person.minimumAuthenticators;
  const trimmed = reason.trim();
  const ready = trimmed.length >= 8 && !wouldLockOut && !action.state.running;

  return (
    <li className="people__key">
      <div>
        <strong>{authenticator.label}</strong>
        <span className="key-list__meta">
          {authenticator.attachment === "cross-platform" ? "Hardware key" : "This device"}
          {authenticator.backupEligible ? " · synchronised" : " · device-bound"} · enrolled{" "}
          <When value={authenticator.createdAt} />
          {authenticator.lastUsedAt ? (
            <>
              {" "}
              · last used <When value={authenticator.lastUsedAt} />
            </>
          ) : (
            " · never used"
          )}
        </span>
      </div>

      {open ? (
        <form
          className="inline-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!ready) return;
            void action.run({ reason }).then((done) => {
              if (done) {
                setOpen(false);
                onChanged();
              }
            });
          }}
        >
          <input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={280}
            placeholder="Why this key is being retired"
            aria-label={`Why ${authenticator.label} is being retired`}
          />
          <button type="submit" disabled={!ready}>
            {action.state.running ? "Retiring…" : "Confirm"}
          </button>
          <button type="button" className="button-quiet" onClick={() => setOpen(false)}>
            Cancel
          </button>
          {wouldLockOut ? (
            <span className="resolve__optional">
              This is their last spare. Enrol a replacement first.
            </span>
          ) : null}
          {action.state.error ? (
            <span className="resolve__error" role="alert">
              {action.state.error}
            </span>
          ) : null}
        </form>
      ) : (
        <button
          type="button"
          className="button-quiet"
          disabled={wouldLockOut}
          title={wouldLockOut ? "This is their last spare — enrol a replacement first." : undefined}
          onClick={() => setOpen(true)}
        >
          Retire
        </button>
      )}
    </li>
  );
}

/**
 * The transitions the server will accept from here.
 *
 * Mirrors `evaluateStatusTransition`, and is the courtesy half of it: the server
 * refuses anything else whatever this returns. `PROVISIONING` is never offered
 * because an account leaves it by enrolling, not by being told to.
 */
function availableStatuses(current: string): readonly AdminStatusAction[] {
  if (current === "ACTIVE") return ["SUSPENDED", "DISABLED"];
  if (current === "SUSPENDED") return ["ACTIVE", "DISABLED"];
  if (current === "PROVISIONING") return ["DISABLED"];
  return [];
}

function describeStatusChange(status: AdminStatusAction, person: AdminPerson): string {
  if (status === "ACTIVE") {
    return "Gives access back. Their existing keys still work; nothing is re-enrolled.";
  }
  const sessions =
    person.activeSessions === 0
      ? "They have no live sessions."
      : `Ends ${person.activeSessions} live session(s) immediately.`;
  return status === "SUSPENDED"
    ? `Stops them signing in, reversibly. ${sessions}`
    : `Shuts the account down permanently — this cannot be undone. ${sessions}`;
}
