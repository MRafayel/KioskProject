// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

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

function renderKiosk(path: string, state: PrototypeState) {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } }
  });
  render(
    <LanguageProvider>
      <QueryClientProvider client={queryClient}>
        <PrototypeSessionProvider initialState={state}>
          <App initialPath={path} />
        </PrototypeSessionProvider>
      </QueryClientProvider>
    </LanguageProvider>
  );
  return queryClient;
}

async function openInEnglish(path: string, state: PrototypeState) {
  const user = userEvent.setup();
  const queryClient = renderKiosk(path, state);
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

    expect(await screen.findByText(copy.upload.paperAvailable(120))).toBeVisible();
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

  it("reopens on its own once somebody refills the tray", async () => {
    requiredSheets = 24;
    estimatedSheets = 18;
    await openInEnglish("/configure", configuringState);
    await screen.findByRole("alertdialog");

    estimatedSheets = 500;

    // No reload and no tap: the screen re-asks on its own timer.
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull(), { timeout: 30_000 });
    await waitFor(() => expect(payButton()).toBeEnabled());
  }, 35_000);
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
