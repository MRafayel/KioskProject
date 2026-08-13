# Admin control plane — Phase 5 status

Publishing a tariff. The last operational surface the control plane was missing,
and the widest-reaching thing anybody can do from it: every other admin action is
bounded to one print, one obligation, one session or one colleague, and this one
changes what every future customer is charged at every kiosk, invisibly to the
person paying.

Phase 0 §22's fifth row asked for a three-person approval workflow —
propose, a second Technical Admin, then an Admin. **That is not what was built,
and the difference is the whole phase.** Two owner decisions arrived mid-flight
and reshaped it, both recorded in `ADMIN_PHASE_0.md` §23.4 and §23.5:

1. **Admin is the operational authority; Technical Admin is support.** Nothing
   routine may require both.
2. **There is one Admin.** A rule requiring a second is not a control, it is a
   stoppage.

Together they remove the second person entirely. What is here instead is not a
weaker version of the same idea — it is a different one. A second approver would
have **prevented** a bad publication. This phase makes one impossible to perform
quietly, to perform differently from what was reviewed, or to disown afterwards,
and it enforces all three in PostgreSQL rather than in this repository.

The accepted risk is stated at the top rather than buried in §4, because it
should be: **a compromised Admin session can change the prices.** What it cannot
do is change them without leaving a record it is unable to alter.

---

## 1. What was implemented

### 1.1 The shape: preview, confirm, publish — one transaction

```
POST /v1/admin/changes/preview    change.read       writes nothing
POST /v1/admin/changes            pricing.publish   R2, step-up, atomic
GET  /v1/admin/changes            change.read       the log + tariff in force
```

There is no proposal, no pending state, no approval queue and no state column. A
change is written by the request that performs it, so a row in
`admin_change_executions` is a past tense — nothing has to advance a state
machine, and nothing can fail to.

The preview is the review step, and it is load-bearing rather than decorative.
It prices four representative jobs with `calculateQuote` — the same pure function
the kiosk quotes with, so an Admin sees the money rather than the basis points —
and returns two digests. Publishing requires echoing both back:

- **`payloadDigest`** is recomputed from the payload on arrival. It differs only
  if the form changed after the preview, which is exactly the case worth
  refusing: the numbers on screen are not the numbers being published.
- **`baselineDigest`** is compared against the tariff actually in force. It
  differs only if the prices moved in between — a second tab, another session —
  and that is a refusal rather than a publication on top of numbers nobody
  compared against.

Confirming a set of basis points nobody has multiplied out is how a review
becomes a rubber stamp, so the panel cannot offer to publish until the preview
has answered, and editing any field clears it.

### 1.2 The canonical digest, computed identically in two languages

`canonicalPricingPublishText` in `@printing-kiosk/admin-access` and
`pricing_rule_sets_canonical_text` in SQL must produce byte-identical output.
Four lines, fixed order, no optional fields, no floating point, and a separator
(`|`) none of the values can contain:

```
pricing.publish/v1
version=price-v3
scope=GLOBAL|ref=|currency=AMD|exponent=2|rounding=HALF_UP|tax=EXCLUSIVE|minimum=BEFORE_TAX
rule=PRINT|A4|MONOCHROME|5000|-1000|0|10000|2000|0
```

The format is versioned in its own first line so a v2 is a new line rather than a
silent reinterpretation of the rows a v1 record accounts for. The currency,
exponent and the three policy fields come from the tariff being replaced and are
**not** in the request — a tariff change that could redenominate the money would
make every historical price mean something else.

Both halves are asserted: the exact bytes in a unit test, and a real round trip
in the integration suite comparing what SQL computes from the written rows
against what the record carries.

### 1.3 What the database refuses, regardless of this repository

`admin_change_executions` is append-only by trigger — no UPDATE, no DELETE, no
TRUNCATE, for every role **including the table's owner**. A record of what the
prices did that could be rewritten afterwards is not a record.

