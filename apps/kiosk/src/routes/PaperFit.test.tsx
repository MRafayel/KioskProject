// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

import { StrictMode } from "react";

import type { PrintJobSnapshot } from "@printing-kiosk/contracts";

import { App } from "../app/App.js";
import { LanguageProvider } from "../features/i18n/LanguageProvider.js";
import { messages as catalogues } from "../features/i18n/messages.js";
import { PrototypeSessionProvider } from "../features/session/PrototypeSessionProvider.js";
import { initialPrototypeState, type PrototypeState } from "../features/session/model.js";
import { KIOSK_PAPER_QUERY_KEY } from "../features/session/paper.js";

/**
 * A job that cannot come out of the tray must not be sold.
 *
 * The refusal has to happen before the payment, because after it there is no
 * cheap outcome left: a half-printed job is a refund, an operator, and somebody
 * standing at a machine holding fewer pages than they paid for. So the screen
 * says what the kiosk can print while the customer is still uploading, and
 * stops them at the settings when the configuration outgrows it.
 *
 * The other half of the rule matters just as much and is easier to get wrong:
 * an estimate nobody is keeping is not an empty tray. A kiosk with no paper
 * ledger, or one whose agent could not be reached, must print exactly as it did
 * before this feature existed.
 */

const copy = catalogues.en;

const SESSION = {
  id: "01900000-0000-7000-8000-000000000010",
  publicId: "ps_1234567890abcdef",
  version: 1,
  uploadUrl: "https://upload.example.test/s/ps_1234567890abcdef#t=u_example",
  expiresAt: "2030-01-01T00:10:00.000Z",
  hardExpiresAt: "2030-01-01T00:30:00.000Z"
};

const READY_FILE = {
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

/**
 * What the control plane says this configuration costs in physical sheets. The
 * screen never recomputes a served count, so driving the test from here is
 * driving it from the only number that decides anything.
 */
let requiredSheets: number;
/** What the kiosk's paper ledger currently answers. Null means untracked. */
let estimatedSheets: number | null;
/** Set to fail every paper read, as an unreachable agent would. */
let paperReadFails: boolean;
let paperReads: number;

function jsonResponse(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" }
    })
  );
}

function settingsBody() {
  return {
    revision: 1,
    paperSize: "A4" as const,
    scaling: "FIT" as const,
    collate: true,
    colorMode: "MONOCHROME" as const,
    files: [
      {
        fileId: READY_FILE.id,
        position: 0,
        pageCount: READY_FILE.pageCount,
        pageRanges: [[1, READY_FILE.pageCount] as [number, number]],
        pageRangeText: `1-${READY_FILE.pageCount}`,
        selectedPages: READY_FILE.pageCount,
        copies: 1,
        duplex: "SIMPLEX" as const,
        orientation: "AUTO" as const,
        printedSides: READY_FILE.pageCount,
        physicalSheets: requiredSheets
      }
    ],
    selectedPages: READY_FILE.pageCount,
    printedSides: READY_FILE.pageCount,
    physicalSheets: requiredSheets,
    createdAt: "2030-01-01T00:00:00.000Z"
  };
}

function quoteBody() {
  return {
    id: "01900000-0000-7000-8000-0000000000aa",
    sessionId: SESSION.id,
    settingsRevision: 1,
    pricingVersion: "price-v1",
    status: "ACTIVE" as const,
    currency: "AMD",
    currencyExponent: 2,
    selectedPages: READY_FILE.pageCount,
    printedSides: READY_FILE.pageCount,
    physicalSheets: requiredSheets,
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
    expiresAt: "2030-12-31T00:00:00.000Z"
  };
}

