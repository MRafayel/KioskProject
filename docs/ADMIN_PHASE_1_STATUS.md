# Admin Control Plane — Phase 1: security foundation

Status: implemented to the Phase 1 acceptance boundary. No operational data is
readable from the control plane yet; that is Phase 2.

This phase builds the thing the system had none of: a human identity, and a
server-side answer to "is this person allowed to do this". Everything here is
about proving who somebody is and what they may do. Nothing here reads a
session, document, payment, or print row — a boundary that is asserted by test.

---

## 1. What was implemented

### Identity — WebAuthn only

There is no password, no TOTP, no emailed link and no SMS anywhere in the
control plane, by decision (Phase 0 §23.1). A security key is the only way in.

- **Discoverable credentials.** Login collects no username. The authenticator
  chooses the account and the server learns it only from a verified signature,
  which removes account enumeration entirely — there is no field to probe.
- **User verification required** on every ceremony, so the authenticator must
  confirm a person (PIN or biometric), not merely that a key is present.
- **Device-bound keys for Technical Admins.** A synchronised passkey is refused
  for that role — checked against what the authenticator actually reported,
  then again by a database trigger.
- **Two authenticators minimum.** An account cannot be activated below it and a
  revocation cannot take an active account below it. `PROVISIONING` is the only
  state in which fewer than two exist.

### Sessions

Server-side and revocable. The cookie carries a random token; only a peppered
HMAC of it is stored, so reading `admin_sessions` yields nothing replayable.

- `__Host-` prefixed, `HttpOnly`, `Secure`, `SameSite=Strict`.
- Idle window (15 min default) rolls forward at most once a minute; absolute
  window (4 h default) never extends.
- Every request re-reads the row, so revocation and account suspension take
  effect immediately rather than at expiry.

### Step-up

Every R2 action requires a WebAuthn assertion within the last 5 minutes. A
stolen cookie is therefore worth read access at most, and only until the idle
window closes.

### Authorization

One gate, `authorizeAdmin`, performs four checks in a fixed order: live session
→ CSRF on mutations → capability → step-up freshness. There is no way for a
route to request a subset.

- **Capabilities, not role checks.** 30 capabilities across three roles, defined
  as one reviewable table in `packages/admin-access`.
- **No role is a superset of another** — asserted by test. Admin cannot propose
  technical changes; Technical Admin cannot manage people.
- **R3 is refused unconditionally** with `ADMIN_APPROVAL_REQUIRED`, because no
  single request can prove a second Technical Admin and an Admin approved it.
- **CSRF**: double-submit token bound to the session row, so a token lifted from
  another session does not satisfy it.

### Audit

`audit_events` is now append-only, enforced by triggers that reject `UPDATE` and
`DELETE`. Admin actions are recorded with a new `ADMIN_USER` actor type, and
metadata passes through a key allow-list so a later caller cannot put a filename
or an error message into durable storage "for context".

### Bootstrap and recovery

`pnpm db:admin` — an operator-run CLI, deliberately not a dashboard feature. It
creates accounts, issues sealed break-glass codes, lists accounts, and suspends
or disables them. See §5 for the runbook.

### Admin UI

`apps/admin` (React 19 + Vite, port 5175, loopback-only in development). Sign-in,
identity and capability display, and self-service security-key management. The
overview deliberately shows no operational numbers rather than placeholders.

---

## 2. Why it was designed this way

**Self-hosted WebAuthn over a managed IdP.** Chosen by the owner to avoid a
runtime dependency on a third party: an IdP outage would otherwise lock every
operator out during exactly the incident the control plane exists for. The
usual objection — a lost key has no reset path — is answered by requiring two
authenticators and an offline break-glass envelope, not by adding a weaker
fallback factor.

**No kiosk-credential capability at any level.** Phase 0 §12 found that whoever
can issue a kiosk credential can read customer documents through two existing
endpoints. Rather than mitigate that with approvals, the capability does not
exist in the dashboard at all, and a test asserts no capability name mentions
it.

**Observation separated from money.** `print.recovery.resolve` (Operator and
above) records what a person saw at the tray. `refund.authorize` (Admin and
above) is the only capability that can create or settle a monetary obligation.
A compromised Operator account produces false observations an Admin must still
act on — not a payout.

**Invariants in PostgreSQL, not only in TypeScript.** Matching how the rest of
this repository already works. Five new triggers enforce device-bound keys,
the two-authenticator minimum on activation and on revocation, single-use
break-glass, and audit immutability. All five were verified to fire against a
live database.

---

## 3. A correction made during this phase

