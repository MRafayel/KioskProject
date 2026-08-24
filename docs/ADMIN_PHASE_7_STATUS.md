# Admin control plane — Phase 7 status

Authentication. The first phase that changes how somebody signs in rather than
what they can do once they have, and the first that removes a rule the earlier
phases treated as foundational.

The owner's complaint was about daily use: people were signed out when the
browser closed, signed out again after fifteen minutes away, and — for the one
Technical Admin account — a security key that stopped working after every
logout. The instruction was explicit that this was not a request to reduce
security. It was a request to stop conflating three different things that the
original design had fused into one.

**Credentials, sessions and authorization are now separate.** A credential
belongs to a person and outlives every session. A session belongs to a browser,
survives that browser closing, and locks rather than dies when it is left alone.
Authorization is decided per request from the role and the freshness of the last
strong reauthentication, exactly as before.

One dependency was considered and not taken: password hashing runs on Node 24's
own `crypto.argon2`, so the control plane still has exactly one runtime
dependency added across seven phases (`@simplewebauthn/server`, Phase 0 §13.1).

---

## 1. What was implemented

### 1.1 Passwords, as the base factor for everybody

`admin_passwords` holds one Argon2id digest per account, as a self-describing
PHC string (`$argon2id$v=19$m=65536,t=3,p=1$…`) so the parameters travel with
the hash and can be raised later without a migration. 64 MiB, three passes —
comfortably above OWASP's first recommended configuration, and well under 100ms
per login at this scale.

Three properties are worth stating because each one is a decision:

**It is the runtime's own implementation.** Node 24 ships RFC 9106 Argon2 in
`node:crypto`. `passwords.test.ts` pins it to the RFC's own argon2id test vector,
so a runtime whose Argon2 disagrees with the specification fails the suite rather
than the users.

**Verification honours the stored parameters, not the current constants.** A
digest written under weaker settings keeps verifying until the person next
changes their password, which is what makes the constants safe to raise.

**A login against an account that does not exist burns the same work.** There is
a username field now, so "no such account" and "wrong password" would otherwise
differ by 90 milliseconds. `burnEquivalentWork` closes that, and
`admin-access.test.ts` asserts the two refusals are byte-identical apart from
the request id.

The digest lives in its own table rather than as a column on `admin_users`, and
that is a boundary rather than tidiness: the people-writer role holds
column-level UPDATE on `admin_users`, and a password digest must never be
reachable from the connection that administers accounts.

### 1.2 WebAuthn, kept and demoted to a second factor

Every ceremony, challenge, sign-count check and replay defence from Phase 1
survives untouched. What changed is where the assertion sits: a privileged login
is a password _then_ a key, and the ceremony is created only because the password
verified — which is what binds the assertion to the knowledge factor that
preceded it.

Which roles carry it is a table in `packages/admin-access/src/authentication.ts`
rather than a condition spread across the login, unlock, step-up and activation
paths. Requiring WebAuthn for a further role later is one line there.

**The Technical Admin device-bound rule was retired**, and this is the change
that fixes the owner's third complaint. It was the right rule while WebAuthn
stood alone. In practice, on a machine with no hardware FIDO2 key, the only
thing satisfying it was a Chrome DevTools virtual authenticator — destroyed when
the browser closed, and costing one sealed break-glass code per browser restart.
Four codes had been burned that way. With a password as the first factor, a
platform authenticator that persists is strictly better than a perfect key that
keeps not existing.

`admin-access.test.ts` now asserts the permission in the affirmative, so
reintroducing the rule fails a test rather than somebody's Tuesday.

### 1.3 Sessions that lock instead of dying

`evaluateSession` returns three states rather than two. `LOCKED` is new and is
the whole point: the idle window has passed, the absolute window has not, the
row is intact, and one reauthentication reopens the same session — same token,
same cookie, same absolute limit, same place in whatever the person was doing.

The windows follow the role, from configuration:

| Role            | Idle (locks) | Absolute (ends) |
| --------------- | ------------ | --------------- |
| Operator        | 6 hours      | 30 days         |
| Admin           | 2 hours      | 14 days         |
| Technical Admin | 1 hour       | 7 days          |

Previously: fifteen minutes and four hours, for everybody, and the fifteen
minutes destroyed the session. The absolute limits are long because they are now
the only thing that _ends_ a session on a timer, and their job is to make sure no
cookie lives forever — not to interrupt a working day.

The cookie was always persistent (`expires` at the absolute limit) — what made
sessions vanish on a browser restart was that the fifteen-minute idle window had
always lapsed by the time the browser reopened. Both halves are asserted now.

