import {
  adminErrorsResponseSchema,
  adminOverviewResponseSchema,
  resolveRecoveryResponseSchema,
  type AcknowledgeIncidentBody,
  type AcknowledgeIncidentResponse,
  type AdminAuditResponse,
  type AdminDocumentsResponse,
  type AdminKiosksResponse,
  type AdminPaymentsResponse,
  type AdminPrintJobDetailResponse,
  type AdminPrintJobsResponse,
  type AdminRefundsResponse,
  type AdminRetentionResponse,
  type AdminSessionDetailResponse,
  type AdminSessionsResponse,
  type AdminTimelineResponse,
  type ResolveRecoveryBody,
  type ResolveRecoveryResponse
} from "@printing-kiosk/admin-access";

import { adminRequest, adminRequestParsed } from "../auth/api.js";

/**
 * The operational reads, and the two things an operator can do.
 *
 * The mutating calls are at the bottom and there are exactly two of them. Both
 * go through the same `adminRequest`, so both carry the CSRF token and both
 * surface "touch your key again" the same way every other call does.
 *
 * There is no call here that moves money. `refund.authorize` has no endpoint to
 * reach yet, and this file would be the wrong place to discover otherwise.
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

  payments: (filters: ListFilters = {}) =>
    adminRequest<AdminPaymentsResponse>("GET", `/v1/admin/payments${query(filters)}`),
  refunds: (unsettledOnly: boolean, cursor?: string) =>
    adminRequest<AdminRefundsResponse>(
      "GET",
      `/v1/admin/refunds${query({ unsettledOnly, cursor })}`
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

  audit: (filters: { sessionId?: string; cursor?: string } = {}) =>
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

  acknowledgeIncident: (body: AcknowledgeIncidentBody) =>
    adminRequest<AcknowledgeIncidentResponse>("POST", "/v1/admin/incidents/acknowledge", body)
};
