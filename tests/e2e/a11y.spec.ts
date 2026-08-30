import { test, expect } from "./harness";

test.describe("accessibility and responsive", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("composer and send have accessible names", async ({ page }) => {
    await expect(page.getByRole("textbox", { name: "Message the local model" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
    await expect(page.locator("#messages")).toHaveAttribute("role", "log");
  });

  test("run completion is announced in a polite status region", async ({ page }) => {
    await page.locator("#prompt").fill("hello");
    await page.locator("#prompt").press("Enter");
    await expect(page.locator("#messages")).toContainText("You said: hello");
    await expect(page.locator("#a11y-status")).toHaveText("Response ready.");
  });

  test("core chat works at a 320px width", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
    await page.locator("#prompt").fill("narrow");
    await page.locator("#prompt").press("Enter");
    await expect(page.locator(".message.assistant").last()).toContainText("You said: narrow");
  });

  test("the context picker traps focus and closes on Escape", async ({ page }) => {
    await page.locator("#context-add").click();
    await expect(page.locator("#context-picker")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#context-picker")).toBeHidden();
    // Focus returns to the trigger.
    await expect(page.locator("#context-add")).toBeFocused();
  });
});
