import { expect, test, type Page, type Route } from "@playwright/test";

const publicSessionId = "ps_1234567890abcdef";
const sessionId = "01900000-0000-7000-8000-000000000071";
const fileId = "01900000-0000-7000-8000-000000000072";
const uploadToken = `u_${"T".repeat(43)}`;
const mobileCookie = `m_${"C".repeat(43)}`;
const mobileCookieName = `pk_upload_${sessionId.replaceAll("-", "")}`;
const csrfToken = `c_${"S".repeat(43)}`;
const syntheticPdf = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n", "utf8");

test("keeps the QR bearer private through a responsive upload, delete, and refresh", async ({
  page
}) => {
  let filePresent = false;
  let exchangeRequests = 0;
  let contextRequests = 0;
  let hashAtExchange: string | null = null;
  const observedRequests: Array<{ url: string; body: string | null }> = [];
  const browserErrors: string[] = [];

  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  await page.route("**/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    observedRequests.push({ url: request.url(), body: request.postData() });

    if (path === "/v1/mobile-auth/exchange" && request.method() === "POST") {
      exchangeRequests += 1;
      hashAtExchange = new URL(page.url()).hash;
      expect(request.postDataJSON()).toMatchObject({ publicSessionId, uploadToken });
      await fulfillJson(route, mobileContext(), {
        "set-cookie": `${mobileCookieName}=${mobileCookie}; Path=/v1; HttpOnly; SameSite=Strict`
      });
      return;
    }

    if (path.endsWith("/events/stream")) {
      await fulfillIdleEventStream(route);
      return;
    }

    if (path.includes("/mobile-auth/") && path.endsWith("/context")) {
      contextRequests += 1;
      expect(request.headers().cookie).toContain(`${mobileCookieName}=${mobileCookie}`);
      await fulfillJson(route, mobileContext());
      return;
    }

    if (path === `/v1/sessions/${sessionId}/files` && request.method() === "GET") {
      await fulfillJson(route, { items: filePresent ? [fileSnapshot()] : [] });
      return;
    }

    if (path === `/v1/sessions/${sessionId}/files` && request.method() === "POST") {
      expect(request.headers()["x-csrf-token"]).toBe(csrfToken);
      expect(request.headers()["x-client-file-id"]).toMatch(uuidPattern);
      expect(request.headers()["idempotency-key"]).toMatch(uuidPattern);
      expect(request.postDataBuffer()?.includes(syntheticPdf)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 300));
      filePresent = true;
      await fulfillJson(route, { file: fileSnapshot() }, {}, 202);
      return;
    }

    if (path === `/v1/sessions/${sessionId}/files/${fileId}` && request.method() === "DELETE") {
      expect(request.headers()["x-csrf-token"]).toBe(csrfToken);
      expect(request.headers()["idempotency-key"]).toMatch(uuidPattern);
      filePresent = false;
      await route.fulfill({ status: 204 });
      return;
    }

    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "UNEXPECTED_TEST_REQUEST" } })
    });
  });

  await page.goto(`/s/${publicSessionId}#t=${uploadToken}`);

  await expect(page).toHaveURL(new RegExp(`/s/${publicSessionId}$`));
  await expect(page.locator("html")).toHaveAttribute("lang", "ru");
  await expect(page.getByRole("heading", { name: "Загрузите файл для печати" })).toBeVisible();
  expect(await page.evaluate(() => window.location.hash)).toBe("");
  expect(hashAtExchange).toBe("");
  await expectNoHorizontalOverflow(page);
  await expect(page.locator(".transfer-card")).toBeInViewport();
  expect((await page.locator(".transfer-card").boundingBox())?.width).toBeLessThanOrEqual(390);
  expect(await page.locator("body").evaluate((element) => getComputedStyle(element).margin)).toBe(
    "0px"
  );
  await expect(page.locator("body")).not.toContainText(uploadToken);
  expect(await page.content()).not.toContain(uploadToken);
  expect(await browserStorageText(page)).not.toContain(uploadToken);
  expect(await page.evaluate(() => document.cookie)).not.toContain("pk_upload");

  const cookie = (await page.context().cookies()).find(
    (candidate) => candidate.name === mobileCookieName
  );
  expect(cookie).toMatchObject({ value: mobileCookie, httpOnly: true, sameSite: "Strict" });
  expect(cookie?.value).not.toContain(uploadToken);

  await page.locator('input[type="file"]').setInputFiles({
    name: "synthetic.pdf",
    mimeType: "application/pdf",
    buffer: syntheticPdf
  });
  await expect(page.getByRole("progressbar", { name: "Передаём файл" })).toBeVisible();
  await expect(page.getByRole("status")).toContainText(
    "Файл передан и уже отображается на терминале печати"
  );
  await expect(page.getByText("Документ 1", { exact: true })).toBeVisible();
  await expect(page.getByText(/Принят · проверяется/)).toBeVisible();

  await page.getByRole("button", { name: "Удалить" }).click();
  await expect(page.getByText("Вы пока не передали ни одного файла.")).toBeVisible();

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "ru");
  await expect(page.getByRole("heading", { name: "Загрузите файл для печати" })).toBeVisible();
  expect(exchangeRequests).toBe(1);
  expect(contextRequests).toBeGreaterThanOrEqual(2);
  expect(await page.evaluate(() => document.cookie)).not.toContain("pk_upload");
  expect(await browserStorageText(page)).not.toContain(uploadToken);
  expect(observedRequests.every((request) => !request.url.includes(uploadToken))).toBe(true);
  expect(
    observedRequests
      .filter((request) => request.body?.includes(uploadToken))
      .map((request) => request.url)
  ).toEqual([expect.stringContaining("/v1/mobile-auth/exchange")]);
  expect(browserErrors).toEqual([]);
});

