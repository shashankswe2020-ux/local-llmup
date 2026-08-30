import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GuiServer } from "../../src/gui/server.js";
import { WorkspaceService } from "../../src/gui/workspace/service.js";

const STATIC = new URL("../../src/gui/static", import.meta.url);

describe("GuiServer edit-review API (task 32.9)", () => {
  const servers: GuiServer[] = [];
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(async (server) => server.stop()));
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "llmup-editapi-"));
    dirs.push(dir);
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "app.ts"), "a\nb\nc\n");
    return dir;
  }

  async function start(withWorkspace: boolean): Promise<{
    base: string;
    headers: Record<string, string>;
  }> {
    const options: ConstructorParameters<typeof GuiServer>[0] = { rootDir: STATIC };
    if (withWorkspace) {
      options.workspace = new WorkspaceService();
    }
    const server = new GuiServer(options);
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
    };
  }

  async function register(base: string, headers: Record<string, string>, dir: string): Promise<{ id: string; hash: string }> {
    const res = await fetch(`${base}/api/workspace/root`, {
      method: "POST",
      headers,
      body: JSON.stringify({ path: dir }),
    });
    const { root } = (await res.json()) as { root: { id: string } };
    const file = await (
      await fetch(`${base}/api/workspace/file?id=${root.id}&path=${encodeURIComponent("src/app.ts")}`, { headers })
    ).json();
    return { id: root.id, hash: (file as { snapshot: { hash: string } }).snapshot.hash };
  }

  it("returns a review diff and leaves the file unchanged", async () => {
    const { base, headers } = await start(true);
    const dir = makeDir();
    const { id, hash } = await register(base, headers, dir);

    const res = await fetch(`${base}/api/workspace/edits/review`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        workspaceId: id,
        operations: [{ op: "update", path: "src/app.ts", baseHash: hash, hunks: [{ start: 2, end: 2, lines: ["B"] }] }],
      }),
    });
    expect(res.status).toBe(200);
    const { review } = (await res.json()) as { review: { files: { added: number; removed: number }[] } };
    expect(review.files[0]?.added).toBe(1);
    expect(review.files[0]?.removed).toBe(1);
    expect(readFileSync(join(dir, "src", "app.ts"), "utf8")).toBe("a\nb\nc\n");
  });

  it("rejects a stale base with 400", async () => {
    const { base, headers } = await start(true);
    const dir = makeDir();
    const { id } = await register(base, headers, dir);
    const res = await fetch(`${base}/api/workspace/edits/review`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        workspaceId: id,
        operations: [{ op: "update", path: "src/app.ts", baseHash: "stale", hunks: [{ start: 1, end: 1, lines: ["x"] }] }],
      }),
    });
    expect(res.status).toBe(400);
  });

  it("refuses cross-origin and missing-token requests", async () => {
    const { base, headers } = await start(true);
    const dir = makeDir();
    const { id, hash } = await register(base, headers, dir);
    const body = JSON.stringify({
      workspaceId: id,
      operations: [{ op: "update", path: "src/app.ts", baseHash: hash, hunks: [{ start: 1, end: 1, lines: ["x"] }] }],
    });

    const crossOrigin = await fetch(`${base}/api/workspace/edits/review`, {
      method: "POST",
      headers: { ...headers, Origin: "http://evil.example" },
      body,
    });
    expect(crossOrigin.status).toBe(403);

    const noToken = await fetch(`${base}/api/workspace/edits/review`, {
      method: "POST",
      headers: { Host: headers.Host, "Content-Type": "application/json", Origin: base },
      body,
    });
    expect(noToken.status).toBe(403);
  });

  it("returns 404 when workspace access is disabled", async () => {
    const { base, headers } = await start(false);
    const res = await fetch(`${base}/api/workspace/edits/review`, {
      method: "POST",
      headers,
      body: JSON.stringify({ workspaceId: "x", operations: [] }),
    });
    expect(res.status).toBe(404);
  });
});
