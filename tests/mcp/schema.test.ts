import { describe, expect, it } from "vitest";
import { ValidationError } from "../../src/errors.js";
import {
  assertLoopbackMcpUrl,
  ConnectorsFileSchema,
  emptyConnectorsFile,
  parseAddConnectorRequest,
} from "../../src/mcp/schema.js";

describe("assertLoopbackMcpUrl", () => {
  it("accepts loopback http and https endpoints", () => {
    expect(assertLoopbackMcpUrl("http://127.0.0.1:3001/mcp")).toContain("127.0.0.1");
    expect(assertLoopbackMcpUrl("https://localhost:8443/mcp")).toContain("localhost");
    expect(assertLoopbackMcpUrl("http://[::1]:9000/")).toContain("[::1]");
  });

  it("refuses non-loopback hosts, credentials, and other schemes", () => {
    expect(() => assertLoopbackMcpUrl("http://example.com/mcp")).toThrow(ValidationError);
    expect(() => assertLoopbackMcpUrl("http://10.0.0.5:3001/")).toThrow(ValidationError);
    expect(() => assertLoopbackMcpUrl("http://user:pass@127.0.0.1/")).toThrow(ValidationError);
    expect(() => assertLoopbackMcpUrl("ftp://127.0.0.1/")).toThrow(ValidationError);
    expect(() => assertLoopbackMcpUrl("not a url")).toThrow(ValidationError);
  });
});

describe("parseAddConnectorRequest", () => {
  it("builds a stdio connector with a slug id derived from the name", () => {
    const connector = parseAddConnectorRequest(
      { name: "File System", transport: "stdio", command: "npx", args: ["-y", "server"] },
      [],
    );
    expect(connector).toMatchObject({
      id: "file-system",
      name: "File System",
      transport: "stdio",
      command: "npx",
      args: ["-y", "server"],
    });
  });

  it("defaults stdio args to an empty array", () => {
    const connector = parseAddConnectorRequest(
      { name: "svc", transport: "stdio", command: "run" },
      [],
    );
    expect(connector.transport).toBe("stdio");
    if (connector.transport === "stdio") {
      expect(connector.args).toEqual([]);
    }
  });

  it("normalizes and keeps loopback urls for http connectors", () => {
    const connector = parseAddConnectorRequest(
      { name: "remote", transport: "http", url: "http://127.0.0.1:3001/mcp" },
      [],
    );
    expect(connector.transport).toBe("http");
    if (connector.transport === "http") {
      expect(connector.url).toContain("127.0.0.1:3001");
    }
  });

  it("assigns a non-colliding id when the slug is taken", () => {
    const connector = parseAddConnectorRequest(
      { name: "svc", transport: "stdio", command: "run" },
      ["svc"],
    );
    expect(connector.id).not.toBe("svc");
    expect(connector.id.startsWith("svc-")).toBe(true);
  });

  it("rejects non-loopback http urls", () => {
    expect(() =>
      parseAddConnectorRequest({ name: "x", transport: "http", url: "http://evil.com" }, []),
    ).toThrow(ValidationError);
  });

  it("rejects unknown keys and missing fields", () => {
    expect(() =>
      parseAddConnectorRequest({ name: "x", transport: "stdio", command: "c", extra: 1 }, []),
    ).toThrow(ValidationError);
    expect(() => parseAddConnectorRequest({ name: "x", transport: "stdio" }, [])).toThrow(
      ValidationError,
    );
    expect(() => parseAddConnectorRequest({ transport: "bogus" }, [])).toThrow(ValidationError);
  });
});

describe("ConnectorsFileSchema", () => {
  it("accepts an empty document", () => {
    expect(ConnectorsFileSchema.safeParse(emptyConnectorsFile()).success).toBe(true);
  });

  it("rejects duplicate connector ids", () => {
    const result = ConnectorsFileSchema.safeParse({
      schemaVersion: 1,
      connectors: [
        { id: "a", name: "A", transport: "stdio", command: "x", args: [] },
        { id: "a", name: "A2", transport: "stdio", command: "y", args: [] },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown schema version", () => {
    const result = ConnectorsFileSchema.safeParse({ schemaVersion: 2, connectors: [] });
    expect(result.success).toBe(false);
  });
});
