import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { GuiServer } from "../../src/gui/server.js";
import { SessionRepository } from "../../src/gui/session-repository.js";

const STATIC = new URL("../../src/gui/static", import.meta.url);

describe("GuiServer session API", () => {
  const servers: GuiServer[] = [];
  const homes: string[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(async (server) => server.stop()));
    for (const home of homes.splice(0)) {
      rmSync(home, { recursive: true, force: true });
    }
  });

  async function start(withSessions: boolean): Promise<{ port: number; headers: Record<string, string> }> {
    const options: ConstructorParameters<typeof GuiServer>[0] = {
      rootDir: STATIC,
      sendChat: async () => ["hello there"],
    };
    if (withSessions) {
      const home = mkdtempSync(join(tmpdir(), "llmup-sessapi-"));
      homes.push(home);
      options.sessions = new SessionRepository(loadConfig({ LOCAL_LLMUP_HOME: home }));
    }
    const server = new GuiServer(options);
    servers.push(server);
    const port = await server.start(0);
    return { port, headers: { Host: `127.0.0.1:${port}`, "Content-Type": "application/json" } };
  }

  it("returns 404 when persistence is disabled", async () => {
    const { port, headers } = await start(false);
    const response = await fetch(`http://127.0.0.1:${port}/api/sessions`, { headers });
    expect(response.status).toBe(404);
  });

  it("creates, activates, and lists sessions", async () => {
    const { port, headers } = await start(true);
    const created = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Planning" }),
    });
    expect(created.status).toBe(201);
    const { session } = (await created.json()) as { session: { id: string; title: string } };
    expect(session.title).toBe("Planning");

    const listed = await fetch(`http://127.0.0.1:${port}/api/sessions`, { headers });
    const body = (await listed.json()) as { sessions: { id: string }[]; activeSessionId: string };
    expect(body.sessions.map((s) => s.id)).toContain(session.id);
    expect(body.activeSessionId).toBe(session.id);
  });

  it("persists a chat turn into the active session", async () => {
    const { port, headers } = await start(true);
    const created = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    });
    const { session } = (await created.json()) as { session: { id: string } };

    await (
      await fetch(`http://127.0.0.1:${port}/api/chat`, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: "demo", harness: "local", messages: [{ role: "user", content: "hi" }] }),
      })
    ).text();

    const messages = await fetch(`http://127.0.0.1:${port}/api/sessions/${session.id}/messages`, { headers });
    const page = (await messages.json()) as { messages: { role: string; content: string }[] };
    expect(page.messages).toEqual([
      expect.objectContaining({ role: "user", content: "hi" }),
      expect.objectContaining({ role: "assistant", content: "hello there" }),
    ]);
  });

  it("renames, enforces a revision conflict, archives, and deletes", async () => {
    const { port, headers } = await start(true);
    const created = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    });
    const { session } = (await created.json()) as { session: { id: string; revision: number } };

    const renamed = await fetch(`http://127.0.0.1:${port}/api/sessions/${session.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ title: "Renamed", expectedRevision: session.revision }),
    });
    expect(renamed.status).toBe(200);

    const conflict = await fetch(`http://127.0.0.1:${port}/api/sessions/${session.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ title: "Again", expectedRevision: session.revision }),
    });
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as { code: string }).code).toBe("SESSION_CONFLICT");

    await fetch(`http://127.0.0.1:${port}/api/sessions/${session.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ archived: true }),
    });
    const listed = await fetch(`http://127.0.0.1:${port}/api/sessions`, { headers });
    expect(((await listed.json()) as { sessions: unknown[] }).sessions).toHaveLength(0);

    const deleted = await fetch(`http://127.0.0.1:${port}/api/sessions/${session.id}`, {
      method: "DELETE",
      headers,
    });
    expect(deleted.status).toBe(200);
    const gone = await fetch(`http://127.0.0.1:${port}/api/sessions/${session.id}`, { headers });
    expect(gone.status).toBe(404);
  });

  it("searches sessions by content", async () => {
    const { port, headers } = await start(true);
    await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Hardware advice" }),
    });
    const found = await fetch(`http://127.0.0.1:${port}/api/sessions?q=hardware`, { headers });
    const body = (await found.json()) as { results: { summary: { title: string } }[] };
    expect(body.results.map((r) => r.summary.title)).toEqual(["Hardware advice"]);
  });
});
