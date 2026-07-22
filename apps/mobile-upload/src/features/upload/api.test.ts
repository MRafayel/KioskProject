// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MOBILE_UPLOAD_TIMEOUT_MS,
  deleteUploadedFile,
  listUploadedFiles,
  uploadFile
} from "./api.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("mobile file upload", () => {
  it("sends one multipart file with separate request identifiers and progress", async () => {
    const request = new FakeRequest();
    const identifiers = [
      "01900000-0000-7000-8000-000000000041",
      "01900000-0000-7000-8000-000000000042"
    ];
    const progress = vi.fn();
    const file = new File(["synthetic-pdf"], "private-name.pdf", {
      type: "application/pdf"
    });

    const resultPromise = uploadFile(
      "01900000-0000-7000-8000-000000000040",
      file,
      `c_${"C".repeat(43)}`,
      progress,
      {
        createRequest: () => request as unknown as XMLHttpRequest,
        randomUUID: () => identifiers.shift() ?? "unexpected"
      }
    );

    expect(request.method).toBe("POST");
    expect(request.url).toBe("/v1/sessions/01900000-0000-7000-8000-000000000040/files");
    expect(request.withCredentials).toBe(true);
    expect(request.timeout).toBe(MOBILE_UPLOAD_TIMEOUT_MS);
    expect(request.headers).toMatchObject({
      "X-CSRF-Token": `c_${"C".repeat(43)}`,
      "X-Client-File-Id": "01900000-0000-7000-8000-000000000041",
      "X-File-Size": String(file.size),
      "Idempotency-Key": "01900000-0000-7000-8000-000000000042"
    });
    expect(request.body).toBeInstanceOf(FormData);
    expect([...(request.body as FormData).keys()]).toEqual(["file"]);

    request.upload.onprogress?.(
      new ProgressEvent("progress", { lengthComputable: true, loaded: 5, total: 10 })
    );
    expect(progress).toHaveBeenCalledWith(0.5);

    request.status = 202;
    request.responseText = JSON.stringify({
      file: {
        id: "01900000-0000-7000-8000-000000000043",
        ordinal: 0,
        status: "QUARANTINED",
        kind: "PDF",
        sizeBytes: file.size,
        createdAt: "2030-01-01T00:00:00.000Z"
      }
    });
    request.onload?.(new ProgressEvent("load"));

    await expect(resultPromise).resolves.toMatchObject({
      file: { status: "QUARANTINED", kind: "PDF" }
    });
    expect(progress).toHaveBeenLastCalledWith(1);
  });

  it("refreshes the private list with the scoped cookie", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    vi.stubGlobal("fetch", request);

    await expect(listUploadedFiles("01900000-0000-7000-8000-000000000044")).resolves.toEqual({
      items: []
    });
    expect(request).toHaveBeenCalledWith(
      "/v1/sessions/01900000-0000-7000-8000-000000000044/files",
      expect.objectContaining({ method: "GET", credentials: "include", cache: "no-store" })
    );
  });

  it("deletes with CSRF protection and an idempotency key", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", request);

    await deleteUploadedFile(
      "01900000-0000-7000-8000-000000000045",
      "01900000-0000-7000-8000-000000000046",
      `c_${"E".repeat(43)}`
    );

    const [url, init] = request.mock.calls[0] ?? [];
    expect(url).toBe(
      "/v1/sessions/01900000-0000-7000-8000-000000000045/files/01900000-0000-7000-8000-000000000046"
    );
    expect(init?.method).toBe("DELETE");
    expect(init?.credentials).toBe("include");
    const headers = new Headers(init?.headers);
    expect(headers.get("X-CSRF-Token")).toBe(`c_${"E".repeat(43)}`);
    expect(headers.get("Idempotency-Key")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });
});

class FakeRequest {
  public method = "";
  public url = "";
  public withCredentials = false;
  public timeout = 0;
  public headers: Record<string, string> = {};
  public upload: { onprogress: ((event: ProgressEvent) => void) | null } = {
    onprogress: null
  };
  public onload: ((event: ProgressEvent) => void) | null = null;
  public onerror: ((event: ProgressEvent) => void) | null = null;
  public onabort: ((event: ProgressEvent) => void) | null = null;
  public ontimeout: ((event: ProgressEvent) => void) | null = null;
  public status = 0;
  public responseText = "";
  public body: Document | XMLHttpRequestBodyInit | null = null;

  public open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  public setRequestHeader(name: string, value: string): void {
    this.headers[name] = value;
  }

  public send(body: Document | XMLHttpRequestBodyInit | null): void {
    this.body = body;
  }
}
