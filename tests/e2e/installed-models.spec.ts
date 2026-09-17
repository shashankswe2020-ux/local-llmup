import { test, expect } from "./harness";

for (const width of [1280, 390]) {
  test(`installed model context and bypass at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const requests: unknown[] = [];
    await page.route("**/api/models/installed?*", async (route) =>
      route.fulfill({
        json: {
          models: [
            {
              id: "gemma4:e4b-it-qat",
              quant: "Q4_0",
              context: 65536,
              contextLength: 131072,
              sizeBytes: 3_000_000_000,
              requiredBytes: null,
              usableBytes: 8_000_000_000,
              memoryKind: "vram",
              weightsFit: true,
              fit: "unknown",
              throughput: "unknown",
            },
          ],
        },
      }),
    );
    await page.route("**/api/models/up", async (route) => {
      requests.push(route.request().postDataJSON());
      await route.fulfill({
        json: {
          active: {
            modelId: "gemma4:e4b-it-qat",
            runtimeModelId: "llmup-context-test:65536",
            context: 65536,
            backend: "ollama",
            endpoint: "http://127.0.0.1:11435",
            port: 11435,
            ownership: "attached",
          },
        },
      });
    });
    await page.goto("/");
    await page.getByRole("button", { name: "Models", exact: true }).click();
    await page.locator("#model-source").selectOption("installed");
    await page.locator("#context-window").selectOption("custom");
    await page.locator("#context-tokens").fill("65536");
    await page.locator("#installed-port").fill("11435");
    await page.locator("#refresh-models").click();
    await expect(page.getByText("gemma4:e4b-it-qat", { exact: true }).last()).toBeVisible();
    await expect(page.locator("#recommended-list")).toContainText("Context fit unknown");
    await page.locator("#models-fit-only").check();
    await expect(page.locator("#recommended-list")).toContainText("No installed models match");
    await page.locator("#models-fit-only").uncheck();
    await page.locator("#model-bypass").check();
    await expect(
      page.locator("#recommended-list").getByRole("button", { name: "Start" }),
    ).toBeEnabled();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`installed-${width}.png`), fullPage: true });
    page.once("dialog", async (dialog) => {
      expect(dialog.message()).toContain("65536");
      expect(dialog.message()).toContain("integrity");
      await dialog.accept();
    });
    await page.locator("#recommended-list").getByRole("button", { name: "Start" }).click();
    await expect
      .poll(() => requests)
      .toContainEqual({
        model: "gemma4:e4b-it-qat",
        backend: "ollama",
        context: 65536,
        bypass: true,
        installed: true,
        port: 11435,
      });
  });
}