Two deferred constraint triggers, one on `pricing_rule_sets` and one on
`pricing_rules`, both `DEFERRABLE INITIALLY DEFERRED` and both firing only when
`current_user` is the pricing role. At COMMIT they recompute the tariff's
canonical digest **from the rows actually written** and refuse unless a record
names that rule set with that digest. Deferred because the record has to be
written after the tariff it names, and the rules after the set they belong to —
at COMMIT there is no ordering left to excuse a missing record or a half-written
tariff. Three things this closes:

- publishing a tariff no record accounts for (`restrict_violation`);
- publishing something other than what was confirmed (`restrict_violation`);
- leaving a draft behind (`insufficient_privilege`) — a draft is a step inside
  the transaction, never a state a committed row rests in.

A third trigger bounds the pricing role's UPDATE to exactly two transitions,
`DRAFT → PUBLISHED` and `PUBLISHED → ARCHIVED`. Everything else is refused, so an
archived tariff cannot be brought back into force.

An insert trigger re-reads the acting account inside the transaction and refuses
any row not naming an **active Admin** — the role on the account row, not the one
the session presented. A check constraint says the same thing statically, so the
separation survives an endpoint that forgets which capability it meant to
require.

### 1.4 The publication order, which the schema dictates

A publication is four inserts and two updates in one transaction:

```
INSERT pricing_rule_sets      status DRAFT, published_at already set
INSERT pricing_rules          the numbers — only attachable while it is a draft
UPDATE pricing_rule_sets      the incumbent → ARCHIVED   (conditional)
UPDATE pricing_rule_sets      the draft     → PUBLISHED  (conditional)
INSERT admin_change_executions
INSERT audit_events
```

The draft step is not a design choice, it is the order
`20260801020000_harden_published_tariffs` established last year and this phase
kept: `pricing_rules_immutable_when_published` refuses a rule added to an
already-published set, which is the guarantee that a published tariff's numbers
never change after the fact. Inserting the set as
`PUBLISHED` in one statement would have meant weakening that trigger, which is
worth more than the convenience. (This was found the hard way — see §4.2.)

Both updates are `updateMany` with the predicate they were authorized against,
and the row count is the answer: `count !== 1` means the world moved and the
transaction rolls back. `published_at` is written by the insert that creates the
draft rather than by the publishing update, because the role holds no grant on
that column — a publication cannot arrive undated even if this code tried.

The archival lands before the publication because the published-per-scope unique
index permits exactly one, and `validFrom` is the commit instant because the
quote path answers "no tariff covers now" with a 503. There is no window in which
a kiosk cannot sell.

### 1.5 The pricing role — `printing_kiosk_admin_pricing_writer`

The fifth least-privilege connection, and the only one that can change what a
customer will be charged. `admin-pricing-writer-matrix.mjs` states the grants;
four properties are worth naming because each is something a compromised admin
backend holding this credential **cannot** do:

- **Publish without recording who did.** The deferred triggers above.
- **Edit a tariff.** UPDATE is held on three columns of `pricing_rule_sets` —
  `status`, `archived_at`, `updated_at` — and on nothing else anywhere. Amounts,
  currency, version and validity are unreachable once written.
- **Rewrite or remove the record.** No UPDATE and no DELETE on
  `admin_change_executions`; the missing grant refuses it before the trigger
  gets the chance.
- **Touch a quote or a payment.** `price_quotes` is not merely unwritable, it is
  unreadable: a quote is what a named customer was told they would pay and the
  evidence their payment is checked against. A new tariff does not reach
  backwards.

The role shares `admin-column-role.mjs` with the people role — both are defined
by a column list rather than by the absence of one — which is the duplication
Phase 4B flagged as a cost, now paid off.

### 1.6 Capabilities

Net −1 capability, which is the right direction for a phase that adds a feature.

| Capability        | Risk | Operator | Admin | Technical Admin |
| ----------------- | ---- | -------- | ----- | --------------- |
| `change.read`     | R0   | ❌       | ✅    | ✅              |
| `pricing.publish` | R2   | ❌       | ✅    | ❌              |

`pricing.publish.request`, `change.propose`, `change.approve.technical` and
`change.approve.admin` are gone. Reading the log is R0 for both privileged roles,
because "what did the prices do at 14:03" is a diagnostic question. The preview
sits on `change.read` deliberately: it writes nothing, discloses nothing
`pricing.read` does not already, and a support role modelling "what would this
do" is diagnostics.

