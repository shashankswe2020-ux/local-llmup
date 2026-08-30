import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { GuiServer, type GuiChatRequest } from "../../src/gui/server.js";
import { SessionRepository } from "../../src/gui/session-repository.js";
import { WorkspaceService } from "../../src/gui/workspace/service.js";

const STATIC = new URL("../../src/gui/static", import.meta.url);

describe("GuiServer cloud disclosure (Checkpoint C)", () => {
  const servers: GuiServer[] = [];
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(async (server) => server.stop()));
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "llmup-disc-ws-"));
    dirs.push(dir);
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "index.ts"), "export const x = 1;\n");
    return dir;
  }

  async function start(): Promise<{
    base: string;
    headers: Record<string, string>;
    calls: { count: number };
  }> {
    const home = mkdtempSync(join(tmpdir(), "llmup-disc-home-"));
    dirs.push(home);
    const calls = { count: 0 };
    const server = new GuiServer({
      rootDir: STATIC,
      workspace: new WorkspaceService(),
      sessions: new SessionRepository(loadConfig({ LOCAL_LLMUP_HOME: home })),
      sendChat: async (_request: GuiChatRequest) => {
        calls.count += 1;
        return ["reply"];
      },
    });
    servers.push(server);
    const port = await server.start(0);
    const base = `http://127.0.0.1:${port}`;
    return {
      base,
      headers: {
        Host: `127.0.0.1:${port}`,
        "Content-Type": "application/json",
        "X-LLMUP-Token": server.launchToken,
        Origin: base,
      },
      calls,
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

  function body(harness: string | undefined, rootId: string, ack: boolean): string {
    return JSON.stringify({
      model: "demo",
      ...(harness !== undefined ? { harness } : {}),
      messages: [{ role: "user", content: "review this" }],
      attachments: [{ workspaceId: rootId, path: "src/index.ts" }],
      ...(ack ? { disclosureAck: true } : {}),
    });
  }

  it("blocks cloud sends with context until disclosure is acknowledged", async () => {
    const { base, headers, calls } = await start();
    const rootId = await registerRoot(base, headers, makeDir());

    const stream = await (
      await fetch(`${base}/api/chat`, { method: "POST", headers, body: body("claude", rootId, false) })
    ).text();

    expect(stream).toContain('"type":"disclosure-required"');
    expect(stream).toContain('"provider":"claude"');
    expect(stream).not.toContain('"type":"delta"');
    expect(calls.count).toBe(0); // nothing left the machine
  });

  it("sends after the disclosure is acknowledged, then remembers it", async () => {
    const { base, headers, calls } = await start();
    const rootId = await registerRoot(base, headers, makeDir());

    const acked = await (
      await fetch(`${base}/api/chat`, { method: "POST", headers, body: body("claude", rootId, true) })
    ).text();
    expect(acked).toContain('"type":"context"');
    expect(acked).toContain('"type":"delta"');
    expect(calls.count).toBe(1);

    // A second send of the same context/provider no longer prompts.
    const again = await (
      await fetch(`${base}/api/chat`, { method: "POST", headers, body: body("claude", rootId, false) })
    ).text();
    expect(again).not.toContain('"type":"disclosure-required"');
    expect(again).toContain('"type":"delta"');
    expect(calls.count).toBe(2);
  });

  it("never prompts the local harness", async () => {
    const { base, headers, calls } = await start();
    const rootId = await registerRoot(base, headers, makeDir());

    const stream = await (
      await fetch(`${base}/api/chat`, { method: "POST", headers, body: body(undefined, rootId, false) })
    ).text();
    expect(stream).not.toContain('"type":"disclosure-required"');
    expect(stream).toContain('"type":"delta"');
    expect(calls.count).toBe(1);
  });

  it("does not prompt a cloud harness when no context is attached", async () => {
    const { base, headers, calls } = await start();
    const stream = await (
      await fetch(`${base}/api/chat`, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: "demo", harness: "claude", messages: [{ role: "user", content: "hi" }] }),
      })
    ).text();
    expect(stream).not.toContain('"type":"disclosure-required"');
    expect(stream).toContain('"type":"delta"');
    expect(calls.count).toBe(1);
  });
});
