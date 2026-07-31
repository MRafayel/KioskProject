// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

import type { SessionEvent } from "@printing-kiosk/contracts";

import { LanguageProvider } from "../features/i18n/LanguageProvider.js";
import { PrototypeSessionProvider } from "../features/session/PrototypeSessionProvider.js";
import { initialPrototypeState, type PrototypeState } from "../features/session/model.js";
import { App } from "./App.js";

const testSession = {
  id: "01900000-0000-7000-8000-000000000010",
  publicId: "ps_1234567890abcdef",
  version: 1,
  uploadUrl: "https://upload.example.test/s/ps_1234567890abcdef#t=u_example",
  expiresAt: "2030-01-01T00:10:00.000Z",
  hardExpiresAt: "2030-01-01T00:30:00.000Z"
};

const readyFixture = {
  id: "01900000-0000-7000-8000-000000000011",
  ordinal: 0,
  name: "safe-fixture.pdf",
  kind: "PDF" as const,
  status: "READY" as const,
  pageCount: 8,
  processingRevision: 1,
  rejectionCode: null,
  sizeBytes: 2_400_000
};

// The control plane owns every number below. These fixtures stand in for its
// answers so the screens can be checked for displaying them rather than for
// working any of them out locally.
const settingsFixture = {
  revision: 1,
  copies: 2,
  duplex: "LONG_EDGE" as const,
  paperSize: "A4" as const,
  orientation: "PORTRAIT" as const,
  scaling: "FIT" as const,
  collate: true,
  colorMode: "MONOCHROME" as const,
  files: [
    {
      fileId: readyFixture.id,
      position: 0,
      pageCount: 8,
      pageRanges: [[3, 7] as [number, number]],
      pageRangeText: "3-7",
      selectedPages: 5
    }
  ],
  selectedPages: 5,
  printedSides: 10,
  physicalSheets: 6,
  createdAt: "2030-01-01T00:00:00.000Z"
};

const quoteFixture = {
  id: "01900000-0000-7000-8000-0000000000aa",
  sessionId: testSession.id,
  settingsRevision: 1,
  pricingVersion: "price-v1",
  status: "ACTIVE" as const,
  currency: "AMD",
  currencyExponent: 2,
  selectedPages: 5,
  printedSides: 10,
  physicalSheets: 6,
  breakdown: {
    printAmountMinor: 50_000,
    duplexAdjustmentMinor: 0,
    serviceFeeMinor: 0,
    minimumAdjustmentMinor: 0
  },
  subtotalMinor: 50_000,
  taxMinor: 10_000,
  totalMinor: 60_000,
  createdAt: "2030-01-01T00:00:00.000Z",
  expiresAt: "2030-01-01T00:05:00.000Z"
};

const capabilitiesFixture = {
  capabilityVersion: 2,
  paperSizes: ["A4"],
  duplexModes: ["SIMPLEX", "LONG_EDGE"],
  orientations: ["AUTO", "PORTRAIT", "LANDSCAPE"],
  scalingModes: ["FIT", "ACTUAL_SIZE"],
  colorModes: ["MONOCHROME"],
  maxCopies: 20,
  maxSelectedPages: 200,
  maxPrintedSides: 1_000
};

function readRequestBody(body: BodyInit | null | undefined): string {
  return typeof body === "string" ? body : "";
}

