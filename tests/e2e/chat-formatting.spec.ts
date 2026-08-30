import {
  FORMATTING_RESPONSE,
  FORMATTING_INCOMPLETE_TRIGGER,
  FORMATTING_SCROLL_TRIGGER,
  FORMATTING_STREAM_TRIGGER,
  FORMATTING_TRIGGER,
} from "../fixtures/chat-formatting.js";
import { test, expect } from "./harness.js";

test.describe("assistant Markdown formatting", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    const newChat = page.locator("#session-new");
    if (await newChat.isVisible()) {
      await newChat.click();
      await expect(page.locator(".message")).toHaveCount(0);
    }
    await page.locator("#prompt").fill(FORMATTING_TRIGGER);
    await page.locator("#prompt").press("Enter");
    await expect(page.locator(".message.assistant .code-copy")).toHaveCount(3);
  });

  test("renders sanitized GFM semantics and keeps user messages plain", async ({ page }) => {
    const user = page.locator(".message.user .message-body").last();
    const reply = page.locator(".message.assistant .message-body").last();
    await expect(reply.getByRole("heading", { level: 1, name: "Deployment result" })).toBeVisible();
    await expect(reply.getByRole("heading", { level: 2, name: "Checklist" })).toBeVisible();
    await expect(reply.locator("ul ul li")).toHaveCount(2);
    await expect(reply.locator('input[type="checkbox"]')).toHaveCount(2);
    await expect(reply.locator(".contains-task-list > .task-list-item")).toHaveCount(2);
    expect(
      await reply.locator(".task-list-item").first().evaluate((item) => getComputedStyle(item).listStyleType),
    ).toBe("none");
    await expect(reply.locator("blockquote p")).toHaveCount(2);
    await expect(reply.locator("table thead th")).toHaveCount(3);
    await expect(reply.locator("table tbody tr")).toHaveCount(2);
    await expect(reply.locator("hr")).toHaveCount(1);
    await expect(reply.locator("pre code.language-typescript")).toContainText("greet");
    await expect(reply.locator("pre code.language-bash")).toContainText("npm run build");
    await expect(reply.locator("pre code.language-html")).toContainText("<main");
    await expect(reply.locator("del")).toHaveText("removed text");
    await expect(reply.locator('a[href="https://example.com/docs?q=local"]')).toHaveAttribute(
      "rel",
      "noopener noreferrer",
    );
    await expect(reply.locator('img[src^="data:image/png;base64,"]')).toHaveCount(1);
    await expect(reply.locator('img[src="/api/images/formatting.png"]')).toHaveCount(1);
    await expect(reply.locator('img[src^="https://"]')).toHaveCount(0);
    await expect(reply.locator('img[src^="file:"]')).toHaveCount(0);
    await expect(reply.locator('img[src^="data:text/html"]')).toHaveCount(0);
    await expect(reply.locator('a[href^="javascript:"]')).toHaveCount(0);
    await expect(reply.locator('a[href^="data:"]')).toHaveCount(0);
    await expect(reply.locator("#unsafe, script, svg, [style], [onload], [onerror], [onmouseover]")).toHaveCount(0);
    await expect(reply).toContainText('<button id="unsafe"');
    await expect(reply).toContainText("Remote image");
    await expect(reply).toContainText("File image");
    await expect(reply).toContainText("HTML data image");
    expect(await page.evaluate(() => (globalThis as { __xss?: boolean }).__xss)).not.toBe(true);
    await expect(user.locator("h1, ul, pre, table")).toHaveCount(0);
    await expect(user).toHaveText(FORMATTING_TRIGGER);
  });

  test("exposes semantic response structure and keyboard-focusable code actions", async ({ page }) => {
    const reply = page.locator(".message.assistant .message-body").last();
    await expect(reply.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(reply.getByRole("heading", { level: 2 })).toHaveCount(1);
    await expect(reply.getByRole("list")).toHaveCount(4);
    await expect(reply.getByRole("listitem")).toHaveCount(8);
    await expect(reply.getByRole("table")).toHaveCount(1);
    await expect(reply.locator("blockquote")).toHaveCount(1);

    const copy = reply.getByRole("button", { name: "Copy code" }).first();
    const preview = reply.getByRole("button", { name: "Preview HTML code" });
    await copy.focus();
    await expect(copy).toBeFocused();
    expect(await copy.evaluate((button) => getComputedStyle(button).outlineStyle)).not.toBe("none");
    await preview.focus();
    await expect(preview).toBeFocused();
    expect(await preview.evaluate((button) => getComputedStyle(button).outlineStyle)).not.toBe("none");
  });

  test("restores the same semantic response from durable history", async ({ page }) => {
    const original = page.locator(".message.assistant .message-body").last();
    await expect(original.locator("table")).toHaveCount(1);
    const originalText = await original.textContent();

    await page.reload();
    const restored = page.locator(".message.assistant .message-body").last();
    await expect(restored.locator("table")).toHaveCount(1);
    await expect(restored.locator("blockquote")).toHaveCount(1);
    expect(await restored.textContent()).toBe(originalText);
    expect(originalText).toContain(FORMATTING_RESPONSE.split("\n")[0]?.replace(/^# /u, ""));
  });

  test("contains wide GFM structures on a narrow viewport", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const reply = page.locator(".message.assistant .message-body").last();
    await expect(reply.locator(".markdown-table-wrap > table")).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });

  test("streamed Markdown converges to the complete final DOM without duplicate controls", async ({ page }) => {
    const complete = page.locator(".message.assistant .message-body").last();
    const expected = await complete.innerHTML();

    await page.locator("#session-new").click();
    await expect(page.locator(".message")).toHaveCount(0);
    await page.locator("#prompt").fill(FORMATTING_STREAM_TRIGGER);
    await page.locator("#prompt").press("Enter");

    const streamed = page.locator(".message.assistant .message-body").last();
    await expect(streamed.locator("table")).toHaveCount(1);
    await expect(streamed.locator(".code-copy")).toHaveCount(3);
    expect(await streamed.innerHTML()).toBe(expected);
  });

  test("follows at the bottom, then preserves the reader's scroll position", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const prompt = page.locator("#prompt");
    await prompt.fill(FORMATTING_SCROLL_TRIGGER);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await prompt.press("Enter");

    const streamed = page.locator(".message.assistant").last();
    await expect(streamed).toHaveClass(/streaming/u);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const scroller = document.scrollingElement;
          return scroller ? scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight : Infinity;
        }),
      )
      .toBeLessThan(8);

    await page.evaluate(() => window.scrollTo(0, 200));
    const held = await page.evaluate(() => window.scrollY);
    await expect(streamed).not.toHaveClass(/streaming/u);
    const after = await page.evaluate(() => window.scrollY);
    expect(Math.abs(after - held)).toBeLessThan(8);
  });

  test("preserves an upward position when the message log owns scrolling", async ({ page }) => {
    await page.addStyleTag({ content: "#messages { flex: 0 0 18rem; min-height: 0; }" });
    const messages = page.locator("#messages");
    await expect.poll(() => messages.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
    await messages.evaluate((element) => {
      element.scrollTop = 80;
    });
    const held = await messages.evaluate((element) => element.scrollTop);

    await page.locator("#prompt").fill(FORMATTING_SCROLL_TRIGGER);
    await page.locator("#prompt").press("Enter");
    await expect(page.locator(".message.assistant.streaming").last()).toBeVisible();
    expect(await messages.evaluate((element) => element.scrollTop)).toBe(held);
    await expect(page.locator(".message.assistant.streaming").last()).toBeHidden();
    expect(Math.abs((await messages.evaluate((element) => element.scrollTop)) - held)).toBeLessThan(8);
  });

  test("does not jump the message log when cancellation adds a notice", async ({ page }) => {
    await page.addStyleTag({ content: "#messages { flex: 0 0 18rem; min-height: 0; }" });
    const messages = page.locator("#messages");
    await expect.poll(() => messages.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
    await messages.evaluate((element) => {
      element.scrollTop = 80;
    });
    const held = await messages.evaluate((element) => element.scrollTop);

    await page.locator("#prompt").fill("SLOW formatting cancellation");
    await page.locator("#prompt").press("Enter");
    await page.getByRole("button", { name: "Stop" }).click();
    await expect(page.locator(".run-notice")).toContainText("Stopped.");
    expect(Math.abs((await messages.evaluate((element) => element.scrollTop)) - held)).toBeLessThan(8);
  });

  test("renders an open fence predictably and decorates only the final block", async ({ page }) => {
    await page.locator("#session-new").click();
    await expect(page.locator(".message")).toHaveCount(0);
    await page.locator("#prompt").fill(FORMATTING_INCOMPLETE_TRIGGER);
    await page.locator("#prompt").press("Enter");

    const streamed = page.locator(".message.assistant").last();
    await expect(streamed).toHaveClass(/streaming/u);
    await expect(streamed.locator("pre code.language-typescript")).toContainText("const");
    await expect(streamed.locator(".code-copy")).toHaveCount(0);

    await expect(streamed).not.toHaveClass(/streaming/u);
    await expect(streamed.locator("pre code.language-typescript")).toContainText("const value = 1;");
    await expect(streamed.locator(".code-copy")).toHaveCount(1);
    await expect(streamed).toContainText("After the code.");
  });

  test("opens and closes the HTML code preview", async ({ page }) => {
    const preview = page.getByRole("button", { name: "Preview HTML code" });
    await preview.click();
    await expect(page.locator("#artifact-modal")).toBeVisible();
    await expect(page.locator("#artifact-frame")).toHaveAttribute("sandbox", "");
    await expect(page.locator("#artifact-frame")).toHaveAttribute(
      "srcdoc",
      /<main class="status">Ready<\/main>/u,
    );
    await page.getByRole("button", { name: "Close preview" }).click();
    await expect(page.locator("#artifact-modal")).toBeHidden();
    await expect(preview).toBeFocused();
  });

  for (const viewport of [
    { name: "desktop", width: 1440, height: 900 },
    { name: "tablet", width: 768, height: 1024 },
    { name: "mobile", width: 390, height: 844 },
    { name: "narrow", width: 320, height: 720 },
  ]) {
    test(`keeps response affordances usable at ${viewport.name} width`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const reply = page.locator(".message.assistant .message-body").last();
      await expect(reply.locator(".code-language")).toHaveText(["typescript", "bash", "html"]);
      await expect(reply.locator(".code-preview")).toHaveCount(1);
      await expect(reply.locator(".code-copy")).toHaveCount(3);

      const layout = await reply.evaluate((element) => {
        const copy = element.querySelector(".code-copy");
        const table = element.querySelector(".markdown-table-wrap");
        return {
          width: element.getBoundingClientRect().width,
          fontSize: Number.parseFloat(getComputedStyle(element).fontSize),
          copyOpacity: copy ? Number.parseFloat(getComputedStyle(copy).opacity) : 0,
          tableOverflow: table ? table.scrollWidth >= table.clientWidth : false,
          pageOverflow: document.documentElement.scrollWidth > window.innerWidth,
        };
      });
      expect(layout.width / layout.fontSize).toBeLessThanOrEqual(80);
      expect(layout.copyOpacity).toBe(1);
      expect(layout.tableOverflow).toBe(true);
      expect(layout.pageOverflow).toBe(false);

      const firstCopy = reply.locator(".code-copy").first();
      await firstCopy.focus();
      await expect(firstCopy).toBeVisible();
    });
  }
});
