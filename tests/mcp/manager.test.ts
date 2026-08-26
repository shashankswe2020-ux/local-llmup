import { describe, expect, it, vi } from "vitest";
import { loadConfig, type Config } from "../../src/config.js";
import { ValidationError } from "../../src/errors.js";
import { createMcpManager, type McpManagerDeps } from "../../src/mcp/manager.js";
import type { McpClientFactory, McpConnection, McpToolInfo } from "../../src/mcp/client.js";
import { emptyConnectorsFile, type ConnectorsFile } from "../../src/mcp/schema.js";

function buildDeps(
  overrides: Partial<McpManagerDeps> = {},
  initial: ConnectorsFile = emptyConnectorsFile(),
): { deps: McpManagerDeps; saved: ConnectorsFile[]; factory: McpClientFactory } {
  const config: Config = loadConfig({ LOCAL_LLMUP_HOME: "/tmp/does-not-matter" });
  const saved: ConnectorsFile[] = [];
  let current = initial;

  const tools: McpToolInfo[] = [{ name: "read_file", description: "Read a file" }];
  const connection: McpConnection = {
    listTools: vi.fn(async () => tools),
    callTool: vi.fn(async () => ({ content: "file contents", isError: false })),
    close: vi.fn(async () => undefined),
  };
  const factory: McpClientFactory = {
    connect: vi.fn(async () => connection),
  };

  const deps: McpManagerDeps = {
    config,
    factory,
    load: () => current,
    save: (_config, file) => {
      current = file;
      saved.push(file);
    },
    ...overrides,
  };
  return { deps, saved, factory };
}

