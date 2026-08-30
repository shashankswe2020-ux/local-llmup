import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GuiServer } from "../../src/gui/server.js";
import { WorkspaceService } from "../../src/gui/workspace/service.js";

const STATIC = new URL("../../src/gui/static", import.meta.url);

describe("GuiServer edit apply/revert API (task 32.10)", () => {
  const servers: GuiServer[] = [];
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(async (server) => server.stop()));
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "llmup-applyapi-"));
    dirs.push(dir);
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "app.ts"), "a\nb\nc\n");
    return dir;
  }

  async function start(withRecords: boolean): Promise<{ base: string; headers: Record<string, string> }> {
    const options: ConstructorParameters<typeof GuiServer>[0] = {
      rootDir: STATIC,
      workspace: new WorkspaceService(),
    };
    if (withRecords) {
      const records = mkdtempSync(join(tmpdir(), "llmup-applyapi-rec-"));
      dirs.push(records);
      options.editRecordsDir = records;
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
    const res = await fetch(`${base}/api/workspace/root`, { method: "POST", headers, body: JSON.stringify({ path: dir }) });
    const { root } = (await res.json()) as { root: { id: string } };
    const file = await (
      await fetch(`${base}/api/workspace/file?id=${root.id}&path=${encodeURIComponent("src/app.ts")}`, { headers })
    ).json();
    return { id: root.id, hash: (file as { snapshot: { hash: string } }).snapshot.hash };
  }

  it("applies an update to disk and then reverts it", async () => {
    const { base, headers } = await start(true);
    const dir = makeDir();
    const { id, hash } = await register(base, headers, dir);

    const applyRes = await fetch(`${base}/api/workspace/edits/apply`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        workspaceId: id,
        operations: [{ op: "update", path: "src/app.ts", baseHash: hash, hunks: [{ start: 2, end: 2, lines: ["B"] }] }],
      }),
    });
    expect(applyRes.status).toBe(200);
    const { result } = (await applyRes.json()) as { result: { applicationId: string } };
    expect(readFileSync(join(dir, "src", "app.ts"), "utf8")).toBe("a\nB\nc\n");

    const revertRes = await fetch(`${base}/api/workspace/edits/revert`, {
      method: "POST",
      headers,
      body: JSON.stringify({ applicationId: result.applicationId }),
    });
    expect(revertRes.status).toBe(200);
    expect(readFileSync(join(dir, "src", "app.ts"), "utf8")).toBe("a\nb\nc\n");
  });

  it("rejects delete apply and a stale base", async () => {
    const { base, headers } = await start(true);
    const dir = makeDir();
    const { id, hash } = await register(base, headers, dir);

    const del = await fetch(`${base}/api/workspace/edits/apply`, {
      method: "POST",
      headers,
      body: JSON.stringify({ workspaceId: id, operations: [{ op: "delete", path: "src/app.ts", baseHash: hash }] }),
    });
    expect(del.status).toBe(400);
    expect(existsSync(join(dir, "src", "app.ts"))).toBe(true);

    const stale = await fetch(`${base}/api/workspace/edits/apply`, {
      method: "POST",
      headers,
      body: JSON.stringify({ workspaceId: id, operations: [{ op: "update", path: "src/app.ts", baseHash: "stale", hunks: [{ start: 1, end: 1, lines: ["x"] }] }] }),
    });
    expect(stale.status).toBe(400);
    expect(readFileSync(join(dir, "src", "app.ts"), "utf8")).toBe("a\nb\nc\n");
  });

  it("refuses cross-origin and missing-token apply", async () => {
    const { base, headers } = await start(true);
    const dir = makeDir();
    const { id, hash } = await register(base, headers, dir);
    const body = JSON.stringify({
      workspaceId: id,
      operations: [{ op: "update", path: "src/app.ts", baseHash: hash, hunks: [{ start: 1, end: 1, lines: ["x"] }] }],
    });
    const cross = await fetch(`${base}/api/workspace/edits/apply`, {
      method: "POST",
      headers: { ...headers, Origin: "http://evil.example" },
      body,
    });
    expect(cross.status).toBe(403);
    const noToken = await fetch(`${base}/api/workspace/edits/apply`, {
      method: "POST",
      headers: { Host: headers.Host, "Content-Type": "application/json", Origin: base },
      body,
    });
    expect(noToken.status).toBe(403);
  });

  it("returns 404 when apply is not configured (no records dir)", async () => {
    const { base, headers } = await start(false);
    const dir = makeDir();
    const { id, hash } = await register(base, headers, dir);
    const res = await fetch(`${base}/api/workspace/edits/apply`, {
      method: "POST",
      headers,
      body: JSON.stringify({ workspaceId: id, operations: [{ op: "update", path: "src/app.ts", baseHash: hash, hunks: [{ start: 1, end: 1, lines: ["x"] }] }] }),
    });
    expect(res.status).toBe(404);
  });
});