`authorizeAdmin` is unchanged in shape — publishing is R2, so it goes through the
ordinary door with a fresh WebAuthn assertion, exactly like authorizing a refund.
The `authorizeAdminChangeStep` gate written for the two-person design was removed
rather than left unused.

### 1.7 Schema, read side, and the panel

One model, `AdminChangeExecution`, and one migration,
`20260812010000_admin_phase5_pricing_publication`. The read pool gains
`adminChangeExecution`, `pricingRuleSet` and `pricingRule` — reading the log is a
read like any other, so it runs on the read role rather than widening the one
that publishes for the sake of a screen.

The panel is deliberately plain, per the owner's instruction that this build's UI
is temporary: the tariff in force, a form, the priced-out preview, a publish
button, and the log. Two behaviours in it are load-bearing rather than cosmetic
and should survive whatever replaces it — publishing is unavailable until the
change has been priced out, and editing any field clears the preview. The server
refuses both cases anyway; the panel only avoids offering something it will be
told no for.

---

## 2. New dependencies

**None.** Phase 5 adds no runtime and no development dependency. The new external
artifact is one PostgreSQL role — and the phase **retires** one, the
`printing_kiosk_admin_change_writer` written for the two-person design, along
with its matrix, its runner, its pool, its narrowed client surface, its
`ADMIN_CHANGE_DATABASE_URL`, and the config rules that policed it. The control
plane still has exactly one runtime dependency in total
(`@simplewebauthn/server`, justified in `ADMIN_PHASE_0.md` §13.1).

---

## 3. Verification

```
pnpm lint            25 tasks, clean
pnpm typecheck       25 tasks, clean
pnpm test            25 packages — API 103, admin-access 113, config 67, admin 29
pnpm test:integration 13 files, 286 tests
pnpm format:check    clean
```

`tests/integration/admin-changes.test.ts` — 21 tests, all on the real
least-privilege role through the real API:

- the publishing connection cannot read a quote, edit a tariff, delete one, erase
  an audit row, rewrite its own record, or un-archive;
- a tariff written with no record behind it is refused at COMMIT, **and the test
  asserts the message as well as the SQLSTATE** — several triggers on these
  tables raise `restrict_violation`, so a test matching only the code could pass
  because the wrong guarantee fired;
- a draft left behind is refused;
- a rule added after publication is refused;
- the record cannot be edited or deleted even on the application connection;
- SQL and TypeScript produce the same digest on a real round trip;
- publishing replaces the tariff in one transaction, archives the predecessor,
  names the Admin, and writes the amounts into the audit row;
- a customer is quoted the new tariff immediately;
- a publication whose numbers are not the previewed ones is refused;
- a publication written against a tariff that has since moved is refused;
- a Technical Admin is refused publishing and allowed reading and previewing;
- an Operator is refused the section entirely;
- publishing without a fresh assertion is refused;
- the trigger refuses a record naming a non-Admin, asked of PostgreSQL directly.

Role provisioning verified after the migration:

```
printing_kiosk_admin_reader: privilege matrix verified.
printing_kiosk_admin_pricing_writer: privilege matrix verified.
  3 updatable column(s) across 1 table(s), no table-level UPDATE, no DELETE.
```

---

## 4. Security review

### What this phase closes

A tariff cannot be published that no record accounts for, or that differs from
the numbers the record carries — checked by the database against the rows
actually written, not against what the application claims it wrote. The record
cannot be altered or removed by any connection in the system. The connection that
publishes cannot reach a quote, a payment, a print job, a session, or an account.
An archived tariff cannot be brought back. A published tariff's numbers cannot
change after the fact. There is no window in which no tariff covers `now`.

### 4.1 Deviations from the plan, stated deliberately

