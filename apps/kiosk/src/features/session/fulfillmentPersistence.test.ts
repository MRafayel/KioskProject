// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";

import { initialPrototypeState, type PrototypeState } from "./model.js";
import { persistFulfillmentState, restoreFulfillmentState } from "./fulfillmentPersistence.js";

const sessionId = "01900000-0000-7000-8000-000000000101";
const paymentId = "01900000-0000-7000-8000-000000000102";
const printJobId = "01900000-0000-7000-8000-000000000103";
const now = "2030-01-01T00:00:00.000Z";

beforeEach(() => window.sessionStorage.clear());

function fulfillmentState(): PrototypeState {
  return {
    ...initialPrototypeState,
    session: {
      id: sessionId,
      publicId: "ps_1234567890abcdef",
      version: 8,
      uploadUrl: "https://upload.test/#t=u_private-upload-bearer-token-must-not-persist",
      expiresAt: "2030-01-01T00:10:00.000Z",
      hardExpiresAt: "2030-01-01T00:30:00.000Z"
    },
    files: [
      {
        id: "01900000-0000-7000-8000-000000000104",
        ordinal: 0,
        name: "customer-private-name.pdf",
        kind: "PDF",
        status: "READY",
        pageCount: 2,
        processingRevision: 1,
        rejectionCode: null,
        sizeBytes: 100
      }
    ],
    payment: {
      payment: {
        id: paymentId,
        sessionId,
        quoteId: "01900000-0000-7000-8000-000000000105",
        provider: "MOCK",
        status: "CAPTURED",
        appliedToSession: true,
        amountMinor: 10_000,
        currency: "AMD",
        currencyExponent: 2,
        failureCode: null,
        createdAt: now,
        expiresAt: "2030-01-01T00:05:00.000Z",
        capturedAt: now
      },
      attempt: 1,
      errorCode: null
    },
    print: {
      job: {
        id: printJobId,
        sessionId,
        quoteId: "01900000-0000-7000-8000-000000000105",
        paymentId,
        settingsRevision: 1,
        status: "PRINTING",
        resultConfidence: "UNKNOWN",
        failureCode: null,
        warningCode: null,
        copies: 1,
        printedSides: 2,
        physicalSheets: 2,
        sheetsProduced: null,
        createdAt: now,
        deadlineAt: "2030-01-01T00:05:00.000Z",
        completedAt: null
      },
      errorCode: null
    }
  };
}

describe("fulfillment refresh persistence", () => {
  it("restores payment and print identifiers without retaining upload secrets or filenames", () => {
    persistFulfillmentState(fulfillmentState());

    const raw = Array.from({ length: window.sessionStorage.length }, (_, index) =>
      window.sessionStorage.getItem(window.sessionStorage.key(index) ?? "")
    );
    expect(JSON.stringify(raw)).not.toContain("private-upload-bearer-token");
    expect(JSON.stringify(raw)).not.toContain("customer-private-name.pdf");

    const restored = restoreFulfillmentState();
    expect(restored?.session).toMatchObject({ id: sessionId, uploadUrl: "" });
    expect(restored?.payment.payment?.id).toBe(paymentId);
    expect(restored?.print.job?.id).toBe(printJobId);
    expect(restored?.files[0]?.name).toBeNull();
  });

  it("drops malformed or cross-session local state instead of trusting it", () => {
    persistFulfillmentState(fulfillmentState());
    const key = window.sessionStorage.key(0) ?? "";
    const stored = JSON.parse(window.sessionStorage.getItem(key) ?? "{}") as {
      payment?: { sessionId?: string };
    };
    if (stored.payment) stored.payment.sessionId = "01900000-0000-7000-8000-000000000999";
    window.sessionStorage.setItem(key, JSON.stringify(stored));

    expect(restoreFulfillmentState()).toBeNull();
    expect(window.sessionStorage.getItem(key)).toBeNull();
  });

  it("removes the recovery record once the workflow is reset", () => {
    persistFulfillmentState(fulfillmentState());
    persistFulfillmentState(initialPrototypeState);

    expect(restoreFulfillmentState()).toBeNull();
  });
});
