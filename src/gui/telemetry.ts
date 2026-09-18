import { resolve, relative, isAbsolute } from "node:path";
import si from "systeminformation";
import { z } from "zod";

export interface TelemetrySample {
  readonly sampledAt: number;
  readonly cpuPercent: number | null;
  readonly memoryUsedBytes: number | null;
  readonly memoryTotalBytes: number | null;
  readonly diskUsedBytes: number | null;
  readonly diskTotalBytes: number | null;
}
export interface TelemetrySensors {
  readonly cpu: () => Promise<unknown>;
  readonly memory: () => Promise<unknown>;
  readonly disks: () => Promise<unknown>;
  readonly now: () => number;
}
const bytes = z.number().finite().nonnegative().safe();
const cpuSchema = z.object({ currentLoad: z.number().finite().min(0).max(100) });
const memorySchema = z.object({ total: bytes.positive(), available: bytes });
const diskSchema = z.array(
  z.object({ mount: z.string(), size: bytes.positive(), available: bytes }),
);

export function createTelemetryProvider(
  home: string,
  sensors: TelemetrySensors = {
    cpu: () => si.currentLoad(),
    memory: () => si.mem(),
    disks: () => si.fsSize(),
    now: () => Date.now(),
  },
): () => Promise<TelemetrySample> {
  const root = resolve(home);
  let pending: Promise<TelemetrySample> | undefined;
  let cached: TelemetrySample | undefined;
  async function sample(): Promise<TelemetrySample> {
    const [cpu, memory, disks] = await Promise.all([
      sensors.cpu().catch(() => null),
      sensors.memory().catch(() => null),
      sensors.disks().catch(() => null),
    ]);
    const processor = cpuSchema.safeParse(cpu);
    const ram = memorySchema.safeParse(memory);
    const volumes = diskSchema.safeParse(disks);
    const disk = volumes.success
      ? volumes.data
          .filter((volume) => {
            const path = relative(resolve(volume.mount), root);
            return path === "" || (!path.startsWith("..") && !isAbsolute(path));
          })
          .sort((left, right) => right.mount.length - left.mount.length)[0]
      : undefined;
    const validRam = ram.success && ram.data.available <= ram.data.total ? ram.data : undefined;
    const validDisk = disk !== undefined && disk.available <= disk.size ? disk : undefined;
    return {
      sampledAt: sensors.now(),
      cpuPercent: processor.success ? processor.data.currentLoad : null,
      memoryUsedBytes: validRam === undefined ? null : validRam.total - validRam.available,
      memoryTotalBytes: validRam?.total ?? null,
      diskUsedBytes: validDisk === undefined ? null : validDisk.size - validDisk.available,
      diskTotalBytes: validDisk?.size ?? null,
    };
  }
  return async () => {
    if (cached !== undefined && sensors.now() - cached.sampledAt < 1500) return cached;
    pending ??= sample()
      .then((result) => {
        cached = result;
        return result;
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  };
}
