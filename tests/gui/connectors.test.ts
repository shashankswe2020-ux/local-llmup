import { afterEach, describe, expect, it, vi } from "vitest";
import { GuiServer } from "../../src/gui/server.js";
import type { ConnectorView, McpManager } from "../../src/mcp/manager.js";

function fakeManager(overrides: Partial<McpManager> = {}): McpManager {
  const view: ConnectorView = {
    id: "fs",
    name: "fs",
    transport: "stdio",
    target: "npx server",
    status: "disconnected",
    tools: [],
  };
  return {
    list: vi.fn(() => [view]),
    add: vi.fn(async () => view),
    snapshot: vi.fn(() => ({ schemaVersion: 1 as const, connectors: [] })),
    replaceAll: vi.fn(async () => [view]),
    remove: vi.fn(async () => undefined),
    connect: vi.fn(async () => ({ ...view, status: "connected", tools: [{ name: "t", description: "" }] })),
    disconnect: vi.fn(async () => view),
    shutdown: vi.fn(async () => undefined),
    ...overrides,
  };
}

async function call(
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
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, json };
}

describe("GuiServer connector routes", () => {
  const servers: GuiServer[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(async (server) => server.stop()));
  });

  async function startWith(manager: McpManager): Promise<number> {
    const server = new GuiServer({
      rootDir: new URL("../../src/gui/static", import.meta.url),
      mcpManager: manager,
    });
    servers.push(server);
    return server.start(0);
  }

  it("lists connectors", async () => {
    const manager = fakeManager();
    const port = await startWith(manager);
    const { status, json } = await call(port, "GET", "/api/connectors");
    expect(status).toBe(200);
    expect(Array.isArray(json.connectors)).toBe(true);
    expect(manager.list).toHaveBeenCalled();
  });

  it("adds a connector", async () => {
    const manager = fakeManager();
    const port = await startWith(manager);
    const { status } = await call(port, "POST", "/api/connectors", {
      name: "fs",
      transport: "stdio",
      command: "npx",
    });
    expect(status).toBe(201);
    expect(manager.add).toHaveBeenCalledOnce();
  });

  it("connects and disconnects a connector by id", async () => {
    const manager = fakeManager();
    const port = await startWith(manager);

    const connected = await call(port, "POST", "/api/connectors/fs/connect");
    expect(connected.status).toBe(200);
    expect(manager.connect).toHaveBeenCalledWith("fs");

    const disconnected = await call(port, "POST", "/api/connectors/fs/disconnect");
    expect(disconnected.status).toBe(200);
    expect(manager.disconnect).toHaveBeenCalledWith("fs");
  });

  it("removes a connector via DELETE", async () => {
    const manager = fakeManager();
    const port = await startWith(manager);
    const { status } = await call(port, "DELETE", "/api/connectors/fs");
    expect(status).toBe(200);
    expect(manager.remove).toHaveBeenCalledWith("fs");
  });

  it("returns the raw config document", async () => {
    const manager = fakeManager({
      snapshot: vi.fn(() => ({
        schemaVersion: 1 as const,
        connectors: [{ id: "fs", name: "fs", transport: "stdio", command: "npx", args: [] }],
      })),
    });
    const port = await startWith(manager);
    const { status, json } = await call(port, "GET", "/api/connectors/config");
    expect(status).toBe(200);
    expect(manager.snapshot).toHaveBeenCalledOnce();
    expect(json.config).toEqual({
      schemaVersion: 1,
      connectors: [{ id: "fs", name: "fs", transport: "stdio", command: "npx", args: [] }],
    });
  });

  it("replaces all connectors via PUT config", async () => {
    const manager = fakeManager();
    const port = await startWith(manager);
    const document = { schemaVersion: 1, connectors: [] };
    const { status, json } = await call(port, "PUT", "/api/connectors/config", document);
    expect(status).toBe(200);
    expect(manager.replaceAll).toHaveBeenCalledWith(document);
    expect(Array.isArray(json.connectors)).toBe(true);
  });

  it("rejects an invalid config document with 400", async () => {
    const manager = fakeManager({
      replaceAll: vi.fn(async () => {
        throw new (await import("../../src/errors.js")).ValidationError(
          "invalid connectors document: bad",
        );
      }),
    });
    const port = await startWith(manager);
    const { status, json } = await call(port, "PUT", "/api/connectors/config", { bogus: true });
    expect(status).toBe(400);
    expect(String(json.error)).toContain("invalid connectors document");
  });

  it("rejects an unsupported method on the config route with 405", async () => {
    const manager = fakeManager();
    const port = await startWith(manager);
    const { status } = await call(port, "DELETE", "/api/connectors/config");
    expect(status).toBe(405);
  });

  it("returns 400 when a connector add is invalid", async () => {
    const manager = fakeManager({
      add: vi.fn(async () => {
        throw new (await import("../../src/errors.js")).ValidationError("invalid connector: bad");
      }),
    });
    const port = await startWith(manager);
    const { status, json } = await call(port, "POST", "/api/connectors", { bogus: true });
    expect(status).toBe(400);
    expect(String(json.error)).toContain("invalid connector");
  });

  it("returns 404 when no manager is configured", async () => {
    const server = new GuiServer({ rootDir: new URL("../../src/gui/static", import.meta.url) });
    servers.push(server);
    const port = await server.start(0);
    const { status } = await call(port, "GET", "/api/connectors");
    // requireMcpManager throws ValidationError -> mapped to 400 by the handler.
    expect(status).toBe(400);
  });
});
