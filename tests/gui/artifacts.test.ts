import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GuiServer } from "../../src/gui/server.js";
import { resolveArtifactPath } from "../../src/gui/artifacts.js";
import { ValidationError } from "../../src/errors.js";

const STATIC = new URL("../../src/gui/static", import.meta.url);
// Minimal 1x1 PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

describe("GuiServer artifact images", () => {
  const servers: GuiServer[] = [];
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.stop()));
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function newServer(): { server: GuiServer; artifactsDir: string } {
    const home = mkdtempSync(join(tmpdir(), "llmup-art-"));
    dirs.push(home);
    const artifactsDir = join(home, "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    const server = new GuiServer({ rootDir: STATIC, artifactsDir });
    servers.push(server);
    return { server, artifactsDir };
  }

  async function get(port: number, path: string): Promise<{ status: number; type: string | null; bytes: number }> {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { Host: `127.0.0.1:${port}` } });
    const buf = Buffer.from(await response.arrayBuffer());
    return { status: response.status, type: response.headers.get("content-type"), bytes: buf.length };
  }

  it("serves a generated PNG with an image content-type", async () => {
    const { server, artifactsDir } = newServer();
    writeFileSync(join(artifactsDir, "equation_plot.png"), PNG);
    const port = await server.start(0);
    const res = await get(port, "/api/images/equation_plot.png");
    expect(res.status).toBe(200);
    expect(res.type).toBe("image/png");
    expect(res.bytes).toBe(PNG.length);
  });

  it("returns 404 for a missing image", async () => {
    const { server } = newServer();
    const port = await server.start(0);
    expect((await get(port, "/api/images/nope.png")).status).toBe(404);
  });

  it("rejects traversal and non-image names", async () => {
    const { server } = newServer();
    const port = await server.start(0);
    expect((await get(port, "/api/images/..%2F..%2Fetc%2Fpasswd")).status).toBe(400);
    expect((await get(port, "/api/images/secret.txt")).status).toBe(400);
  });

  it("resolveArtifactPath refuses separators and traversal", () => {
    expect(() => resolveArtifactPath("/base", "a/b.png")).toThrow(ValidationError);
    expect(() => resolveArtifactPath("/base", "../x.png")).toThrow(ValidationError);
    expect(() => resolveArtifactPath("/base", "plot.png")).not.toThrow();
  });
});
