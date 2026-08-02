import { describe, expect, it } from "vitest";

import { messages } from "./messages.js";

describe("Armenian dynamic messages", () => {
  const armenian = messages.hy;

  it("keeps page-count labels natural for one and many pages", () => {
    expect(armenian.configure.allPages(1)).toBe("Միակ էջը");
    expect(armenian.configure.allPages(8)).toBe("Բոլոր էջերը (1–8)");
    expect(armenian.configure.previewExcludedCount(2)).toBe("Տպումից հանված էջերի քանակը՝ 2։");
    expect(armenian.checkout.selectedPages(3)).toBe("Ընտրված էջերի քանակը՝ 3");
  });

  it("uses a dedicated singular sentence for one printed sheet", () => {
    expect(armenian.status.collectSheets(1)).toBe("Վերցրեք տպված թերթը ներքևի դարակից։");
    expect(armenian.status.collectSheets(4)).toBe(
      "Ներքևի դարակում 4 տպված թերթ կա։ Վերցրեք բոլորը։"
    );
  });

  it("places timer values without changing the Armenian noun form", () => {
    expect(armenian.idle.countdown(1)).toBe("Մնացել է 1 վայրկյան");
    expect(armenian.idle.countdown(120)).toBe("Մնացել է 120 վայրկյան");
  });
});
