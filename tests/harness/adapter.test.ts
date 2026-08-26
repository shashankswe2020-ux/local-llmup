import { describe, expect, it } from "vitest";
import { HARNESS_NAMES, type ChatHarness, type HarnessChatRequest, type HarnessName } from "../../src/harness/adapter.js";

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

describe("HARNESS_NAMES", () => {
  it("contains the canonical built-in harness names in stable order", () => {
    expect(HARNESS_NAMES).toEqual(["local", "claude", "openai", "openai-compatible"]);
  });

  it("exposes a named harness contract", async () => {
    const harness = createHarness("local", true);
    await expect(harness.isAvailable()).resolves.toBe(true);
    const chunks: string[] = [];
    for await (const chunk of harness.chat({ model: "phi-3", messages: [{ role: "user", content: "hi" }] })) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual(["ok"]);
    await expect(harness.chatSync({ model: "phi-3", messages: [{ role: "user", content: "hi" }] })).resolves.toBe("ok");
  });
});
