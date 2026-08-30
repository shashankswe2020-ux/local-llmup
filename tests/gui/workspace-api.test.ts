import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GuiServer } from "../../src/gui/server.js";
import { WorkspaceService } from "../../src/gui/workspace/service.js";

const STATIC = new URL("../../src/gui/static", import.meta.url);

describe("GuiServer workspace API", () => {
  const servers: GuiServer[] = [];
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(async (server) => server.stop()));
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeWorkspaceDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "llmup-wsapi-"));
    dirs.push(dir);
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "index.ts"), "alpha\nbeta\ngamma\n");
    writeFileSync(join(dir, "README.md"), "# hi\n");
    return dir;
  }

  async function start(withWorkspace: boolean): Promise<{
    server: GuiServer;
    port: number;
    base: string;
    tokenHeaders: Record<string, string>;
  }> {
    const options: ConstructorParameters<typeof GuiServer>[0] = {
      rootDir: STATIC,
      sendChat: async () => ["ok"],
    };
    if (withWorkspace) {
      options.workspace = new WorkspaceService();
    }
    const server = new GuiServer(options);
    servers.push(server);
    const port = await server.start(0);
    const base = `http://127.0.0.1:${port}`;
    return {
      server,
      port,
      base,
      tokenHeaders: {
        Host: `127.0.0.1:${port}`,
        "Content-Type": "application/json",
        "X-LLMUP-Token": server.launchToken,
        Origin: base,
      },
    };
  }

  it("returns 404 when workspace access is disabled", async () => {
    const { base, tokenHeaders } = await start(false);
    const response = await fetch(`${base}/api/workspace/status`, { headers: tokenHeaders });
    expect(response.status).toBe(404);
  });

  it("rejects requests without the launch token", async () => {
    const { base, port } = await start(true);
    const response = await fetch(`${base}/api/workspace/status`, {
      headers: { Host: `127.0.0.1:${port}` },
    });
    expect(response.status).toBe(403);
  });

  it("rejects cross-origin mutations even with a valid token", async () => {
    const { base, tokenHeaders } = await start(true);
    const dir = makeWorkspaceDir();
    const response = await fetch(`${base}/api/workspace/root`, {
      method: "POST",
      headers: { ...tokenHeaders, Origin: "http://evil.example" },
      body: JSON.stringify({ path: dir }),
    });
    expect(response.status).toBe(403);
  });

  it("registers a root, lists a tree, and reads a file", async () => {
    const { base, tokenHeaders } = await start(true);
    const dir = makeWorkspaceDir();

    const registered = await fetch(`${base}/api/workspace/root`, {
      method: "POST",
      headers: tokenHeaders,
      body: JSON.stringify({ path: dir }),
    });
    expect(registered.status).toBe(201);
    const { root } = (await registered.json()) as { root: { id: string; name: string } };

    const status = await (
      await fetch(`${base}/api/workspace/status`, { headers: tokenHeaders })
    ).json();
    expect(status).toEqual({ rootId: root.id });

    const tree = (await (
      await fetch(`${base}/api/workspace/tree?id=${root.id}`, { headers: tokenHeaders })
    ).json()) as { entries: { name: string }[] };
    expect(tree.entries.map((e) => e.name)).toEqual(expect.arrayContaining(["src", "README.md"]));

    const file = (await (
      await fetch(
        `${base}/api/workspace/file?id=${root.id}&path=${encodeURIComponent("src/index.ts")}`,
        { headers: tokenHeaders },
      )
    ).json()) as { snapshot: { content: string; hash: string } };
    expect(file.snapshot.content).toBe("alpha\nbeta\ngamma\n");
    expect(file.snapshot.hash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("reads a line range", async () => {
    const { base, tokenHeaders } = await start(true);
    const dir = makeWorkspaceDir();
    const { root } = (await (
      await fetch(`${base}/api/workspace/root`, {
        method: "POST",
        headers: tokenHeaders,
        body: JSON.stringify({ path: dir }),
      })
    ).json()) as { root: { id: string } };

    const file = (await (
      await fetch(
        `${base}/api/workspace/file?id=${root.id}&path=${encodeURIComponent("src/index.ts")}&startLine=2&endLine=3`,
        { headers: tokenHeaders },
      )
    ).json()) as { snapshot: { content: string; range: { startLine: number; endLine: number } } };
    expect(file.snapshot.content).toBe("beta\ngamma");
    expect(file.snapshot.range).toEqual({ startLine: 2, endLine: 3 });
  });

  it("revokes a registered root", async () => {
    const { base, tokenHeaders } = await start(true);
    const dir = makeWorkspaceDir();
    const { root } = (await (
      await fetch(`${base}/api/workspace/root`, {
        method: "POST",
        headers: tokenHeaders,
        body: JSON.stringify({ path: dir }),
      })
    ).json()) as { root: { id: string } };

    const revoked = await fetch(`${base}/api/workspace/root/revoke`, {
      method: "POST",
      headers: tokenHeaders,
      body: JSON.stringify({ id: root.id }),
    });
    expect(revoked.status).toBe(200);

    const status = await (
      await fetch(`${base}/api/workspace/status`, { headers: tokenHeaders })
    ).json();
    expect(status).toEqual({ rootId: null });
  });

  it("searches files behind the launch token", async () => {
    const { base, tokenHeaders } = await start(true);
    const dir = makeWorkspaceDir();
    const { root } = (await (
      await fetch(`${base}/api/workspace/root`, {
        method: "POST",
        headers: tokenHeaders,
        body: JSON.stringify({ path: dir }),
      })
    ).json()) as { root: { id: string } };

    const page = (await (
      await fetch(`${base}/api/workspace/search?id=${root.id}&q=index`, { headers: tokenHeaders })
    ).json()) as { results: { path: string }[]; nextCursor: string | null };
    expect(page.results.map((r) => r.path)).toContain("src/index.ts");

    const denied = await fetch(`${base}/api/workspace/search?id=${root.id}&q=index`, {
      headers: { Host: tokenHeaders.Host },
    });
    expect(denied.status).toBe(403);
  });

  it("returns 400 on denied and traversal reads", async () => {
    const { base, tokenHeaders } = await start(true);
    const dir = makeWorkspaceDir();
    writeFileSync(join(dir, ".env"), "SECRET=1\n");
    const { root } = (await (
      await fetch(`${base}/api/workspace/root`, {
        method: "POST",
        headers: tokenHeaders,
        body: JSON.stringify({ path: dir }),
      })
    ).json()) as { root: { id: string } };

    const denied = await fetch(
      `${base}/api/workspace/file?id=${root.id}&path=${encodeURIComponent(".env")}`,
      { headers: tokenHeaders },
    );
    expect(denied.status).toBe(400);
  });
});