A locked session may do exactly two things: unlock, or log out. `authorizeAdmin`
refuses everything else with `ADMIN_SESSION_LOCKED`, which the panel tells apart
from "sign in again" — that distinction is the difference between a lock screen
and a login screen.

### 1.4 Step-up, extended rather than replaced

`last_step_up_at` and the R0–R4 risk classes are unchanged. What is new is that
the strong factor follows the role: a key for privileged accounts, the password
for Operators, who hold nothing stronger. A privileged account cannot step up
with its password — `admin-authentication.test.ts` asserts the refusal — because
R2 exists precisely for the actions a stolen password must not reach.

Five capabilities were added and each was given a risk deliberately:

| Capability                | Risk | Why                                                                         |
| ------------------------- | ---- | --------------------------------------------------------------------------- |
| `account.sessions.read`   | R0   | A read. Gating a screen on anything else demands a ceremony to look.        |
| `account.sessions.revoke` | R1   | Protective. Demanding a ceremony would guard the burglar against the owner. |
| `account.password.change` | R2   | A stolen live session must not rotate the knowledge factor.                 |
| `invitation.read`         | R0   | The ledger screen. Only digests exist after issuance.                       |
| `invitation.manage`       | R2   | Ends in somebody new holding credentials.                                   |
| `recovery.manage`         | R2   | The same, by another route.                                                 |

### 1.5 Invitations replace enrolment tickets

There is no public registration and there never was. What changed is that an
account can now be created from the panel, by somebody authorised to create it,
behind a step-up ceremony and an audit row — instead of only from a CLI with a
database credential.

Who may invite whom is a matrix, not a role check:

| Actor           | May invite                       |
| --------------- | -------------------------------- |
| Operator        | nobody                           |
| Admin           | Operator                         |
| Technical Admin | Operator, Admin, Technical Admin |

The account exists from the moment the invitation is created, already holding
its role, so acceptance decides nothing — it proves the code and supplies the
factors. Only a digest is stored; the code is shown once and cannot be re-read.

**One difference from break-glass is deliberate and was learned from it.**
Break-glass consumes its code when the ceremony _opens_, which is why a failed
`navigator.credentials.create()` burned a code with nothing enrolled. An
invitation is consumed when the account _activates_. A fumbled key prompt costs
a retry rather than a walk back to whoever issued it.

Enrolment tickets are gone. They could only authorise a first key on an Operator
account that had never had one; an invitation carries the whole of onboarding.

### 1.6 Administrator-assisted recovery

A short-lived single-use reset code, issued by somebody authorised to issue it,
carried to the person, redeemed by them. The issuer never sees or chooses the
password that results, and completing a reset revokes every session the account
held.

| Actor           | May reset               |
| --------------- | ----------------------- |
| Admin           | Operator                |
| Technical Admin | Operator, Admin         |
| anybody         | never a Technical Admin |

The last row is the escalation boundary. A Technical Admin's password is reset
from the CLI or not at all, because the accounts that could authorise it from a
browser are exactly the ones an attacker would be holding. And a reset against a
privileged target is not a takeover even when issued maliciously: the WebAuthn
factor the issuer does not hold still stands between them and the account.

Both refusals answer 404 rather than 403, so the panel does not become a way to
find out who the privileged accounts are.

The design has one delivery mechanism today — the code is read out — and adding
Telegram or email later changes who carries the code, not this model.

### 1.7 Bootstrap, and break-glass

`pnpm db:admin bootstrap-technical-admin --name … --username …` creates the first
Technical Admin and prints a one-time activation code. It **refuses to run while
a working Technical Admin exists**, which is what stops it becoming an
unrestricted alternative registration endpoint; `--force` exists for the case
where every Technical Admin is genuinely unrecoverable, and says so.

Break-glass is unchanged in every respect. It remains the sealed offline path
for an account that has lost every key: one enrolment ceremony, one named
account, no session, no capability, burned on use. It is now the answer to a
narrower question — a lost _key_, not a lost password — and the sign-in screen
says so, because somebody who only forgot their password should not be spending
an envelope.

### 1.8 A security section

Where you are signed in (creation time, last activity, browser, address, which
one is current), revoke one, sign out everywhere else, and change your password.

The address and browser strings are informational and the code says so twice:
nothing treats either as proof of device identity, and no authorization decision
reads them.

---

## 2. New dependencies

**None.** Argon2id is `node:crypto` in Node 24, which the repository already
requires. The control plane has added one runtime dependency in seven phases.

---

## 3. Verification