test("stops before uploading when the kiosk has canceled the session", async ({ page }) => {
  let canceled = false;
  let uploadRequests = 0;

  await page.route("**/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;

    if (path === "/v1/mobile-auth/exchange") {
      await fulfillJson(route, mobileContext(), {
        "set-cookie": `${mobileCookieName}=${mobileCookie}; Path=/v1; HttpOnly; SameSite=Strict`
      });
      return;
    }
    if (path.endsWith("/events/stream")) {
      await fulfillIdleEventStream(route);
      return;
    }
    if (path.includes("/mobile-auth/") && path.endsWith("/context")) {
      if (canceled) {
        await fulfillJson(
          route,
          {
            error: {
              code: "INVALID_MOBILE_SESSION",
              message: "Mobile authentication failed.",
              requestId: "test"
            }
          },
          {},
          401
        );
      } else {
        await fulfillJson(route, mobileContext());
      }
      return;
    }
    if (path === `/v1/sessions/${sessionId}/files` && request.method() === "GET") {
      await fulfillJson(route, { items: [] });
      return;
    }
    if (path === `/v1/sessions/${sessionId}/files` && request.method() === "POST") {
      uploadRequests += 1;
      await fulfillJson(route, { error: { code: "TEST_UPLOAD_MUST_NOT_START" } }, {}, 500);
      return;
    }
    await route.fulfill({ status: 404 });
  });

  await page.goto(`/s/${publicSessionId}#t=${uploadToken}`);
  await expect(page.getByRole("heading", { name: "Загрузите файл для печати" })).toBeVisible();
  canceled = true;

  await page.locator('input[type="file"]').setInputFiles({
    name: "synthetic.pdf",
    mimeType: "application/pdf",
    buffer: syntheticPdf
  });

  await expect(page.getByText("Сеанс печати завершён")).toBeVisible();
  await expect(page.getByText(/больше не принимает файлы/)).toBeVisible();
  await expect(page.getByText(/Сеанс доступен до/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Выбрать файл" })).toBeDisabled();
  await expect(page.getByRole("progressbar")).toBeHidden();
  expect(uploadRequests).toBe(0);
});

test("pushes kiosk cancellation to the phone and aborts an active upload", async ({ page }) => {
  let releaseCancellation: () => void = () => undefined;
  const cancellation = new Promise<void>((resolve) => {
    releaseCancellation = resolve;
  });
  let markUploadStarted: () => void = () => undefined;
  const uploadStarted = new Promise<void>((resolve) => {
    markUploadStarted = resolve;
  });
  let uploadRequests = 0;
  let failedUploadRequest = false;

  page.on("requestfailed", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === `/v1/sessions/${sessionId}/files`
    ) {
      failedUploadRequest = true;
    }
  });

  await page.route("**/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;

    if (path === "/v1/mobile-auth/exchange") {
      await fulfillJson(route, mobileContext(), {
        "set-cookie": `${mobileCookieName}=${mobileCookie}; Path=/v1; HttpOnly; SameSite=Strict`
      });
      return;
    }
    if (path.endsWith("/events/stream")) {
      await cancellation;
      const event = {
        id: "01900000-0000-7000-8000-000000000079",
        sessionId,
        sequence: 3,
        type: "session.canceled",
        payload: { sessionId, state: "CANCELED", version: 2 },
        occurredAt: "2030-01-01T00:00:03.000Z"
      };
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        headers: { "cache-control": "no-store" },
        body: `id: 3\ndata: ${JSON.stringify(event)}\n\n`
      });
      return;
    }
    if (path.includes("/mobile-auth/") && path.endsWith("/context")) {
      await fulfillJson(route, mobileContext());
      return;
    }
    if (path === `/v1/sessions/${sessionId}/files` && request.method() === "GET") {
      await fulfillJson(route, { items: [] });
      return;
    }
    if (path === `/v1/sessions/${sessionId}/files` && request.method() === "POST") {
      uploadRequests += 1;
      markUploadStarted();
      await cancellation;
      await new Promise((resolve) => setTimeout(resolve, 500));
      try {
        await fulfillJson(
          route,
          {
            error: {
              code: "UPLOAD_SESSION_NOT_EDITABLE",
              message: "This session no longer accepts files."
            }
          },
          {},
          409
        );
      } catch {
        // The expected XMLHttpRequest abort can close the intercepted request first.
      }
      return;
    }
    await route.fulfill({ status: 404 });
  });

  await page.goto(`/s/${publicSessionId}#t=${uploadToken}`);
  await page.locator('input[type="file"]').setInputFiles({
    name: "synthetic.pdf",
    mimeType: "application/pdf",
    buffer: syntheticPdf
  });
  await uploadStarted;
  await expect(page.getByRole("progressbar", { name: "Передаём файл" })).toBeVisible();

  releaseCancellation();

  await expect(page.getByText("Сеанс печати завершён")).toBeVisible();
  await expect(page.getByText(/больше не принимает файлы/)).toBeVisible();
  await expect(page.getByRole("progressbar")).toBeHidden();
  await expect(page.getByRole("button", { name: "Выбрать файл" })).toBeDisabled();
  await expect.poll(() => failedUploadRequest).toBe(true);
  expect(uploadRequests).toBe(1);
});

