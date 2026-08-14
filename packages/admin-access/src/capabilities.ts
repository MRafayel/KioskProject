/**
 * What a human may do in the control plane.
 *
 * This module is pure: no clock, no randomness, no database, no HTTP. The API
 * enforces it on every privileged request and the admin UI reads it only to
 * decide what to draw. Keeping it here — rather than in `@printing-kiosk/domain`
 * — honours the existing decision that admin concepts do not couple into the
 * kiosk or public bundles.
 *
 * Two rules shape everything below. Authorization is default-deny: a capability
 * that is not explicitly granted to a role does not exist for that role, and
 * there is no wildcard, no "superuser", and no role that is a superset of every
 * other. And frontend visibility is never authorization: the same
 * `hasCapability` call that hides a button must be made again on the server
 * before the action it names is allowed to happen.
 */

/**
 * The three operational layers.
 *
 * **Admin is the operational authority.** Running the business — money, people,
 * kiosks, pricing — is an Admin's job, and an Admin does not need anybody else's
 * agreement to do it. **Technical Admin is a support role**: deep diagnostics,
 * troubleshooting and recovery, for the problems an Admin cannot resolve from
 * the operational surface. It is not a second operator and not a co-approver.
 *
 * Deliberately not a hierarchy. A Technical Admin cannot suspend an account,
 * decide which kiosks an Operator works on, move money or change a tariff; an
 * Admin cannot see the deep diagnostics a Technical Admin can. Neither role
 * contains the other, which is what keeps one compromised account from being
 * enough — but the asymmetry is a boundary, not a workflow. Nothing routine
 * requires both.
 */
export const ADMIN_ROLES = ["OPERATOR", "ADMIN", "TECHNICAL_ADMIN"] as const;

export type AdminRole = (typeof ADMIN_ROLES)[number];

export function isAdminRole(value: string): value is AdminRole {
  return (ADMIN_ROLES as readonly string[]).includes(value);
}

/**
 * Roles that hold capabilities able to change production, move money, or grant
 * access. They carry the stricter authenticator rules in `authenticators.ts`.
 */
export const PRIVILEGED_ADMIN_ROLES: readonly AdminRole[] = ["ADMIN", "TECHNICAL_ADMIN"];

export function isPrivilegedRole(role: AdminRole): boolean {
  return PRIVILEGED_ADMIN_ROLES.includes(role);
}

/**
 * Every capability the control plane recognises.
 *
 * Phase 1 implements only the identity and audit entries; the rest are declared
 * here so the matrix is reviewable as one object rather than accumulating
 * silently across later phases. A capability with no endpoint behind it grants
 * nothing.
 *
 * Names absent from this list on purpose, and to stay absent: anything naming
 * SQL, a shell, arbitrary code, an environment variable, a secret, a printer or
 * terminal command, a kiosk credential, or document contents.
 */
export const ADMIN_CAPABILITIES = [
  "dashboard.read",

  "kiosk.read",
  "kiosk.liveness.read",
  "kiosk.maintenance_mode",

  "session.read",
  "session.timeline.read",

  /** Counts, sizes, MIME types, states and timestamps. Never document bytes. */
  "document.metadata.read",
  "document.retention.read",
  "document.retention.retry",

  "print.read",
  "print.diagnostics.read",
  /** Records what a person observed. Cannot move money — see `refund.authorize`. */
  "print.recovery.resolve",
  /**
   * Superseding somebody else's recorded observation with a corrected one.
   *
   * Deliberately not held by the role that records observations. An account
   * that could rewrite its own account of a paid print could launder a failure
   * into a success; correcting one is therefore an act of higher authority,
   * and it appends a new fact rather than editing the original.
   */
  "print.recovery.correct",

  "payment.read",
  "payment.reconcile.read",
  "payment.mismatch.read",
  "refund.obligation.read",
  /** The only capability that can create or settle a monetary obligation. */
  "refund.authorize",

  "error.read",
  "incident.acknowledge",

  "audit.read",
  /** Reading only one's own actions, for a role not trusted with the full log. */
  "audit.read.self",

  "pricing.read",
  /**
   * Publishing a new tariff, which changes what every future customer is charged
   * at every kiosk from the moment it commits.
   *
   * The widest-reaching act an Admin can perform, and the reason it is still a
   * single-Admin action is that this system has one Admin: a rule that waited for
   * a second one would not be a control, it would be a stoppage. What carries the
   * weight instead is evidence — a confirmation digest that must match what was
   * previewed, and a publication record the database refuses to publish without.
   */
  "pricing.publish",

  /** Reading the change log: what the prices did, and when. */
  "change.read",

  /**
   * The Operator roster: who exists, whether they can sign in, which kiosks
   * they cover, and whether a key or a ticket is outstanding.
   *
   * Added in Phase 6 to fix a defect rather than to widen anything. The roster
   * was gated on `authenticator.manage.operator`, which is R2 — so reading a
   * screen demanded a fresh WebAuthn assertion, and five minutes after signing
   * in the section stopped loading at all. Nothing about who may see it changed:
   * the two roles that held the R2 capability hold this one.
   *
   * The general rule it restores is worth more than the fix: a GET names an R0
   * capability, and a capability that can change something is never what gates a
   * read. `admin-security.test.ts` asserts it for every route.
   */
  "operator.read",
  /**
   * Administering Operator accounts: status and kiosk assignment.
   *
   * Never Technical Admin accounts, and never an account's role — an account
   * holds the role it was created with, so no capability here can promote
   * anybody, including its holder.
   */
  "operator.manage",
  /** Enrolling and revoking one's own authenticators. */
  "authenticator.manage.self",
  /**
   * An Operator's authenticators: issuing the ticket that lets them enrol their
   * first one, and retiring one afterwards.
   *
   * It cannot enrol a key on somebody else's behalf, because WebAuthn will not
   * let it: enrolment needs the person and their device. What it can do is
   * authorise one enrolment ceremony on one named account.
   */
  "authenticator.manage.operator"
] as const;

