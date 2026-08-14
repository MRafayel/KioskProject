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
  "people",
  "security-keys"
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
  "security-keys": "authenticator.manage.self"
};

/**
 * A section, plus any opening filter for it.
 *
 * Every field is optional and every panel ignores the ones that are not its
 * own, so adding a filter later does not force a change at each call site.
 */
export interface AdminDestination {
  section: AdminSectionId;
  /** Preselects the print job status filter. */
  printStatus?: string;
  /** Preselects the session state filter. */
  sessionState?: string;
  /** False opens retention on every run rather than only the failures. */
  retentionProblemsOnly?: boolean;
  /** Puts the money owed back at the top, above the payment ledger. */
  moneyFocus?: "refunds";
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
    destination.printStatus ?? null,
    destination.sessionState ?? null,
    destination.retentionProblemsOnly ?? null,
    destination.moneyFocus ?? null
  ]);
}
