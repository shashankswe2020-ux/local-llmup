import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/update", (route) =>
    route.fulfill({
      json: { state: "unknown", currentVersion: "0.11.4", latestVersion: null, releaseUrl: null },
    }),
  );
  await page.goto("/");
  const created = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/sessions") && response.request().method() === "POST",
  );
  await page.locator("#session-new").click();
  const response = await created;
  expect(response.status()).toBe(201);
  const data = await response.json();
  expect(data.session.id).toMatch(/^[a-f0-9-]{36}$/);
  await expect(
    page.locator(`.rail-session-item.active[data-session-id="${data.session.id}"]`),
  ).toBeVisible();
  await expect(page.locator(".message")).toHaveCount(0);
});

test("native SSE persists replies, restores history, and announces completion", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.getByRole("textbox", { name: "Message the local model" }).fill("checkpoint five");
  await page.locator("#prompt").press("Enter");
  await expect(page.locator(".message.assistant").last()).toContainText(
    "Native reply: checkpoint five",
  );
  await expect(page.locator("#a11y-status")).toHaveText("Response ready.");
  await page.reload();
  await expect(page.locator(".message.assistant").last()).toContainText(
    "Native reply: checkpoint five",
  );
  await expect(page.locator(".message.user")).toHaveCount(1);
  expect(errors).toEqual([]);
});

test("native cancellation leaves no incomplete exchange in persisted history", async ({ page }) => {
  await page.locator("#prompt").fill("cancel this response");
  await page.locator("#prompt").press("Enter");
  await expect(page.locator(".message.assistant")).toContainText("Pending fixture response");
  await page.locator(".send-btn.is-stop").click();
  await expect(page.locator(".run-notice")).toContainText("Stopped.");
  await page.reload();
  await expect(page.locator(".message")).toHaveCount(0);
});

test("keyboard context dismissal and narrow layout work against the native host", async ({
  page,
}) => {
  await page.locator("#context-add").click();
  await expect(page.locator("#context-picker")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#context-add")).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.screenshot({ path: "test-results/native-mobile.png" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(page.locator("#metrics-state[data-state='live']")).toBeVisible();
  await expect(page.locator(".metric-chart")).toHaveCount(7);
  await page.screenshot({ path: "test-results/native-desktop.png" });
});
