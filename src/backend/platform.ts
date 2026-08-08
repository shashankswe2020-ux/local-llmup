import type { Arch, BackendName, ModelFormat, Platform } from "../types.js";

/** Deterministic target facts used to gate platform-specific runtimes offline. */
export interface BackendPlatformTarget {
  readonly platform: Platform | undefined;
  readonly arch: Arch | undefined;
}

/**
 * Whether a backend can run on the target platform, without probing the host.
 * MLX is restricted to Apple Silicon; the other registered runtimes are not
 * platform-restricted by the current plan.
 */
export function backendSupportsPlatform(
  backend: BackendName,
  target: BackendPlatformTarget,
): boolean {
  return backend !== "mlx" || (target.platform === "darwin" && target.arch === "arm64");
}

/** Whether one backend format is runnable on the target platform. */
export function backendSupportsFormatOnPlatform(
  backend: BackendName,
  format: ModelFormat,
  target: BackendPlatformTarget,
): boolean {
  if (!backendSupportsPlatform(backend, target)) return false;
  if (backend === "lmstudio" && format === "mlx") {
    return target.platform === "darwin" && target.arch === "arm64";
  }
  return true;
}
