// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

import type { MobileContextResponse } from "@printing-kiosk/contracts";

import { App } from "./App.js";
import {
  MobileRequestError,
  createMobileBootstrap,
  type MobileBootstrapController
} from "../features/join/bootstrap.js";

const publicSessionId = "ps_1234567890abcdef";
const context: MobileContextResponse = {
  session: {
    id: "01900000-0000-7000-8000-000000000051",
    publicId: publicSessionId,
    locale: "hy",
    state: "WAITING_FOR_UPLOAD",
    version: 1,
    expiresAt: "2030-01-01T00:10:00.000Z",
    hardExpiresAt: "2030-01-01T00:30:00.000Z"
  },
  csrfToken: `c_${"D".repeat(43)}`,
  limits: {
    maxFiles: 1,
    maxFileBytes: 10_485_760,
    maxTotalBytes: 10_485_760,
    allowedMimeTypes: ["application/pdf", "image/jpeg", "image/png"]
  }
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("mobile upload application", () => {
  it("shares bootstrap under StrictMode and provides meaningful Armenian, Russian, and English", async () => {
    const listRequest = vi.fn<typeof fetch>().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
    );
    vi.stubGlobal("fetch", listRequest);
    const exchangeRequest = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(context), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    const nonceValues = new Map<string, string>();
    const bootstrap = createMobileBootstrap(
      publicSessionId,
      { kind: "present", token: `u_${"F".repeat(43)}` },
      {
        fetch: exchangeRequest,
        storage: {
          getItem: (key) => nonceValues.get(key) ?? null,
          setItem: (key, value) => {
            nonceValues.set(key, value);
          },
          removeItem: (key) => {
            nonceValues.delete(key);
          }
        },
        randomUUID: () => "01900000-0000-7000-8000-000000000052"
      }
    );
    const user = userEvent.setup();

    render(
      <StrictMode>
        <MemoryRouter initialEntries={[`/s/${publicSessionId}`]}>
          <App bootstrap={bootstrap} />
        </MemoryRouter>
      </StrictMode>
    );

    expect(await screen.findByRole("heading", { name: "Վերբեռնեք տպվող ֆայլը" })).toBeVisible();
    expect(screen.getByText(/Գործողությունը հասանելի է մինչև/)).toBeVisible();
    expect(document.documentElement).toHaveAttribute("lang", "hy");
    expect(exchangeRequest).toHaveBeenCalledOnce();
    expect(nonceValues.size).toBe(0);

    await user.click(screen.getByRole("button", { name: "Русский" }));
    expect(screen.getByRole("heading", { name: "Загрузите файл для печати" })).toBeVisible();
    expect(document.documentElement).toHaveAttribute("lang", "ru");

    await user.click(screen.getByRole("button", { name: "English" }));
    expect(
      screen.getByRole("heading", { name: "Upload the file you want to print" })
    ).toBeVisible();
    expect(document.documentElement).toHaveAttribute("lang", "en");
  });

  it("never displays raw API error messages", async () => {
    const rejectedBootstrap = controllerThatRejects(
      new MobileRequestError("INVALID_UPLOAD_GRANT", 401)
    );
    render(
      <MemoryRouter initialEntries={[`/s/${publicSessionId}`]}>
        <App bootstrap={rejectedBootstrap} />
      </MemoryRouter>
    );

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Այս հղումը վավեր չէ");
    expect(alert).not.toHaveTextContent("INVALID_UPLOAD_GRANT");
    expect(screen.queryByRole("button", { name: "Փորձել կրկին" })).not.toBeInTheDocument();
  });

  it("offers an in-page retry for a transient bootstrap failure", async () => {
    const listRequest = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    vi.stubGlobal("fetch", listRequest);
    const run = vi
      .fn<MobileBootstrapController["run"]>()
      .mockRejectedValueOnce(new MobileRequestError("NETWORK_UNAVAILABLE"))
      .mockResolvedValueOnce(context);
    const user = userEvent.setup();

    render(
      <MemoryRouter initialEntries={[`/s/${publicSessionId}`]}>
        <App bootstrap={{ run }} />
      </MemoryRouter>
    );

    await user.click(await screen.findByRole("button", { name: "Փորձել կրկին" }));
    expect(await screen.findByRole("heading", { name: "Վերբեռնեք տպվող ֆայլը" })).toBeVisible();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("uses the kiosk session language while retaining Armenian as the loading default", async () => {
    let resolveBootstrap: ((value: MobileContextResponse) => void) | undefined;
    const pending = new Promise<MobileContextResponse>((resolve) => {
      resolveBootstrap = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
    );

    render(
      <MemoryRouter initialEntries={[`/s/${publicSessionId}`]}>
        <App bootstrap={{ run: () => pending }} />
      </MemoryRouter>
    );

    expect(screen.getByRole("heading", { name: "Միանում ենք տպման տերմինալին…" })).toBeVisible();
    resolveBootstrap?.({
      ...context,
      session: { ...context.session, locale: "ru" }
    });
    expect(await screen.findByRole("heading", { name: "Загрузите файл для печати" })).toBeVisible();
    expect(document.documentElement).toHaveAttribute("lang", "ru");
  });

  it("retranslates a safe operation error when the customer changes language", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValue(new TypeError("offline")));
    const user = userEvent.setup();

    render(
      <MemoryRouter initialEntries={[`/s/${publicSessionId}`]}>
        <App bootstrap={{ run: () => Promise.resolve(context) }} />
      </MemoryRouter>
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("Չհաջողվեց կապվել տերմինալի հետ");
    await user.click(screen.getByRole("button", { name: "Русский" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Не удалось связаться с терминалом");
  });

  it("checks the session before upload and closes the phone UI after kiosk cancellation", async () => {
    const requests = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/files")) {
        return Promise.resolve(
          new Response(JSON.stringify({ items: [] }), {
            status: 200,
            headers: { "content-type": "application/json" }
          })
        );
      }
      if (url.endsWith("/context")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              error: { code: "INVALID_MOBILE_SESSION", message: "hidden", requestId: "test" }
            }),
            { status: 401, headers: { "content-type": "application/json" } }
          )
        );
      }
      return Promise.reject(new Error("UNEXPECTED_TEST_REQUEST"));
    });
    const xhrConstructor = vi.fn(() => {
      throw new Error("UPLOAD_MUST_NOT_START");
    });
    vi.stubGlobal("fetch", requests);
    vi.stubGlobal("XMLHttpRequest", xhrConstructor);

    render(
      <MemoryRouter initialEntries={[`/s/${publicSessionId}`]}>
        <App bootstrap={{ run: () => Promise.resolve(context) }} />
      </MemoryRouter>
    );
    await screen.findByRole("heading", { name: "Վերբեռնեք տպվող ֆայլը" });
    const input = document.querySelector<HTMLInputElement>("#file-upload");
    if (!input) throw new Error("EXPECTED_FILE_INPUT");

    fireEvent.change(input, {
      target: {
        files: [new File(["%PDF-1.4"], "synthetic.pdf", { type: "application/pdf" })]
      }
    });

    expect(await screen.findByText("Տպման գործողությունը փակված է")).toBeVisible();
    expect(screen.getByText(/այլևս չի ընդունում ֆայլեր/)).toBeVisible();
    expect(screen.queryByText(/Գործողությունը հասանելի է մինչև/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ընտրել ֆայլ" })).toBeDisabled();
    expect(xhrConstructor).not.toHaveBeenCalled();
  });

  it("keeps an active phone session open after a recoverable upload conflict", async () => {
    const requests = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = url.endsWith("/files") ? { items: [] } : context;
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      );
    });
    vi.stubGlobal("fetch", requests);
    vi.stubGlobal("XMLHttpRequest", ConflictRequest);

    render(
      <MemoryRouter initialEntries={[`/s/${publicSessionId}`]}>
        <App bootstrap={{ run: () => Promise.resolve(context) }} />
      </MemoryRouter>
    );
    await screen.findByRole("heading", { name: "Վերբեռնեք տպվող ֆայլը" });
    const input = document.querySelector<HTMLInputElement>("#file-upload");
    if (!input) throw new Error("EXPECTED_FILE_INPUT");

    fireEvent.change(input, {
      target: {
        files: [new File(["%PDF-1.4"], "synthetic.pdf", { type: "application/pdf" })]
      }
    });

    expect(await screen.findByRole("alert")).toHaveTextContent("Ֆայլը չփոխանցվեց");
    expect(screen.getByText("Հեռախոսը միացված է տերմինալին")).toBeVisible();
    expect(screen.getByText(/Գործողությունը հասանելի է մինչև/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Ընտրել ֆայլ" })).toBeEnabled();
    expect(screen.queryByText("Տպման գործողությունը փակված է")).not.toBeInTheDocument();
  });

  it("does not lose a reconnect check while an earlier context request is in flight", async () => {
    let source: ControlledEventSource | undefined;
    let releaseFirstCheck: ((response: Response) => void) | undefined;
    const firstCheck = new Promise<Response>((resolve) => {
      releaseFirstCheck = resolve;
    });
    let contextRequests = 0;
    const requests = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/files")) {
        return Promise.resolve(
          Response.json({ items: [] }, { headers: { "content-type": "application/json" } })
        );
      }
      if (url.endsWith("/context")) {
        contextRequests += 1;
        if (contextRequests === 1) return firstCheck;
        return Promise.resolve(
          Response.json(
            {
              error: {
                code: "INVALID_MOBILE_SESSION",
                message: "Mobile authentication failed.",
                requestId: "test"
              }
            },
            { status: 401 }
          )
        );
      }
      return Promise.reject(new Error("UNEXPECTED_TEST_REQUEST"));
    });
    vi.stubGlobal("fetch", requests);
    const captureSource = (candidate: ControlledEventSource) => {
      source = candidate;
    };
    vi.stubGlobal(
      "EventSource",
      class extends ControlledEventSource {
        public constructor() {
          super();
          captureSource(this);
        }
      }
    );

    render(
      <MemoryRouter initialEntries={[`/s/${publicSessionId}`]}>
        <App bootstrap={{ run: () => Promise.resolve(context) }} />
      </MemoryRouter>
    );
    await screen.findByRole("heading", { name: "Վերբեռնեք տպվող ֆայլը" });
    if (!source) throw new Error("EXPECTED_EVENT_SOURCE");

    act(() => source?.fail());
    await vi.waitFor(() => expect(contextRequests).toBe(1));
    act(() => {
      source?.open();
      releaseFirstCheck?.(
        Response.json(context, { headers: { "content-type": "application/json" } })
      );
    });

    expect(await screen.findByText("Տպման գործողությունը փակված է")).toBeVisible();
    expect(contextRequests).toBe(2);
  });
});