function payButtonName(amountMinor: number): RegExp {
  // The accessible name keeps ICU's non-breaking space, so match either form.
  const escaped = formatAmd(amountMinor).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^Pay\\s${escaped.replace(/^AMD\s/, "AMD\\s")}$`);
}

function formatAmd(amountMinor: number): string {
  // Testing Library normalizes whitespace, and ICU separates the currency code
  // from the amount with a non-breaking space, so match what a query will see.
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "AMD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })
    .format(amountMinor / 100)
    .replace(/\u00a0/g, " ");
}

let listedFileStatus: string;
let cancelFailuresRemaining: number;
let cancelIdempotencyKeys: string[];
let fileDeleteFailuresRemaining: number;
let fileDeleteIdempotencyKeys: string[];
let settingsRequests: Array<{ body: string; ifMatch: string; idempotencyKey: string }>;
let quoteRequests: Array<{ body: string; idempotencyKey: string }>;

beforeEach(() => {
  window.sessionStorage.clear();
  listedFileStatus = "QUARANTINED";
  cancelFailuresRemaining = 0;
  cancelIdempotencyKeys = [];
  fileDeleteFailuresRemaining = 0;
  fileDeleteIdempotencyKeys = [];
  settingsRequests = [];
  quoteRequests = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/print-capabilities")) {
        return Promise.resolve(
          new Response(JSON.stringify(capabilitiesFixture), {
            status: 200,
            headers: { "content-type": "application/json" }
          })
        );
      }

      if (url.endsWith("/settings") && init?.method === "PUT") {
        const headers = new Headers(init.headers);
        settingsRequests.push({
          body: readRequestBody(init.body),
          ifMatch: headers.get("if-match") ?? "",
          idempotencyKey: headers.get("idempotency-key") ?? ""
        });
        return Promise.resolve(
          new Response(
            JSON.stringify({
              settings: settingsFixture,
              sessionState: "CONFIGURING",
              sessionVersion: 2,
              quoteInvalidated: false
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
        );
      }

      if (url.endsWith("/quotes") && init?.method === "POST") {
        quoteRequests.push({
          body: readRequestBody(init.body),
          idempotencyKey: new Headers(init.headers).get("idempotency-key") ?? ""
        });
        return Promise.resolve(
          new Response(JSON.stringify({ quote: quoteFixture }), {
            status: 201,
            headers: { "content-type": "application/json" }
          })
        );
      }

      if (url.endsWith("/cancel")) {
        cancelIdempotencyKeys.push(new Headers(init?.headers).get("idempotency-key") ?? "");
        if (cancelFailuresRemaining > 0) {
          cancelFailuresRemaining -= 1;
          return Promise.reject(new TypeError("simulated network interruption"));
        }
        return Promise.resolve(
          new Response("{}", {
            status: 200,
            headers: { "content-type": "application/json" }
          })
        );
      }

      if (url.endsWith(`/files/${readyFixture.id}/pages`)) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              fileId: readyFixture.id,
              processingRevision: 1,
              pageCount: 8,
              items: Array.from({ length: 8 }, (_, index) => ({
                pageNumber: index + 1,
                widthPixels: 850,
                heightPixels: 1200,
                previewAvailable: true
              }))
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
        );
      }

      if (url.endsWith(`/files/${readyFixture.id}`) && init?.method === "DELETE") {
        fileDeleteIdempotencyKeys.push(new Headers(init.headers).get("idempotency-key") ?? "");
        if (fileDeleteFailuresRemaining > 0) {
          fileDeleteFailuresRemaining -= 1;
          return Promise.reject(new TypeError("simulated file delete interruption"));
        }
        return Promise.resolve(new Response(null, { status: 204 }));
      }

      if (url.endsWith("/files")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              items: [
                {
                  id: "01900000-0000-7000-8000-000000000011",
                  ordinal: 0,
                  status: listedFileStatus,
                  kind: "PDF",
                  pageCount: listedFileStatus === "READY" ? 8 : null,
                  processingRevision: 1,
                  rejectionCode: listedFileStatus === "REJECTED" ? "DOCUMENT_MALFORMED" : null,
                  sizeBytes: 2_400_000,
                  createdAt: "2030-01-01T00:00:00.000Z"
                }
              ]
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
        );
      }

      return Promise.resolve(
        new Response(
          JSON.stringify({
            session: {
              id: "01900000-0000-7000-8000-000000000010",
              publicId: "ps_1234567890abcdef",
              kioskId: "kiosk_dev_001",
              locale: document.documentElement.lang || "hy",
              state: "WAITING_FOR_UPLOAD",
              version: 1,
              expiresAt: "2030-01-01T00:10:00.000Z",
              hardExpiresAt: "2030-01-01T00:30:00.000Z",
              createdAt: "2030-01-01T00:00:00.000Z",
              canceledAt: null
            },
            upload: {
              shortCode: "48291357",
              qrUrl: "https://upload.example.test/s/ps_1234567890abcdef#t=u_example"
            }
          }),
          { status: 201, headers: { "content-type": "application/json" } }
        )
      );
    })
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("kiosk prototype journey", () => {
  it("shows the real quarantined upload without unlocking unvalidated settings", async () => {
    const user = userEvent.setup();
    renderKiosk();
    await user.click(screen.getByRole("button", { name: "English" }));

    await user.click(screen.getByRole("button", { name: "Start printing" }));
    expect(await screen.findByRole("heading", { name: "Upload your document" })).toBeVisible();

    expect(await screen.findByText("Document 1.pdf")).toBeVisible();
    expect(screen.getAllByText("Received — waiting for a secure check").length).toBeGreaterThan(0);
    expect(screen.queryByText("4829 1357")).not.toBeInTheDocument();
    expect(screen.queryByText(/8 pages/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Continue to print settings/i })).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: /simulate phone upload/i })
    ).not.toBeInTheDocument();
  });

  it("shows a rejected upload without treating it as printable", async () => {
    listedFileStatus = "REJECTED";
    const user = userEvent.setup();
    renderKiosk();
    await user.click(screen.getByRole("button", { name: "English" }));
    await user.click(screen.getByRole("button", { name: "Start printing" }));

    expect(await screen.findByText("Document 1.pdf")).toBeVisible();
    expect(screen.getAllByText("File rejected").length).toBeGreaterThan(0);
    expect(screen.getByText(/This file is damaged.*Remove this file on your phone/)).toBeVisible();
    expect(screen.getByRole("button", { name: /Continue to print settings/i })).toBeDisabled();
  });

  it("unlocks settings only after an authoritative ready snapshot", async () => {
    listedFileStatus = "READY";
    const user = userEvent.setup();
    renderKiosk();
    await user.click(screen.getByRole("button", { name: "English" }));
    await user.click(screen.getByRole("button", { name: "Start printing" }));

    expect(await screen.findByText("Document 1.pdf")).toBeVisible();
    expect(screen.getAllByText("Upload complete").length).toBeGreaterThan(0);
    const continueButton = screen.getByRole("button", { name: /Continue to print settings/i });
    expect(continueButton).toBeEnabled();
    await user.click(continueButton);
    expect(screen.getByRole("heading", { name: "Choose print settings" })).toBeVisible();
    expect(await screen.findByRole("img", { name: "Page 1" })).toHaveAttribute(
      "src",
      expect.stringContaining(`/pages/1/preview?revision=1`)
    );
  });

  it("pays only the total the control plane calculated for the saved settings", async () => {
    const user = userEvent.setup();
    renderKiosk({
      initialEntries: ["/configure"],
      initialState: {
        ...initialPrototypeState,
        session: testSession,
        files: [readyFixture]
      }
    });
    await user.click(screen.getByRole("button", { name: "English" }));

    expect(screen.getByRole("heading", { name: "Choose print settings" })).toBeVisible();
    expect(screen.queryByText("Paper size", { exact: true })).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("spinbutton", { name: "From page" }), {
      target: { value: "3" }
    });
    fireEvent.change(screen.getByRole("spinbutton", { name: "To page" }), {
      target: { value: "7" }
    });

    await user.click(screen.getByRole("button", { name: "Increase copies" }));
    await user.click(screen.getByLabelText("Double-sided"));

    // Payment stays unavailable until an authoritative price arrives.
    expect(screen.getByRole("button", { name: /Review and pay/i })).toBeDisabled();
    expect(await screen.findByText(formatAmd(quoteFixture.totalMinor))).toBeVisible();
    expect(screen.getByRole("button", { name: /Review and pay/i })).toBeEnabled();

    // Server counts replace the local preview once they exist.
    expect(screen.getByText(settingsFixture.printedSides.toString())).toBeVisible();
    expect(screen.getByText(settingsFixture.physicalSheets.toString())).toBeVisible();

    const lastSettings = settingsRequests.at(-1);
    const lastQuote = quoteRequests.at(-1);
    expect(lastSettings?.ifMatch).toBe('"1"');
    expect(lastSettings?.idempotencyKey).toMatch(/^kiosk-/);
    expect(JSON.parse(lastSettings?.body ?? "{}")).toMatchObject({
      copies: 2,
      duplex: "LONG_EDGE",
      paperSize: "A4",
      fileSelections: [{ fileId: readyFixture.id, pageRanges: "3-7" }]
    });
    // No request the kiosk sends may contain an amount, a currency, or a total.
    for (const request of [...settingsRequests, ...quoteRequests]) {
      expect(request.body).not.toMatch(/minor|amount|currency|total|price/i);
    }
    expect(JSON.parse(lastQuote?.body ?? "{}")).toEqual({ settingsRevision: 1 });

    await user.click(screen.getByRole("button", { name: /Review and pay/i }));
    expect(screen.getByRole("heading", { name: "Review and pay" })).toBeVisible();
    expect(
      screen.getByRole("button", { name: payButtonName(quoteFixture.totalMinor) })
    ).toBeEnabled();
    expect(screen.getByText(formatAmd(quoteFixture.taxMinor))).toBeVisible();
  });

  it("sends the customer back to configure instead of paying an expired price", async () => {
    const user = userEvent.setup();
    renderKiosk({
      initialEntries: ["/checkout"],
      initialState: {
        ...initialPrototypeState,
        session: testSession,
        files: [readyFixture],
        pricing: {
          status: "READY",
          settings: settingsFixture,
          quote: { ...quoteFixture, expiresAt: "2020-01-01T00:00:00.000Z" },
          errorCode: null
        }
      }
    });
    await user.click(screen.getByRole("button", { name: "English" }));

    expect(screen.getByRole("heading", { name: "Choose print settings" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Review and pay" })).not.toBeInTheDocument();
  });

  it("shows the ready image kind in the compact configure file card", () => {
    const { container } = renderKiosk({
      initialEntries: ["/configure"],
      initialState: {
        ...initialPrototypeState,
        session: testSession,
        files: [
          {
            ...readyFixture,
            name: "passport-photo.jpg",
            kind: "JPEG"
          }
        ]
      }
    });

    expect(container.querySelector(".file-card--compact .file-card__icon")).toHaveTextContent(
      "JPEG"
    );
    expect(container.querySelector(".file-card--compact .file-card__icon")).not.toHaveTextContent(
      "PDF"
    );
  });

  it("keeps the authoritative ready file until kiosk deletion is confirmed and retries safely", async () => {
    fileDeleteFailuresRemaining = 1;
    const user = userEvent.setup();
    renderKiosk({
      initialEntries: ["/configure"],
      initialState: {
        ...initialPrototypeState,
        session: testSession,
        files: [readyFixture]
      }
    });
    await user.click(screen.getByRole("button", { name: "English" }));

    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(
      await screen.findByText("The file could not be removed. Try again before continuing.")
    ).toBeVisible();
    expect(screen.getByText("safe-fixture.pdf")).toBeVisible();
    const retainedKey = window.sessionStorage.getItem(
      `printing-kiosk.pending-file-delete.${testSession.id}.${readyFixture.id}`
    );
    expect(retainedKey).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(await screen.findByRole("heading", { name: "Upload your document" })).toBeVisible();
    expect(fileDeleteIdempotencyKeys).toEqual([retainedKey, retainedKey]);
    expect(
      window.sessionStorage.getItem(
        `printing-kiosk.pending-file-delete.${testSession.id}.${readyFixture.id}`
      )
    ).toBeNull();
  });

  it("keeps the completed Phase 1 payment, printing, and recovery screens covered as test fixtures", async () => {
    vi.useFakeTimers();
    renderKiosk({
      initialEntries: ["/checkout"],
      initialState: {
        ...initialPrototypeState,
        session: testSession,
        files: [readyFixture],
        pricing: {
          status: "READY",
          settings: settingsFixture,
          quote: quoteFixture,
          errorCode: null
        }
      }
    });
    fireEvent.click(screen.getByRole("button", { name: "English" }));
    fireEvent.click(screen.getByLabelText("Printer error"));
    fireEvent.click(screen.getByRole("button", { name: payButtonName(quoteFixture.totalMinor) }));

    expect(screen.getByRole("heading", { name: "Processing payment" })).toBeVisible();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_200);
    });
    expect(screen.getByRole("heading", { name: "Printing your document" })).toBeVisible();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_200);
    });
    expect(screen.getByRole("heading", { name: "The printer needs attention" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Retry printing" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_200);
    });
    expect(screen.getByRole("heading", { name: "Your documents are ready" })).toBeVisible();
  });

  it("recovers a kiosk blocked by a session it can no longer resume", async () => {
    // Exactly the state a validated document creates: the previous session has
    // moved past WAITING_FOR_UPLOAD, so its QR grant can no longer be handed
    // back, and this kiosk cannot start a new session until it is closed.
    const blockingSessionId = "01900000-0000-7000-8000-0000000000b1";
    const createAttempts: string[] = [];
    const cancelled: Array<{ sessionId: string; ifMatch: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = requestUrl(input);
        const headers = new Headers(init?.headers);

        if (url.endsWith("/agent/v1/sessions") && init?.method === "POST") {
          createAttempts.push(headers.get("idempotency-key") ?? "");
          if (createAttempts.length === 1) {
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  error: {
                    code: "ACTIVE_SESSION_EXISTS",
                    message: "This kiosk already has an active session.",
                    requestId: "req_test",
                    details: { sessionId: blockingSessionId, currentState: "FILES_UPLOADED" }
                  }
                }),
                { status: 409, headers: { "content-type": "application/json" } }
              )
            );
          }
          return Promise.resolve(
            new Response(
              JSON.stringify({
                session: {
                  id: "01900000-0000-7000-8000-0000000000b2",
                  publicId: "ps_recoveredsession01",
                  kioskId: "kiosk_dev_001",
                  locale: "en",
                  state: "WAITING_FOR_UPLOAD",
                  version: 1,
                  expiresAt: "2030-01-01T00:10:00.000Z",
                  hardExpiresAt: "2030-01-01T00:30:00.000Z",
                  createdAt: "2030-01-01T00:00:00.000Z",
                  canceledAt: null
                },
                upload: {
                  shortCode: "48291357",
                  qrUrl: "https://upload.example.test/s/ps_recoveredsession01#t=u_example"
                }
              }),
              { status: 201, headers: { "content-type": "application/json" } }
            )
          );
        }

        if (url.endsWith(`/cancel`)) {
          cancelled.push({
            sessionId: blockingSessionId,
            ifMatch: headers.get("if-match") ?? ""
          });
          return Promise.resolve(
            new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
          );
        }

        if (url.endsWith(`/agent/v1/sessions/${blockingSessionId}`)) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                session: {
                  id: blockingSessionId,
                  publicId: "ps_blockedsession0001",
                  kioskId: "kiosk_dev_001",
                  locale: "en",
                  state: "FILES_UPLOADED",
                  version: 2,
                  expiresAt: "2030-01-01T00:10:00.000Z",
                  hardExpiresAt: "2030-01-01T00:30:00.000Z",
                  createdAt: "2030-01-01T00:00:00.000Z",
                  canceledAt: null
                }
              }),
              { status: 200, headers: { "content-type": "application/json" } }
            )
          );
        }

        return Promise.resolve(
          new Response(JSON.stringify({ items: [] }), {
            status: 200,
            headers: { "content-type": "application/json" }
          })
        );
      })
    );

    const user = userEvent.setup();
    renderKiosk();
    await user.click(screen.getByRole("button", { name: "English" }));
    await user.click(screen.getByRole("button", { name: "Start printing" }));

    expect(await screen.findByRole("heading", { name: "Upload your document" })).toBeVisible();
    // The blocking session was closed with its authoritative version, and the
    // retry used a new key rather than replaying the refused one.
    expect(cancelled).toEqual([{ sessionId: blockingSessionId, ifMatch: '"2"' }]);
    expect(createAttempts).toHaveLength(2);
    expect(createAttempts[0]).not.toBe(createAttempts[1]);
  });

  it("cancels safely and returns to the only available service", async () => {
    const user = userEvent.setup();
    renderKiosk();
    await user.click(screen.getByRole("button", { name: "English" }));

    await user.click(screen.getByRole("button", { name: "Start printing" }));
    await screen.findByRole("heading", { name: "Upload your document" });
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByRole("dialog", { name: "Cancel this print session?" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Cancel session" }));
    expect(await screen.findByRole("heading", { name: /Տպեք հեռախոսից/i })).toBeVisible();
    expect(screen.queryByText(/scan documents|xerox|color printing/i)).not.toBeInTheDocument();
  });

  it("ends an active screen when a live session-canceled event arrives", async () => {
    const eventSources = installFakeEventSource();
    window.sessionStorage.setItem("printing-kiosk.pending-create", "private-create-key");
    window.sessionStorage.setItem(
      `printing-kiosk.pending-cancel.${testSession.id}`,
      "private-cancel-key"
    );
    renderKiosk({
      initialEntries: ["/configure"],
      initialState: {
        ...initialPrototypeState,
        session: testSession,
        files: [readyFixture]
      }
    });
    expect(screen.getByRole("heading", { name: "Ընտրեք տպման կարգավորումները" })).toBeVisible();
    const source = latestOpenEventSource(eventSources);

    act(() => {
      source.open();
      source.message(sessionCreatedEvent());
      source.message(sessionTerminalEvent(2, "session.canceled", "CANCELED"));
    });

    expect(await screen.findByRole("heading", { name: /Տպեք հեռախոսից/i })).toBeVisible();
    expect(source.closed).toBe(true);
    expect(window.sessionStorage.getItem("printing-kiosk.pending-create")).toBeNull();
    expect(
      window.sessionStorage.getItem(`printing-kiosk.pending-cancel.${testSession.id}`)
    ).toBeNull();
  });

  it("ends a stale active session when expiration is replayed before the stream opens", async () => {
    const eventSources = installFakeEventSource();
    renderKiosk({
      initialEntries: ["/upload"],
      initialState: { ...initialPrototypeState, session: testSession }
    });
    expect(await screen.findByRole("heading", { name: "Վերբեռնեք փաստաթուղթը" })).toBeVisible();
    const source = latestOpenEventSource(eventSources);

    act(() => {
      source.message(sessionCreatedEvent());
      source.message(sessionTerminalEvent(2, "session.expired", "EXPIRED"));
    });

    expect(await screen.findByRole("heading", { name: /Տպեք հեռախոսից/i })).toBeVisible();
    expect(source.opened).toBe(false);
    expect(source.closed).toBe(true);
  });

  it("refreshes the active file snapshot for a session-wide file event", async () => {
    const eventSources = installFakeEventSource();
    const fetchMock = vi.mocked(fetch);
    renderKiosk({
      initialEntries: ["/upload"],
      initialState: { ...initialPrototypeState, session: testSession }
    });
    expect(await screen.findByText("Փաստաթուղթ 1.pdf")).toBeVisible();
    const source = latestOpenEventSource(eventSources);
    const fileRequestsBefore = fetchMock.mock.calls.filter(([input]) =>
      requestUrl(input).endsWith("/files")
    ).length;

    act(() => {
      source.message(sessionCreatedEvent());
      source.message(fileUploadedEvent(2));
    });

    await vi.waitFor(() => {
      expect(
        fetchMock.mock.calls.filter(([input]) => requestUrl(input).endsWith("/files")).length
      ).toBeGreaterThan(fileRequestsBefore);
    });
  });

  it("refreshes authoritative state and unlocks settings on file.ready", async () => {
    const eventSources = installFakeEventSource();
    renderKiosk({
      initialEntries: ["/upload"],
      initialState: { ...initialPrototypeState, session: testSession }
    });
    expect(await screen.findByText("Փաստաթուղթ 1.pdf")).toBeVisible();
    listedFileStatus = "READY";
    const source = latestOpenEventSource(eventSources);

    act(() => {
      source.message(sessionCreatedEvent());
      source.message(fileReadyEvent(2));
    });

    await vi.waitFor(() => {
      expect(screen.getByRole("button", { name: /Անցնել տպման կարգավորումներին/i })).toBeEnabled();
    });
  });

  it("refreshes an authoritative rejection reason without trusting the realtime payload", async () => {
    const eventSources = installFakeEventSource();
    renderKiosk({
      initialEntries: ["/upload"],
      initialState: { ...initialPrototypeState, session: testSession }
    });
    expect(await screen.findByText("Փաստաթուղթ 1.pdf")).toBeVisible();
    listedFileStatus = "REJECTED";
    const source = latestOpenEventSource(eventSources);

    act(() => {
      source.message(sessionCreatedEvent());
      source.message(fileRejectedEvent(2));
    });

    expect(await screen.findByText(/Ֆայլը վնասված է.*Հեռախոսից հեռացրեք/)).toBeVisible();
    expect(screen.queryByText(/վնասակար բովանդակության/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Անցնել տպման կարգավորումներին/i })).toBeDisabled();
  });

  it("does not treat validation polling or realtime file readiness as customer activity", async () => {
    vi.useFakeTimers();
    const eventSources = installFakeEventSource();
    renderKiosk({
      initialEntries: ["/upload"],
      initialState: { ...initialPrototypeState, session: testSession }
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole("timer", { name: "Մնացել է 120 վայրկյան" })).toBeVisible();

    listedFileStatus = "VALIDATING";
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(screen.getByRole("timer", { name: "Մնացել է 110 վայրկյան" })).toBeVisible();

    window.dispatchEvent(new Event("kiosk-activity"));
    listedFileStatus = "READY";
    const source = latestOpenEventSource(eventSources);
    await act(async () => {
      source.message(sessionCreatedEvent());
      source.message(fileReadyEvent(2));
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.getByRole("button", { name: /Անցնել տպման կարգավորումներին/i })).toBeEnabled();
    expect(screen.getByRole("timer", { name: "Մնացել է 110 վայրկյան" })).toBeVisible();
  });

  it("retains the session and cancellation key until secure cleanup is confirmed", async () => {
    cancelFailuresRemaining = 1;
    const user = userEvent.setup();
    renderKiosk({
      initialEntries: ["/upload"],
      initialState: { ...initialPrototypeState, session: testSession }
    });
    await user.click(screen.getByRole("button", { name: "English" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Cancel session" }));

    expect(
      await screen.findByRole("dialog", { name: "File cleanup still needs confirmation" })
    ).toBeVisible();
    expect(screen.getByRole("heading", { name: "Upload your document" })).toBeVisible();
    const retainedKey = window.sessionStorage.getItem(
      `printing-kiosk.pending-cancel.${testSession.id}`
    );
    expect(retainedKey).toBeTruthy();
    expect(cancelIdempotencyKeys).toEqual([retainedKey]);

    await user.click(screen.getByRole("button", { name: "Retry secure cleanup" }));
    expect(await screen.findByRole("heading", { name: /Տպեք հեռախոսից/i })).toBeVisible();
    expect(cancelIdempotencyKeys).toEqual([retainedKey, retainedKey]);
    expect(
      window.sessionStorage.getItem(`printing-kiosk.pending-cancel.${testSession.id}`)
    ).toBeNull();
  });

  it("warns on inactivity and resets the private session", async () => {
    vi.useFakeTimers();
    renderKiosk({
      initialEntries: ["/upload"],
      initialState: {
        ...initialPrototypeState,
        session: testSession
      }
    });

    expect(screen.getByRole("timer", { name: "Մնացել է 120 վայրկյան" })).toBeVisible();
    await act(() => vi.advanceTimersByTime(10_000));
    expect(screen.getByRole("timer", { name: "Մնացել է 110 վայրկյան" })).toBeVisible();

    fireEvent.pointerDown(screen.getByRole("heading", { name: "Վերբեռնեք փաստաթուղթը" }));
    expect(screen.getByRole("timer", { name: "Մնացել է 120 վայրկյան" })).toBeVisible();

    await act(() => vi.advanceTimersByTime(90_000));
    expect(screen.getByRole("alertdialog", { name: "Ավելի շատ ժամանա՞կ է պետք։" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Ավարտել գործողությունը" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole("heading", { name: /Տպեք հեռախոսից/i })).toBeVisible();
  });

  it("keeps an expired kiosk session recoverable when automatic cleanup cannot be confirmed", async () => {
    vi.useFakeTimers();
    cancelFailuresRemaining = 1;
    renderKiosk({
      initialEntries: ["/configure"],
      initialState: {
        ...initialPrototypeState,
        session: testSession,
        files: [readyFixture]
      }
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_250);
    });

    expect(
      screen.getByRole("alertdialog", { name: "Ֆայլերի հեռացումը դեռ հաստատված չէ" })
    ).toBeVisible();
    expect(screen.getByRole("heading", { name: "Ընտրեք տպման կարգավորումները" })).toBeVisible();
    const retainedKey = window.sessionStorage.getItem(
      `printing-kiosk.pending-cancel.${testSession.id}`
    );
    expect(retainedKey).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Կրկին փորձել անվտանգ հեռացումը" }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByRole("heading", { name: /Տպեք հեռախոսից/i })).toBeVisible();
    expect(cancelIdempotencyKeys).toEqual([retainedKey, retainedKey]);
  });

  it("keeps the completion screen available until file cleanup is confirmed", async () => {
    cancelFailuresRemaining = 1;
    const user = userEvent.setup();
    renderKiosk({
      initialEntries: ["/complete"],
      initialState: {
        ...initialPrototypeState,
        session: testSession,
        files: [readyFixture]
      }
    });
    await user.click(screen.getByRole("button", { name: "English" }));
    await user.click(screen.getByRole("button", { name: "Finish and delete files" }));

    expect(await screen.findByText("File cleanup still needs confirmation")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Your documents are ready" })).toBeVisible();
    const retainedKey = window.sessionStorage.getItem(
      `printing-kiosk.pending-cancel.${testSession.id}`
    );
    expect(retainedKey).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Retry secure cleanup" }));
    expect(await screen.findByRole("heading", { name: /Տպեք հեռախոսից/i })).toBeVisible();
    expect(cancelIdempotencyKeys).toEqual([retainedKey, retainedKey]);
  });

  it("shows only the two alternative languages and resets to Armenian for the next customer", async () => {
    const user = userEvent.setup();
    renderKiosk();

    expect(document.documentElement).toHaveAttribute("lang", "hy");
    expect(
      screen.getByRole("heading", { name: "Տպեք հեռախոսից՝ ընդամենը մի քանի քայլով։" })
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "English" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Русский" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Հայերեն" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Русский" }));
    expect(document.documentElement).toHaveAttribute("lang", "ru");
    expect(
      screen.getByRole("heading", { name: "Печатайте с телефона за несколько простых шагов." })
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Начать печать" }));
    expect(await screen.findByRole("heading", { name: "Загрузите документ" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "English" }));
    expect(document.documentElement).toHaveAttribute("lang", "en");
    expect(screen.getByRole("heading", { name: "Upload your document" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("dialog", { name: "Cancel this print session?" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Cancel session" }));

    expect(document.documentElement).toHaveAttribute("lang", "hy");
    expect(screen.getByRole("heading", { name: /Տպեք հեռախոսից/i })).toBeVisible();
  });
});

function renderKiosk({
  initialEntries = ["/"],
  initialState = initialPrototypeState
}: {
  initialEntries?: string[];
  initialState?: PrototypeState;
} = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } }
  });

  return render(
    <LanguageProvider>
      <QueryClientProvider client={queryClient}>
        <PrototypeSessionProvider initialState={initialState}>
          <App initialPath={initialEntries[0] ?? "/"} />
        </PrototypeSessionProvider>
      </QueryClientProvider>
    </LanguageProvider>
  );
}

function requestUrl(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

class FakeEventSource {
  public onopen: ((event: Event) => void) | null = null;
  public onerror: ((event: Event) => void) | null = null;
  public onmessage: ((event: MessageEvent) => void) | null = null;
  public closed = false;
  public opened = false;

  public open(): void {
    this.opened = true;
    this.onopen?.(new Event("open"));
  }

  public message(event: SessionEvent): void {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(event) }));
  }

  public close(): void {
    this.closed = true;
  }
}

function installFakeEventSource(): FakeEventSource[] {
  const sources: FakeEventSource[] = [];
  vi.stubGlobal(
    "EventSource",
    class {
      public constructor() {
        const source = new FakeEventSource();
        sources.push(source);
        return source;
      }
    }
  );
  return sources;
}

function latestOpenEventSource(sources: FakeEventSource[]): FakeEventSource {
  const source = [...sources].reverse().find((candidate) => !candidate.closed);
  if (!source) throw new Error("ACTIVE_EVENT_SOURCE_REQUIRED");
  return source;
}

function sessionCreatedEvent(): SessionEvent {
  return {
    id: "01900000-0000-7000-8000-000000000081",
    sessionId: testSession.id,
    sequence: 1,
    type: "session.created",
    payload: {
      sessionId: testSession.id,
      state: "WAITING_FOR_UPLOAD",
      version: 1
    },
    occurredAt: "2030-01-01T00:00:00.000Z"
  };
}

function sessionTerminalEvent(
  sequence: number,
  type: "session.canceled" | "session.expired",
  state: "CANCELED" | "EXPIRED"
): SessionEvent {
  return {
    id: `01900000-0000-7000-8000-${String(81 + sequence).padStart(12, "0")}`,
    sessionId: testSession.id,
    sequence,
    type,
    payload: { sessionId: testSession.id, state, version: 2 },
    occurredAt: "2030-01-01T00:00:01.000Z"
  };
}

function fileUploadedEvent(sequence: number): SessionEvent {
  return {
    id: `01900000-0000-7000-8000-${String(90 + sequence).padStart(12, "0")}`,
    sessionId: testSession.id,
    sequence,
    type: "file.uploaded",
    payload: {
      sessionId: testSession.id,
      file: {
        id: readyFixture.id,
        ordinal: 0,
        status: "QUARANTINED",
        kind: "PDF",
        pageCount: null,
        processingRevision: 1,
        rejectionCode: null,
        sizeBytes: readyFixture.sizeBytes,
        createdAt: "2030-01-01T00:00:00.000Z"
      }
    },
    occurredAt: "2030-01-01T00:00:01.000Z"
  };
}

function fileReadyEvent(sequence: number): SessionEvent {
  return {
    id: `01900000-0000-7000-8000-${String(95 + sequence).padStart(12, "0")}`,
    sessionId: testSession.id,
    sequence,
    type: "file.ready",
    payload: {
      sessionId: testSession.id,
      file: {
        id: readyFixture.id,
        ordinal: readyFixture.ordinal,
        status: "READY",
        kind: readyFixture.kind,
        pageCount: readyFixture.pageCount,
        processingRevision: readyFixture.processingRevision,
        rejectionCode: null,
        sizeBytes: readyFixture.sizeBytes,
        createdAt: "2030-01-01T00:00:00.000Z"
      }
    },
    occurredAt: "2030-01-01T00:00:02.000Z"
  };
}

function fileRejectedEvent(sequence: number): SessionEvent {
  return {
    id: `01900000-0000-7000-8000-${String(98 + sequence).padStart(12, "0")}`,
    sessionId: testSession.id,
    sequence,
    type: "file.rejected",
    payload: {
      sessionId: testSession.id,
      file: {
        id: readyFixture.id,
        ordinal: readyFixture.ordinal,
        status: "REJECTED",
        kind: readyFixture.kind,
        pageCount: null,
        processingRevision: readyFixture.processingRevision,
        rejectionCode: "MALWARE_DETECTED",
        sizeBytes: readyFixture.sizeBytes,
        createdAt: "2030-01-01T00:00:00.000Z"
      }
    },
    occurredAt: "2030-01-01T00:00:02.000Z"
  };
}
