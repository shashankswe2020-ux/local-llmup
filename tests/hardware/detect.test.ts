import { afterEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import { graphics, fsSize, mem, osInfo } from "systeminformation";
import {
  DEFAULT_TIMEOUT_MS,
  FALLBACK_DISK_BYTES,
  HardwareProfileSchema,
  detectHardware,
} from "../../src/hardware/detect.js";

vi.mock("systeminformation", () => ({
  osInfo: vi.fn(),
  mem: vi.fn(),
  graphics: vi.fn(),
  fsSize: vi.fn(),
}));

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

function primeOk(
  overrides: {
    arch?: string;
    platform?: string;
    memData?: Partial<Awaited<ReturnType<typeof mem>>>;
    controllers?: Array<{ vendor: string; vram: number | null }>;
    fs?: Array<{ mount: string; available: number }>;
  } = {},
): void {
  vi.mocked(osInfo).mockResolvedValue({
    arch: overrides.arch ?? "x64",
    platform: overrides.platform ?? "linux",
  } as Awaited<ReturnType<typeof osInfo>>);
  vi.mocked(mem).mockResolvedValue({
    total: 32 * GIB,
    free: 20 * GIB,
    available: 24 * GIB,
    ...overrides.memData,
  } as Awaited<ReturnType<typeof mem>>);
  vi.mocked(graphics).mockResolvedValue({
    controllers: (overrides.controllers ?? [{ vendor: "NVIDIA", vram: 8192 }]).map((c) => ({
      ...c,
    })),
    displays: [],
  } as unknown as Awaited<ReturnType<typeof graphics>>);
  vi.mocked(fsSize).mockResolvedValue(
    (overrides.fs ?? [{ mount: "/", available: 500 * GIB }]) as unknown as Awaited<
      ReturnType<typeof fsSize>
    >,
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("detectHardware", () => {
  it("maps systeminformation into a schema-valid profile", async () => {
    primeOk();
    const profile = await detectHardware();
    expect(() => HardwareProfileSchema.parse(profile)).not.toThrow();
    expect(profile.arch).toBe("x64");
    expect(profile.platform).toBe("linux");
    expect(profile.totalRamBytes).toBe(32 * GIB);
    expect(profile.freeRamBytes).toBe(24 * GIB); // prefers `available` over `free`
    expect(profile.gpu).toEqual([{ vendor: "nvidia", vramBytes: 8192 * MIB }]);
    expect(profile.freeDiskBytes).toBe(500 * GIB);
  });

  it("reports an empty GPU list when no controller is present", async () => {
    primeOk({ controllers: [] });
    const profile = await detectHardware();
    expect(profile.gpu).toEqual([]);
  });

  it("preserves multiple GPUs so the largest single pool is selectable", async () => {
    primeOk({
      controllers: [
        { vendor: "NVIDIA", vram: 8192 },
        { vendor: "NVIDIA", vram: 12288 },
      ],
    });
    const profile = await detectHardware();
    expect(profile.gpu).toHaveLength(2);
    const largest = Math.max(...profile.gpu.map((g) => g.vramBytes));
    expect(largest).toBe(12288 * MIB); // largest-single selection, never the sum
  });

  it("treats an integrated GPU with null VRAM as a zero-VRAM device", async () => {
    primeOk({ controllers: [{ vendor: "Intel Corporation", vram: null }] });
    const profile = await detectHardware();
    expect(profile.gpu).toEqual([{ vendor: "none", vramBytes: 0 }]);
  });

  it("maps Apple and AMD vendors", async () => {
    primeOk({
      controllers: [
        { vendor: "Apple", vram: null },
        { vendor: "Advanced Micro Devices, Inc.", vram: 16384 },
      ],
    });
    const profile = await detectHardware();
    expect(profile.gpu).toEqual([
      { vendor: "apple", vramBytes: 0 },
      { vendor: "amd", vramBytes: 16384 * MIB },
    ]);
  });

  it("zeroes VRAM for an unrecognized adapter that reports shared memory", async () => {
    // An iGPU reporting shared memory as `vram` must not hijack the VRAM path.
    primeOk({ controllers: [{ vendor: "Intel Iris", vram: 128 }] });
    const profile = await detectHardware();
    expect(profile.gpu).toEqual([{ vendor: "none", vramBytes: 0 }]);
  });

  it("rounds a fractional VRAM reading instead of discarding the whole profile", async () => {
    primeOk({ controllers: [{ vendor: "NVIDIA", vram: 8191.5 }] });
    const profile = await detectHardware();
    expect(profile.gpu).toEqual([{ vendor: "nvidia", vramBytes: Math.round(8191.5 * MIB) }]);
    expect(profile.totalRamBytes).toBe(32 * GIB); // rest of the profile survives
  });

  it("returns a conservative default when a probe hangs past the timeout", async () => {
    vi.useFakeTimers();
    primeOk();
    vi.mocked(mem).mockReturnValue(new Promise(() => {}) as ReturnType<typeof mem>);
    const pending = detectHardware({ timeoutMs: DEFAULT_TIMEOUT_MS });
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS);
    const profile = await pending;
    expect(profile.gpu).toEqual([]);
    expect(profile.totalRamBytes).toBeGreaterThan(0);
    expect(profile.freeDiskBytes).toBe(FALLBACK_DISK_BYTES);
    expect(() => HardwareProfileSchema.parse(profile)).not.toThrow();
  });

  it("returns a conservative default when a probe yields malformed data", async () => {
    primeOk({ memData: { total: Number.NaN } });
    const profile = await detectHardware();
    expect(profile.gpu).toEqual([]);
    expect(profile.totalRamBytes).toBeGreaterThan(0);
    expect(profile.totalRamBytes).toBe(os.totalmem());
    expect(profile.freeDiskBytes).toBe(FALLBACK_DISK_BYTES);
    expect(() => HardwareProfileSchema.parse(profile)).not.toThrow();
  });
});
