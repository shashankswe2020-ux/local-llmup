/**
 * Hardware detection: probes the machine via `systeminformation` and maps the
 * result into a validated {@link HardwareProfile}. Every probe is bounded by a
 * timeout, and any failure or malformed reading degrades to a **conservative**
 * default (real RAM, no GPU) so the ranker never over-recommends into an OOM.
 */
import os from "node:os";
import { graphics, fsSize, mem, osInfo } from "systeminformation";
import { z } from "zod";
import { ARCHS, GPU_VENDORS, PLATFORMS } from "../types.js";
import type { Arch, GpuVendor, HardwareProfile, Platform } from "../types.js";

/** Default per-run cap for the whole detection probe. */
export const DEFAULT_TIMEOUT_MS = 3000;

/**
 * Free-disk value used in the conservative fallback. Disk is the one field Node
 * cannot report reliably without `systeminformation`; a large sentinel keeps
 * disk from becoming a false "won't fit" reason when detection failed. A genuine
 * shortfall still surfaces loudly at pull time, unlike a silent RAM OOM.
 */
export const FALLBACK_DISK_BYTES = 1024 ** 4;

export const HardwareProfileSchema = z.object({
  arch: z.enum(ARCHS),
  platform: z.enum(PLATFORMS),
  totalRamBytes: z.number().int().positive(),
  freeRamBytes: z.number().int().positive(),
  gpu: z.array(
    z.object({
      vendor: z.enum(GPU_VENDORS),
      vramBytes: z.number().int().nonnegative(),
    }),
  ),
  freeDiskBytes: z.number().int().nonnegative(),
});

class DetectionTimeoutError extends Error {}

function normalizeArch(value: string): Arch | undefined {
  const v = value.toLowerCase();
  if (v === "arm64" || v === "aarch64") return "arm64";
  if (v === "x64" || v === "x86_64" || v === "amd64") return "x64";
  return undefined;
}

function normalizePlatform(value: string): Platform | undefined {
  return (PLATFORMS as readonly string[]).includes(value) ? (value as Platform) : undefined;
}

function normalizeVendor(vendor: string): GpuVendor {
  const v = vendor.toLowerCase();
  if (v.includes("nvidia")) return "nvidia";
  if (v.includes("apple")) return "apple";
  // `\bati\b` avoids matching the "ati" inside words like "corporation".
  if (v.includes("amd") || v.includes("advanced micro") || v.includes("radeon") || /\bati\b/.test(v))
    return "amd";
  return "none"; // integrated Intel / unknown → no dedicated VRAM
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DetectionTimeoutError()), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function conservativeDefault(): HardwareProfile {
  return {
    arch: normalizeArch(os.arch()) ?? "x64",
    platform: normalizePlatform(process.platform) ?? "linux",
    totalRamBytes: Math.max(1, Math.round(os.totalmem())),
    freeRamBytes: Math.max(1, Math.round(os.freemem())),
    gpu: [],
    freeDiskBytes: FALLBACK_DISK_BYTES,
  };
}

function mapGpus(controllers: ReadonlyArray<{ vendor: string; vram: number | null }>): Array<{
  vendor: GpuVendor;
  vramBytes: number;
}> {
  return controllers.map((c) => {
    const vendor = normalizeVendor(c.vendor ?? "");
    const vramMib = typeof c.vram === "number" && Number.isFinite(c.vram) && c.vram > 0 ? c.vram : 0;
    // Enforce the invariant memory-math relies on: only a *recognized* dedicated
    // GPU contributes VRAM. An adapter mapped to "none" (integrated/unknown) must
    // report 0 so it never routes usable memory to the small VRAM branch. Round
    // so a fractional MB reading can't fail int validation and nuke the profile.
    const vramBytes = vendor === "none" ? 0 : Math.round(vramMib * 1024 ** 2);
    return { vendor, vramBytes };
  });
}

function pickFreeDiskBytes(entries: ReadonlyArray<{ mount: string; available: number }>): number {
  const usable = entries.filter((e) => Number.isFinite(e.available) && e.available >= 0);
  const root = usable.find((e) => e.mount === "/" || /^[A-Za-z]:\\?$/.test(e.mount));
  if (root) return Math.round(root.available);
  return usable.reduce((max, e) => Math.max(max, Math.round(e.available)), 0);
}

/** Detect the current machine's hardware profile, or a conservative default. */
export async function detectHardware(
  options: { timeoutMs?: number } = {},
): Promise<HardwareProfile> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    const [osData, memData, graphicsData, fsData] = await withTimeout(
      Promise.all([osInfo(), mem(), graphics(), fsSize()]),
      timeoutMs,
    );

    const freeRam =
      Number.isFinite(memData.available) && memData.available > 0
        ? memData.available
        : memData.free;

    const candidate = {
      arch: normalizeArch(osData.arch) ?? normalizeArch(os.arch()),
      platform: normalizePlatform(osData.platform) ?? normalizePlatform(process.platform),
      totalRamBytes: Math.round(memData.total),
      freeRamBytes: Math.round(freeRam),
      gpu: mapGpus(graphicsData.controllers ?? []),
      freeDiskBytes: pickFreeDiskBytes(fsData ?? []),
    };

    const parsed = HardwareProfileSchema.safeParse(candidate);
    return parsed.success ? parsed.data : conservativeDefault();
  } catch {
    return conservativeDefault();
  }
}
