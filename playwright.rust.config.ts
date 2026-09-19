import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.RUST_GUI_TEST_PORT ?? "4322");
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests/e2e-native",
  workers: 1,
  retries: 0,
  timeout: 30_000,
  use: { baseURL, screenshot: "only-on-failure", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "cargo run --locked -p llmup-gui --example browser_fixture",
    env: { RUST_GUI_TEST_PORT: String(port) },
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
