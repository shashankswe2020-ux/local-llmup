import { defineConfig, devices } from "@playwright/test";
import { E2E_BASE_URL, E2E_PORT } from "./tests/e2e/fixtures.js";

/**
 * Deterministic, development-only browser + Electron journeys (task 32.13).
 * Serves the real loopback GuiServer with fakes — never a cloud API or Ollama.
 * Kept separate from the fast unit/integration suite (vitest, `npm test`).
 */
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  // Real-browser journeys run against one shared live server; a single retry
  // absorbs inherent timing flakiness without masking reproducible failures.
  retries: process.env.CI ? 2 : 1,
  timeout: 30_000,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: E2E_BASE_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `E2E_PORT=${E2E_PORT} npx tsx tests/e2e/server.ts`,
    url: E2E_BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
