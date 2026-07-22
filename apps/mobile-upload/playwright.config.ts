import { defineConfig } from "@playwright/test";

const previewUrl = "http://127.0.0.1:4174";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: {
    baseURL: previewUrl,
    browserName: "chromium",
    colorScheme: "light",
    trace: "retain-on-failure",
    viewport: { width: 390, height: 844 }
  },
  projects: [{ name: "mobile-390x844" }],
  webServer: {
    command: "pnpm exec vite preview --host 127.0.0.1 --port 4174 --strictPort",
    url: previewUrl,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000
  }
});
