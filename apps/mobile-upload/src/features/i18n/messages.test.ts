import { describe, expect, it } from "vitest";

import { interpolate, messages } from "./messages.js";

describe("Armenian mobile-upload messages", () => {
  it("places time, size, progress, and ordinal values naturally", () => {
    expect(interpolate(messages.hy.expires, { time: "18:30" })).toBe(
      "Կարող եք ֆայլ վերբեռնել մինչև 18:30"
    );
    expect(interpolate(messages.hy.fileHint, { size: "20 ՄԲ" })).toBe(
      "PDF, JPEG կամ PNG · մինչև 20 ՄԲ"
    );
    expect(interpolate(messages.hy.uploadProgress, { percent: 75 })).toBe("Վերբեռնվել է 75%");
    expect(interpolate(messages.hy.document, { number: 2 })).toBe("Փաստաթուղթ 2");
  });
});
