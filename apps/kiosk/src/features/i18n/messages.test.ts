import { describe, expect, it } from "vitest";

import { messages } from "./messages.js";

describe("terminal retention messages", () => {
  it.each([
    [
      "en" as const,
      "Nothing was printed. Your payment has been recorded for a refund, and your documents are scheduled for secure deletion.",
      "Secure deletion scheduled",
      "Finish"
    ],
    [
      "ru" as const,
      "Ничего не напечатано. Возврат средств зафиксирован, а документы поставлены в очередь на безопасное удаление.",
      "Безопасное удаление запланировано",
      "Завершить"
    ],
    [
      "hy" as const,
      "Ոչինչ չի տպվել։ Գումարի վերադարձը գրանցված է, իսկ փաստաթղթերի անվտանգ հեռացումը նախատեսված է։",
      "Անվտանգ հեռացումը նախատեսված է",
      "Ավարտել"
    ]
  ])(
    "%s describes deletion as scheduled instead of immediate",
    (locale, printerErrorDescription, deletionScheduled, finish) => {
      expect(messages[locale].status.printerErrorDescription).toBe(printerErrorDescription);
      expect(messages[locale].status.deletionScheduled).toBe(deletionScheduled);
      expect(messages[locale].status.finish).toBe(finish);
    }
  );

  it.each([
    [
      "en" as const,
      "Print status is temporarily unavailable",
      "PRINT STATUS UNKNOWN",
      "Retry printing"
    ],
    [
      "ru" as const,
      "Статус печати временно недоступен",
      "СТАТУС ПЕЧАТИ НЕИЗВЕСТЕН",
      "Повторить печать"
    ],
    [
      "hy" as const,
      "Տպման կարգավիճակը ժամանակավորապես հասանելի չէ",
      "ՏՊՄԱՆ ԿԱՐԳԱՎԻՃԱԿՆ ԱՆՀԱՅՏ Է",
      "Կրկնել տպումը"
    ]
  ])(
    "%s distinguishes an unavailable print status from a settled failure",
    (locale, title, code, retry) => {
      const status = messages[locale].status;
      expect(status.printerStatusUnavailableTitle).toBe(title);
      expect(status.printerStatusUnavailableCode).toBe(code);
      expect(status.retryPrinting).toBe(retry);
      expect(status.printerStatusUnavailableDescription).not.toMatch(/refund|возврат|վերադարձ/iu);
      expect(status.printerStatusUnavailableDescription).not.toMatch(/delet|удален|հեռաց|ջնջ/iu);
    }
  );

  it.each([
    [
      "en" as const,
      "Printing needs operator assistance",
      "PRINT REQUEST BLOCKED",
      "Do not pay again · An operator must verify the paid session."
    ],
    [
      "ru" as const,
      "Для печати нужна помощь оператора",
      "ЗАПРОС ПЕЧАТИ ЗАБЛОКИРОВАН",
      "Не оплачивайте повторно · Оператор должен проверить оплаченный сеанс."
    ],
    [
      "hy" as const,
      "Տպումը շարունակելու համար սպասարկողի օգնությունն է պետք",
      "ՏՊՄԱՆ ՀԱՐՑՈՒՄԸ ՉԻ ԸՆԴՈՒՆՎԵԼ",
      "Կրկին մի վճարեք · Սպասարկողը պետք է ստուգի վճարված սեանսը։"
    ]
  ])(
    "%s directs deterministic print refusals to an operator without claiming settlement",
    (locale, title, code, detail) => {
      const status = messages[locale].status;
      expect(status.printerOperatorRequiredTitle).toBe(title);
      expect(status.printerOperatorRequiredCode).toBe(code);
      expect(status.printerOperatorRequiredDetail).toBe(detail);
      expect(status.printerOperatorRequiredDescription).not.toMatch(/refund|возврат|վերադարձ/iu);
      expect(status.printerOperatorRequiredDescription).not.toMatch(/delet|удален|հեռաց|ջնջ/iu);
    }
  );
});

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
