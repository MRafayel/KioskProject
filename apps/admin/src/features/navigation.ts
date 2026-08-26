import { createContext, useContext } from "react";

import type { AdminCapability } from "@printing-kiosk/admin-access";

/**
 * Moving between sections, carrying the reason you moved.
 *
 * The overview exists to be left. A count only earns its place there if a
 * person who sees a number can reach the rows behind it, and reaching them
 * should not mean opening another section and rebuilding the filter by hand —
 * the moment between noticing and looking is exactly where a busy operator
 * gives up.
 *
 * So a destination is a section plus the filter that made it worth visiting,
 * and the panels below accept that filter as their opening state.
 */

export const ADMIN_SECTION_IDS = [
  "overview",
  "kiosks",
  "sessions",
  "printing",
  "money",
  "retention",
  "errors",
  "audit",
  "changes",
  // Not in the rail. People and Security are reached through the account area,
  // and the account area is reached by pressing your own name — see `account`.
  "people",
  "security-keys",
  "account"
] as const;

export type AdminSectionId = (typeof ADMIN_SECTION_IDS)[number];

/**
 * What each section needs before it may be shown or navigated to.
 *
 * Held here rather than only in the shell so that a link can ask the question
 * before it is drawn. Hiding a link the server would refuse is a courtesy, not
 * a boundary — the refusal is still the authority — but offering a person a
 * door that opens onto a permission error is its own small cruelty.
 */
export const SECTION_CAPABILITY: Readonly<Record<AdminSectionId, AdminCapability>> = {
  overview: "dashboard.read",
  kiosks: "kiosk.read",
  sessions: "session.read",
  printing: "print.read",
  money: "payment.read",
  retention: "document.retention.read",
  errors: "error.read",
  audit: "audit.read.self",
  // Read, not write. A Technical Admin holds this and not `pricing.publish`, so
  // it finds the section present and the form absent — which is the right answer
  // for a support role: what the prices did, and when, is a diagnostic question,
  // and changing them is not its job.
  changes: "change.read",
  // The same shape again. A Technical Admin holds `operator.read` and not
  // `operator.manage`, so it reaches the roster it may issue an enrolment ticket
  // against and finds the status and kiosk controls absent, because those are
  // drawn from the other one. Phase 6 moved this off
  // `authenticator.manage.operator`: that capability is R2, so gating a screen
  // on it made opening the section demand a security key.
  people: "operator.read",
  // The Security section is mostly reads — your sessions, your keys — so it is
  // gated on the R0 read every role holds, for the same reason People moved to
  // `operator.read` in Phase 6: opening a screen must never demand a ceremony.
  "security-keys": "account.sessions.read",
  // Nominal only — see `UNGATED_SECTIONS`. Kept in the table so every id has an
  // entry and the record type stays exhaustive.
  account: "account.sessions.read"
};

/**
 * Sections every signed-in account may open, whatever it holds.
 *
 * There is exactly one, and the reason is that it makes no request. The profile
 * tab renders from the identity the browser is already holding — the same
 * object that decided which sections to draw — so there is no call for the
 * server to refuse and nothing for a capability to protect. Gating it would be
 * theatre with a real cost: an account without the grant could not find out who
 * it is signed in as or when that sign-in ends.
 *
 * The People and Security tabs inside the area are gated normally and disappear
 * individually. The area itself does not.
 */
export const UNGATED_SECTIONS = new Set<AdminSectionId>(["account"]);

/** Whether a role may open a section at all. */
export function canOpenSection(
  section: AdminSectionId,
  can: (capability: AdminCapability) => boolean
): boolean {
  return UNGATED_SECTIONS.has(section) || can(SECTION_CAPABILITY[section]);
}

/**
 * A section, plus any opening filter for it.
 *
 * Every field is optional and every panel ignores the ones that are not its
 * own, so adding a filter later does not force a change at each call site.
 */
export interface AdminDestination {
  section: AdminSectionId;
  /** Preselects one fleet-health card. */
  kioskFilter?: "OFFLINE" | "DEGRADED" | "RECOVERY" | "PRINTER" | "ONLINE";
  /** Preselects the print job status filter. */
  printStatus?: string;
  /** Opens Printing on the unresolved recovery worklist. */
  printUnresolvedOnly?: boolean;
  /** Preselects the session state filter. */
  sessionState?: string;
  /** Opens Retention on one explicit, synchronized card/filter. */
  retentionFilter?: "PROBLEMS" | "GAVE_UP" | "OVERDUE" | "PENDING" | "ALL";
  /** Puts the money owed back at the top, above the payment ledger. */
  moneyFocus?: "refunds";
  /** Which part of the account area to open on. */
  accountTab?: AccountTabId;
}

/**
 * The sections inside the account area.
 *
 * Profile is the signed-in account itself and every role has one. People and
 * Security are the two former top-level sections, unchanged in what they do and
 * moved here because both answer a question about accounts rather than about
 * printing — which is the distinction the rail had stopped making.
 */
export const ACCOUNT_TAB_IDS = ["profile", "people", "security"] as const;

export type AccountTabId = (typeof ACCOUNT_TAB_IDS)[number];

/**
 * What each tab needs, reusing the capabilities the two sections already had.
 *
 * Moving a screen must not change who may open it: these are the same grants
 * that gated People and Security in the rail, so a Technical Admin sees exactly
 * what it saw before, in a different place.
 *
 * Profile has no entry, and that is the point rather than an omission. It draws
 * the identity the browser is already holding and makes no request, so there is
 * nothing for a capability to protect — and an account that could not open it
 * would have no way to see who it is signed in as. Absent means ungated.
 */
export const ACCOUNT_TAB_CAPABILITY: Readonly<Partial<Record<AccountTabId, AdminCapability>>> = {
  people: SECTION_CAPABILITY.people,
  security: SECTION_CAPABILITY["security-keys"]
};

/** Whether a role may open one tab of the account area. */
export function canOpenAccountTab(
  tab: AccountTabId,
  can: (capability: AdminCapability) => boolean
): boolean {
  const capability = ACCOUNT_TAB_CAPABILITY[tab];
  return capability === undefined || can(capability);
}

export type NavigateToAdminSection = (destination: AdminDestination) => void;

export const NavigationContext = createContext<NavigateToAdminSection>(() => {
  // The shell always provides one. This exists so a panel rendered in a test
  // without the shell does not have to stub navigation to render at all.
});

export function useAdminNavigation(): NavigateToAdminSection {
  return useContext(NavigationContext);
}

/**
 * A stable string for one destination, used to remount a panel when the reason
 * for visiting it changes.
 *
 * Panels take their filter as opening state. Without this, arriving at
 * Printing a second time — from a different count, wanting a different
 * filter — would leave the first filter in place and quietly show the wrong
 * rows under the right heading.
 */
export function destinationKey(destination: AdminDestination): string {
  return JSON.stringify([
    destination.section,
    destination.kioskFilter ?? null,
    destination.printStatus ?? null,
    destination.printUnresolvedOnly ?? null,
    destination.sessionState ?? null,
    destination.retentionFilter ?? null,
    destination.moneyFocus ?? null,
    destination.accountTab ?? null
  ]);
}