beforeEach(() => {
  window.sessionStorage.clear();
  requiredSheets = 8;
  estimatedSheets = 120;
  paperReadFails = false;
  paperReads = 0;

  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

      if (url.endsWith("/v1/paper")) {
        paperReads += 1;
        if (paperReadFails) return Promise.reject(new TypeError("simulated agent interruption"));
        return jsonResponse({ paper: { estimatedSheets } });
      }

      if (url.endsWith("/print-capabilities")) {
        return jsonResponse({
          capabilityVersion: 2,
          paperSizes: ["A4"],
          duplexModes: ["SIMPLEX", "LONG_EDGE"],
          orientations: ["AUTO"],
          scalingModes: ["FIT"],
          colorModes: ["MONOCHROME"],
          maxCopies: 10,
          maxSelectedPages: 200,
          maxPrintedSides: 1_000
        });
      }

      if (url.endsWith("/settings") && init?.method === "PUT") {
        return jsonResponse({
          settings: settingsBody(),
          sessionState: "CONFIGURING",
          sessionVersion: 2,
          quoteInvalidated: false
        });
      }

      if (url.endsWith("/quotes") && init?.method === "POST") {
        return jsonResponse({ quote: quoteBody() }, 201);
      }

      if (url.endsWith(`/files/${READY_FILE.id}/pages`)) {
        return jsonResponse({
          fileId: READY_FILE.id,
          processingRevision: 1,
          pageCount: READY_FILE.pageCount,
          items: Array.from({ length: READY_FILE.pageCount }, (_, index) => ({
            pageNumber: index + 1,
            widthPixels: 850,
            heightPixels: 1200,
            previewAvailable: true
          }))
        });
      }

      if (url.endsWith("/files")) {
        return jsonResponse({
          items: [{ ...READY_FILE, createdAt: "2030-01-01T00:00:00.000Z" }]
        });
      }

      return jsonResponse({
        session: {
          id: SESSION.id,
          publicId: SESSION.publicId,
          kioskId: "kiosk_dev_001",
          locale: document.documentElement.lang || "hy",
          state: "WAITING_FOR_UPLOAD",
          version: 1,
          expiresAt: SESSION.expiresAt,
          hardExpiresAt: SESSION.hardExpiresAt,
          createdAt: "2030-01-01T00:00:00.000Z",
          canceledAt: null
        },
        upload: { shortCode: "48291357", url: SESSION.uploadUrl }
      });
    })
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderKiosk(
  path: string,
  state: PrototypeState,
  seedPaperSheets?: number,
  strict = false
) {
  // The same defaults `main.tsx` builds, `staleTime` included. Without it these
  // tests would exercise a client no terminal ever runs, and the app-wide
  // "never goes stale" rule — the one thing the paper query has to opt out of —
  // would be invisible here.
  const queryClient = new QueryClient({
    defaultOptions: {
      mutations: { retry: false },
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY }
    }
  });
  if (seedPaperSheets !== undefined) {
    // Stamped as an old answer on purpose. A seed written with the current time
    // would count as fresh, and a test asserting that opening a screen asks
    // again would pass without ever asking.
    queryClient.setQueryData(
      KIOSK_PAPER_QUERY_KEY,
      { estimatedSheets: seedPaperSheets },
      { updatedAt: 0 }
    );
  }
  const tree = (
    <LanguageProvider>
      <QueryClientProvider client={queryClient}>
        <PrototypeSessionProvider initialState={state}>
          <App initialPath={path} />
        </PrototypeSessionProvider>
      </QueryClientProvider>
    </LanguageProvider>
  );
  // `main.tsx` mounts the terminal inside StrictMode, so every effect here runs,
  // cleans up and runs again in development. Anything that may only happen once
  // has to survive that, and the only way to check it is to reproduce it.
  render(strict ? <StrictMode>{tree}</StrictMode> : tree);
  return queryClient;
}

async function openInEnglish(path: string, state: PrototypeState, seedPaperSheets?: number) {
  const user = userEvent.setup();
  const queryClient = renderKiosk(path, state, seedPaperSheets);
  await user.click(screen.getByRole("button", { name: "English" }));
  return { user, queryClient };
}

const uploadingState: PrototypeState = { ...initialPrototypeState, session: SESSION };
const configuringState: PrototypeState = {
  ...initialPrototypeState,
  session: SESSION,
  files: [READY_FILE]
};

const payButton = () => screen.getByRole("button", { name: new RegExp(copy.configure.reviewAndPay) });