The first migration made `audit_events` append-only _and_ changed its kiosk and
session foreign keys from `SET NULL` to `RESTRICT`, on the reasoning that
detaching an audit row from its subject is a rewrite by another name.

That reasoning was right and the fix was wrong. With the append-only trigger in
place, `SET NULL` fails as a forbidden `UPDATE`, and `RESTRICT` makes any
audited kiosk or session undeletable forever. Either way an operational deletion
ends up being decided by the audit log, which is backwards.

The second migration drops both constraints. The identifiers stay as recorded
values rather than live references: an audit row keeps naming the session it was
about after that session is gone, which is what a historical record is for.
Nothing detaches, nothing blocks, and the append-only guarantee becomes
unconditional.

**Consequence for tests.** Fixtures could previously delete audit rows between
runs. They no longer can, and should not — so the cleanup was removed from six
integration suites. One test then failed on a primary-key collision: it used a
deterministic random source whose fixed UUIDs collided with audit rows it had
written in an earlier run. That source now draws a per-run prefix; only the
token sequence it pins down was ever load-bearing. The integration suite passes
twice in a row from a warm database, which is the property that was missing.

---

## 4. Verification

| Check                   | Result                                                                                                          |
| ----------------------- | --------------------------------------------------------------------------------------------------------------- |
| `pnpm lint`             | 25/25 packages clean                                                                                            |
| `pnpm typecheck`        | 25/25 packages clean                                                                                            |
| `pnpm format:check`     | clean                                                                                                           |
| `pnpm test`             | 25/25 packages, all suites green                                                                                |
| `pnpm test:integration` | 139/139 across 8 files, twice consecutively                                                                     |
| New tests               | 54 capability/authenticator/session unit tests, 14 authorization-gate unit tests, 28 boundary integration tests |

Database invariants verified directly against PostgreSQL:

```
audit_events UPDATE                          → refused
audit_events DELETE                          → refused
Technical Admin synchronised passkey         → refused
activation with one authenticator            → refused
revocation leaving one key on ACTIVE account → refused
revocation once a third key is enrolled      → allowed
```

Boundary tests cover: every route refused unauthenticated; forged session
cookie refused; revoked, idle-expired and suspended-account sessions refused;
logout revokes immediately; CSRF missing, mismatched, and cross-session all
refused; safe methods exempt; capability grants match the role table exactly; no
role reports a document-content or kiosk-credential capability; step-up absent,
stale and fresh; last-spare revocation refused; another account's authenticator
refused; and no operational route exists yet.

---

## 5. Break-glass runbook

The sealed path back in when every authenticator for an account is gone. It is
part of the Phase 1 gate, not follow-up work.

### What it is

A 256-bit code, stored only as a peppered digest under a pepper independent of
every other secret. It authorises **one** security-key enrolment on **one**
named account. It issues no session, carries no capability, and cannot perform
an operational action. Recovery restores the ability to sign in; it is not
itself a sign-in.

### Issuing

```bash
pnpm db:admin create --name "Ada Lovelace" --role TECHNICAL_ADMIN
pnpm db:admin break-glass --admin-user <uuid> --label "safe A — Ada"
```

The code is printed once and is not recoverable. Print it, seal it in a labelled
envelope, and store it offline in a physical safe. Do not save it to a file, a
password manager, or a chat message.

Issue **two** envelopes per privileged account, stored in different physical
locations, so losing access to one safe is not itself an incident.

Codes expire after 90 days by default (`--expires-days`, max 365). Re-issue on
expiry and destroy the old envelope.

### Using

1. Operator opens the admin origin and starts recovery with the sealed code.
2. The code is consumed **at the point it authorises the ceremony**, not when
   the ceremony succeeds — a failed attempt still burns it, so a code that has
   been read by anyone is spent.
3. The operator enrols one security key. The account is still `PROVISIONING`
   and cannot sign in.
4. They enrol a second key. The account activates and normal sign-in works.
5. Consumption writes an audit event and an error-level log line. Treat every
   use as an incident until confirmed: verify out-of-band that the named person
   actually initiated it.

### After use

- Issue a replacement envelope; the consumed one is dead.
- Revoke any authenticator believed lost, once the replacements are enrolled —
  the ordering is enforced, so the replacement must come first.
- Record why in the revocation reason; it is kept in the audit trail.

### If an envelope is compromised

An opened, photographed, or unaccounted-for envelope is a live credential.
Revoke it and issue a replacement:

```bash
pnpm db:admin revoke-break-glass --admin-user <uuid>
pnpm db:admin break-glass --admin-user <uuid> --label "safe A — reissued"
```

This retires every _unused_ credential for the account. A consumed one is
already spent and is left alone, so revocation cannot rewrite the record of a
recovery that actually happened.