export type AdminCapability = (typeof ADMIN_CAPABILITIES)[number];

export function isAdminCapability(value: string): value is AdminCapability {
  return (ADMIN_CAPABILITIES as readonly string[]).includes(value);
}

/**
 * The capability grant for each role.
 *
 * Read this table as the authorization policy: it is the whole of it. If a
 * capability is not listed under a role, no endpoint may accept that role for
 * it, whatever the UI shows.
 */
const ROLE_CAPABILITIES: Readonly<Record<AdminRole, readonly AdminCapability[]>> = {
  /**
   * Routine kiosk operations and support. Sees what is happening and can
   * record what they observed; cannot change configuration, cannot move money,
   * cannot reach any account but their own.
   */
  OPERATOR: [
    "dashboard.read",
    "kiosk.read",
    "kiosk.liveness.read",
    "session.read",
    "session.timeline.read",
    "document.metadata.read",
    "document.retention.read",
    "print.read",
    "print.recovery.resolve",
    "payment.read",
    "error.read",
    "incident.acknowledge",
    "audit.read.self",
    "authenticator.manage.self"
  ],

  /**
   * The operational authority. Every legitimate business workflow, plus the
   * people who perform them: money, kiosks, retention, accounts, and the tariff.
   *
   * It publishes the tariff on its own authority, because there is one Admin and
   * making the prices wait for a second one would stop the business rather than
   * protect it. What it cannot do is see deep diagnostics, which is the one thing
   * the support role is for.
   */
  ADMIN: [
    "dashboard.read",
    "kiosk.read",
    "kiosk.liveness.read",
    "kiosk.maintenance_mode",
    "session.read",
    "session.timeline.read",
    "document.metadata.read",
    "document.retention.read",
    "document.retention.retry",
    "print.read",
    "print.recovery.resolve",
    "print.recovery.correct",
    "payment.read",
    "payment.reconcile.read",
    "payment.mismatch.read",
    "refund.obligation.read",
    "refund.authorize",
    "error.read",
    "incident.acknowledge",
    "audit.read",
    "audit.read.self",
    "pricing.read",
    "pricing.publish",
    "change.read",
    "operator.read",
    "operator.manage",
    "authenticator.manage.self",
    "authenticator.manage.operator"
  ],

  /**
   * Deep technical visibility, for the problems an Admin cannot resolve from the
   * operational surface. A support role, not a second operator.
   *
   * It cannot publish a tariff. Pricing is an operational decision, and putting
   * the support role anywhere in that path — as an approver, a fallback, or a
   * second pair of hands — would make it load-bearing for business as usual. It
   * reads the change log, because "what did the prices do at 14:03" is a
   * diagnostic question.
   *
   * **It cannot move money.** `refund.authorize` was granted here in Phase 4,
   * when the plan still made Technical Admin a co-approver of production change.
   * That model is gone, and Phase 6 removed the grant with it on the owner's
   * decision: authorizing a payout is the operational authority's act, and a
   * support role holding it meant a single compromised support account could
   * cost money. It still reads `refund.obligation.read`, because "why is this
   * obligation outstanding" is a diagnostic question and answering it moves
   * nothing.
   *
   * Three capabilities below are operational rather than diagnostic and were
   * kept deliberately at the same decision. `print.recovery.correct` and
   * `document.retention.retry` are recovery work — a dead-lettered cleanup means
   * customer documents that should not exist still do, and an Admin who has to
   * be woken up to press retry is a worse answer than a support role that can.
   * Neither can cause a payout: correcting an observation appends a fact, and
   * `refund.authorize` is what turns any of it into money.
   *
   * It holds one capability over people, and the boundary around it is the
   * point. `authenticator.manage.operator` lets it get an Operator onto their
   * first security key, and retire one, at whatever hour the system breaks — an
   * onboarding that had to wait for an Admin would be an outage with a person in
   * the middle of it. It does **not** hold `operator.manage`, so it cannot
   * suspend an account, resume one, or change which kiosks an Operator may act
   * on; and there is no capability anywhere that changes an account's role, so
   * this cannot become a promotion.
   *
   * The residual risk is stated rather than hidden: a compromised Technical
   * Admin can put a key it controls on a provisioning Operator account and act
   * as that person. It gains no capability by doing so — every Operator
   * capability is already in this list — but it does gain a second name to act
   * under, so both halves of that ceremony are audited and the panel shows the
   * account's live tickets to anyone who can see the section.
   */
  TECHNICAL_ADMIN: [
    "dashboard.read",
    "kiosk.read",
    "kiosk.liveness.read",
    "kiosk.maintenance_mode",
    "session.read",
    "session.timeline.read",
    "document.metadata.read",
    "document.retention.read",
    "document.retention.retry",
    "print.read",
    "print.diagnostics.read",
    "print.recovery.resolve",
    "print.recovery.correct",
    "payment.read",
    "payment.reconcile.read",
    "payment.mismatch.read",
    "refund.obligation.read",
    "error.read",
    "incident.acknowledge",
    "audit.read",
    "audit.read.self",
    "pricing.read",
    "change.read",
    "operator.read",
    "authenticator.manage.self",
    "authenticator.manage.operator"
  ]
};