describe("what the upload screen says about paper", () => {
  it("names the number of sheets the kiosk can print", async () => {
    estimatedSheets = 120;
    await openInEnglish("/upload", uploadingState);

    // In the status pill, which is the one thing on this screen with nothing to
    // say until a document arrives. Asserted through the pill rather than by
    // text alone, so moving the count somewhere quieter is a failure here
    // rather than a silent change to the first thing a customer reads.
    const pill = await screen.findByRole("status", { name: copy.upload.paperAvailable(120) });
    expect(pill).toBeVisible();
    expect(pill).toHaveClass("status-pill--waiting");
  });

  it("says the availability is unknown rather than showing a fake zero", async () => {
    // No refill has ever been recorded here. The tray may well be full.
    estimatedSheets = null;
    await openInEnglish("/upload", uploadingState);

    expect(await screen.findByText(copy.upload.paperUnavailable)).toBeVisible();
    expect(screen.queryByText(copy.upload.paperAvailable(0))).toBeNull();
  });

  it("says the same when the agent cannot be reached", async () => {
    paperReadFails = true;
    await openInEnglish("/upload", uploadingState);

    expect(await screen.findByText(copy.upload.paperUnavailable)).toBeVisible();
  });
});

describe("the count is re-read when a screen that shows it opens", () => {
  it("asks again as the upload screen opens rather than showing what was cached", async () => {
    // What a customer sees a second after pressing Start printing. The estimate
    // moves while nobody is looking at it — a print completes, somebody refills
    // the tray and types the new count into the admin panel — so opening a
    // screen that shows it has to be a reason to ask, not a reason to reuse.
    //
    // This app sets `staleTime: Number.POSITIVE_INFINITY` for every query, and
    // under that default this mount would fetch nothing and the customer would
    // wait out the poll interval looking at the old number.
    const queryClient = renderKiosk("/upload", uploadingState, 18);

    await waitFor(() => expect(paperReads).toBeGreaterThan(0));
    await waitFor(() =>
      expect(queryClient.getQueryData(KIOSK_PAPER_QUERY_KEY)).toEqual({ estimatedSheets: 120 })
    );
  });

  it("tells a kiosk that has only just started what it holds, without waiting", async () => {
    // Nothing has been polled yet, so the cache begins at unknown. Under the
    // app-wide default that unknown would never go stale, and the first
    // customer of the day would be told the count is unavailable on a kiosk
    // that knows exactly what it holds.
    estimatedSheets = 120;
    await openInEnglish("/upload", uploadingState);

    expect(await screen.findByText(copy.upload.paperAvailable(120))).toBeVisible();
  });
});

describe("nothing asks in the background", () => {
  it("makes no further request while a customer sits on the upload screen", async () => {
    // There is no interval any more. Opening a screen asks; standing on one
    // does not, however long the customer takes to photograph the code and send
    // their documents.
    await openInEnglish("/upload", uploadingState);
    await waitFor(() => expect(paperReads).toBe(1));

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_100));
    });

    expect(paperReads).toBe(1);
  });

  it("reuses the answer when a customer steps straight on to the settings", async () => {
    // The "Continue", "Add document" and "Back" buttons make this a step a
    // customer takes repeatedly, and asking the kiosk again for the same second
    // would be a request per tap.
    // A document is already validated, so the continue button is live.
    const { user } = await openInEnglish("/upload", configuringState);
    await waitFor(() => expect(paperReads).toBe(1));

    await user.click(screen.getByRole("button", { name: new RegExp(copy.upload.continue) }));

    expect(await screen.findByRole("heading", { name: copy.configure.title })).toBeVisible();
    expect(paperReads).toBe(1);
  });
});