### Rotation and offboarding

```bash
pnpm db:admin suspend --admin-user <uuid>   # revokes live sessions immediately
pnpm db:admin disable --admin-user <uuid>   # permanent
pnpm db:admin list
```

Suspension takes effect on the next request, not at session expiry. Accounts are
never deleted: their audit trail refers to them by identifier and outlives them.

---

## 6. Security review of this phase

**What a stolen admin session cookie gets an attacker.** Read access to their
own identity and their own authenticator list, until the idle window closes.
Every R2 action requires a fresh assertion the cookie cannot provide. It cannot
be used cross-site: `SameSite=Strict` plus a session-bound CSRF token.

**What a compromised admin _account_ gets an attacker.** In Phase 1, nothing
operational exists to reach. Structurally: no document contents, no kiosk
credentials, no secrets, no SQL, no shell, no R3 execution, and no ability to
rewrite or delete audit history.

**Phishing.** WebAuthn binds credentials to the origin, so a lookalike site
cannot obtain a usable assertion. This is the main reason the owner chose it
over any shared-secret factor.

**Cloned authenticator.** A signature counter that fails to advance is refused
and audited. Authenticators that report no counter (always zero) are handled
correctly rather than being treated as clones.

**Enumeration.** No username field exists. Login options are identical whether
or not any account exists. All authentication failures return one code.

**Ceremony replay.** Challenges are single-use, claimed by a conditional
update, so two concurrent requests presenting the same ceremony cannot both
proceed. They expire in 3 minutes.

**Known gaps, carried forward honestly:**

- **One database role.** The API, worker and migrations still share
  `DATABASE_URL`. The audit triggers are real defence in depth, but an attacker
  with that credential and `ALTER TABLE` rights could drop them. The proper fix
  is a read-only role for admin reads and revoking `DELETE`/`UPDATE` on
  `audit_events` from the application role — planned for Phase 2, when the
  read paths that need it arrive.
- **No rate limit on failed assertions per account.** Bounded per source
  address only. WebAuthn assertions are not guessable, so this is low risk, but
  a per-account lockout signal would be better telemetry.
- **Break-glass depends on physical process.** The control is an envelope in a
  safe. Nothing technical prevents a code being photographed.
- **Attestation is not verified.** Enrolment uses `attestationType: "none"`, so
  the device-bound rule for Technical Admins rests on the authenticator's own
  self-reported flags rather than a signed attestation statement. Adequate
  against a mistake; not against a determined insider using modified firmware.

---

## 7. Printing-performance impact

None. The admin plane shares the API process but touches only `admin_*` tables
and `audit_events`. It opens no object-storage client, holds no S3 credential,
issues no query against sessions, files, payments or print jobs, and adds no
work to any background runner. The one added index is on `audit_events(action,
occurred_at)`, which is write-side cost on a table already written per action.

---

## 8. New dependencies

Two, both halves of the same protocol.

| Dependency                       | Why                                                                                                                                                                                              | Alternative considered                                                                                                                                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@simplewebauthn/server` 13.3.2  | Server-side registration/assertion verification: CBOR decoding, COSE key parsing, attestation formats, RP ID hashing, counter handling. Cryptographic protocol code this project should not own. | Hand-written verification — rejected as exactly the "greater risk implemented internally" case the dependency policy exists to prevent. Managed OIDC — rejected by the owner (runtime third-party dependency). |
| `@simplewebauthn/browser` 13.3.0 | The client half: base64url ↔ ArrayBuffer marshalling for `navigator.credentials`. Zero transitive dependencies.                                                                                  | Hand-written marshalling — possible but an easy place to introduce a subtle encoding bug for no benefit.                                                                                                       |

Nothing else was added. The capability model, sessions, CSRF, audit, rate
limiting and UI all reuse what the repository already had.

---

## 9. What remains

Phase 2 (read-only observability) is unblocked. Before it starts:

1. **Add the read-only database role** and revoke `UPDATE`/`DELETE` on
   `audit_events` from the application role. This closes the largest gap in §6
   and is cheapest to do before read paths exist.
2. **`Kiosk.lastSeenAt` is still never written** (Phase 0 §20 item 7). Kiosk
   liveness — the first thing the overview must answer — is not answerable
   until the throttled heartbeat in `sessions/auth.ts` populates it.
3. **Operator kiosk scoping is stored but unused.** `admin_kiosk_scopes` exists
   and is reported in the identity response; the first query that must respect
   it arrives with Phase 2's session list.

Not started, and correctly so: every operational read, every R1/R2 action, and
the R3 approval workflow.
