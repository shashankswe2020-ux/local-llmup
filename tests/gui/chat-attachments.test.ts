import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { GuiServer, type GuiChatRequest } from "../../src/gui/server.js";
import { SessionRepository } from "../../src/gui/session-repository.js";
import { WorkspaceService } from "../../src/gui/workspace/service.js";

const STATIC = new URL("../../src/gui/static", import.meta.url);

describe("GuiServer chat attachments", () => {
  const servers: GuiServer[] = [];
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(async (server) => server.stop()));
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeWorkspaceDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "llmup-attach-ws-"));
    dirs.push(dir);
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "index.ts"), "export const answer = 42;\nconsole.log(answer);\n");
    return dir;
  }

  async function start(): Promise<{
    server: GuiServer;
    base: string;
    headers: Record<string, string>;
    captured: { messages: GuiChatRequest["messages"] | undefined };
  }> {
    const home = mkdtempSync(join(tmpdir(), "llmup-attach-home-"));
    dirs.push(home);
    const captured: { messages: GuiChatRequest["messages"] | undefined } = { messages: undefined };
    const server = new GuiServer({
      rootDir: STATIC,
      workspace: new WorkspaceService(),
      sessions: new SessionRepository(loadConfig({ LOCAL_LLMUP_HOME: home })),
      sendChat: async (request) => {
        captured.messages = request.messages;
        return ["understood"];
      },
    });
    servers.push(server);
    const port = await server.start(0);
    const base = `http://127.0.0.1:${port}`;
    return {
      server,
      base,
      headers: {
        Host: `127.0.0.1:${port}`,
        "Content-Type": "application/json",
        "X-LLMUP-Token": server.launchToken,
        Origin: base,
      },
      captured,
    };
  }

  async function registerRoot(base: string, headers: Record<string, string>, dir: string): Promise<string> {
    const res = await fetch(`${base}/api/workspace/root`, {
      method: "POST",
      headers,
      body: JSON.stringify({ path: dir }),
    });
    const { root } = (await res.json()) as { root: { id: string } };
    return root.id;
  }

  it("injects attachment content, emits a context event, and persists the manifest", async () => {
    const { base, headers, captured } = await start();
    const dir = makeWorkspaceDir();
    const rootId = await registerRoot(base, headers, dir);

    const stream = await (
      await fetch(`${base}/api/chat`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: "demo",
          harness: "local",
          messages: [{ role: "user", content: "explain this file" }],
          attachments: [{ workspaceId: rootId, path: "src/index.ts" }],
        }),
      })
    ).text();

    // The model saw the file content in a system context message.
    const systemContent = (captured.messages ?? [])
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n");
    expect(systemContent).toContain("export const answer = 42;");
    expect(systemContent).toContain("src/index.ts");

    // The client received a context ledger event with an honest manifest.
    expect(stream).toContain('"type":"context"');
    expect(stream).toContain('"path":"src/index.ts"');
    expect(stream).toContain('"included":true');

    // The persisted user message records the manifest (no content, just identity).
    const sessions = await (await fetch(`${base}/api/sessions`, { headers })).json();
    const activeId = (sessions as { activeSessionId: string }).activeSessionId;
    const page = (await (
      await fetch(`${base}/api/sessions/${activeId}/messages`, { headers })
    ).json()) as { messages: { role: string; attachments?: { path: string; hash: string }[] }[] };
    const user = page.messages.find((m) => m.role === "user");
    expect(user?.attachments?.[0]?.path).toBe("src/index.ts");
    expect(user?.attachments?.[0]?.hash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("attaches only a requested line range", async () => {
    const { base, headers, captured } = await start();
    const dir = makeWorkspaceDir();
    const rootId = await registerRoot(base, headers, dir);

    await (
      await fetch(`${base}/api/chat`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: "demo",
          harness: "local",
          messages: [{ role: "user", content: "line 2 only" }],
          attachments: [{ workspaceId: rootId, path: "src/index.ts", startLine: 2, endLine: 2 }],
        }),
      })
    ).text();

    const systemContent = (captured.messages ?? [])
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n");
    expect(systemContent).toContain("console.log(answer);");
    expect(systemContent).not.toContain("export const answer");
  });

  it("ignores an attachment that fails closed", async () => {
    const { base, headers, captured } = await start();
    const dir = makeWorkspaceDir();
    const rootId = await registerRoot(base, headers, dir);

    const stream = await (
      await fetch(`${base}/api/chat`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: "demo",
          harness: "local",
          messages: [{ role: "user", content: "hi" }],
          attachments: [{ workspaceId: rootId, path: "does/not/exist.ts" }],
        }),
      })
    ).text();

    // No context event because the only reference failed closed.
    expect(stream).not.toContain('"type":"context"');
    const systemContent = (captured.messages ?? [])
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n");
    expect(systemContent).not.toContain("FILE:");
  });
});