function mobileContext() {
  return {
    session: {
      id: sessionId,
      publicId: publicSessionId,
      locale: "ru",
      state: "WAITING_FOR_UPLOAD",
      version: 1,
      expiresAt: "2030-01-01T00:10:00.000Z",
      hardExpiresAt: "2030-01-01T00:30:00.000Z"
    },
    csrfToken,
    limits: {
      maxFiles: 1,
      maxFileBytes: 10_485_760,
      maxTotalBytes: 10_485_760,
      allowedMimeTypes: ["application/pdf", "image/jpeg", "image/png"]
    }
  };
}

function fileSnapshot() {
  return {
    id: fileId,
    ordinal: 0,
    status: "QUARANTINED",
    kind: "PDF",
    sizeBytes: syntheticPdf.byteLength,
    createdAt: "2030-01-01T00:00:00.000Z"
  };
}

async function fulfillJson(
  route: Route,
  body: unknown,
  headers: Record<string, string> = {},
  status = 200
): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    headers,
    body: JSON.stringify(body)
  });
}

async function fulfillIdleEventStream(route: Route): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: "text/event-stream",
    headers: { "cache-control": "no-store" },
    body: "retry: 60000\n: connected\n\n"
  });
}

function browserStorageText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const values = [window.localStorage, window.sessionStorage].flatMap((storage) =>
      Array.from({ length: storage.length }, (_, index) =>
        storage.getItem(storage.key(index) ?? "")
      )
    );
    return values.join(" ");
  });
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
    )
  ).toBe(true);
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
