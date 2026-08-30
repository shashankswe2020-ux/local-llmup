import { test, expect } from "./harness";

test.describe("tool approval", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("a proposed tool call must be approved before it runs", async ({ page }) => {
    await page.locator("#prompt").fill("use the TOOL please");
    await page.locator("#prompt").press("Enter");

    const card = page.locator(".tool-card").first();
    await expect(card).toContainText("demo_tool");
    const approve = page.getByRole("button", { name: "Approve" });
    await expect(approve).toBeVisible();
    await approve.click();

    await expect(card).toContainText("Used demo_tool");
    await expect(page.locator(".message.assistant").last()).toContainText("Tool finished. Done.");
  });

  test("a denied tool call does not run", async ({ page }) => {
    await page.locator("#prompt").fill("use the TOOL please");
    await page.locator("#prompt").press("Enter");

    const card = page.locator(".tool-card").first();
    await expect(page.getByRole("button", { name: "Deny" })).toBeVisible();
    await page.getByRole("button", { name: "Deny" }).click();

    await expect(card).toContainText("denied");
    await expect(card).not.toContainText("Used demo_tool");
  });
});
