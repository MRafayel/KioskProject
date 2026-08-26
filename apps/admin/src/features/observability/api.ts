import {
  adminChangesResponseSchema,
  adminMoneySummaryResponseSchema,
  adminErrorsResponseSchema,
  adminOverviewResponseSchema,
  adminPeopleResponseSchema,
  adminRefundQueueResponseSchema,
  previewChangeResponseSchema,
  authorizeRefundResponseSchema,
  changeAdminStatusResponseSchema,
  correctRecoveryResponseSchema,
  kioskAssignmentResponseSchema,
  publishChangeResponseSchema,
  resolveRecoveryResponseSchema,
  retryRetentionResponseSchema,
  revokeAdminSessionsResponseSchema,
  revokeOperatorAuthenticatorResponseSchema,
  type AcknowledgeIncidentBody,
  type AcknowledgeIncidentResponse,
  type AdminAuditResponse,
  type AdminDocumentsResponse,
  type AdminKiosksResponse,
  type AdminPaymentsResponse,
  type AdminPrintJobDetailResponse,
  type AdminPrintJobsResponse,
  type AdminRefundQueueResponse,
  type AdminRefundsResponse,
  type AdminRetentionResponse,
  type AdminSessionDetailResponse,
  type AdminSessionsResponse,
  type AdminTimelineResponse,
  type PreviewChangeBody,
  type PreviewChangeResponse,
  type AuthorizeRefundBody,
  type AuthorizeRefundResponse,
  type ChangeAdminStatusBody,
  type ChangeAdminStatusResponse,
  type CorrectRecoveryBody,
  type CorrectRecoveryResponse,
  type KioskAssignmentBody,
  type KioskAssignmentResponse,
  type PublishChangeBody,
  type PublishChangeResponse,
  type ResolveRecoveryBody,
  type ResolveRecoveryResponse,
  type RetryRetentionBody,
  type RetryRetentionResponse,
  type RevokeAdminSessionsBody,
  type RevokeAdminSessionsResponse,
  type RevokeOperatorAuthenticatorBody,
  type RevokeOperatorAuthenticatorResponse,
  type MoneyWindow
} from "@printing-kiosk/admin-access";

import { adminRequest, adminRequestParsed } from "../auth/api.js";

/**
 * The operational reads, and the five things a person can do.
 *
 * The mutating calls are at the bottom and there are exactly five of them. All
 * go through the same `adminRequest`, so all carry the CSRF token and all
 * surface "touch your key again" the same way every other call does.
 *
 * One of them costs money. `authorizeRefund` creates an obligation to pay a
 * customer back and its response is parsed at runtime rather than asserted as a
 * type, because a response this build believed without checking is exactly the
 * wrong thing to trust about a payout.
 */

function query(parameters: Readonly<Record<string, string | number | boolean | undefined>>) {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(parameters)) {
    if (value !== undefined && value !== "") search.set(name, String(value));
  }
  const serialized = search.toString();
  return serialized ? `?${serialized}` : "";
}

export interface ListFilters extends Record<string, string | undefined> {
  kioskId?: string | undefined;
  state?: string | undefined;
  status?: string | undefined;
  recoveryResolved?: "true" | "false" | undefined;
  cursor?: string | undefined;
}

