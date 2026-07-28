import { describe, expect, it } from "vitest";

import { safeProcessorError } from "./errors.js";

describe("safeProcessorError", () => {
  it.each(["ENOSPC", "EDQUOT", "EFBIG"])(
    "maps the private %s capacity failure to a retryable infrastructure code",
    (code) => {
      const error = Object.assign(new Error("private filesystem detail"), { code });

      expect(safeProcessorError(error)).toMatchObject({
        code: "PROCESSOR_CAPACITY_EXHAUSTED",
        statusCode: 503,
        retryable: true
      });
    }
  );

  it("does not expose an unexpected private error", () => {
    expect(safeProcessorError(new Error("private parser detail"))).toMatchObject({
      code: "INTERNAL_ERROR",
      statusCode: 500,
      retryable: true
    });
  });
});
