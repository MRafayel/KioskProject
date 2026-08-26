import { useState } from "react";

import { useSession } from "../features/auth/SessionProvider.js";
import { ACCOUNT_TAB_IDS, canOpenAccountTab, type AccountTabId } from "../features/navigation.js";
import { PeoplePanel } from "./PeoplePanel.js";
import { SecurityPanel } from "./SecurityKeysPanel.js";

const TAB_LABELS: Readonly<Record<AccountTabId, string>> = {
  profile: "My profile",
  people: "People",
  security: "Security"
};

/**
 * Everything about accounts, in one place.
 *
 * People and Security used to be two of eleven entries in the rail, which made
 * the main navigation of an operations dashboard 18% account administration —
 * two doors an operator passes every day on the way to the four they actually
 * use. Neither answers a question about printing. Both answer a question about
 * who may do what, which is what the signed-in identity at the foot of the rail
 * is already about, so that is where they now live.
 *
 * Nothing about either screen changed. The capabilities that gated them in the
 * rail gate them here, so a role that could not open People still cannot, and
 * finds the tab absent rather than present-and-refusing.
 *
 * Profile is new, and small on purpose. This control plane cannot edit an
 * identity from a browser — no connection a browser can reach holds UPDATE on
 * `admin_users.role`, and an account's name and username are immutable after
 * creation — so there is nothing here to edit and no edit control pretending
 * otherwise. What it does is answer the questions the old page footer was
 * answering on every screen at once: who am I, what can I do, and when does
 * this sign-in end.
 */
export function AccountScreen({ initialTab }: { initialTab?: AccountTabId | undefined } = {}) {
  const session = useSession();
  const tabs = ACCOUNT_TAB_IDS.filter((tab) => canOpenAccountTab(tab, session.can));
  const [tab, setTab] = useState<AccountTabId>(
    initialTab && tabs.includes(initialTab) ? initialTab : (tabs[0] ?? "profile")
  );
  const current = tabs.includes(tab) ? tab : (tabs[0] ?? "profile");

  return (
    <div className="account">
      {/* A real tab list rather than eleven more rail entries wearing a
          different colour: the three are alternatives within one screen, and
          arrow-key movement between them is what a person expects from that. */}
      <nav className="account__nav" aria-label="Account settings">
        {tabs.map((id) => (
          <button
            key={id}
            type="button"
            className={id === current ? "account__tab is-active" : "account__tab"}
            aria-current={id === current ? "page" : undefined}
            onClick={() => setTab(id)}
          >
            {TAB_LABELS[id]}
          </button>
        ))}
      </nav>

      <div className="account__body">
        {current === "profile" ? <ProfilePanel /> : null}
        {current === "people" ? <PeoplePanel /> : null}
        {current === "security" ? <SecurityPanel /> : null}
      </div>
    </div>
  );
}

/**
 * The signed-in account, and what this sign-in is.
 *
 * The sign-in expiry moved here from the page footer, where it was rendered
 * below every panel in the application. A time that only matters twice a day —
 * once when you notice it and once when it happens — does not earn a permanent
 * strip under the rows somebody is reading, and putting it on eleven screens
 * did not make it eleven times more likely to be read.
 */
function ProfilePanel() {
  const session = useSession();
  const identity = session.identity;
  if (!identity) return null;

  const hardExpiry = new Date(identity.session.hardExpiresAt);
  const idleExpiry = new Date(identity.session.idleExpiresAt);

  return (
    <>
      <section className="panel">
        <div className="account__identity">
          <span className="account__avatar" aria-hidden="true">
            {initials(identity.displayName)}
          </span>
          <div>
            <h2 className="account__name">{identity.displayName}</h2>
            <p className="account__role">{roleLabel(identity.role)}</p>
          </div>
        </div>

        <dl className="detail-grid">
          <div>
            <dt>Username</dt>
            <dd>
              <code>{identity.username}</code>
            </dd>
          </div>
          <div>
            <dt>Role</dt>
            <dd>{roleLabel(identity.role)}</dd>
          </div>
          <div>
            <dt>Second factor</dt>
            <dd>{identity.strongAuthMethod === "WEBAUTHN" ? "Security key" : "Password only"}</dd>
          </div>
          <div>
            <dt>Kiosks you may act on</dt>
            <dd>
              {identity.kioskScopes.length === 0 ? "Every kiosk" : identity.kioskScopes.join(", ")}
            </dd>
          </div>
        </dl>

        {/* Immutability is a property worth stating rather than leaving people
            to infer from an absence of buttons. */}
        <p className="panel__hint">
          Your name, username and role are fixed when the account is created and cannot be changed
          from here by anybody, including an Admin. Ask an administrator if one of them is wrong.
        </p>
      </section>

      <section className="panel">
        <div className="panel__heading">
          <h2>This sign-in</h2>
          <button
            type="button"
            disabled={session.activity === "signing-out"}
            onClick={() => void session.signOut()}
          >
            {session.activity === "signing-out" ? "Signing out…" : "Sign out"}
          </button>
        </div>

        <p className="panel__status">
          This sign-in expires at{" "}
          <time dateTime={identity.session.hardExpiresAt}>
            {hardExpiry.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
          </time>
          .
        </p>

        <dl className="detail-grid">
          <div>
            <dt>Locks if idle until</dt>
            <dd>
              <time dateTime={identity.session.idleExpiresAt}>
                {idleExpiry.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
              </time>
            </dd>
          </div>
          <div>
            <dt>Sensitive actions</dt>
            <dd>
              {identity.session.stepUpFreshUntil ? (
                <>
                  Authorised until{" "}
                  <time dateTime={identity.session.stepUpFreshUntil}>
                    {new Date(identity.session.stepUpFreshUntil).toLocaleTimeString(undefined, {
                      hour: "numeric",
                      minute: "2-digit"
                    })}
                  </time>
                </>
              ) : (
                "Will ask you to confirm it is you"
              )}
            </dd>
          </div>
        </dl>
      </section>
    </>
  );
}

/**
 * Two letters standing in for a face.
 *
 * There are no avatar images in this system and there should not be: a photo
 * upload is a storage surface, a moderation problem and a piece of personal
 * data, bought for decoration on a five-person dashboard.
 */
function initials(displayName: string): string {
  const words = displayName.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = words[0]?.[0] ?? "";
  const last = words.length > 1 ? (words[words.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase();
}

export function roleLabel(role: string): string {
  return (
    {
      OPERATOR: "Operator",
      ADMIN: "Admin",
      TECHNICAL_ADMIN: "Technical Admin"
    }[role] ?? role
  );
}