describe("a job that does not fit is stopped before it is paid for", () => {
  it("explains the shortfall in sheets and refuses to continue", async () => {
    requiredSheets = 24;
    estimatedSheets = 18;
    await openInEnglish("/configure", configuringState);

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent ?? "").toContain(copy.configure.paperShortTitle);
    // The customer is told both numbers, because "not enough" without them
    // gives nobody any idea how much to take out.
    expect(dialog.textContent ?? "").toContain(copy.configure.paperShortBody(18, 24));
    expect(dialog.textContent ?? "").toContain(copy.configure.paperShortAdvice);

    await waitFor(() => expect(payButton()).toBeDisabled());
  });

  it("lets the customer out of the dialog and back to the settings", async () => {
    // Unlike the printer-unavailable dialog, this one has a choice behind it:
    // fewer copies, fewer pages. So it must not trap anybody.
    requiredSheets = 24;
    estimatedSheets = 18;
    const { user } = await openInEnglish("/configure", configuringState);

    await screen.findByRole("alertdialog");
    await user.click(screen.getByRole("button", { name: copy.configure.paperShortDismiss }));
    expect(screen.queryByRole("alertdialog")).toBeNull();

    // The refusal itself stands: the dialog was the explanation, not the gate.
    expect(payButton()).toBeDisabled();
    expect(screen.getByText(copy.configure.paperShortHelp)).toBeVisible();
  });
});

describe("a job that fits is left alone", () => {
  it("shows no dialog and allows payment", async () => {
    requiredSheets = 8;
    estimatedSheets = 8;
    await openInEnglish("/configure", configuringState);

    await waitFor(() => expect(payButton()).toBeEnabled());
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("never refuses a kiosk that keeps no estimate", async () => {
    // The case this must not break: a deployment where nobody records paper at
    // all still prints exactly as it did before.
    requiredSheets = 2_000;
    estimatedSheets = null;
    await openInEnglish("/configure", configuringState);

    await waitFor(() => expect(payButton()).toBeEnabled());
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("never refuses because the agent could not be reached", async () => {
    requiredSheets = 2_000;
    paperReadFails = true;
    await openInEnglish("/configure", configuringState);

    await waitFor(() => expect(payButton()).toBeEnabled());
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});

describe("the estimate is checked again on the way to the checkout", () => {
  it("refuses a job the tray stopped being able to print while it was chosen", async () => {
    // The race worth closing: the poll said thirty sheets, another job finished
    // at this kiosk, and the customer presses pay a second later.
    requiredSheets = 8;
    estimatedSheets = 30;
    const { user } = await openInEnglish("/configure", configuringState);
    await waitFor(() => expect(payButton()).toBeEnabled());

    estimatedSheets = 2;
    const readsBefore = paperReads;
    await user.click(payButton());

    expect(paperReads).toBeGreaterThan(readsBefore);
    expect(await screen.findByRole("alertdialog")).toBeVisible();
    expect(screen.queryByRole("heading", { name: copy.checkout.title })).toBeNull();
  });

  it("keeps a known shortfall when later reads stop arriving", async () => {
    // The failure mode worth guarding: an agent that goes quiet must not be
    // able to lift a refusal the screen had already earned. A read that does
    // not arrive is not news about the tray, so the last answer that did
    // arrive stands.
    //
    // It starts from a job that fits and a button that is live, so that every
    // assertion below is about paper rather than about a price that had not
    // settled yet.
    requiredSheets = 24;
    estimatedSheets = 30;
    const { queryClient } = await openInEnglish("/configure", configuringState);
    await waitFor(() => expect(payButton()).toBeEnabled());

    // Another job completes at this kiosk. The poll notices, without waiting
    // out its interval.
    estimatedSheets = 18;
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: KIOSK_PAPER_QUERY_KEY });
    });
    await waitFor(() => expect(payButton()).toBeDisabled());
    await screen.findByRole("alertdialog");

    // Now the agent stops answering. The refusal has to survive that.
    paperReadFails = true;
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: KIOSK_PAPER_QUERY_KEY });
    });

    // The read failed rather than answering unknown, so the cache still holds
    // the last count that actually arrived. That is the mechanism the refusal
    // below rests on, and asserting it here is what makes this test fail if the
    // read ever starts reporting a failure as "no estimate".
    await waitFor(() =>
      expect(queryClient.getQueryState(KIOSK_PAPER_QUERY_KEY)?.status).toBe("error")
    );
    expect(queryClient.getQueryData(KIOSK_PAPER_QUERY_KEY)).toEqual({ estimatedSheets: 18 });

    expect(payButton()).toBeDisabled();
    expect(screen.getByText(copy.configure.paperShortHelp)).toBeVisible();
    expect(screen.queryByRole("heading", { name: copy.checkout.title })).toBeNull();
  });
});

