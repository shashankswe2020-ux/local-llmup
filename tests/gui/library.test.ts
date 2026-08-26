import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config.js";
import { createLibraryService } from "../../src/library/service.js";
import { GuiServer, type GuiChatRequest } from "../../src/gui/server.js";

const STATIC = new URL("../../src/gui/static", import.meta.url);

describe("GuiServer agent & skill library", () => {
  const servers: GuiServer[] = [];
  const homes: string[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.stop()));
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });

  function newServer(extra: Partial<ConstructorParameters<typeof GuiServer>[0]> = {}): GuiServer {
    const home = mkdtempSync(join(tmpdir(), "llmup-gui-lib-"));
    homes.push(home);
    const library = createLibraryService(loadConfig({ LOCAL_LLMUP_HOME: home }));
    const server = new GuiServer({ rootDir: STATIC, library, ...extra });
    servers.push(server);
    return server;
  }

  async function call(
    server: GuiServer,
    port: number,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        Host: `127.0.0.1:${port}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : {} };
  }

  it("creates, lists, reads, updates, and deletes an agent", async () => {
    const server = newServer();
    const port = await server.start(0);

    const created = await call(server, port, "POST", "/api/agents", {
      name: "Code Reviewer",
      description: "Reviews code",
      body: "You are a reviewer.",
    });
    expect(created.status).toBe(201);
    const item = created.json.item as { id: string; enabled: boolean };
    expect(item.id).toBe("code-reviewer");
    expect(item.enabled).toBe(true);

    const list = await call(server, port, "GET", "/api/agents");
    expect((list.json.items as unknown[]).length).toBe(1);

    const read = await call(server, port, "GET", "/api/agents/code-reviewer");
    expect((read.json.item as { body: string }).body).toBe("You are a reviewer.");

    const updated = await call(server, port, "PUT", "/api/agents/code-reviewer", { enabled: false });
    expect((updated.json.item as { enabled: boolean }).enabled).toBe(false);

    const removed = await call(server, port, "DELETE", "/api/agents/code-reviewer");
    expect(removed.status).toBe(200);
    expect((await call(server, port, "GET", "/api/agents")).json.items).toEqual([]);
  });

  it("manages skills under /api/skills", async () => {
    const server = newServer();
    const port = await server.start(0);
    const created = await call(server, port, "POST", "/api/skills", { name: "Cite", body: "Cite sources." });
    expect(created.status).toBe(201);
    expect((created.json.item as { id: string }).id).toBe("cite");
    expect((await call(server, port, "GET", "/api/skills")).json.items).toHaveLength(1);
  });

  it("rejects an invalid create payload", async () => {
    const server = newServer();
    const port = await server.start(0);
    const bad = await call(server, port, "POST", "/api/agents", { description: "no name" });
    expect(bad.status).toBe(400);
  });

  it("injects the composed agent+skill prompt as a system message in chat", async () => {
    let captured: GuiChatRequest | undefined;
    const server = newServer({ sendChat: async (r) => { captured = r; return ["ok"]; } });
    const port = await server.start(0);

    await call(server, port, "POST", "/api/agents", { name: "Persona", body: "You are helpful." });
    await call(server, port, "POST", "/api/skills", { name: "Cite", body: "Always cite." });

    const chat = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: { Host: `127.0.0.1:${port}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "m",
        harness: "local",
        messages: [{ role: "user", content: "hi" }],
        agentId: "persona",
        skillIds: ["cite"],
      }),
    });
    await chat.text();

    expect(captured?.messages[0]?.role).toBe("system");
    expect(captured?.messages[0]?.content).toContain("You are helpful.");
    expect(captured?.messages[0]?.content).toContain("Always cite.");
    expect(captured?.messages[1]).toEqual({ role: "user", content: "hi" });
  });

  it("omits the system message when no agent or skills are selected", async () => {
    let captured: GuiChatRequest | undefined;
    const server = newServer({ sendChat: async (r) => { captured = r; return ["ok"]; } });
    const port = await server.start(0);
    const chat = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: { Host: `127.0.0.1:${port}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m", harness: "local", messages: [{ role: "user", content: "hi" }] }),
    });
    await chat.text();
    expect(captured?.messages[0]?.role).toBe("user");
  });
});