**R3 is empty, and publishing a tariff is R2.** The largest deviation, made on
the owner's explicit decision (`ADMIN_PHASE_0.md` §23.5). R3 means "no single
account may do this alone", and this deployment has one Admin: the rule would
never complete, and an Admin blocked on a colleague who does not exist finds a
way around the control plane rather than waiting. The class is kept rather than
deleted and `authorizeAdmin` still refuses every R3 capability outright, so
classifying something R3 in a future deployment fails the endpoint closed instead
of quietly running as a single-account action. That branch has no test of its
own, precisely because a unit test asserts the class is empty — inventing an R3
fixture would test the fixture rather than the policy.

**The residual risk this accepts, in plain terms.** A compromised Admin session,
within its step-up window, can publish a tariff. Nothing here prevents that.
What it produces is an append-only row naming the account, the reason, the
previous tariff, the new one, and a digest the database verified against the rows
written — plus an audit event carrying the amounts themselves rather than only a
digest, so the record reads years later without joining to a table somebody has
since replaced. Detection and attribution, not prevention. If a second Admin
account ever exists, the honest upgrade is to reinstate a two-person rule for
this one capability; the digest machinery that would need is already here.

**Technical Admin was removed from the workflow entirely.** The plan made it the
proposer and second approver. Under the owner's role model it holds `change.read`
and nothing else here: pricing is an operational decision, and putting the
support role anywhere in that path — as approver, fallback, or second pair of
hands — would make it load-bearing for business as usual.

**Four Technical Admin capabilities from Phases 4 and 4B are unchanged, and this
is an open owner decision.** `refund.authorize`, `print.recovery.correct`,
`document.retention.retry` and `authenticator.manage.operator` are operational
rather than diagnostic, and sit oddly with "support role, not a second operator".
They were left alone: narrowing them is a change to shipped, tested behaviour and
belongs to the owner rather than to a passing edit in a pricing phase. A pointer
sits in `capabilities.ts` beside the grant list. Recommendation, when it is
looked at: `refund.authorize` is the one worth removing — it moves money, and the
support role's reason to hold it was the co-approver model that no longer exists.

**One table instead of two.** `change_request` + `change_approval` (§21.7) became
`admin_change_executions`. With no second approver there is nothing to propose
_to_, so the pending state, the expiry, the supersede chain and the self-approval
trigger were all removed. What survives is the digest, and it does more work than
the plan gave it.

**One role instead of two.** The change-writer role existed so that the
connection publishing a tariff could not manufacture the agreement it acted on.
With no agreement to manufacture it had nothing to write, and keeping it would
have been exactly the bureaucracy the owner asked to remove.

**The identity triggers do not lock the account row.** Every identity-touching
trigger before this one uses `SELECT ... FOR UPDATE`. That requires UPDATE
privilege on `admin_users`, which the pricing role deliberately does not hold —
a property worth more than the lock. The race it would close is a publication
recorded in the same instant its author is suspended, and that is bounded from
both sides: suspending revokes every session, so the request would not authorize,
and the account is re-read inside the transaction that writes. The absence is
commented at each site.

**`admin-column-role.mjs` was extracted from the people-writer runner** and is now
shared by the people and pricing roles. A refactor of shipped code, made because
the second column-defined role would otherwise have been a copy of the first.

### 4.2 Defects found and fixed in existing code

**`admin-append-role.mjs` granted on migrator-owned tables using the application
connection.** GRANT requires ownership (or membership in the owning role). This
worked only because development runs the application role as a superuser, and
would have failed at provisioning time in production — where the standing
deployment gate says that role must **not** be a superuser. Fixed by splitting
the script across two connections: `DATABASE_URL` for role management,
`ADMIN_OWNER_DATABASE_URL ?? DATABASE_URL` for the GRANTs.

**The publication path was written in the wrong order** — the rule set inserted
as `PUBLISHED`, then its rule — which `pricing_rules_immutable_when_published`
correctly refused. The trigger was right and the code was wrong; §1.4 is the fix.
Worth recording because the temptation was to weaken the trigger, and the trigger
is the guarantee that a published tariff's numbers never change.

### 4.3 Known gaps

**A tariff cannot be scheduled.** Publishing takes effect at COMMIT. Anything
else needs a window in which no tariff covers `now`, and the quote path answers
that with a 503. If scheduling is ever wanted, it needs a validity-window design
that keeps continuous coverage as an invariant, not an optional field.