| Suite                                            | Result                              |
| ------------------------------------------------ | ----------------------------------- |
| `pnpm typecheck`                                 | 27/27                               |
| `pnpm lint`                                      | 27/27                               |
| `pnpm test`                                      | 27/27 tasks                         |
| `tests/integration/admin-authentication.test.ts` | 17 passed (new this phase)          |
| `tests/integration/admin-security.test.ts`       | 52 passed — the route matrix gate   |
| `tests/integration/admin-access.test.ts`         | 40 passed                           |
| `tests/integration/admin-people.test.ts`         | 33 passed                           |
| `tests/integration` (all)                        | 360 passed, 6 pre-existing failures |

The six failures are in `device-plane.test.ts` and are **not from this phase** —
they reproduce identically on a clean checkout (verified by stashing this work
and re-running). They concern `approvedQueues` and predate it.

`admin-authentication.test.ts` is the phase's own gate and asks the questions the
owner's complaint raises, through the real API against a real database:

- a password alone signs an Operator in, and does not sign an Admin in;
- **logging out leaves every WebAuthn credential exactly where it was** — the
  test that would have caught the original defect;
- a session survives a browser restart, cookie attributes asserted;
- inactivity locks, and one password reopens _the same session row_ rather than
  issuing a new one;
- the absolute limit ends a session that nothing reopens;
- reading is never interrupted, and a sensitive action on a stale session is
  refused and then accepted after a step-up;
- a privileged account cannot step up with a password;
- changing a password requires the current one even inside a fresh step-up, and
  ends every other session.

Every one of the twelve behaviours the owner asked to be covered has a test. The
privileged-login-with-WebAuthn assertion is covered up to the browser boundary —
the ceremony is created, bound to the account the password proved, and the
credential half is asserted in `App.test.tsx` with a mocked authenticator,
because a real assertion cannot be produced without a browser.

All six least-privilege roles were re-provisioned and verified after the
migration, per the standing rule.

---

## 4. Security review

### 4.1 What got stronger

**Recovery no longer costs a sealed envelope.** Losing a password was previously
indistinguishable from losing every key, because there was only one factor. Four
break-glass codes were spent on what were, in effect, browser restarts.

**Two factors where there was one.** A privileged account now needs a password
_and_ a key. Previously a stolen or cloned authenticator was the whole identity.

**A locked session is a smaller target than a signed-out one.** People will not
now be tempted to keep a browser open on purpose to avoid the fifteen-minute
re-login, which is the behaviour short windows actually produce.

**Account creation gained an audit trail.** It was a CLI act with a database
credential; it is now also a panel act behind a step-up ceremony, a role matrix
and an audit row naming who authorised it.

### 4.2 What got weaker, stated plainly

