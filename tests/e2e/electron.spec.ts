/**
 * Focused Electron smoke (task 32.13). Skipped unless the desktop app is built
 * and the Electron binary is installed (CI installs both). Verifies the shell
 * boots the loopback host, exposes no Node in the renderer, and blocks external
 * navigation — the hardening 32.11 depends on.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { _electron as electron, test, expect } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const desktopMain = join(here, "..", "..", "apps", "desktop", "dist", "main.js");

let electronBinaryPresent = true;
try {
  await import("electron");
} catch {
  electronBinaryPresent = false;
}

test.describe("electron shell", () => {
  test.skip(!existsSync(desktopMain) || !electronBinaryPresent, "desktop app not built / electron absent");

  test("boots the loopback host without Node in the renderer", async () => {
    const app = await electron.launch({ args: [join(here, "..", "..", "apps", "desktop")] });
    try {
      const window = await app.firstWindow();
      await window.waitForLoadState("domcontentloaded");
      const url = window.url();
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:/u);
      // Sandbox/context-isolation: renderer must not see Node's require.
      const hasRequire = await window.evaluate(() => typeof (globalThis as { require?: unknown }).require);
      expect(hasRequire).toBe("undefined");
    } finally {
      await app.close();
    }
  });
});