**Only one scope, and one rule.** `GLOBAL` with an empty scope ref, and exactly
one `PRINT`/`A4`/`MONOCHROME` rule, because that is what the schema pins. The
canonical text is built from the rules actually attached, so a second rule
changes the digest — the format is ready for more, the form is not.

**There is no rollback button.** Reinstating a previous tariff means publishing
its numbers again under a new version name, which is a publication like any other
and leaves its own record. Deliberate: un-archiving would be a way to put a
tariff back in force without a record of the decision.

**The `payload` column is `JSONB` and unvalidated at the database.** The
`payloadDigest` beside it is what anything depends on; the JSON is the
human-readable copy.

### Deliberately absent

No capability to edit a published tariff, delete one, schedule one, change the
currency, or reprice an issued quote. No way for any role to alter the change
log. No kiosk-scoped or site-scoped pricing surface. No second-person approval
anywhere in the control plane.

---

## 5. Printing performance impact

**None on the print path.** The kiosk reads the tariff through the application
connection and does not know the pricing role exists.

The publication transaction takes a row lock on the tariff the quote path reads
on every price request. It is a short lock on one row, quoting takes no
conflicting lock, and the role carries the same ceilings as every other admin
write role — `statement_timeout` 2s, `lock_timeout` 1s — so a publication that
stalled while holding it fails and rolls back rather than queueing behind itself.
Publishing happens a few times a year; the pool is two connections.

The preview computes four quotes in memory with a pure function and touches the
database once, on the read role, to fetch the tariff in force.

---

## 6. Setup

```bash
# 1. Apply the migration as the owning role
ADMIN_OWNER_DATABASE_URL=... pnpm db:migrate:owner

# 2. Provision the pricing role
ADMIN_PRICING_DATABASE_PASSWORD=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))") \
  pnpm db:admin-pricing-writer provision
pnpm db:admin-pricing-writer verify

# 3. Re-provision the reader — a new table means new SELECT grants, and
#    `verify` fails on any undecided table until it is re-run
pnpm db:admin-reader provision

# 4. Point the API at it
#    ADMIN_PRICING_DATABASE_URL=postgresql://printing_kiosk_admin_pricing_writer:...@host/db
```

`ADMIN_PRICING_DATABASE_URL` is required in production, like the refund and
people roles, and must differ from every other connection string. Without it the
API logs a warning at boot and the change routes are not registered — the panel
section is absent rather than broken.

To stop any tariff being published without touching anything else:
`pnpm db:admin-pricing-writer disable`. Quoting is unaffected and the tariff in
force stays in force.

**Removing the retired role**, if a deployment provisioned it from an earlier
build of this branch:

```sql
REASSIGN OWNED BY printing_kiosk_admin_change_writer TO printing_kiosk;
DROP OWNED BY printing_kiosk_admin_change_writer;
DROP ROLE printing_kiosk_admin_change_writer;
```

Delete `ADMIN_CHANGE_DATABASE_URL` from the environment; config validation now
ignores it.

### Standing deployment gates

- **The production application role must not be a superuser.** `admin-owner
verify` reports two known development failures — the application role is a
  superuser and holds `BYPASSRLS` — which are properties of the local Docker
  image, not of this code. In production both must be false, or every ownership
  separation in the control plane is decoration. Re-stated here because §4.2's
  first defect was hidden by exactly this.
- **`verify` fails on any undecided table**, so every migration forces every role
  to be re-provisioned before deploy. That is the mechanism, not a nuisance.

---

## 7. What remains

**For the owner.**

1. The four Technical Admin capabilities in §4.1. `refund.authorize` in
   particular.
2. Whether a second Admin account will ever exist. If so, whether publishing a
   tariff should require both — the machinery is already in place.

**For a later phase.**

3. Phase 0 §22's sixth row: hardening. Authorization matrix review per endpoint,
   IDOR, CSRF, XSS, secret leakage, query performance, audit integrity.
4. The panel replacement the owner has signalled. The business logic to preserve
   is in §1.7.
