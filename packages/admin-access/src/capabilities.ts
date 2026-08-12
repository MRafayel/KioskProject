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
 * Deliberately not a hierarchy. An Admin cannot propose technical changes, and a
 * Technical Admin cannot suspend an account or decide which kiosks an Operator
 * works on, so neither role contains the other. That asymmetry is what keeps one
 * compromised account from being enough.
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
  "pricing.publish.request",

  "change.propose",
  "change.approve.technical",
  "change.approve.admin",

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
   * Most legitimate operational workflows, plus the people who perform them.
   * Holds the money-moving capability and the approval side of serious change,
   * but cannot propose technical change and cannot see deep diagnostics.
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
    "change.approve.admin",
    "operator.manage",
    "authenticator.manage.self",
    "authenticator.manage.operator"
  ],

  /**
   * Deep technical visibility and the proposing side of serious change.
   *
   * It holds exactly one capability over people, and the boundary around it is
   * the point. `authenticator.manage.operator` lets it get an Operator onto
   * their first security key, and retire one, at whatever hour the system
   * breaks — an onboarding that had to wait for an Admin would be an outage
   * with a person in the middle of it. It does **not** hold `operator.manage`,
   * so it cannot suspend an account, resume one, or change which kiosks an
   * Operator may act on; and there is no capability anywhere that changes an
   * account's role, so this cannot become a promotion.
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
    "refund.authorize",
    "error.read",
    "incident.acknowledge",
    "audit.read",
    "audit.read.self",
    "pricing.read",
    "pricing.publish.request",
    "change.propose",
    "change.approve.technical",
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
 * anything. R3 is not expressible as a capability check at all — it needs two
 * further people — so it is marked here and refused by the endpoint until the
 * approval workflow exists.
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
  "pricing.publish.request": "R3",

  "change.propose": "R3",
  "change.approve.technical": "R3",
  "change.approve.admin": "R3",

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
