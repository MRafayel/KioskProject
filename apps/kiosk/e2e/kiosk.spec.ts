import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/agent/v1/sessions**", async (route) => {
    if (route.request().url().endsWith("/cancel")) {
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
      return;
    }

    if (route.request().url().endsWith("/files")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items: [
            {
              id: "01900000-0000-7000-8000-000000000021",
              ordinal: 0,
              status: "QUARANTINED",
              kind: "PDF",
              sizeBytes: 2_400_000,
              createdAt: "2030-01-01T00:00:00.000Z"
            }
          ]
        })
      });
      return;
    }

    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        session: {
          id: "01900000-0000-7000-8000-000000000020",
          publicId: "ps_1234567890abcdef",
          kioskId: "kiosk_dev_001",
          locale: "hy",
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
      })
    });
  });
});

test("receives the phone upload while keeping unvalidated settings locked", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".welcome__footer")).toBeInViewport();
  await expectNoHorizontalOverflow(page);
  await switchToEnglish(page);
  await expect(page.getByRole("heading", { name: /Print from your phone/i })).toBeVisible();

  await page.getByRole("button", { name: "Start printing" }).click();
  await expect(page.getByRole("heading", { name: "Upload your document" })).toBeVisible();
  await expect(page.getByRole("timer")).toContainText("02:00");

  await expect(page.getByText("Document 1.pdf")).toBeVisible();
  await expect(page.getByText("4829 1357")).toHaveCount(0);
  await expect(page.getByText("Received — checking file safety").first()).toBeVisible();
  await expect(page.getByText(/8 pages/i)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Continue to print settings/i })).toBeDisabled();
  await expect(page.getByRole("button", { name: /simulate phone upload/i })).toHaveCount(0);
  await expect(page.locator(".session-footer")).toBeInViewport();
  await expectNoHorizontalOverflow(page);
});

test("offers a safe cancel path while an uploaded file is quarantined", async ({ page }) => {
  await page.goto("/");
  await switchToEnglish(page);
  await page.getByRole("button", { name: "Start printing" }).click();
  await expect(page.getByText("Document 1.pdf")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("dialog", { name: "Cancel this print session?" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel session" }).click();
  await expect(page.getByRole("button", { name: "Սկսել տպագրությունը" })).toBeVisible();
});

test("returns safely to welcome when an expired session is replayed", async ({ page }) => {
  await page.addInitScript(() => {
    const sessionId = "01900000-0000-7000-8000-000000000020";
    class ReplayEventSource {
      public onopen: ((event: Event) => void) | null = null;
      public onerror: ((event: Event) => void) | null = null;
      public onmessage: ((event: MessageEvent) => void) | null = null;

      public constructor() {
        queueMicrotask(() => {
          this.onopen?.(new Event("open"));
          this.emit({
            id: "01900000-0000-7000-8000-000000000091",
            sessionId,
            sequence: 1,
            type: "session.created",
            payload: { sessionId, state: "WAITING_FOR_UPLOAD", version: 1 },
            occurredAt: "2030-01-01T00:00:00.000Z"
          });
          this.emit({
            id: "01900000-0000-7000-8000-000000000092",
            sessionId,
            sequence: 2,
            type: "session.expired",
            payload: { sessionId, state: "EXPIRED", version: 2 },
            occurredAt: "2030-01-01T00:00:01.000Z"
          });
          Reflect.set(window, "__terminalReplayDelivered", true);
        });
      }

      public close(): void {
        return;
      }

      private emit(event: unknown): void {
        this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(event) }));
      }
    }

    Object.defineProperty(window, "EventSource", {
      configurable: true,
      value: ReplayEventSource
    });
  });

  await page.goto("/");
  await switchToEnglish(page);
  await page.getByRole("button", { name: "Start printing" }).click();

  await expect
    .poll(() => page.evaluate(() => Boolean(Reflect.get(window, "__terminalReplayDelivered"))))
    .toBe(true);
  await expect(page.getByRole("button", { name: "Սկսել տպագրությունը" })).toBeVisible();
  await expect(page.getByRole("timer")).toHaveCount(0);
});

test("has keyboard-visible focus and no serious accessibility violations", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Սկսել տպագրությունը" })).toBeFocused();

  const welcomeResults = await new AxeBuilder({ page }).analyze();
  expect(
    welcomeResults.violations.filter(
      (violation) => violation.impact === "critical" || violation.impact === "serious"
    )
  ).toEqual([]);

  await page.getByRole("button", { name: "Սկսել տպագրությունը" }).click();
  await expect(page.getByText("Փաստաթուղթ 1.pdf")).toBeVisible();
  const uploadResults = await new AxeBuilder({ page }).analyze();
  expect(
    uploadResults.violations.filter(
      (violation) => violation.impact === "critical" || violation.impact === "serious"
    )
  ).toEqual([]);
});

test("keeps Russian and Armenian meaningful across the active session", async ({ page }) => {
  await page.goto("/");

  await expect(page.locator("html")).toHaveAttribute("lang", "hy");
  await expect(page.getByRole("button", { name: "English" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Русский" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Հայերեն" })).toHaveCount(0);

  await page.getByRole("button", { name: "Русский" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "ru");
  await expect(
    page.getByRole("heading", { name: "Печатайте с телефона за несколько простых шагов." })
  ).toBeVisible();

  await page.getByRole("button", { name: "Начать печать" }).click();
  await expect(page.getByRole("heading", { name: "Загрузите документ" })).toBeVisible();

  await page.getByRole("button", { name: "Հայերեն" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "hy");
  await expect(page.getByRole("heading", { name: "Վերբեռնեք փաստաթուղթը" })).toBeVisible();
  await expect(page.getByText("Փաստաթուղթ 1.pdf")).toBeVisible();
  await expect(
    page.getByText("Ֆայլը ստացվել է․ անվտանգության ստուգում է կատարվում").first()
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Անցնել տպման կարգավորումներին" })).toBeDisabled();
});

async function switchToEnglish(page: Page): Promise<void> {
  await page.getByRole("button", { name: "English" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const fitsViewport = await page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
  );
  expect(fitsViewport).toBe(true);
}