**A password is now sufficient for an Operator.** It was WebAuthn-only. This is
the owner's explicit instruction (§2 of the brief: `operator: username +
password`), and it is bounded — an Operator holds no capability that moves
money, changes a price, or reaches another account.

**The device-bound key rule is gone.** A Technical Admin may now use a
synchronised passkey, so that credential is as strong as the vendor account
holding it. The mitigation is the password in front of it and the fact that the
alternative was a virtual authenticator that did not survive a browser restart.

**Sessions live much longer.** Thirty days absolute for an Operator against four
hours before. The lock is what carries the risk now, and it is tighter in
practice than the old idle window was in theory, because the old one produced
propped-open browsers.

**One defect was found and fixed during this phase.** The activation trigger
reads `admin_passwords`, which the people role deliberately cannot select — so
resuming a suspended account failed with a permission error. The trigger is now
`SECURITY DEFINER` with a pinned `search_path`, owned by the migrator, which is
the standard shape for an invariant that must see more than its caller. Found by
`admin-people.test.ts`, not by review.

**A second, pre-existing defect was surfaced.** The reader role's column
allow-list was stale for `print_job_events.device_detail`, added by the device
plane work. Re-provisioning after this migration applied the stale matrix and
broke the print-job detail read. The column is now allow-listed with its reason.
This is the "re-run provision and verify after every migration" trap the handoff
warns about, working exactly as intended.

**A self-review of the diff raised two things, both tightened rather than
argued away.** Neither was exploitable; both were the kind of loose end that
becomes one later.

The invitation key-enrolment route parsed a `code` it never checked — the
ceremony identifier is server-issued and bound to the account, and
`completeRegistration` re-checks a live invitation inside its transaction, so
the guarantee held without it. It now verifies the code names the same account,
so a leaked ceremony identifier finishes nothing on its own.

And `reissueInvitation` answered 403 for a target whose role the caller may not
invite, against 404 for one that does not exist. Both answer 404 now, matching
the reset path and the people module: the difference between "no such account"
and "an account you may not reach" is not one the panel should disclose, even to
an authenticated Admin holding an unguessable identifier.

**One design decision is worth naming rather than burying.** A privileged
account may unlock a locked session with its password, not only with its key.
That is deliberate: the lock exists to keep a walked-up stranger out of an
unattended browser, and somebody who has both the cookie and the password gets
back only what a live session already had — reads. Every R2 action still demands
the key, and `admin-authentication.test.ts` asserts a privileged account cannot
step up with a password. Requiring a key to unlock would have reintroduced the
lockout this phase exists to end.

### 4.3 Known gaps

1. **No rate limit tuning was done for password guessing beyond a bucket.** Ten
   login attempts a minute per address. The real defence is Argon2id and the
   256-bit codes; a determined attacker with many addresses is not bounded by
   this. Account lockout was deliberately not added — it is a denial-of-service
   against ten known usernames.
2. **Usernames were backfilled from display names.** Existing accounts got a
   slug, or a slug plus an id fragment on collision. `pnpm db:admin set-username`
   renames. Worth doing before anybody tries to sign in.
3. **The invitation ledger has no expiry sweep.** Expired rows stay. They are
   inert and the unique index only constrains live ones, so this is untidiness
   rather than a leak.
4. **Break-glass still burns its code at ceremony start.** The invitation flow
   fixed this for onboarding; recovery keeps the old behaviour deliberately,
   because a code that survives a failed attempt is a code that can be retried
   by whoever saw it. The failure copy improvement offered in an earlier session
   is still not taken.
5. **`kiosk.maintenance_mode`, `payment.mismatch.read`, `kiosk.liveness.read`
   and `pricing.read` still gate nothing.** Unchanged from Phase 6 §7 item 10.

---

## 5. Printing performance impact

None. No route in this phase touches a print, payment, document or session row,
and no query added here runs on the product's connection. The three new tables
are read only by the identity paths and by the people roster, which was already
one bounded query per screen.

Login costs one Argon2id derivation (64 MiB, ~50ms) on the API process. At ten
users this is invisible; it is worth knowing that it is memory-hard, so a login
storm is a memory question rather than a CPU one.

---

## 6. Setup

New environment variables, all with defaults:

```
ADMIN_SESSION_IDLE_MINUTES_OPERATOR=360
ADMIN_SESSION_IDLE_MINUTES_ADMIN=120
ADMIN_SESSION_IDLE_MINUTES_TECHNICAL_ADMIN=60
ADMIN_SESSION_ABSOLUTE_HOURS_OPERATOR=720
ADMIN_SESSION_ABSOLUTE_HOURS_ADMIN=336
ADMIN_SESSION_ABSOLUTE_HOURS_TECHNICAL_ADMIN=168
ADMIN_INVITATION_TTL_HOURS=72
ADMIN_PASSWORD_RESET_TTL_MINUTES=60
```

`ADMIN_SESSION_IDLE_MINUTES` and `ADMIN_SESSION_ABSOLUTE_MINUTES` are gone.

Deploying:

```bash
ADMIN_OWNER_DATABASE_URL=... pnpm db:migrate:owner
pnpm db:admin-owner provision && pnpm db:admin-owner verify
# then all five least-privilege roles, provision and verify
```

Existing accounts keep their keys and get a backfilled username and no password,
which means **they cannot sign in until somebody issues them a reset**. For an
existing Technical Admin:

```bash
pnpm db:admin list                                     # find the id and username
pnpm db:admin invite --admin-user <uuid>               # if still PROVISIONING
pnpm db:admin reset-password --admin-user <uuid>       # if ACTIVE
```

A first Technical Admin on an empty system:

```bash
pnpm db:admin bootstrap-technical-admin --name "Ada" --username ada
```

---

## 7. What remains

The five items in Phase 6 §8 are all still open and unchanged — nothing settles
a refund, how the built admin app is served, concurrent load, the panel
replacement, and the four dead capabilities. Nothing in this phase touched any
of them.

Specific to this phase:

1. **Give the existing accounts passwords** (§6). Nobody can sign in until this
   is done, and it is the first thing to do after deploying.
2. **Decide whether Operators should be able to enrol a key at all.** They can
   today — it is optional and unused by the login path, which is either a
   harmless affordance or a confusing one.
3. **The 25 pre-existing formatting warnings** in the device and telemetry work
   are untouched, so `pnpm format:check` still fails. Not this phase's to fix,
   but it will keep failing until somebody does.