describe("createMcpManager", () => {
  it("adds a connector, persists it, and lists it as disconnected", async () => {
    const { deps, saved } = buildDeps();
    const manager = createMcpManager(deps);

    const view = await manager.add({ name: "fs", transport: "stdio", command: "npx", args: [] });
    expect(view.status).toBe("disconnected");
    expect(view.transport).toBe("stdio");
    expect(saved).toHaveLength(1);
    expect(manager.list()).toHaveLength(1);
  });

  it("connects a connector and discovers its tools", async () => {
    const { deps, factory } = buildDeps();
    const manager = createMcpManager(deps);
    const added = await manager.add({ name: "fs", transport: "stdio", command: "npx", args: [] });

    const view = await manager.connect(added.id);
    expect(factory.connect).toHaveBeenCalledOnce();
    expect(view.status).toBe("connected");
    expect(view.tools.map((t) => t.name)).toEqual(["read_file"]);
  });

  it("records an error status when the connection fails", async () => {
    const failing: McpClientFactory = {
      connect: vi.fn(async () => {
        throw new Error("boom");
      }),
    };
    const { deps } = buildDeps({ factory: failing });
    const manager = createMcpManager(deps);
    const added = await manager.add({ name: "fs", transport: "stdio", command: "npx", args: [] });

    const view = await manager.connect(added.id);
    expect(view.status).toBe("error");
    expect(view.error).toContain("boom");
    expect(view.tools).toEqual([]);
  });

  it("disconnects a connected connector and clears its tools", async () => {
    const { deps } = buildDeps();
    const manager = createMcpManager(deps);
    const added = await manager.add({ name: "fs", transport: "stdio", command: "npx", args: [] });
    await manager.connect(added.id);

    const view = await manager.disconnect(added.id);
    expect(view.status).toBe("disconnected");
    expect(view.tools).toEqual([]);
  });

  it("removes a connector and persists the removal", async () => {
    const { deps, saved } = buildDeps();
    const manager = createMcpManager(deps);
    const added = await manager.add({ name: "fs", transport: "stdio", command: "npx", args: [] });

    await manager.remove(added.id);
    expect(manager.list()).toHaveLength(0);
    expect(saved.at(-1)?.connectors).toEqual([]);
  });

  it("throws for unknown connector ids", async () => {
    const { deps } = buildDeps();
    const manager = createMcpManager(deps);
    await expect(manager.connect("nope")).rejects.toThrow(ValidationError);
  });

  it("hydrates existing connectors from the store on construction", () => {
    const initial: ConnectorsFile = {
      schemaVersion: 1,
      connectors: [{ id: "pre", name: "pre", transport: "stdio", command: "run", args: [] }],
    };
    const { deps } = buildDeps({}, initial);
    const manager = createMcpManager(deps);
    expect(manager.list().map((c) => c.id)).toEqual(["pre"]);
  });

  it("closes live connections on shutdown", async () => {
    const close = vi.fn(async () => undefined);
    const factory: McpClientFactory = {
      connect: vi.fn(async () => ({ listTools: vi.fn(async () => []), close })),
    };
    const { deps } = buildDeps({ factory });
    const manager = createMcpManager(deps);
    const added = await manager.add({ name: "fs", transport: "stdio", command: "npx", args: [] });
    await manager.connect(added.id);

    await manager.shutdown();
    expect(close).toHaveBeenCalledOnce();
  });

  it("returns the raw config document via snapshot", async () => {
    const { deps } = buildDeps();
    const manager = createMcpManager(deps);
    await manager.add({ name: "fs", transport: "stdio", command: "npx", args: ["-y", "srv"] });

    const snapshot = manager.snapshot();
    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.connectors).toEqual([
      { id: "fs", name: "fs", transport: "stdio", command: "npx", args: ["-y", "srv"] },
    ]);
  });

  it("replaceAll validates, persists, and lists the new definitions", async () => {
    const { deps, saved } = buildDeps();
    const manager = createMcpManager(deps);

    const views = await manager.replaceAll({
      schemaVersion: 1,
      connectors: [
        { id: "a", name: "a", transport: "stdio", command: "run", args: [] },
        { id: "b", name: "b", transport: "http", url: "http://127.0.0.1:3001/mcp" },
      ],
    });

    expect(views.map((v) => v.id)).toEqual(["a", "b"]);
    expect(views.every((v) => v.status === "disconnected")).toBe(true);
    expect(saved.at(-1)?.connectors.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("replaceAll rejects an invalid document without mutating state", async () => {
    const { deps, saved } = buildDeps();
    const manager = createMcpManager(deps);
    await manager.add({ name: "fs", transport: "stdio", command: "npx", args: [] });
    const before = saved.length;

    await expect(manager.replaceAll({ schemaVersion: 1, connectors: [{ bogus: true }] })).rejects.toThrow(
      ValidationError,
    );
    expect(manager.list().map((c) => c.id)).toEqual(["fs"]);
    expect(saved.length).toBe(before);
  });

  it("replaceAll refuses a non-loopback http connector", async () => {
    const { deps } = buildDeps();
    const manager = createMcpManager(deps);
    await expect(
      manager.replaceAll({
        schemaVersion: 1,
        connectors: [{ id: "remote", name: "remote", transport: "http", url: "http://10.0.0.5/mcp" }],
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("replaceAll preserves a live connection whose definition is unchanged", async () => {
    const { deps, factory } = buildDeps();
    const manager = createMcpManager(deps);
    const added = await manager.add({ name: "fs", transport: "stdio", command: "npx", args: ["srv"] });
    await manager.connect(added.id);
    expect(manager.list()[0]?.status).toBe("connected");

    await manager.replaceAll({
      schemaVersion: 1,
      connectors: [{ id: added.id, name: "fs", transport: "stdio", command: "npx", args: ["srv"] }],
    });

    expect(manager.list()[0]?.status).toBe("connected");
    // Only the original connect() opened a connection; unchanged defs are not reconnected.
    expect(factory.connect).toHaveBeenCalledOnce();
  });

  it("replaceAll closes a live connection whose definition changed", async () => {
    const close = vi.fn(async () => undefined);
    const factory: McpClientFactory = {
      connect: vi.fn(async () => ({ listTools: vi.fn(async () => []), close })),
    };
    const { deps } = buildDeps({ factory });
    const manager = createMcpManager(deps);
    const added = await manager.add({ name: "fs", transport: "stdio", command: "npx", args: ["old"] });
    await manager.connect(added.id);

    await manager.replaceAll({
      schemaVersion: 1,
      connectors: [{ id: added.id, name: "fs", transport: "stdio", command: "npx", args: ["new"] }],
    });

    expect(close).toHaveBeenCalledOnce();
    expect(manager.list()[0]?.status).toBe("disconnected");
  });

  it("agentTools aggregates tools from connected connectors only", async () => {
    const { deps } = buildDeps();
    const manager = createMcpManager(deps);
    const connected = await manager.add({ name: "fs", transport: "stdio", command: "npx", args: [] });
    await manager.add({ name: "other", transport: "stdio", command: "npx", args: [] });
    await manager.connect(connected.id);

    const tools = manager.agentTools();
    expect(tools.map((t) => t.name)).toEqual(["read_file"]);
    expect(tools[0]?.connectorId).toBe(connected.id);
  });

  it("agentTools returns nothing when no connector is connected", async () => {
    const { deps } = buildDeps();
    const manager = createMcpManager(deps);
    await manager.add({ name: "fs", transport: "stdio", command: "npx", args: [] });
    expect(manager.agentTools()).toEqual([]);
  });

  it("agentTools keeps the first connector on a tool-name collision", async () => {
    const shared: McpToolInfo[] = [{ name: "search", description: "Search" }];
    const factory: McpClientFactory = {
      connect: vi.fn(async () => ({
        listTools: vi.fn(async () => shared),
        callTool: vi.fn(async () => ({ content: "", isError: false })),
        close: vi.fn(async () => undefined),
      })),
    };
    const { deps } = buildDeps({ factory });
    const manager = createMcpManager(deps);
    const first = await manager.add({ name: "a", transport: "stdio", command: "npx", args: [] });
    const second = await manager.add({ name: "b", transport: "stdio", command: "npx", args: [] });
    await manager.connect(first.id);
    await manager.connect(second.id);

    const tools = manager.agentTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]?.connectorId).toBe(first.id);
  });

  it("callTool routes to the connected connector that advertises the tool", async () => {
    const { deps, factory } = buildDeps();
    const manager = createMcpManager(deps);
    const added = await manager.add({ name: "fs", transport: "stdio", command: "npx", args: [] });
    await manager.connect(added.id);

    const result = await manager.callTool("read_file", { path: "/x" });
    expect(result).toEqual({ content: "file contents", isError: false });
    const connection = await (factory.connect as ReturnType<typeof vi.fn>).mock.results[0]?.value;
    expect(connection.callTool).toHaveBeenCalledWith("read_file", { path: "/x" });
  });

  it("callTool throws when no connected connector advertises the tool", async () => {
    const { deps } = buildDeps();
    const manager = createMcpManager(deps);
    await manager.add({ name: "fs", transport: "stdio", command: "npx", args: [] });
    await expect(manager.callTool("read_file", {})).rejects.toThrow(ValidationError);
  });
});
