import type {
  AdminAuditResponse,
  AdminDocumentsResponse,
  AdminErrorsResponse,
  AdminKiosksResponse,
  AdminOverviewResponse,
  AdminPaymentsResponse,
  AdminPrintJobDetailResponse,
  AdminPrintJobsResponse,
  AdminRefundsResponse,
  AdminRetentionResponse,
  AdminSessionDetailResponse,
  AdminSessionsResponse,
  AdminTimelineResponse
} from "@printing-kiosk/admin-access";

import { adminRequest } from "../auth/api.js";

/**
 * The operational reads.
 *
 * Every one is a GET. There is no mutating call in this file and, for Phase 2,
 * none anywhere in the panel — the acceptance gate is that the control plane
 * can look and cannot touch.
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
  overview: () => adminRequest<AdminOverviewResponse>("GET", "/v1/admin/overview"),
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

  errors: (windowHours: number) =>
    adminRequest<AdminErrorsResponse>("GET", `/v1/admin/errors${query({ windowHours })}`),

  audit: (filters: { sessionId?: string; cursor?: string } = {}) =>
    adminRequest<AdminAuditResponse>("GET", `/v1/admin/audit${query(filters)}`)
};
