import { afterEach, describe, expect, it } from "vitest";
import { GuiServer } from "../../src/gui/server.js";
import type { GuiChatRequest } from "../../src/gui/server.js";

/** Helpers shared by the run-lifecycle server tests. */
function chatBody(content: string): string {
  return JSON.stringify({ model: "demo", harness: "local", messages: [{ role: "user", content }] });
}

describe("GuiServer run lifecycle", () => {
  const servers: GuiServer[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(async (server) => server.stop()));
  });

  async function startServer(options: ConstructorParameters<typeof GuiServer>[0]): Promise<{
    server: GuiServer;
    port: number;
  }> {
    const server = new GuiServer({
      rootDir: new URL("../../src/gui/static", import.meta.url),
      ...options,
    });
    servers.push(server);
    const port = await server.start(0);
    return { server, port };
  }

  it("builds the second turn from canonical session state exactly once", async () => {
    const seen: GuiChatRequest["messages"][] = [];
    let reply = 0;
    const { port } = await startServer({
      sendChat: async (request) => {
        seen.push(request.messages);
        reply += 1;
        return [`reply-${reply}`];
      },
    });

    const headers = { Host: `127.0.0.1:${port}`, "Content-Type": "application/json" };
    await (
      await fetch(`http://127.0.0.1:${port}/api/chat`, { method: "POST", headers, body: chatBody("hi") })
    ).text();
    await (
      await fetch(`http://127.0.0.1:${port}/api/chat`, { method: "POST", headers, body: chatBody("again") })
    ).text();

    expect(seen[0]).toEqual([{ role: "user", content: "hi" }]);
    expect(seen[1]).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "reply-1" },
      { role: "user", content: "again" },
    ]);
  });

  it("preserves multiline chat content through model input, SSE, and canonical history", async () => {
    const seen: GuiChatRequest["messages"][] = [];
    const expectedReply = "## Result\n\n```ts\nconst value = 1;\n```\t";
    const { port } = await startServer({
      sendChat: async (request) => {
        seen.push(request.messages);
        return ["## Result\r", "\n\r\n```ts\r\nconst value = 1;\r\n```\t\u001b[", "31m\u202e"];
      },
    });
    const headers = { Host: `127.0.0.1:${port}`, "Content-Type": "application/json" };
    const user = "# Question\r\n\r\n- one\r- two\t\u0000\u001b[2J";

    const stream = await (
      await fetch(`http://127.0.0.1:${port}/api/chat`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: "demo",
          harness: "local",
          systemPrompt: "Follow these rules:\r\n\t- preserve structure\u001b[31m",
          messages: [{ role: "user", content: user }],
        }),
      })
    ).text();

    expect(seen[0]).toEqual([
      { role: "system", content: "Follow these rules:\n\t- preserve structure" },
      { role: "user", content: "# Question\n\n- one\n- two\t" },
    ]);
    const deltas = [...stream.matchAll(/^data: (.+)$/gmu)]
      .map((match) => JSON.parse(match[1] ?? "{}") as { type?: string; content?: string })
      .filter((event) => event.type === "delta")
      .map((event) => event.content ?? "")
      .join("");
    expect(deltas).toBe(expectedReply);

    await (
      await fetch(`http://127.0.0.1:${port}/api/chat`, {
        method: "POST",
        headers,
        body: chatBody("follow up"),
      })
    ).text();
    expect(seen[1]).toEqual([
      { role: "user", content: "# Question\n\n- one\n- two\t" },
      { role: "assistant", content: expectedReply },
      { role: "user", content: "follow up" },
    ]);

    const history = await fetch(`http://127.0.0.1:${port}/api/history`, {
      headers: { Host: `127.0.0.1:${port}` },
    });
    expect((await history.json()) as { history: unknown[] }).toMatchObject({
      history: [
        { role: "user", content: "# Question\n\n- one\n- two\t" },
        { role: "assistant", content: expectedReply },
        { role: "user", content: "follow up" },
        { role: "assistant", content: expectedReply },
      ],
    });
  });

  it("returns a typed 409 when a second run starts while one is active", async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { port } = await startServer({
      sendChat: async () => {
        await gate;
        return ["done"];
      },
    });
    const headers = { Host: `127.0.0.1:${port}`, "Content-Type": "application/json" };

    const first = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers,
      body: chatBody("one"),
    });
    expect(first.status).toBe(200);

    const second = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers,
      body: chatBody("two"),
    });
    expect(second.status).toBe(409);
    const conflict = (await second.json()) as { error: string; code: string };
    expect(conflict.code).toBe("RUN_CONFLICT");

    release?.();
    await first.text();
  });

  it("cancels a run: no done event, no error, and no assistant appended", async () => {
    const { port } = await startServer({
      sendChat: async (_request, signal) => {
        await new Promise<void>((_resolve, reject) => {
          const fail = (): void => reject(new Error("aborted by client"));
          if (signal?.aborted === true) {
            fail();
            return;
          }
          signal?.addEventListener("abort", fail);
        });
        return ["late reply"];
      },
    });
    const headers = { Host: `127.0.0.1:${port}`, "Content-Type": "application/json" };

    const streaming = fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers,
      body: chatBody("cancel me"),
    });
    const response = await streaming;
    expect(response.status).toBe(200);

    const cancelled = await fetch(`http://127.0.0.1:${port}/api/chat/cancel`, {
      method: "POST",
      headers: { Host: `127.0.0.1:${port}` },
    });
    expect(((await cancelled.json()) as { cancelled: boolean }).cancelled).toBe(true);

    const text = await response.text();
    expect(text).not.toContain('"type":"done"');
    expect(text).not.toContain('"type":"error"');

    const history = await fetch(`http://127.0.0.1:${port}/api/history`, {
      headers: { Host: `127.0.0.1:${port}` },
    });
    expect(((await history.json()) as { history: unknown[] }).history).toEqual([]);
  });

  it("reports cancelled=false when nothing is running", async () => {
    const { port } = await startServer({ sendChat: async () => ["ok"] });
    const cancelled = await fetch(`http://127.0.0.1:${port}/api/chat/cancel`, {
      method: "POST",
      headers: { Host: `127.0.0.1:${port}` },
    });
    expect(((await cancelled.json()) as { cancelled: boolean }).cancelled).toBe(false);
  });
});
