import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("completes the successful print prototype", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Print from your phone/i })).toBeVisible();

  await page.getByRole("button", { name: "Start printing" }).click();
  await expect(page.getByRole("heading", { name: "Upload your document" })).toBeVisible();

  await page.getByRole("button", { name: "Simulate phone upload" }).click();
  await expect(page.getByText("sample-document.pdf")).toBeVisible();
  await page.getByRole("button", { name: /Continue to print settings/i }).click();

  await expect(page.getByRole("heading", { name: "Choose print settings" })).toBeVisible();
  await page.getByRole("button", { name: "Increase copies" }).click();
  await page.getByLabel("Double-sided").check();
  await page.getByRole("button", { name: /Review and pay/i }).click();

  await page.getByRole("button", { name: /Pay \$2\.40/i }).click();
  await expect(page.getByRole("heading", { name: "Processing payment" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Printing your document" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Your documents are ready" })).toBeVisible();

  await page.getByRole("button", { name: "Finish and delete files" }).click();
  await expect(page.getByRole("button", { name: "Start printing" })).toBeVisible();
});

test("offers cancel, browser-back, failure, and retry paths", async ({ page }) => {
  await page.goto("/");
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
  await page.getByRole("button", { name: "Start printing" }).click();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("dialog", { name: "Cancel this print session?" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel session" }).click();
  await expect(page.getByRole("button", { name: "Start printing" })).toBeVisible();
});

test("has keyboard-visible focus and no serious accessibility violations", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Start printing" })).toBeFocused();

  const welcomeResults = await new AxeBuilder({ page }).analyze();
  expect(
    welcomeResults.violations.filter(
      (violation) => violation.impact === "critical" || violation.impact === "serious"
    )
  ).toEqual([]);

  await page.getByRole("button", { name: "Start printing" }).click();
  const uploadResults = await new AxeBuilder({ page }).analyze();
  expect(
    uploadResults.violations.filter(
      (violation) => violation.impact === "critical" || violation.impact === "serious"
    )
  ).toEqual([]);
});
