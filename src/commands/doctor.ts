/**
 * The `doctor` command: a read-only health check across the five things that
 * make `up`/`chat`/`switch` work — backend, hardware, catalog, and runtime
 * state. Each probe is isolated in its own try/catch so one failure (a corrupt
 * catalog, say) still lets the others report; a thrown error becomes a `fail`
 * check rather than aborting the whole diagnosis. `runDoctor` never throws for
 * an *expected* problem — it returns a report whose `ok` flag drives the process
 * exit code, so scripts and CI can gate on `local-llmup doctor`.
 */
import { loadCatalog } from "../catalog/load.js";
import { loadConfig, type Config } from "../config.js";
import { detectHardware } from "../hardware/detect.js";
import { usableMemoryBytes } from "../hardware/memory-math.js";
import { computeHardwareScore } from "../advisor/score.js";
import { renderTable, type Column } from "../output.js";
import { stripControl } from "../sanitize.js";
import { OllamaAdapter } from "../backend/ollama.js";
import type { BackendAdapter } from "../backend/adapter.js";
import { readState, type RuntimeState } from "../state/state.js";
import type { Bottleneck, Catalog, HardwareProfile, HardwareScore } from "../types.js";

/** Least usable memory (RAM or VRAM) that can load even the smallest model. */
const MIN_USABLE_MEMORY_BYTES = 1024 ** 3; // 1 GiB

/** How long the reachability probe waits before calling a server unreachable. */
const REACHABILITY_TIMEOUT_MS = 1500;

/** Outcome of a single diagnostic. `fail` is the only status that flips exit. */
export type DoctorStatus = "ok" | "warn" | "fail";

/** One diagnostic line: what was checked, how it went, and a human detail. */
export interface DoctorCheck {
  readonly name: string;
  readonly status: DoctorStatus;
  readonly detail: string;
}

/** The full diagnosis. `ok` is false when any check failed. */
export interface DoctorReport {
  readonly checks: readonly DoctorCheck[];
  readonly ok: boolean;
  /**
   * The AI Hardware Score, or `null` when hardware detection failed (the score
   * is additive context and never, on its own, flips `ok`).
   */
  readonly hardwareScore: HardwareScore | null;
}

/** Injectable side effects, so the command can be driven with fakes in tests. */
export interface DoctorDeps {
  readonly config: Config;
  readonly detectHardware: () => Promise<HardwareProfile>;
  readonly loadCatalog: () => Catalog;
  readonly readState: (config: Config) => RuntimeState;
  readonly adapter: BackendAdapter;
  /** Command result data → stdout. */
  readonly write: (text: string) => void;
}

const createDefaultDeps = (): DoctorDeps => ({
  config: loadConfig(),
  detectHardware: () => detectHardware(),
  loadCatalog: () => loadCatalog(),
  readState,
  adapter: new OllamaAdapter(),
  write: (text) => process.stdout.write(text),
});

function messageOf(error: unknown): string {
  return stripControl(error instanceof Error ? error.message : String(error));
}

