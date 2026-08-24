import { useCallback, useState } from "react";

import {
  invitableRoles,
  type AdminPeopleResponse,
  type AdminPerson,
  type AdminRole,
  type AdminStatusAction
} from "@printing-kiosk/admin-access";

import { useSession } from "../features/auth/SessionProvider.js";
import { adminApi } from "../features/auth/api.js";
import { observabilityApi } from "../features/observability/api.js";
import { Empty, Identifier, When } from "../features/observability/components.js";
import { useAdminAction } from "../features/observability/useAdminAction.js";
import { useAdminData } from "../features/observability/useAdminData.js";

/**
 * The Operators, and what can be done about them.
 *
 * Several capabilities feed this screen and they draw different things. An
 * Admin holds them all and sees everything below. A Technical Admin holds
 * `authenticator.manage.operator`, `invitation.manage` and `recovery.manage`
 * but not `operator.manage`, so it can bring somebody in and get them back
 * into their account, and still cannot decide whether they may work or where.
 *
 * The screen is written to make three things hard to do by accident. Suspending
 * somebody says how many sessions it will end before it ends them. Retiring a
 * key is refused, visibly, when it would leave an account without the second
 * factor its role signs in with. And a one-time code — an invitation or a
 * password reset — is shown exactly once, on a panel that says so, next to the
 * instruction that it goes to the person directly rather than by message.
 *
 * Only Operators appear, because the capabilities behind it reach nothing else.
 * A screen listing Admins with every control disabled would be a screen telling
 * anybody who opened it which accounts are the interesting ones.
 */

const STATUS_LABELS: Readonly<Record<string, { label: string; hint: string }>> = {
  PROVISIONING: {
    label: "Setting up",
    hint: "Cannot sign in yet. Waiting for the invitation to be accepted."
  },
  ACTIVE: { label: "Active", hint: "Can sign in and work." },
  SUSPENDED: { label: "Suspended", hint: "Cannot sign in. Access can be given back." },
  DISABLED: { label: "Disabled", hint: "Shut down permanently. This cannot be undone." }
};

