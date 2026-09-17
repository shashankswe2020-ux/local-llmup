import { test, expect } from "./harness";

test.describe("model catalog details", () => {
  test("launches from model details with the displayed context", async ({ page }) => {
    await page.route("**/api/models/recommended?*", async (route) => {
      const response = await route.fetch();
      const data = await response.json();
      data.models = data.models.map((model: Record<string, unknown>) => ({ ...model, contextTokens: 65536, contextFitKnown: true }));
      await route.fulfill({ json: data });
    });
    await page.locator("#refresh-models").click();
    await expect(page.locator(".model-card-item").first().locator(".model-card-meta")).toContainText("65,536 context tokens");
    await page.locator(".model-card-item").first().getByRole("button", { name: /View performance details/ }).click();
    const requests: unknown[] = [];
    await page.route("**/api/models/up", async (route) => { requests.push(route.request().postDataJSON()); await route.fulfill({ json: { active: null } }); });
    page.once("dialog", (dialog) => dialog.accept());
    await page.locator("#model-detail").getByRole("button", { name: "Start model", exact: true }).click();
    await expect.poll(() => requests).toContainEqual(expect.objectContaining({ context: 65536 }));
  });
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Models", exact: true }).click();
    await expect(page.locator(".model-card-item").first()).toBeVisible();
  });

  test("opens complete performance evidence and returns to the catalog", async ({ page }, testInfo) => {
    const firstModel = page.locator(".model-card-item").first();
    const modelName = (await firstModel.locator(".model-card-title").textContent()) ?? "";

    await firstModel.getByRole("button", { name: /View performance details for/ }).click();

    await expect(page.locator("#model-detail")).toBeVisible();
    await expect(page.locator("#model-catalog-panel")).toBeHidden();
    await expect(page.locator("#model-detail-title")).toHaveText(modelName);
    await expect(page.getByRole("heading", { name: "Recommendation score" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Performance & fit" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Model profile" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Quantization options" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Catalog evidence" })).toBeVisible();
    await expect(page.locator(".model-score-row")).toHaveCount(5);
    await expect(page.locator(".model-quant-table tbody tr").first()).toBeVisible();
    await expect(page.getByText("no benchmark result is implied", { exact: false })).toBeVisible();

    await page.screenshot({ path: testInfo.outputPath("model-detail-desktop.png"), fullPage: true });

    await page.getByRole("button", { name: "Back to model catalog" }).click();
    await expect(page.locator("#model-catalog-panel")).toBeVisible();
    await expect(page.locator("#model-detail")).toBeHidden();
  });

  test("keeps the detail dossier usable on a narrow viewport", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator(".model-card-item").first().getByRole("button", { name: /View performance details for/ }).click();

    await expect(page.locator("#model-detail-title")).toBeVisible();
    await expect(page.getByRole("button", { name: "Back to model catalog" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Quantization options" })).toBeVisible();
    await expect(page.locator(".model-detail-metrics")).toHaveCSS("grid-template-columns", /.+/);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);

    await page.screenshot({ path: testInfo.outputPath("model-detail-mobile.png"), fullPage: true });
  });
});