describe("a finished print leaves the estimate immediately", () => {
  const PRINTED_SHEETS = 6;

  const settledPrintJob: PrintJobSnapshot = {
    id: "01900000-0000-7000-8000-0000000000cc",
    sessionId: SESSION.id,
    quoteId: "01900000-0000-7000-8000-0000000000aa",
    paymentId: "01900000-0000-7000-8000-0000000000bb",
    settingsRevision: 1,
    status: "COMPLETED",
    resultConfidence: "CONFIRMED",
    failureCode: null,
    warningCode: null,
    copies: 1,
    printedSides: 8,
    physicalSheets: PRINTED_SHEETS,
    sheetsProduced: PRINTED_SHEETS,
    createdAt: "2030-01-01T00:01:00.000Z",
    deadlineAt: "2030-01-01T00:06:00.000Z",
    completedAt: "2030-01-01T00:02:00.000Z"
  };

  function printedState(printJob: PrintJobSnapshot): PrototypeState {
    return {
      ...configuringState,
      pricing: { status: "READY", settings: settingsBody(), quote: quoteBody(), errorCode: null },
      payment: {
        payment: {
          id: settledPrintJob.paymentId,
          sessionId: SESSION.id,
          quoteId: settledPrintJob.quoteId,
          provider: "MOCK",
          status: "CAPTURED",
          appliedToSession: true,
          amountMinor: 60_000,
          currency: "AMD",
          currencyExponent: 2,
          failureCode: null,
          createdAt: "2030-01-01T00:00:00.000Z",
          expiresAt: "2030-01-01T00:03:00.000Z",
          capturedAt: "2030-01-01T00:01:00.000Z"
        },
        attempt: 1,
        errorCode: null
      },
      print: { job: printJob, errorCode: null, failureDisposition: null }
    };
  }

  function heldSheets(queryClient: QueryClient): number | null | undefined {
    return queryClient.getQueryData<{ estimatedSheets: number | null }>(KIOSK_PAPER_QUERY_KEY)
      ?.estimatedSheets;
  }

  it("subtracts the sheets the device produced without waiting for a poll", async () => {
    // The control plane deducted these when it confirmed the completion. The
    // screen must not spend an interval offering paper the kiosk no longer has.
    const { queryClient } = await openInEnglish("/printing", printedState(settledPrintJob), 40);

    await waitFor(() => expect(heldSheets(queryClient)).toBe(40 - PRINTED_SHEETS));
  });

  it("applies the deduction once even though every effect here runs twice", async () => {
    // The terminal mounts inside StrictMode, so this effect really does run,
    // clean up and run again on every screen in development. Applying the
    // deduction twice would understate the paper by a whole job until the next
    // poll corrected it, which is exactly the wrong direction to be wrong in.
    const queryClient = renderKiosk("/printing", printedState(settledPrintJob), 40, true);

    await waitFor(() => expect(heldSheets(queryClient)).toBe(40 - PRINTED_SHEETS));
    await act(async () => {
      await Promise.resolve();
    });

    expect(heldSheets(queryClient)).toBe(40 - PRINTED_SHEETS);
  });

  it("takes nothing out for a print the device could not confirm", async () => {
    // An unconfirmed job goes to recovery and its sheets are settled by an
    // operator. Guessing at them here would be guessing at the tray.
    const { queryClient } = await openInEnglish(
      "/printing",
      printedState({
        ...settledPrintJob,
        status: "RECOVERY_REQUIRED",
        resultConfidence: "UNCONFIRMED",
        sheetsProduced: null
      }),
      40
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(heldSheets(queryClient)).toBe(40);
  });
});
