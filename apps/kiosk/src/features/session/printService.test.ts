import { describe, expect, it } from "vitest";

import { isRetryablePrintFailure, PrintRequestError } from "./printService.js";

describe("print failure retry classification", () => {
  it.each([408, 425, 429, 500, 503])("treats HTTP %s as transient", (status) => {
    expect(isRetryablePrintFailure(new PrintRequestError("TEMPORARY", status))).toBe(true);
  });

  it.each([400, 401, 403, 404, 409, 422])(
    "treats deterministic HTTP %s refusals as operator-required",
    (status) => {
      expect(isRetryablePrintFailure(new PrintRequestError("REJECTED", status))).toBe(false);
    }
  );

  it("keeps an ambiguous network failure retryable", () => {
    expect(isRetryablePrintFailure(new TypeError("connection reset"))).toBe(true);
  });
});
