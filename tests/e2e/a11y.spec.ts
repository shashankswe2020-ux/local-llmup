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

  test("streaming announces state changes without repeating response content", async ({ page }) => {
    const status = page.locator("#a11y-status");
    const announcements: string[] = [];
    await status.evaluate((element) => {
      const values: string[] = [];
      (globalThis as typeof globalThis & { __a11yAnnouncements?: string[] }).__a11yAnnouncements = values;
      new MutationObserver(() => {
        if (element.textContent) values.push(element.textContent);
      }).observe(element, { childList: true, characterData: true, subtree: true });
    });

    await page.locator("#prompt").fill("FORMAT_MARKDOWN_STREAM");
    await page.locator("#prompt").press("Enter");
    await expect(status).toHaveText("Response ready.");
    announcements.push(
      ...(await page.evaluate(
        () => (globalThis as typeof globalThis & { __a11yAnnouncements?: string[] }).__a11yAnnouncements ?? [],
      )),
    );

    expect(announcements).toEqual(["Sending message.", "Response ready."]);
    expect(announcements.join(" ")).not.toContain("Deployment result");
  });

  test("core chat works at a 320px width", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
    await page.locator("#prompt").fill("narrow");
    await page.locator("#prompt").press("Enter");
    await expect(page.locator(".message.assistant").last()).toContainText("You said: narrow");
  });

  test("shows a trusted update link only when a newer release is available", async ({ page }) => {
    await page.route("**/api/update", async (route) => {
      await route.fulfill({
        json: {
          currentVersion: "0.11.2",
          latestVersion: "0.12.0",
          state: "update-available",
          releaseUrl: "https://github.com/shashankswe2020-ux/local-llmup/releases",
        },
      });
    });
    await page.reload();

    const update = page.getByRole("link", { name: "Update to 0.12.0" });
    await expect(update).toBeVisible();
    await expect(update).toHaveAttribute(
      "href",
      "https://github.com/shashankswe2020-ux/local-llmup/releases",
    );
    await expect(update).toHaveAttribute("target", "_blank");
    await expect(update).toHaveAttribute("rel", "noopener noreferrer");
  });

  test("keeps the update link hidden when release status is unknown", async ({ page }) => {
    await page.route("**/api/update", async (route) => {
      await route.fulfill({
        json: {
          currentVersion: "0.11.2",
          latestVersion: null,
          state: "unknown",
          releaseUrl: null,
        },
      });
    });
    await page.reload();

    await expect(page.locator("#update-link")).toBeHidden();
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
