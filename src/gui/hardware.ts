/**
 * GUI hardware bridge. Maps the detected {@link HardwareProfile} into a compact,
 * UI-facing summary the browser workspace renders in the sidebar and Runtime
 * view. Detection itself lives in `src/hardware/detect.ts`; this module only
 * shapes the result for display and never fabricates missing figures.
 */
import { detectHardware } from "../hardware/detect.js";
import type { GpuVendor, HardwareProfile } from "../types.js";

/** One GPU in the UI-facing hardware summary. */
export interface GuiGpuSummary {
  readonly vendor: GpuVendor;
  readonly vramBytes: number;
}

/** A compact, UI-facing view of the detected machine. */
export interface GuiHardwareSummary {
  readonly platform: string;
  readonly arch: string;
  readonly totalRamBytes: number;
  readonly freeRamBytes: number;
  readonly gpu: readonly GuiGpuSummary[];
  readonly freeDiskBytes: number;
}

/** Detects hardware and returns a validated {@link HardwareProfile}. */
export type HardwareProvider = () => Promise<HardwareProfile>;

/** Shape a detected profile into the UI-facing summary (no fabricated values). */
export function toHardwareSummary(profile: HardwareProfile): GuiHardwareSummary {
  return {
    platform: profile.platform,
    arch: profile.arch,
    totalRamBytes: profile.totalRamBytes,
    freeRamBytes: profile.freeRamBytes,
    gpu: profile.gpu.map((gpu) => ({ vendor: gpu.vendor, vramBytes: gpu.vramBytes })),
    freeDiskBytes: profile.freeDiskBytes,
  };
}

/** The production hardware provider wired to real detection. */
export function createDefaultHardwareProvider(): HardwareProvider {
  return () => detectHardware();
}
