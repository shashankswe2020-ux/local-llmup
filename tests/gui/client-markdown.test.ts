import { beforeAll, describe, expect, it } from "vitest";

interface GuiMarkdownApi {
  createRenderScheduler(
    render: (target: object, source: string, streaming: boolean) => void,
    options: {
      scheduleFrame(callback: () => void): number;
      cancelFrame(handle: number): void;
    },
  ): {
    update(target: object, source: string): void;
    finalize(target: object, source: string): void;
  };
  escapeHtml(value: string): string;
  safeImageSrc(value: string): string | null;
  safeLinkHref(value: string): string | null;
  renderAssistantMarkdown(container: FakeContainer, source: string): boolean;
}

interface FakeContainer {
  textContent: string;
  innerHTML: string;
  classList: { toggle(name: string, force?: boolean): void };
}

let markdown: GuiMarkdownApi;

beforeAll(async () => {
  await import("../../src/gui/static/markdown.js");
  markdown = (globalThis as unknown as { GuiMarkdown: GuiMarkdownApi }).GuiMarkdown;
});

describe("GUI Markdown policy", () => {
  it("allows only HTTP(S) links", () => {
    expect(markdown.safeLinkHref("https://example.com/docs?q=local")).toBe(
      "https://example.com/docs?q=local",
    );
    expect(markdown.safeLinkHref("http://127.0.0.1:4000/docs")).toBe(
      "http://127.0.0.1:4000/docs",
    );
    expect(markdown.safeLinkHref("javascript:alert(1)")).toBeNull();
    expect(markdown.safeLinkHref("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(markdown.safeLinkHref("/relative")).toBeNull();
  });

  it("allows approved local and inline images only", () => {
    expect(markdown.safeImageSrc("chart.png")).toBe("/api/images/chart.png");
    expect(markdown.safeImageSrc("/api/images/chart.svg")).toBe("/api/images/chart.svg");
    expect(markdown.safeImageSrc("data:image/png;base64,AAAA")).toBe(
      "data:image/png;base64,AAAA",
    );
    expect(markdown.safeImageSrc("https://example.com/tracker.png")).toBeNull();
    expect(markdown.safeImageSrc("file:///tmp/image.png")).toBeNull();
    expect(markdown.safeImageSrc("../secret.png")).toBeNull();
  });

  it("falls back to escaped plain text when parser globals are unavailable", () => {
    const classes = new Map<string, boolean>();
    const container: FakeContainer = {
      textContent: "",
      innerHTML: "",
      classList: { toggle: (name, force) => classes.set(name, force === true) },
    };
    expect(markdown.renderAssistantMarkdown(container, "# Safe\n<script>alert(1)</script>")).toBe(
      false,
    );
    expect(container.textContent).toBe("# Safe\n<script>alert(1)</script>");
    expect(classes.get("markdown-fallback")).toBe(true);
  });

  it("escapes raw HTML characters", () => {
    expect(markdown.escapeHtml(`<button title="x">'unsafe' & more</button>`)).toBe(
      "&lt;button title=&quot;x&quot;&gt;&#39;unsafe&#39; &amp; more&lt;/button&gt;",
    );
  });

  it("batches 1,000 streaming updates into one animation frame render", () => {
    const frames: Array<(() => void) | undefined> = [];
    const renders: Array<{ source: string; streaming: boolean }> = [];
    const target = {};
    const scheduler = markdown.createRenderScheduler(
      (_target, source, streaming) => renders.push({ source, streaming }),
      {
        scheduleFrame: (callback) => {
          frames.push(callback);
          return frames.length - 1;
        },
        cancelFrame: (handle) => {
          frames[handle] = undefined;
        },
      },
    );

    for (let index = 1; index <= 1000; index += 1) {
      scheduler.update(target, "x".repeat(index));
    }
    expect(frames).toHaveLength(1);
    expect(renders).toEqual([]);
    frames[0]?.();
    expect(renders).toEqual([{ source: "x".repeat(1000), streaming: true }]);
  });

  it("cancels a pending frame and performs exactly one final render", () => {
    const frames: Array<(() => void) | undefined> = [];
    const renders: Array<{ source: string; streaming: boolean }> = [];
    const target = {};
    const scheduler = markdown.createRenderScheduler(
      (_target, source, streaming) => renders.push({ source, streaming }),
      {
        scheduleFrame: (callback) => {
          frames.push(callback);
          return frames.length - 1;
        },
        cancelFrame: (handle) => {
          frames[handle] = undefined;
        },
      },
    );

    scheduler.update(target, "```ts\npartial");
    scheduler.finalize(target, "```ts\ncomplete\n```");
    frames[0]?.();
    expect(renders).toEqual([{ source: "```ts\ncomplete\n```", streaming: false }]);
  });
});