export function PeoplePanel() {
  const session = useSession();
  const load = useCallback(() => observabilityApi.people(), []);
  const state = useAdminData<AdminPeopleResponse>(load);
  const [inviting, setInviting] = useState(false);

  const canManage = session.can("operator.manage");
  const canManageKeys = session.can("authenticator.manage.operator");
  const canInvite = session.can("invitation.manage");
  const canRecover = session.can("recovery.manage");

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
        <div className="panel__actions">
          {canInvite ? (
            <button type="button" onClick={() => setInviting((current) => !current)}>
              {inviting ? "Close" : "Invite somebody"}
            </button>
          ) : null}
          <button type="button" onClick={state.reload} disabled={state.loading}>
            Refresh
          </button>
        </div>
      </header>

      {canManage ? null : (
        <p className="panel__hint">
          Your role can bring somebody in, help them back into their account, and retire a key.
          Suspending an account and changing which kiosks somebody covers are held by Admins.
        </p>
      )}

      {inviting && canInvite ? (
        <InvitationForm
          onClose={() => setInviting(false)}
          onCreated={state.reload}
          invitableRoles={session.identity ? invitableRoles(session.identity.role) : []}
        />
      ) : null}

      {data.items.length === 0 ? (
        <Empty>
          No Operator accounts exist yet. Use <strong>Invite somebody</strong> above: it creates the
          account and a one-time code they use to set a password.
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
              canInvite={canInvite}
              canRecover={canRecover}
              onChanged={state.reload}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Creating an account and the code that hands it over.
 *
 * The account exists from the moment this succeeds, holding the role chosen
 * here — acceptance decides nothing, it only proves the code and supplies the
 * factors. The role list comes from the shared matrix, so an Admin is offered
 * Operator and nothing else, and the server refuses anything wider regardless
 * of what this form draws.
 */
function InvitationForm({
  onClose,
  onCreated,
  invitableRoles: roles
}: {
  onClose: () => void;
  onCreated: () => void;
  invitableRoles: readonly AdminRole[];
}) {
  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [role, setRole] = useState<AdminRole>(roles[0] ?? "OPERATOR");
  const [reason, setReason] = useState("");
  const [issued, setIssued] = useState<{
    code: string;
    expiresAt: string;
    username: string;
  } | null>(null);

  const action = useAdminAction<{
    displayName: string;
    username: string;
    role: AdminRole;
    reason: string;
  }>(
    useCallback(async (input) => {
      const invitation = await adminApi.createInvitation({
        displayName: input.displayName.trim(),
        username: input.username.trim().toLowerCase(),
        role: input.role,
        reason: input.reason.trim()
      });
      setIssued({
        code: invitation.invitationCode,
        expiresAt: invitation.expiresAt,
        username: invitation.username
      });
      return invitation;
    }, [])
  );

  const trimmedReason = reason.trim();
  const ready =
    displayName.trim().length > 0 &&
    username.trim().length >= 3 &&
    trimmedReason.length >= 8 &&
    !action.state.running;

  if (issued) {
    return (
      <div className="resolve enrollment-ticket">
        <h3>Invitation code for {displayName}</h3>
        <p className="enrollment-ticket__code">
          <code>{issued.code}</code>
        </p>
        <p className="resolve__money" role="note">
          <strong>This is shown once.</strong> It cannot be looked up again — issue another if it is
          lost. Hand it over directly rather than sending it. It expires{" "}
          <When value={issued.expiresAt} />.
        </p>
        <p className="resolve__optional">
          They enter it on the sign-in screen under &ldquo;I have an invitation code&rdquo;, set
          their password, and — for privileged roles — enrol a security key. They will sign in as{" "}
          <strong>{issued.username}</strong>.
        </p>
        <div className="resolve__actions">
          <button
            type="button"
            onClick={() => {
              setIssued(null);
              onCreated();
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
        void action.run({ displayName, username, role, reason });
      }}
    >
      <h3>Invite somebody</h3>
      <p className="resolve__optional">
        Creates the account and a one-time code. Nothing here sets a password — only the person does
        that, and nobody else ever sees it.
      </p>

      <label className="resolve__field">
        Their name
        <input
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          maxLength={120}
          placeholder="Ada Lovelace"
        />
      </label>

      <label className="resolve__field">
        Username
        <input
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          maxLength={32}
          autoCapitalize="none"
          spellCheck={false}
          placeholder="ada"
        />
        <small className="resolve__optional">
          Lowercase letters, digits, and . _ - between them. This is what they type to sign in.
        </small>
      </label>

      <label className="resolve__field">
        Role
        <select value={role} onChange={(event) => setRole(event.target.value as AdminRole)}>
          {roles.map((option) => (
            <option key={option} value={option}>
              {option === "OPERATOR"
                ? "Operator"
                : option === "ADMIN"
                  ? "Admin"
                  : "Technical Admin"}
            </option>
          ))}
        </select>
        <small className="resolve__optional">
          {role === "OPERATOR"
            ? "Signs in with a password."
            : "Signs in with a password and a security key, which they enrol when they accept."}
        </small>
      </label>

      <label className="resolve__field">
        Why
        <textarea
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          rows={2}
          maxLength={280}
          placeholder="New operator at the central branch, starting Monday."
        />
        <small className="resolve__optional">
          {trimmedReason.length < 8 ? "A few words at least." : `${trimmedReason.length}/280`}
        </small>
      </label>

      {action.state.error ? (
        <p className="resolve__error" role="alert">
          {action.state.error}
        </p>
      ) : null}

      <div className="resolve__actions">
        <button type="submit" disabled={!ready}>
          {action.state.running ? "Creating…" : "Create account and code"}
        </button>
        <button type="button" className="button-quiet" onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function PersonRow({
  person,
  kiosks,
  canManage,
  canManageKeys,
  canInvite,
  canRecover,
  onChanged
}: {
  person: AdminPerson;
  kiosks: AdminPeopleResponse["kiosks"];
  canManage: boolean;
  canManageKeys: boolean;
  canInvite: boolean;
  canRecover: boolean;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState<
    "status" | "kiosks" | "sessions" | "invitation" | "reset" | null
  >(null);
  const status = STATUS_LABELS[person.status] ?? { label: person.status, hint: "" };
  const belowMinimum = person.usableAuthenticators < person.minimumAuthenticators;

  return (
    <li className="people__item">
      <div className="people__identity">
        <p className="people__name">
          <strong>{person.displayName}</strong>
          <span className="key-list__meta"> {person.username}</span>
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
          {person.passwordSet ? "Password set" : "No password yet"}
          {person.minimumAuthenticators > 0 || person.usableAuthenticators > 0
            ? ` · ${person.usableAuthenticators} security key(s)`
            : ""}
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
        {person.pendingInvitationExpiresAt ? (
          <p className="people__ticket-warning" role="note">
            An invitation code is outstanding until{" "}
            <When value={person.pendingInvitationExpiresAt} />. Anybody holding it can set this
            account&rsquo;s password.
          </p>
        ) : null}
        {person.pendingPasswordResetExpiresAt ? (
          <p className="people__ticket-warning" role="note">
            A password reset code is outstanding until{" "}
            <When value={person.pendingPasswordResetExpiresAt} />.
          </p>
        ) : null}
      </div>

      <div className="people__controls">
        {canInvite && person.status === "PROVISIONING" ? (
          <button
            type="button"
            onClick={() => setOpen(open === "invitation" ? null : "invitation")}
          >
            New invitation code
          </button>
        ) : null}
        {canRecover && person.status === "ACTIVE" ? (
          <button type="button" onClick={() => setOpen(open === "reset" ? null : "reset")}>
            Reset password
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

      {open === "invitation" ? (
        <OneTimeCodeForm
          person={person}
          kind="invitation"
          onClose={() => setOpen(null)}
          onIssued={onChanged}
        />
      ) : null}
      {open === "reset" ? (
        <OneTimeCodeForm
          person={person}
          kind="reset"
          onClose={() => setOpen(null)}
          onIssued={onChanged}
        />
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
 * Minting a one-time code for somebody else: a fresh invitation, or a password
 * reset.
 *
 * One component for both because they are the same act with different words —
 * a code that appears exactly once, goes to a person directly, and cannot be
 * looked up afterwards because the server kept only a digest. What differs is
 * which account state it applies to and what the person does with it, and both
 * of those are text.
 */
function OneTimeCodeForm({
  person,
  kind,
  onClose,
  onIssued
}: {
  person: AdminPerson;
  kind: "invitation" | "reset";
  onClose: () => void;
  onIssued: () => void;
}) {
  const [reason, setReason] = useState("");
  const [issued, setIssued] = useState<{ code: string; expiresAt: string } | null>(null);

  const action = useAdminAction<{ reason: string }>(
    useCallback(
      async (input) => {
        if (kind === "invitation") {
          const invitation = await adminApi.reissueInvitation(
            person.adminUserId,
            input.reason.trim()
          );
          setIssued({ code: invitation.invitationCode, expiresAt: invitation.expiresAt });
          return invitation;
        }
        const reset = await adminApi.issuePasswordReset(person.adminUserId, input.reason.trim());
        setIssued({ code: reset.resetCode, expiresAt: reset.expiresAt });
        return reset;
      },
      [kind, person.adminUserId]
    )
  );

  const trimmed = reason.trim();
  const ready = trimmed.length >= 8 && !action.state.running;
  const isInvitation = kind === "invitation";

  if (issued) {
    return (
      <div className="resolve enrollment-ticket">
        <h3>
          {isInvitation ? "Invitation code" : "Password reset code"} for {person.displayName}
        </h3>
        <p className="enrollment-ticket__code">
          <code>{issued.code}</code>
        </p>
        <p className="resolve__money" role="note">
          <strong>This is shown once.</strong> It cannot be looked up again — issue another if it is
          lost. Hand it over directly rather than sending it. It expires{" "}
          <When value={issued.expiresAt} />.
        </p>
        <p className="resolve__optional">
          {isInvitation ? (
            <>
              They enter it on the sign-in screen under &ldquo;I have an invitation code&rdquo; and
              set their password. Any earlier invitation for this account has been revoked.
            </>
          ) : (
            <>
              They enter it under &ldquo;I have a password reset code&rdquo; and choose a new
              password — you never see it. Completing it signs the account out everywhere; their
              security keys are untouched.
            </>
          )}
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
      <h3>
        {isInvitation
          ? `Issue a new invitation code for ${person.displayName}`
          : `Reset ${person.displayName}'s password`}
      </h3>
      <p className="resolve__optional">
        {isInvitation
          ? "Replaces any code already outstanding for this account. Works only while the account is still being set up."
          : "Issues a short-lived, single-use code. You never see or choose the password that results, and completing it ends every session the account holds."}
      </p>

      <label className="resolve__field">
        Why
        <textarea
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          rows={2}
          maxLength={280}
          placeholder={
            isInvitation
              ? "The first code expired before they could use it."
              : "Forgot their password; confirmed their identity in person."
          }
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
 * Disabled with a reason when the account is active and at its minimum — for a
 * privileged role that means the last key, because removing it would leave a
 * password as the only thing between the internet and an administrator
 * account. The server refuses it either way.
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