export function capabilitiesForRole(role: AdminRole): readonly AdminCapability[] {
  return ROLE_CAPABILITIES[role];
}

export function hasCapability(role: AdminRole, capability: AdminCapability): boolean {
  return ROLE_CAPABILITIES[role].includes(capability);
}

/**
 * How much re-proving an action needs before it may run.
 *
 * R0 is answered by a live session alone. Everything above it requires a fresh
 * WebAuthn assertion, because a stolen cookie must not be enough to change
 * anything.
 *
 * R3 is not expressible as a capability check at all: it means "no one account
 * may do this alone", and no account can prove that about itself. Nothing is
 * classified R3, and the class is kept rather than deleted so that it stays a
 * backstop: `authorizeAdmin` refuses an R3 capability outright, so if a future
 * capability is classed R3 the endpoint naming it fails closed instead of
 * quietly running as a single-account action.
 *
 * Publishing a tariff was the one candidate, and it is R2. This deployment has a
 * single Admin, so a two-person rule over the prices would not be a control — it
 * would be a workflow that never completes. What stands in for the second person
 * is evidence rather than prevention: see `changes.ts`.
 */
export type ActionRisk = "R0" | "R1" | "R2" | "R3";

/**
 * The risk of every capability.
 *
 * Read-only capabilities are written out as R0 instead of falling through to a
 * permissive default. That makes this record an authorization review gate: a
 * newly declared capability cannot compile until somebody deliberately assigns
 * its risk.
 */
const CAPABILITY_RISK: Readonly<Record<AdminCapability, ActionRisk>> = {
  "dashboard.read": "R0",

  "kiosk.read": "R0",
  "kiosk.liveness.read": "R0",
  "kiosk.maintenance_mode": "R2",

  "session.read": "R0",
  "session.timeline.read": "R0",

  "document.metadata.read": "R0",
  "document.retention.read": "R0",
  "document.retention.retry": "R1",

  "print.read": "R0",
  "print.diagnostics.read": "R0",
  "print.recovery.resolve": "R2",
  "print.recovery.correct": "R2",

  "payment.read": "R0",
  "payment.reconcile.read": "R0",
  "payment.mismatch.read": "R0",
  "refund.obligation.read": "R0",
  "refund.authorize": "R2",

  "error.read": "R0",
  "incident.acknowledge": "R1",

  "audit.read": "R0",
  "audit.read.self": "R0",

  "pricing.read": "R0",
  // The same class as authorizing a refund, and for the same reason: a single
  // Admin performs it, a fresh assertion is required, and the record of it is
  // append-only. Its reach is wider than a refund's, which is why the database
  // refuses to publish a tariff that no record accounts for.
  "pricing.publish": "R2",

  "change.read": "R0",

  // A read, and therefore R0. It was the roster's gate being an R2 capability
  // that made a screen ask for a security key, so this is the correction rather
  // than a new power: see the note beside the declaration.
  "operator.read": "R0",
  "operator.manage": "R2",
  "authenticator.manage.self": "R2",
  "authenticator.manage.operator": "R2"
};

export function riskOfCapability(capability: AdminCapability): ActionRisk {
  return CAPABILITY_RISK[capability];
}

/** Whether an action at this risk needs a fresh WebAuthn assertion. */
export function requiresStepUp(risk: ActionRisk): boolean {
  return risk === "R2" || risk === "R3";
}
