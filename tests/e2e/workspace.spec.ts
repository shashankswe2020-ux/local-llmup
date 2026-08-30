import { test, expect } from "./harness";
import { E2E_WORKSPACE_DIR } from "./fixtures";

test.describe("workspace context", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("registers a root, searches, attaches a file, and shows the ledger", async ({ page }) => {
    // The context bar is progressive-disclosure: hidden until workspace is ready.
    await expect(page.locator("#context-bar")).toBeVisible();
    await page.locator("#context-add").click();

    // No root yet: register the fixture workspace by confirmed path.
    await page.locator("#context-root-path").fill(E2E_WORKSPACE_DIR);
    await page.locator("#context-root-add").click();

    // Search then attach a file.
    const search = page.locator("#context-search");
    await expect(search).toBeVisible();
    await search.fill("app");
    const result = page.locator(".context-result", { hasText: "src/app.ts" });
    await expect(result).toBeVisible();
    await result.click();

    // A removable chip appears for the attachment.
    await expect(page.locator(".context-chip", { hasText: "app.ts" })).toBeVisible();

    // Sending surfaces the honest context ledger.
    await page.locator("#prompt").fill("review this file");
    await page.locator("#prompt").press("Enter");
    await expect(page.locator(".context-ledger")).toContainText("1 of 1");
  });
});
