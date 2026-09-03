import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { ValidationError } from "../../src/errors.js";
import { GuiServer, resolveGuiRootDir } from "../../src/gui/server.js";

describe("GuiServer", () => {
  const servers: GuiServer[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(async (server) => server.stop()));
  });

  it("binds to loopback and serves the workspace shell", async () => {
    const server = new GuiServer({
      rootDir: new URL("../../src/gui/static", import.meta.url),
      registry: undefined,
    });
    servers.push(server);

    const port = await server.start(0);
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      headers: { Host: `127.0.0.1:${port}` },
    });

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("<html");
    expect(html).toContain("Workspace");
    expect(html).toContain("Current session");
    expect(html).toContain("Model");
    expect(server.url).toBe(`http://127.0.0.1:${port}`);
  });

  it("serves update status from the configured provider", async () => {
    const server = new GuiServer({
      rootDir: new URL("../../src/gui/static", import.meta.url),
      registry: undefined,
      updateStatus: async () => ({
        currentVersion: "0.11.2",
        latestVersion: "0.12.0",
        state: "update-available",
        releaseUrl: "https://github.com/shashankswe2020-ux/local-llmup/releases",
      }),
    });
    servers.push(server);

    const port = await server.start(0);
    const response = await fetch(`http://127.0.0.1:${port}/api/update`, {
      headers: { Host: `127.0.0.1:${port}` },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      currentVersion: "0.11.2",
      latestVersion: "0.12.0",
      state: "update-available",
      releaseUrl: "https://github.com/shashankswe2020-ux/local-llmup/releases",
    });
  });

  it("hardens the main document with a restrictive content security policy", async () => {
    const server = new GuiServer({
      rootDir: new URL("../../src/gui/static", import.meta.url),
      registry: undefined,
    });
    servers.push(server);
    const port = await server.start(0);
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      headers: { Host: `127.0.0.1:${port}` },
    });

    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("img-src 'self' data:");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-src 'self'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("https:");
    expect(await response.text()).toContain('id="artifact-frame"');
    expect(await (await fetch(`http://127.0.0.1:${port}/`, { headers: { Host: `127.0.0.1:${port}` } })).text())
      .not.toContain('sandbox="allow-scripts"');
  });

  it("serves only the approved Markdown vendor bundles from fixed routes", async () => {
    const server = new GuiServer({
      rootDir: new URL("../../src/gui/static", import.meta.url),
      registry: undefined,
    });
    servers.push(server);
    const port = await server.start(0);
    const headers = { Host: `127.0.0.1:${port}` };

    const index = await (await fetch(`http://127.0.0.1:${port}/`, { headers })).text();
    expect(index.indexOf("/vendor/marked.min.js")).toBeLessThan(index.indexOf("/static/chat.js"));
    expect(index.indexOf("/vendor/dompurify.min.js")).toBeLessThan(index.indexOf("/static/chat.js"));
    expect(index.indexOf("/static/markdown.js")).toBeLessThan(index.indexOf("/static/chat.js"));

    const marked = await fetch(`http://127.0.0.1:${port}/vendor/marked.min.js`, { headers });
    expect(marked.status).toBe(200);
    expect(marked.headers.get("content-type")).toBe("application/javascript; charset=utf-8");
    expect(await marked.text()).toContain("marked");

    const purify = await fetch(`http://127.0.0.1:${port}/vendor/dompurify.min.js`, { headers });
    expect(purify.status).toBe(200);
    expect(purify.headers.get("content-type")).toBe("application/javascript; charset=utf-8");
    expect(await purify.text()).toContain("DOMPurify");

    const unknown = await fetch(`http://127.0.0.1:${port}/vendor/package.json`, { headers });
    expect(unknown.status).toBe(400);

    const traversal = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port,
          path: "/vendor/../package.json",
          headers,
        },
        (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode ?? 0));
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(traversal).toBe(400);
  });

  it("rejects host header mismatches and path traversal", async () => {
    const server = new GuiServer({
      rootDir: new URL("../../src/gui/static", import.meta.url),
      registry: undefined,
    });
    servers.push(server);

    const port = await server.start(0);
    const badHost = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port,
          path: "/api/status",
          method: "GET",
          headers: { Host: "localhost:3000" },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          response.on("end", () => resolve({ statusCode: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
        },
      );
      req.on("error", reject);
      req.end();
    });
    const traversal = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port,
          path: "/static/../outside.txt",
          method: "GET",
          headers: { Host: `127.0.0.1:${port}` },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          response.on("end", () => resolve({ statusCode: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
        },
      );
      req.on("error", reject);
      req.end();
    });

    expect(badHost.statusCode).toBe(400);
    expect(traversal.statusCode).toBe(400);
  });

  it("limits oversized chat bodies", async () => {
    const server = new GuiServer({
      rootDir: new URL("../../src/gui/static", import.meta.url),
      registry: undefined,
    });
    servers.push(server);

    const port = await server.start(0);
    const huge = "x".repeat(70 * 1024);
    const response = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: {
        Host: `127.0.0.1:${port}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "demo", messages: [{ role: "user", content: huge }] }),
    });

    expect(response.status).toBe(413);
  });

  it("resolves the static asset root from source when dist assets are absent", () => {
    const root = mkdtempSync(path.join(tmpdir(), "local-llmup-gui-"));
    const srcStatic = path.join(root, "src", "gui", "static");
    mkdirSync(srcStatic, { recursive: true });
    writeFileSync(path.join(srcStatic, "index.html"), "<html></html>");

    const resolved = resolveGuiRootDir(new URL(`file://${path.join(root, "dist", "gui", "server.js")}`));
    expect(path.resolve(fileURLToPath(resolved))).toBe(path.resolve(srcStatic));
  });

  it("opens an SSE stream for a valid chat request", async () => {
    const server = new GuiServer({
      rootDir: new URL("../../src/gui/static", import.meta.url),
      registry: undefined,
      sendChat: async () => ["hello", " world"],
    });
    servers.push(server);

    const port = await server.start(0);
    const response = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: {
        Host: `127.0.0.1:${port}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "demo-model",
        messages: [{ role: "user", content: "hi" }],
        harness: "local",
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const text = await response.text();
    expect(text).toContain('"type":"delta"');
    expect(text).toContain('"type":"done"');
  });

  it("injects a per-chat system prompt as a system message", async () => {
    let captured: readonly { readonly role: string; readonly content: string }[] = [];
    const server = new GuiServer({
      rootDir: new URL("../../src/gui/static", import.meta.url),
      registry: undefined,
      sendChat: async (request) => {
        captured = request.messages;
        return ["ok"];
      },
    });
    servers.push(server);

    const port = await server.start(0);
    const response = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: {
        Host: `127.0.0.1:${port}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "demo-model",
        messages: [{ role: "user", content: "hi" }],
        harness: "local",
        systemPrompt: "You are a terse pirate.",
      }),
    });
    await response.text();

    const systemMessages = captured.filter((message) => message.role === "system");
    expect(systemMessages.some((message) => message.content === "You are a terse pirate.")).toBe(true);
  });

  it("forwards a per-chat temperature to the backend", async () => {
    let seenTemperature: number | undefined;
    const server = new GuiServer({
      rootDir: new URL("../../src/gui/static", import.meta.url),
      registry: undefined,
      sendChat: async (request) => {
        seenTemperature = request.temperature;
        return ["ok"];
      },
    });
    servers.push(server);

    const port = await server.start(0);
    const response = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: {
        Host: `127.0.0.1:${port}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "demo-model",
        messages: [{ role: "user", content: "hi" }],
        harness: "local",
        temperature: 0.3,
      }),
    });
    await response.text();

    expect(seenTemperature).toBe(0.3);
  });

  it("streams the real backend error when chat execution throws synchronously", async () => {
    const server = new GuiServer({
      rootDir: new URL("../../src/gui/static", import.meta.url),
      registry: undefined,
      sendChat: () => {
        throw new Error("listener ownership is untrusted");
      },
    });
    servers.push(server);

    const port = await server.start(0);
    const response = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: {
        Host: `127.0.0.1:${port}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "demo-model",
        messages: [{ role: "user", content: "hi" }],
        harness: "local",
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const text = await response.text();
    expect(text).toContain("listener ownership is untrusted");
    expect(text).not.toContain("internal server error");
  });

  it("lists recommended models for the workspace", async () => {
    const server = new GuiServer({
      rootDir: new URL("../../src/gui/static", import.meta.url),
      registry: undefined,
      modelManager: {
        recommended: async () => [
          {
            id: "qwen2.5:1.5b",
            family: "qwen2.5",
            params: "1.5B",
            verdict: "yes",
            quant: "Q4_K_M",
            diskBytes: 1_000_000,
            throughput: { known: true, lowTokPerSec: 40, highTokPerSec: 60 },
            backends: ["ollama"],
          },
        ],
        runtimes: () => ["ollama", "llamacpp", "mlx", "lmstudio"],
        active: () => null,
        up: async () => {
          throw new Error("not used");
        },
      },
    });
    servers.push(server);

    const port = await server.start(0);
    const response = await fetch(`http://127.0.0.1:${port}/api/models/recommended`, {
      headers: { Host: `127.0.0.1:${port}` },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { models: { id: string }[] };
    expect(body.models[0]?.id).toBe("qwen2.5:1.5b");
  });

  it("lists the available inference runtimes", async () => {
    const server = new GuiServer({
      rootDir: new URL("../../src/gui/static", import.meta.url),
      registry: undefined,
      modelManager: {
        recommended: async () => [],
        runtimes: () => ["ollama", "llamacpp", "mlx", "lmstudio"],
        active: () => null,
        up: async () => {
          throw new Error("not used");
        },
      },
    });
    servers.push(server);

    const port = await server.start(0);
    const response = await fetch(`http://127.0.0.1:${port}/api/runtimes`, {
      headers: { Host: `127.0.0.1:${port}` },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { runtimes: string[] };
    expect(body.runtimes).toContain("ollama");
    expect(body.runtimes).toContain("llamacpp");
  });

  it("scopes recommendations to a validated runtime query", async () => {
    const seen: (string | undefined)[] = [];
    const server = new GuiServer({
      rootDir: new URL("../../src/gui/static", import.meta.url),
      registry: undefined,
      modelManager: {
        recommended: async (options) => {
          seen.push(options?.runtime);
          return [];
        },
        runtimes: () => ["ollama", "llamacpp", "mlx", "lmstudio"],
        active: () => null,
        up: async () => {
          throw new Error("not used");
        },
      },
    });
    servers.push(server);

    const port = await server.start(0);
    const ok = await fetch(`http://127.0.0.1:${port}/api/models/recommended?runtime=llamacpp`, {
      headers: { Host: `127.0.0.1:${port}` },
    });
    expect(ok.status).toBe(200);
    const okBody = (await ok.json()) as { runtime: string | null };
    expect(okBody.runtime).toBe("llamacpp");
    expect(seen).toEqual(["llamacpp"]);

    const bad = await fetch(`http://127.0.0.1:${port}/api/models/recommended?runtime=bogus`, {
      headers: { Host: `127.0.0.1:${port}` },
    });
    expect(bad.status).toBe(400);
    const badBody = (await bad.json()) as { error: string };
    expect(badBody.error).toContain("unknown runtime");
  });

  it("forwards a validated context-window preset to recommendations", async () => {
    const seen: (string | undefined)[] = [];
    const server = new GuiServer({
      rootDir: new URL("../../src/gui/static", import.meta.url),
      registry: undefined,
      modelManager: {
        recommended: async (options) => {
          seen.push(options?.contextPreset);
          return [];
        },
        runtimes: () => ["ollama", "llamacpp", "mlx", "lmstudio"],
        active: () => null,
        up: async () => {
          throw new Error("not used");
        },
      },
    });
    servers.push(server);

    const port = await server.start(0);
    const ok = await fetch(`http://127.0.0.1:${port}/api/models/recommended?context=high`, {
      headers: { Host: `127.0.0.1:${port}` },
    });
    expect(ok.status).toBe(200);
    expect(seen).toEqual(["high"]);

    const bad = await fetch(`http://127.0.0.1:${port}/api/models/recommended?context=extreme`, {
      headers: { Host: `127.0.0.1:${port}` },
    });
    expect(bad.status).toBe(400);
  });

  it("reports the active workspace model", async () => {
    const server = new GuiServer({
      rootDir: new URL("../../src/gui/static", import.meta.url),
      registry: undefined,
      modelManager: {
        recommended: async () => [],
        runtimes: () => ["ollama", "llamacpp", "mlx", "lmstudio"],
        active: () => ({
          modelId: "qwen2.5:1.5b",
          backend: "ollama",
          endpoint: "http://127.0.0.1:11434",
          port: 11434,
          ownership: "attached",
        }),
        up: async () => {
          throw new Error("not used");
        },
      },
    });
    servers.push(server);

    const port = await server.start(0);
    const response = await fetch(`http://127.0.0.1:${port}/api/models/active`, {
      headers: { Host: `127.0.0.1:${port}` },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { active: { modelId: string } | null };
    expect(body.active?.modelId).toBe("qwen2.5:1.5b");
  });

  it("brings a chosen model up through the manager", async () => {
    const upCalls: { model: string; port?: number }[] = [];
    const server = new GuiServer({
      rootDir: new URL("../../src/gui/static", import.meta.url),
      registry: undefined,
      modelManager: {
        recommended: async () => [],
        runtimes: () => ["ollama", "llamacpp", "mlx", "lmstudio"],
        active: () => null,
        up: async (request) => {
          upCalls.push(request);
          return {
            modelId: request.model,
            backend: "ollama",
            endpoint: "http://127.0.0.1:11434",
            port: 11434,
            ownership: "owned",
          };
        },
      },
    });
    servers.push(server);

    const port = await server.start(0);
    const response = await fetch(`http://127.0.0.1:${port}/api/models/up`, {
      method: "POST",
      headers: {
        Host: `127.0.0.1:${port}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "qwen2.5:1.5b" }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { active: { modelId: string } };
    expect(body.active.modelId).toBe("qwen2.5:1.5b");
    expect(upCalls).toEqual([{ model: "qwen2.5:1.5b" }]);
  });

  it("returns a 400 with a clean message when up fails", async () => {
    const server = new GuiServer({
      rootDir: new URL("../../src/gui/static", import.meta.url),
      registry: undefined,
      modelManager: {
        recommended: async () => [],
        runtimes: () => ["ollama", "llamacpp", "mlx", "lmstudio"],
        active: () => null,
        up: async () => {
          throw new ValidationError("no model matches \"bogus\"");
        },
      },
    });
    servers.push(server);

    const port = await server.start(0);
    const response = await fetch(`http://127.0.0.1:${port}/api/models/up`, {
      method: "POST",
      headers: {
        Host: `127.0.0.1:${port}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "bogus" }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("no model matches");
  });
});