function controllerThatRejects(error: MobileRequestError): MobileBootstrapController {
  const rejected = Promise.reject(error);
  void rejected.catch(() => undefined);
  return { run: () => rejected };
}

class ConflictRequest {
  public readonly upload = { addEventListener: () => undefined };
  public onabort: ((event: ProgressEvent) => void) | null = null;
  public onerror: ((event: ProgressEvent) => void) | null = null;
  public onload: ((event: ProgressEvent) => void) | null = null;
  public ontimeout: ((event: ProgressEvent) => void) | null = null;
  public responseText = JSON.stringify({
    error: {
      code: "CONCURRENT_FILE_UPLOAD",
      message: "Another upload is already in progress.",
      requestId: "test"
    }
  });
  public status = 409;
  public timeout = 0;
  public withCredentials = false;

  public abort(): void {
    this.onabort?.({} as ProgressEvent);
  }

  public open(): void {}

  public send(): void {
    queueMicrotask(() => this.onload?.({} as ProgressEvent));
  }

  public setRequestHeader(): void {}
}

class ControlledEventSource {
  public onopen: ((event: Event) => void) | null = null;
  public onerror: ((event: Event) => void) | null = null;
  public onmessage: ((event: MessageEvent) => void) | null = null;

  public open(): void {
    this.onopen?.(new Event("open"));
  }

  public fail(): void {
    this.onerror?.(new Event("error"));
  }

  public close(): void {}
}
