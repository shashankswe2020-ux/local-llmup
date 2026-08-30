import { test, expect } from "./harness";

test.describe("chat lifecycle", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    // Sessions persist server-side; start each journey in a fresh conversation.
    const newChat = page.locator("#session-new");
    if (await newChat.isVisible()) {
      await newChat.click();
      await expect(page.locator(".message")).toHaveCount(0);
    }
  });

  test("sends a message and shows the assistant reply", async ({ page }) => {
    await page.locator("#prompt").fill("hello world");
    await page.locator("#prompt").press("Enter");
    await expect(page.locator(".message.assistant .message-body").last()).toContainText("You said: hello world");
  });

  test("keeps prior turns across a multi-turn exchange", async ({ page }) => {
    await page.locator("#prompt").fill("first message");
    await page.locator("#prompt").press("Enter");
    await expect(page.locator(".message.assistant").last()).toContainText("You said: first message");

    await page.locator("#prompt").fill("second message");
    await page.locator("#prompt").press("Enter");
    await expect(page.locator(".message.assistant").last()).toContainText("You said: second message");

    await expect(page.locator(".message.user")).toHaveCount(2);
    await expect(page.locator(".message.assistant")).toHaveCount(2);
  });

  test("stops an in-flight run and offers a recoverable retry", async ({ page }) => {
    await page.locator("#prompt").fill("SLOW please");
    await page.locator("#prompt").press("Enter");

    const stop = page.locator(".send-btn.is-stop");
    await expect(stop).toBeVisible();
    await stop.click();

    // The run resolves to a recoverable, retryable state.
    await expect(page.locator(".run-notice")).toContainText("Stopped.");
    await expect(page.locator(".retry-btn")).toBeVisible();
  });
});
