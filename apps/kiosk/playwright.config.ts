import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:5173",
    browserName: "chromium",
    colorScheme: "light",
    trace: "retain-on-failure"
  },
  projects: [
    { name: "kiosk-1280x800", use: { viewport: { width: 1280, height: 800 } } },
    { name: "kiosk-1920x1080", use: { viewport: { width: 1920, height: 1080 } } }
  ],
  webServer: {
    command: "pnpm dev",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000
  }
});
