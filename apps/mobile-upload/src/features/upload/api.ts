import {
  listUploadedFilesResponseSchema,
  mobileContextResponseSchema,
  publicSessionIdSchema,
  uploadFileResponseSchema,
  type ListUploadedFilesResponse,
  type MobileContextResponse,
  type UploadFileResponse
} from "@printing-kiosk/contracts";

import { MobileRequestError, safeMobileFetch, toMobileRequestError } from "../join/bootstrap.js";
import { secureRandomUuid } from "../security/random.js";

export const MOBILE_UPLOAD_TIMEOUT_MS = 125_000;

export interface UploadDependencies {
  createRequest: () => XMLHttpRequest;
  randomUUID: () => string;
  timeoutMs?: number;
}

export interface UploadFileOptions {
  dependencies?: UploadDependencies;
  signal?: AbortSignal;
}

export async function checkMobileSession(publicSessionId: string): Promise<MobileContextResponse> {
  const parsedPublicId = publicSessionIdSchema.safeParse(publicSessionId);
  if (!parsedPublicId.success) throw new MobileRequestError("INVALID_UPLOAD_LINK");

  let response: Response;
  try {
    response = await safeMobileFetch(
      fetch,
      `/v1/mobile-auth/${encodeURIComponent(parsedPublicId.data)}/context`,
      {
        method: "GET",
        credentials: "include",
        cache: "no-store",
        headers: { accept: "application/json" }
      }
    );
  } catch (error) {
    if (error instanceof MobileRequestError) throw error;
    throw new MobileRequestError("NETWORK_UNAVAILABLE");
  }

  if (!response.ok) throw await toMobileRequestError(response);

  try {
    return mobileContextResponseSchema.parse(await response.json());
  } catch (error) {
    if (error instanceof MobileRequestError) throw error;
    throw new MobileRequestError("INVALID_SERVER_RESPONSE", response.status);
  }
}

export async function listUploadedFiles(sessionId: string): Promise<ListUploadedFilesResponse> {
  let response: Response;
  try {
    response = await safeMobileFetch(fetch, filesPath(sessionId), {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      headers: { accept: "application/json" }
    });
  } catch (error) {
    if (error instanceof MobileRequestError) throw error;
    throw new MobileRequestError("NETWORK_UNAVAILABLE");
  }

  if (!response.ok) throw await toMobileRequestError(response);

  try {
    return listUploadedFilesResponseSchema.parse(await response.json());
  } catch (error) {
    if (error instanceof MobileRequestError) throw error;
    throw new MobileRequestError("INVALID_SERVER_RESPONSE", response.status);
  }
}

export function uploadFile(
  sessionId: string,
  file: File,
  csrfToken: string,
  onProgress: (ratio: number) => void,
  options: UploadFileOptions = {}
): Promise<UploadFileResponse> {
  const dependencies = options.dependencies ?? browserUploadDependencies();
  const clientFileId = dependencies.randomUUID();
  const idempotencyKey = dependencies.randomUUID();
  const body = new FormData();
  body.append("file", file, file.name);

  return new Promise((resolve, reject) => {
    const request = dependencies.createRequest();
    let settled = false;
    const cleanup = () => options.signal?.removeEventListener("abort", abortUpload);
    const fail = (error: MobileRequestError) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const succeed = (result: UploadFileResponse) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const signalError = () =>
      options.signal?.reason instanceof MobileRequestError
        ? options.signal.reason
        : new MobileRequestError("UPLOAD_CANCELED");
    const abortUpload = () => {
      request.abort();
      fail(signalError());
    };

    request.open("POST", filesPath(sessionId));
    request.withCredentials = true;
    request.timeout = dependencies.timeoutMs ?? MOBILE_UPLOAD_TIMEOUT_MS;
    request.setRequestHeader("Accept", "application/json");
    request.setRequestHeader("X-CSRF-Token", csrfToken);
    request.setRequestHeader("X-Client-File-Id", clientFileId);
    request.setRequestHeader("X-File-Size", String(file.size));
    request.setRequestHeader("Idempotency-Key", idempotencyKey);

    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.min(1, event.loaded / event.total));
      }
    };

    request.onload = () => {
      if (request.status < 200 || request.status >= 300) {
        fail(xhrError(request));
        return;
      }

      try {
        const parsed = uploadFileResponseSchema.parse(JSON.parse(request.responseText));
        onProgress(1);
        succeed(parsed);
      } catch {
        fail(new MobileRequestError("INVALID_SERVER_RESPONSE", request.status));
      }
    };
    request.onerror = () => fail(new MobileRequestError("NETWORK_UNAVAILABLE"));
    request.onabort = () => fail(signalError());
    request.ontimeout = () => fail(new MobileRequestError("UPLOAD_TIMEOUT"));
    if (options.signal?.aborted) {
      abortUpload();
      return;
    }
    options.signal?.addEventListener("abort", abortUpload, { once: true });
    request.send(body);
  });
}

export async function deleteUploadedFile(
  sessionId: string,
  fileId: string,
  csrfToken: string
): Promise<void> {
  let response: Response;
  try {
    response = await safeMobileFetch(
      fetch,
      `${filesPath(sessionId)}/${encodeURIComponent(fileId)}`,
      {
        method: "DELETE",
        credentials: "include",
        cache: "no-store",
        headers: {
          accept: "application/json",
          "X-CSRF-Token": csrfToken,
          "Idempotency-Key": secureRandomUuid(globalThis.crypto)
        }
      }
    );
  } catch (error) {
    if (error instanceof MobileRequestError) throw error;
    throw new MobileRequestError("NETWORK_UNAVAILABLE");
  }

  if (!response.ok) throw await toMobileRequestError(response);
}

function filesPath(sessionId: string): string {
  return `/v1/sessions/${encodeURIComponent(sessionId)}/files`;
}

function browserUploadDependencies(): UploadDependencies {
  return {
    createRequest: () => new XMLHttpRequest(),
    randomUUID: () => secureRandomUuid(globalThis.crypto)
  };
}

function xhrError(request: XMLHttpRequest): MobileRequestError {
  let code = "REQUEST_FAILED";
  try {
    const body: unknown = JSON.parse(request.responseText);
    if (
      body &&
      typeof body === "object" &&
      "error" in body &&
      body.error &&
      typeof body.error === "object" &&
      "code" in body.error &&
      typeof body.error.code === "string" &&
      /^[A-Z][A-Z0-9_]{1,63}$/.test(body.error.code)
    ) {
      code = body.error.code;
    }
  } catch {
    // Raw server responses are deliberately hidden from the customer.
  }

  return new MobileRequestError(code, request.status);
}
