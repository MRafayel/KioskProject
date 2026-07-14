import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

test("completes the successful print prototype", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".welcome__footer")).toBeInViewport();
  await expectNoHorizontalOverflow(page);
  await switchToEnglish(page);
  await expect(page.getByRole("heading", { name: /Print from your phone/i })).toBeVisible();

  await page.getByRole("button", { name: "Start printing" }).click();
  await expect(page.getByRole("heading", { name: "Upload your document" })).toBeVisible();
  await expect(page.getByRole("timer")).toContainText("02:00");

  await page.getByRole("button", { name: "Simulate phone upload" }).click();
  await expect(page.getByText("sample-document.pdf")).toBeVisible();
  await page.getByRole("button", { name: /Continue to print settings/i }).click();

  await expect(page.getByRole("heading", { name: "Choose print settings" })).toBeVisible();
  await expect(page.getByRole("timer")).toContainText("02:00");
  await expect(page.locator(".session-footer")).toBeInViewport();
  await expectNoHorizontalOverflow(page);
  await expect(page.getByText("Paper size", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Pages per side", { exact: true })).toHaveCount(0);
  await page.getByRole("spinbutton", { name: "From page" }).fill("3");
  await page.getByRole("spinbutton", { name: "To page" }).fill("7");
  await page.getByRole("button", { name: "Increase copies" }).click();
  await page.getByLabel("Double-sided").check();
  await page.getByRole("button", { name: /Review and pay/i }).click();
  await expect(page.getByRole("timer")).toContainText("02:00");

  await page.getByRole("button", { name: /Pay \$1\.50/i }).click();
  await expect(page.getByRole("heading", { name: "Processing payment" })).toBeVisible();
  await expect(page.getByRole("timer")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Printing your document" })).toBeVisible();
  await expect(page.getByRole("timer")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Your documents are ready" })).toBeVisible();
  await expect(page.getByRole("timer")).toBeVisible();

  await page.getByRole("button", { name: "Finish and delete files" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "hy");
  await expect(page.getByRole("button", { name: "Սկսել տպագրությունը" })).toBeVisible();
});

test("offers cancel, browser-back, failure, and retry paths", async ({ page }) => {
  await page.goto("/");
  await switchToEnglish(page);
  await page.getByRole("button", { name: "Start printing" }).click();
  await page.getByRole("button", { name: "Simulate phone upload" }).click();
  await page.getByRole("button", { name: /Continue to print settings/i }).click();

  await page.goBack();
  await expect(page.getByRole("heading", { name: "Upload your document" })).toBeVisible();
  await page.getByRole("button", { name: /Continue to print settings/i }).click();
  await page.getByRole("button", { name: /Review and pay/i }).click();
  await page.getByLabel("Printer error").check();
  await page.getByRole("button", { name: /Pay /i }).click();

  await expect(page.getByRole("heading", { name: "The printer needs attention" })).toBeVisible();
  await page.getByRole("button", { name: "Retry printing" }).click();
  await expect(page.getByRole("heading", { name: "Your documents are ready" })).toBeVisible();

  await page.getByRole("button", { name: "Finish and delete files" }).click();
  await switchToEnglish(page);
  await page.getByRole("button", { name: "Start printing" }).click();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("dialog", { name: "Cancel this print session?" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel session" }).click();
  await expect(page.getByRole("button", { name: "Սկսել տպագրությունը" })).toBeVisible();
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
  await page.getByRole("button", { name: "Նմանակել վերբեռնումը" }).click();
  await page.getByRole("button", { name: "Անցնել տպման կարգավորումներին" }).click();

  await expect(page.getByRole("heading", { name: "Ընտրեք տպման կարգավորումները" })).toBeVisible();
  await page.getByRole("button", { name: "Ստուգել և վճարել" }).click();
  await expect(page.getByRole("heading", { name: "Ստուգեք պատվերը և վճարեք" })).toBeVisible();

  await page.getByRole("button", { name: /Վճարել/ }).click();
  await expect(page.getByRole("heading", { name: "Մշակում ենք վճարումը" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Տպում ենք փաստաթուղթը" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Փաստաթղթերը պատրաստ են" })).toBeVisible();

  await page.getByRole("button", { name: "Ավարտել և հեռացնել ֆայլերը" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "hy");
  await expect(page.getByRole("button", { name: "Սկսել տպագրությունը" })).toBeVisible();
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
