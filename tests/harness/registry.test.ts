import { describe, expect, it } from "vitest";
import { ValidationError } from "../../src/errors.js";
import { type ChatHarness, type HarnessChatRequest, type HarnessName, HARNESS_NAMES } from "../../src/harness/adapter.js";
import { createDefaultRegistry, createRegistry } from "../../src/harness/registry.js";

function createHarness(name: HarnessName, available: boolean): ChatHarness {
  return {
    name,
    unavailableHint: `${name} is unavailable`,
    async isAvailable(): Promise<boolean> {
      return available;
    },
    async *chat(_request: HarnessChatRequest): AsyncIterable<string> {
      yield "ok";
    },
    async chatSync(_request: HarnessChatRequest): Promise<string> {
      return "ok";
    },
  };
}

describe("createRegistry", () => {
  it("returns a registered harness by name", () => {
    const local = createHarness("local", true);
    const registry = createRegistry([local]);
    expect(registry.get("local")).toBe(local);
  });

  it("throws ValidationError for an unknown harness", () => {
    const registry = createRegistry([createHarness("local", true)]);
    expect(() => registry.get("bogus")).toThrow(ValidationError);
  });

  it("rejects duplicate harness names", () => {
    expect(() =>
      createRegistry([
        createHarness("local", true),
        createHarness("local", true),
      ]),
    ).toThrow(ValidationError);
  });

  it("all() preserves registration order and is stable", () => {
    const a = createHarness("local", true);
    const b = createHarness("claude", true);
    const registry = createRegistry([a, b]);
    expect(registry.all().map((harness) => harness.name)).toEqual(["local", "claude"]);
  });

  it("available() filters to available harnesses, preserving order", async () => {
    const local = createHarness("local", true);
    const claude = createHarness("claude", false);
    const openai = createHarness("openai", true);
    const registry = createRegistry([local, claude, openai]);
    expect((await registry.available()).map((harness) => harness.name)).toEqual(["local", "openai"]);
  });
});

describe("createDefaultRegistry", () => {
  it("includes the built-in harnesses in deterministic order", () => {
    const registry = createDefaultRegistry();
    expect(registry.all().map((harness) => harness.name)).toEqual(HARNESS_NAMES);
  });
});
