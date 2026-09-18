import { describe, expect, it, vi } from "vitest";
import { createTelemetryProvider } from "../../src/gui/telemetry.js";

describe("live host telemetry", () => {
  it("samples real sensor values and selects the data filesystem", async () => {
    const sensors = {
      cpu: vi.fn().mockResolvedValue({ currentLoad: 23.5 }),
      memory: vi.fn().mockResolvedValue({ total: 16000, available: 6000 }),
      disks: vi.fn().mockResolvedValue([
        { mount: "/", size: 100000, available: 40000 },
        { mount: "/data", size: 200000, available: 50000 },
      ]),
      now: () => 1234,
    };
    const sample = await createTelemetryProvider("/data/llmup", sensors)();
    expect(sample).toEqual({
      sampledAt: 1234,
      cpuPercent: 23.5,
      memoryUsedBytes: 10000,
      memoryTotalBytes: 16000,
      diskUsedBytes: 150000,
      diskTotalBytes: 200000,
    });
  });
  it("reports missing and invalid readings as unknown", async () => {
    const sample = await createTelemetryProvider("/data", {
      cpu: vi.fn().mockRejectedValue(new Error("unavailable")),
      memory: vi.fn().mockResolvedValue({ total: 100, available: 200 }),
      disks: vi.fn().mockResolvedValue([]),
      now: () => 1234,
    })();
    expect(sample.cpuPercent).toBeNull();
    expect(sample.memoryUsedBytes).toBeNull();
    expect(sample.diskTotalBytes).toBeNull();
  });
});
