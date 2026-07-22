import {
  listUploadedFilesResponseSchema,
  uploadFileResponseSchema,
  type ListUploadedFilesResponse,
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
  dependencies: UploadDependencies = browserUploadDependencies()
): Promise<UploadFileResponse> {
  const clientFileId = dependencies.randomUUID();
  const idempotencyKey = dependencies.randomUUID();
  const body = new FormData();
  body.append("file", file, file.name);

  return new Promise((resolve, reject) => {
    const request = dependencies.createRequest();
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
        reject(xhrError(request));
        return;
      }

      try {
        const parsed = uploadFileResponseSchema.parse(JSON.parse(request.responseText));
        onProgress(1);
        resolve(parsed);
      } catch {
        reject(new MobileRequestError("INVALID_SERVER_RESPONSE", request.status));
      }
    };
    request.onerror = () => reject(new MobileRequestError("NETWORK_UNAVAILABLE"));
    request.onabort = () => reject(new MobileRequestError("UPLOAD_CANCELED"));
    request.ontimeout = () => reject(new MobileRequestError("UPLOAD_TIMEOUT"));
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
