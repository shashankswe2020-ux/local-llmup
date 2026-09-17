import { describe, expect, it, vi } from "vitest";
import { collectInstalledModels, sizeInstalledModel } from "../../src/commands/installed-models.js";
import type { HardwareProfile } from "../../src/types.js";
import type { InstalledModel } from "../../src/backend/installed.js";

const hardware: HardwareProfile = {
  arch: "x64",
  platform: "linux",
  totalRamBytes: 32 * 1024 ** 3,
  freeRamBytes: 24 * 1024 ** 3,
  freeDiskBytes: 0,
  gpu: [{ vendor: "nvidia", vramBytes: 8 * 1024 ** 3 }],
};
const model: InstalledModel = {
  id: "gemma4:e4b-it-qat",
  digest: "a".repeat(64),
  sizeBytes: 3 * 1024 ** 3,
  contextLength: 131072,
  kvBytesPerToken: null,
  quant: "Q4_0",
  capabilities: ["completion"],
};

describe("installed model comparisons", () => {
  it("keeps full-context fit unknown when only weights fit", () => {
    expect(sizeInstalledModel(model, hardware, 65536)).toMatchObject({
      fit: "unknown",
      weightsFit: true,
      requiredBytes: null,
      context: 65536,
      memoryKind: "vram",
    });
  });
  it("sizes known fp16 geometry and respects context caps", () => {
    expect(sizeInstalledModel({ ...model, kvBytesPerToken: 16384 }, hardware, 65536).fit).toBe(
      "yes",
    );
    expect(sizeInstalledModel({ ...model, kvBytesPerToken: 262144 }, hardware, 65536).fit).toBe(
      "no",
    );
    expect(sizeInstalledModel(model, hardware, 262144).fit).toBe("no");
  });
  it("explicitly contacts the requested local runtime and preserves unknown models", async () => {
    const inspect = vi.fn(async () => model);
    const results = await collectInstalledModels(
      { context: 65536, port: 11435 },
      {
        detectHardware: vi.fn(async () => hardware),
        support: { list: vi.fn(async () => [model]), inspect, verify: vi.fn(), activate: vi.fn() },
      },
    );
    expect(results).toHaveLength(1);
    expect(inspect).toHaveBeenCalledWith("http://127.0.0.1:11435", model.id);
    expect(results[0]?.fit).toBe("unknown");
  });
});
