import { describe, expect, it } from "vitest";
import {
  classifyToolRisk,
  redactToolArgs,
  redactToolResult,
  toolGrantKey,
} from "../../src/gui/tool-policy.js";

describe("tool policy", () => {
  describe("classifyToolRisk", () => {
    it("classifies mutation, process/network, read-only, and unknown", () => {
      expect(classifyToolRisk({ name: "write_file" })).toBe("workspace-mutation");
      expect(classifyToolRisk({ name: "delete_record" })).toBe("workspace-mutation");
      expect(classifyToolRisk({ name: "run_command" })).toBe("process-network");
      expect(classifyToolRisk({ name: "http_fetch" })).toBe("process-network");
      expect(classifyToolRisk({ name: "search_docs" })).toBe("read-only");
      expect(classifyToolRisk({ name: "frobnicate" })).toBe("unknown");
    });

    it("uses the description as a secondary signal", () => {
      expect(classifyToolRisk({ name: "x", description: "delete a row" })).toBe("workspace-mutation");
    });
  });

  describe("redactToolArgs", () => {
    it("masks secret-shaped keys and bounds long strings", () => {
      const redacted = redactToolArgs({
        query: "weather",
        apiKey: "sk-abcdef",
        token: "t",
        blob: "x".repeat(300),
      });
      expect(redacted.query).toBe("weather");
      expect(redacted.apiKey).toBe("[redacted]");
      expect(redacted.token).toBe("[redacted]");
      expect(String(redacted.blob)).toContain("300 chars");
    });

    it("recurses into nested objects and arrays", () => {
      const redacted = redactToolArgs({ nested: { password: "p", ok: 1 }, list: [1, 2] });
      const nested = redacted.nested as Record<string, unknown>;
      expect(nested.password).toBe("[redacted]");
      expect(nested.ok).toBe(1);
      expect(redacted.list).toEqual([1, 2]);
    });
  });

  describe("redactToolResult", () => {
    it("masks long secret-like tokens and reports truncation", () => {
      const masked = redactToolResult("token=abcd1234ABCD5678efgh9012xyz");
      expect(masked.text).toContain("[redacted]");
      expect(masked.truncated).toBe(false);

      const big = redactToolResult("y".repeat(5000));
      expect(big.truncated).toBe(true);
    });
  });

  describe("toolGrantKey", () => {
    it("binds connector, name, and schema; differs when any changes", () => {
      const a = toolGrantKey({ connectorId: "c1", name: "t", schema: { type: "object" } });
      const b = toolGrantKey({ connectorId: "c1", name: "t", schema: { type: "object" } });
      const c = toolGrantKey({ connectorId: "c1", name: "t", schema: { type: "string" } });
      const d = toolGrantKey({ connectorId: "c2", name: "t", schema: { type: "object" } });
      expect(a).toBe(b);
      expect(a).not.toBe(c);
      expect(a).not.toBe(d);
    });
  });
});
