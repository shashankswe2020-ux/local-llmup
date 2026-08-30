/**
 * Playwright test harness: a `page` fixture that fails the test on any console
 * error or uncaught page error, per the 32.13 acceptance criteria.
 */
import { test as base, expect } from "@playwright/test";

export const test = base.extend({
  page: async ({ page }, use) => {
    const errors: string[] = [];
    page.on("console", (message) => {
      if (message.type() !== "error") {
        return;
      }
      const text = message.text();
      // Benign, expected network noise: a missing favicon, and the aborted
      // request that a user-initiated Stop deliberately cancels.
      if (text.includes("favicon") || text.includes("ERR_ABORTED")) {
        return;
      }
      errors.push(text);
    });
    page.on("pageerror", (error) => {
      errors.push(String(error));
    });
    await use(page);
    expect(errors, `unexpected console errors:\n${errors.join("\n")}`).toEqual([]);
  },
});

export { expect };