function formatGiB(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

async function checkBackend(adapter: BackendAdapter): Promise<DoctorCheck> {
  try {
    if (await adapter.isInstalled()) {
      return { name: "backend", status: "ok", detail: `${stripControl(adapter.name)} is installed` };
    }
    return {
      name: "backend",
      status: "fail",
      detail: `${stripControl(adapter.name)} is not installed — run: ${stripControl(adapter.installHint())}`,
    };
  } catch (error) {
    return { name: "backend", status: "fail", detail: `backend probe failed: ${messageOf(error)}` };
  }
}

/** Outcome of the single hardware probe, shared by the check and the score. */
type Detection = { readonly ok: true; readonly profile: HardwareProfile } | { readonly ok: false; readonly error: unknown };

/** Probe hardware exactly once so the check and the score agree on one reading. */
async function detectSafely(detect: () => Promise<HardwareProfile>): Promise<Detection> {
  try {
    return { ok: true, profile: await detect() };
  } catch (error) {
    return { ok: false, error };
  }
}

function checkHardware(detection: Detection): DoctorCheck {
  if (!detection.ok) {
    return { name: "hardware", status: "fail", detail: `hardware detection failed: ${messageOf(detection.error)}` };
  }
  const hw = detection.profile;
  const usable = usableMemoryBytes(hw);
  const summary = `${hw.arch}/${hw.platform}, ${formatGiB(usable)} usable memory, ${formatGiB(hw.freeDiskBytes)} free disk`;
  if (usable < MIN_USABLE_MEMORY_BYTES) {
    return {
      name: "hardware",
      status: "fail",
      detail: `insufficient usable memory to run a model (${summary})`,
    };
  }
  return { name: "hardware", status: "ok", detail: summary };
}

function checkCatalog(load: () => Catalog): DoctorCheck {
  try {
    const catalog = load();
    if (catalog.models.length === 0) {
      return { name: "catalog", status: "warn", detail: "catalog contains no models" };
    }
    const unverified: string[] = [];
    for (const model of catalog.models) {
      for (const quant of model.quantizations) {
        if (quant.digestVerified === false) {
          unverified.push(`${stripControl(model.id)} (${stripControl(quant.name)})`);
        }
      }
    }
    if (unverified.length > 0) {
      return {
        name: "catalog",
        status: "warn",
        detail: `${String(unverified.length)} quantization(s) have digestVerified:false — size-only verify: ${unverified.join(", ")}`,
      };
    }
    return {
      name: "catalog",
      status: "ok",
      detail: `${String(catalog.models.length)} model(s), all digests verified`,
    };
  } catch (error) {
    return { name: "catalog", status: "fail", detail: `catalog is unusable: ${messageOf(error)}` };
  }
}

async function checkState(deps: DoctorDeps): Promise<DoctorCheck> {
  let active: RuntimeState["active"];
  try {
    active = deps.readState(deps.config).active;
  } catch (error) {
    return { name: "state", status: "fail", detail: `runtime state is unreadable: ${messageOf(error)}` };
  }

  if (active === null) {
    return { name: "state", status: "ok", detail: "no active server recorded" };
  }

  const label = stripControl(active.modelId);
  const endpoint = stripControl(active.endpoint);
  try {
    await deps.adapter.waitUntilReady({
      endpoint: active.endpoint,
      timeoutMs: REACHABILITY_TIMEOUT_MS,
      retries: 0,
    });
    return { name: "state", status: "ok", detail: `serving ${label} at ${endpoint}` };
  } catch (error) {
    return {
      name: "state",
      status: "warn",
      detail: `recorded server ${endpoint} (${label}) is not reachable: ${messageOf(error)} — run \`local-llmup down\` to clear it`,
    };
  }
}

const STATUS_LABEL: Readonly<Record<DoctorStatus, string>> = {
  ok: "OK",
  warn: "WARN",
  fail: "FAIL",
};

const TABLE_COLUMNS: readonly Column[] = [
  { header: "Check" },
  { header: "Status" },
  { header: "Detail" },
];

/** Human-facing label for each bottleneck axis. */
const BOTTLENECK_LABEL: Readonly<Record<Bottleneck, string>> = {
  vram: "VRAM",
  ram: "RAM",
  compute: "Compute",
  storage: "Storage",
};

/** Run every diagnostic, print a report to stdout, and return the verdict. */
export async function runDoctor(
  deps: DoctorDeps = createDefaultDeps(),
  options: { json?: boolean } = {},
): Promise<DoctorReport> {
  const detection = await detectSafely(deps.detectHardware);
  const checks: readonly DoctorCheck[] = [
    checkHardware(detection),
    await checkBackend(deps.adapter),
    checkCatalog(deps.loadCatalog),
    await checkState(deps),
  ];

  const ok = checks.every((c) => c.status !== "fail");
  const hardwareScore = detection.ok ? computeHardwareScore(detection.profile) : null;
  const report: DoctorReport = { checks, ok, hardwareScore };

  if (options.json === true) {
    deps.write(`${JSON.stringify(report, null, 2)}\n`);
    return report;
  }

  const table = renderTable(
    TABLE_COLUMNS,
    checks.map((c) => [c.name, STATUS_LABEL[c.status], c.detail]),
  );
  deps.write(`${table}\n`);

  if (hardwareScore !== null) {
    deps.write(`\nAI Hardware Score: ${String(hardwareScore.total)}/100\n`);
    deps.write(`Primary bottleneck: ${BOTTLENECK_LABEL[hardwareScore.bottleneck]}\n`);
  }

  deps.write(ok ? "\nAll checks passed.\n" : "\nProblems found — see FAIL rows above.\n");

  return report;
}
