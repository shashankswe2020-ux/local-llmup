import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { GuiServer, type GuiChatRequest } from "../../src/gui/server.js";
import { SessionRepository } from "../../src/gui/session-repository.js";
import { WorkspaceService, type GitRunner } from "../../src/gui/workspace/service.js";

const STATIC = new URL("../../src/gui/static", import.meta.url);

describe("GuiServer terminal/diagnostics/git context (task 32.7)", () => {
  const servers: GuiServer[] = [];
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(async (server) => server.stop()));
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "llmup-ctx-src-"));
    dirs.push(dir);
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "index.ts"), "export const x = 1;\n");
    return dir;
  }

  async function start(runGit: GitRunner): Promise<{
    base: string;
    headers: Record<string, string>;
    captured: { messages: GuiChatRequest["messages"] | undefined };
  }> {
    const home = mkdtempSync(join(tmpdir(), "llmup-ctx-home-"));
    dirs.push(home);
    const captured: { messages: GuiChatRequest["messages"] | undefined } = { messages: undefined };
    const server = new GuiServer({
      rootDir: STATIC,
      workspace: new WorkspaceService({ runGit }),
      sessions: new SessionRepository(loadConfig({ LOCAL_LLMUP_HOME: home })),
      sendChat: async (request) => {
        captured.messages = request.messages;
        return ["ok"];
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

  function systemText(messages: GuiChatRequest["messages"] | undefined): string {
    return (messages ?? [])
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n");
  }

  it("attaches pasted terminal and diagnostics text without executing it", async () => {
    const { base, headers, captured } = await start(() => ({
      stdout: "",
      stderr: "",
      code: 0,
      failedToStart: false,
    }));

    const stream = await (
      await fetch(`${base}/api/chat`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: "demo",
          harness: "local",
          messages: [{ role: "user", content: "why did it fail" }],
          contextSources: [
            { kind: "terminal", label: "npm test", content: "Error: boom at line 3" },
            { kind: "diagnostics", content: "src/index.ts(2,1): error TS1005" },
          ],
        }),
      })
    ).text();

    const text = systemText(captured.messages);
    expect(text).toContain("Error: boom at line 3");
    expect(text).toContain("error TS1005");
    expect(stream).toContain('"type":"context"');
    expect(stream).toContain('"kind":"terminal"');
    expect(stream).toContain('"kind":"diagnostics"');
  });

  it("attaches a read-only git snapshot from the injected runner", async () => {
    const { base, headers, captured } = await start((args) => ({
      stdout: args.includes("status") ? " M src/index.ts\n" : "diff --git a b\n+added\n",
      stderr: "",
      code: 0,
      failedToStart: false,
    }));
    const dir = makeDir();
    const rootId = await registerRoot(base, headers, dir);

    const stream = await (
      await fetch(`${base}/api/chat`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: "demo",
          harness: "local",
          messages: [{ role: "user", content: "what changed" }],
          contextSources: [{ kind: "git", workspaceId: rootId, mode: "status" }],
        }),
      })
    ).text();

    expect(systemText(captured.messages)).toContain("src/index.ts");
    expect(stream).toContain('"kind":"git"');
    expect(stream).toContain('"label":"git status"');
  });

  it("skips a git source that is unavailable, adding no context", async () => {
    const { base, headers, captured } = await start(() => ({
      stdout: "",
      stderr: "fatal: not a git repository",
      code: 128,
      failedToStart: false,
    }));
    const dir = makeDir();
    const rootId = await registerRoot(base, headers, dir);

    const stream = await (
      await fetch(`${base}/api/chat`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: "demo",
          harness: "local",
          messages: [{ role: "user", content: "status?" }],
          contextSources: [{ kind: "git", workspaceId: rootId, mode: "status" }],
        }),
      })
    ).text();

    expect(stream).not.toContain('"type":"context"');
    expect(systemText(captured.messages)).not.toContain("GIT");
  });

  it("exposes an honest git preview endpoint", async () => {
    const { base, headers } = await start(() => ({
      stdout: "",
      stderr: "",
      code: null,
      failedToStart: true,
    }));
    const dir = makeDir();
    const rootId = await registerRoot(base, headers, dir);

    const preview = (await (
      await fetch(`${base}/api/workspace/git?id=${rootId}&mode=status`, { headers })
    ).json()) as { snapshot: { available: boolean; reason?: string } };
    expect(preview.snapshot.available).toBe(false);
    expect(preview.snapshot.reason).toBe("git-not-found");
  });

  it("persists non-file sources in the message manifest", async () => {
    const { base, headers } = await start(() => ({
      stdout: "",
      stderr: "",
      code: 0,
      failedToStart: false,
    }));

    await (
      await fetch(`${base}/api/chat`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: "demo",
          harness: "local",
          messages: [{ role: "user", content: "logs" }],
          contextSources: [{ kind: "terminal", content: "boom" }],
        }),
      })
    ).text();

    const sessions = (await (await fetch(`${base}/api/sessions`, { headers })).json()) as {
      activeSessionId: string;
    };
    const page = (await (
      await fetch(`${base}/api/sessions/${sessions.activeSessionId}/messages`, { headers })
    ).json()) as { messages: { role: string; attachments?: { kind?: string; label?: string }[] }[] };
    const user = page.messages.find((m) => m.role === "user");
    expect(user?.attachments?.[0]?.kind).toBe("terminal");
  });
});