export const observabilityApi = {
  // Parsed: every attention code on the overview is a link to somewhere, and a
  // code this build has never heard of would otherwise be drawn as raw
  // SCREAMING_SNAKE next to a button that goes nowhere useful.
  overview: () => adminRequestParsed(adminOverviewResponseSchema, "GET", "/v1/admin/overview"),
  kiosks: () => adminRequest<AdminKiosksResponse>("GET", "/v1/admin/kiosks"),

  sessions: (filters: ListFilters = {}) =>
    adminRequest<AdminSessionsResponse>("GET", `/v1/admin/sessions${query(filters)}`),
  session: (sessionId: string) =>
    adminRequest<AdminSessionDetailResponse>(
      "GET",
      `/v1/admin/sessions/${encodeURIComponent(sessionId)}`
    ),
  timeline: (sessionId: string) =>
    adminRequest<AdminTimelineResponse>(
      "GET",
      `/v1/admin/sessions/${encodeURIComponent(sessionId)}/timeline`
    ),
  documents: (sessionId: string) =>
    adminRequest<AdminDocumentsResponse>(
      "GET",
      `/v1/admin/sessions/${encodeURIComponent(sessionId)}/documents`
    ),

  printJobs: (filters: ListFilters = {}) =>
    adminRequest<AdminPrintJobsResponse>("GET", `/v1/admin/print-jobs${query(filters)}`),
  printJob: (printJobId: string) =>
    adminRequest<AdminPrintJobDetailResponse>(
      "GET",
      `/v1/admin/print-jobs/${encodeURIComponent(printJobId)}`
    ),

  /**
   * The money dashboard: one window, the window before it, and its shape.
   *
   * Parsed rather than trusted, for the same reason the refund queue is. Every
   * figure on that screen is a business reading somebody will act on or repeat —
   * an amount taken, a success rate, a change against the previous period — and
   * a response shape this build guessed at would be a percentage computed from a
   * field that was not there.
   *
   * The offset is the caller's own clock. A day boundary is a local fact and the
   * database stores instants, so the server is told where the days are rather
   * than assuming UTC and labelling somebody's Tuesday as Monday.
   */
  moneySummary: (window: MoneyWindow) =>
    adminRequestParsed(
      adminMoneySummaryResponseSchema,
      "GET",
      `/v1/admin/money/summary${query({
        window,
        utcOffsetMinutes: -new Date().getTimezoneOffset()
      })}`
    ),

  payments: (filters: ListFilters = {}) =>
    adminRequest<AdminPaymentsResponse>("GET", `/v1/admin/payments${query(filters)}`),
  refunds: (unsettledOnly: boolean, cursor?: string) =>
    adminRequest<AdminRefundsResponse>(
      "GET",
      `/v1/admin/refunds${query({ unsettledOnly, cursor })}`
    ),

  // Parsed: every row carries the money an Admin is about to act on, and the
  // ceiling the server will enforce. A shape this build guessed at is a form
  // prefilled with a number nobody computed.
  refundQueue: (cursor?: string) =>
    adminRequestParsed<AdminRefundQueueResponse>(
      adminRefundQueueResponseSchema,
      "GET",
      `/v1/admin/refund-queue${query({ cursor })}`
    ),

  retention: (problemsOnly: boolean, cursor?: string) =>
    adminRequest<AdminRetentionResponse>(
      "GET",
      `/v1/admin/retention${query({ problemsOnly, cursor })}`
    ),

  // Parsed: the acknowledgement flow keys on subsystem and code, so a group
  // whose shape drifted would be acknowledged under a key nothing matches.
  errors: (windowHours: number) =>
    adminRequestParsed(
      adminErrorsResponseSchema,
      "GET",
      `/v1/admin/errors${query({ windowHours })}`
    ),

  audit: (filters: { sessionId?: string | undefined; cursor?: string | undefined } = {}) =>
    adminRequest<AdminAuditResponse>("GET", `/v1/admin/audit${query(filters)}`),

  /**
   * Record what a person saw at the tray.
   *
   * The job identifier is the idempotency key, so a double-clicked button
   * cannot record two conflicting accounts of the same print. The server
   * replays an identical repeat and refuses a contradictory one.
   */
  resolveRecovery: (printJobId: string, body: ResolveRecoveryBody) =>
    adminRequestParsed<ResolveRecoveryResponse>(
      resolveRecoveryResponseSchema,
      "POST",
      `/v1/admin/print-jobs/${encodeURIComponent(printJobId)}/recovery-resolution`,
      body
    ),

  /**
   * Supersede an account of a print with a corrected one.
   *
   * `supersedesId` names the record the person was looking at, so two people
   * correcting the same record collide with a 409 rather than the second one
   * silently becoming the truth.
   */
  correctRecovery: (printJobId: string, body: CorrectRecoveryBody) =>
    adminRequestParsed<CorrectRecoveryResponse>(
      correctRecoveryResponseSchema,
      "POST",
      `/v1/admin/print-jobs/${encodeURIComponent(printJobId)}/recovery-correction`,
      body
    ),

  /**
   * Authorize a refund. The only call in this file that costs anything.
   *
   * It creates an obligation at PENDING; it does not pay anybody, and the
   * response says so through a literal the schema refuses to parse otherwise.
   */
  authorizeRefund: (printJobId: string, body: AuthorizeRefundBody) =>
    adminRequestParsed<AuthorizeRefundResponse>(
      authorizeRefundResponseSchema,
      "POST",
      `/v1/admin/print-jobs/${encodeURIComponent(printJobId)}/refund-authorization`,
      body
    ),

  /** Ask retention to try a cleanup run that gave up. The worker re-arms it. */
  retryRetention: (body: RetryRetentionBody) =>
    adminRequestParsed<RetryRetentionResponse>(
      retryRetentionResponseSchema,
      "POST",
      "/v1/admin/retention/retry",
      body
    ),

  acknowledgeIncident: (body: AcknowledgeIncidentBody) =>
    adminRequest<AcknowledgeIncidentResponse>("POST", "/v1/admin/incidents/acknowledge", body),

  // ---------------------------------------------------------------------------
  // People
  // ---------------------------------------------------------------------------

  // Parsed: every control on the people screen is drawn from a status, a key
  // count and a minimum, and a shape this build guessed at would be a retire
  // button offered on an account that cannot spare the key.
  people: () => adminRequestParsed(adminPeopleResponseSchema, "GET", "/v1/admin/people"),

  changePersonStatus: (adminUserId: string, body: ChangeAdminStatusBody) =>
    adminRequestParsed<ChangeAdminStatusResponse>(
      changeAdminStatusResponseSchema,
      "POST",
      `/v1/admin/people/${encodeURIComponent(adminUserId)}/status`,
      body
    ),

  assignPersonKiosk: (adminUserId: string, body: KioskAssignmentBody) =>
    adminRequestParsed<KioskAssignmentResponse>(
      kioskAssignmentResponseSchema,
      "POST",
      `/v1/admin/people/${encodeURIComponent(adminUserId)}/kiosks`,
      body
    ),

  revokePersonSessions: (adminUserId: string, body: RevokeAdminSessionsBody) =>
    adminRequestParsed<RevokeAdminSessionsResponse>(
      revokeAdminSessionsResponseSchema,
      "POST",
      `/v1/admin/people/${encodeURIComponent(adminUserId)}/sessions/revoke`,
      body
    ),

  revokePersonAuthenticator: (
    adminUserId: string,
    authenticatorId: string,
    body: RevokeOperatorAuthenticatorBody
  ) =>
    adminRequestParsed<RevokeOperatorAuthenticatorResponse>(
      revokeOperatorAuthenticatorResponseSchema,
      "POST",
      `/v1/admin/people/${encodeURIComponent(adminUserId)}/authenticators/${encodeURIComponent(
        authenticatorId
      )}/revoke`,
      body
    ),

  // ---------------------------------------------------------------------------
  // Changes
  // ---------------------------------------------------------------------------

  // All three are parsed rather than trusted, and this is the section where that
  // matters most. Every number on these screens is a price somebody is about to
  // publish, and the digests the publish call echoes back are what tie the
  // numbers on screen to the numbers written — a shape this build guessed at
  // would be a publication of numbers nobody checked.
  changes: () => adminRequestParsed(adminChangesResponseSchema, "GET", "/v1/admin/changes"),

  /**
   * Price a change out. Changes nothing.
   *
   * The `published: false` literal is why this is parsed: no response can
   * persuade this build that a preview published something.
   */
  previewChange: (body: PreviewChangeBody) =>
    adminRequestParsed<PreviewChangeResponse>(
      previewChangeResponseSchema,
      "POST",
      "/v1/admin/changes/preview",
      body
    ),

  /**
   * Publish the tariff.
   *
   * The one call in this client whose success means prices have already changed
   * at every kiosk. Both digests come from the preview; the server recomputes
   * them and refuses if either no longer holds.
   */
  publishChange: (body: PublishChangeBody) =>
    adminRequestParsed<PublishChangeResponse>(
      publishChangeResponseSchema,
      "POST",
      "/v1/admin/changes",
      body
    )
};
