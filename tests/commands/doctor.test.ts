import { describe, expect, it } from "vitest";
import type { Config } from "../../src/config.js";
import type { BackendAdapter } from "../../src/backend/adapter.js";
import { CatalogError, StateError } from "../../src/errors.js";
import type { RuntimeState } from "../../src/state/state.js";
import type { Catalog, HardwareProfile, Quantization } from "../../src/types.js";
import { runDoctor, type DoctorDeps } from "../../src/commands/doctor.js";

const GiB = 1024 ** 3;

const config: Config = {
  homeDir: "/tmp/llmup-doctor",
  stateFile: "/tmp/llmup-doctor/state.json",
  lockFile: "/tmp/llmup-doctor/state.lock",
  memoryDir: "/tmp/llmup-doctor/memory",
  stagingDir: "/tmp/llmup-doctor/staging",
};

function healthyHardware(): HardwareProfile {
  return {
    arch: "arm64",
    platform: "darwin",
    totalRamBytes: 32 * GiB,
    freeRamBytes: 24 * GiB,
    gpu: [{ vendor: "apple", vramBytes: 0 }],
    freeDiskBytes: 500 * GiB,
  };
}

function quant(overrides: Partial<Quantization> = {}): Quantization {
  return {
    name: "Q4_K_M",
    diskBytes: 5 * GiB,
    minRamBytes: 6 * GiB,
    minVramBytes: 6 * GiB,
    ...overrides,
  };
}

function catalogWith(quants: readonly Quantization[]): Catalog {
  return {
    schemaVersion: 1,
    generatedAt: "2026-01-01T00:00:00Z",
    models: [
      {
        id: "llama3.1:8b",
        family: "llama",
        params: "8B",
        architecture: "dense",
        license: "apache-2.0",
        openWeight: true,
        contextLength: 8192,
        capabilities: ["chat"],
        releaseDate: "2024-07-23",
        source: { ollama: "llama3.1:8b" },
        quantizations: quants,
      },
    ],
  };
}

function fakeAdapter(overrides: Partial<BackendAdapter> = {}): BackendAdapter {
  return {
    name: "ollama",
    isInstalled: async () => true,
    installHint: () => "brew install ollama",
    pull: async () => ({ modelId: "x", digestVerified: true }),
    serve: async () => ({ endpoint: "http://127.0.0.1:11434", pid: 1, port: 11434, ownedByUs: true }),
    waitUntilReady: async () => undefined,
    stop: async () => undefined,
    chat: async () => ({ content: "" }),
    embed: async () => ({ vectors: [], dimension: 0 }),
    ...overrides,
  };
}

function baseDeps(overrides: Partial<DoctorDeps> = {}): { deps: DoctorDeps; stdout: string[] } {
  const stdout: string[] = [];
  const deps: DoctorDeps = {
    config,
    detectHardware: async () => healthyHardware(),
    loadCatalog: () => catalogWith([quant()]),
    readState: () => ({ schemaVersion: 1, active: null }),
    adapter: fakeAdapter(),
    write: (t) => stdout.push(t),
    ...overrides,
  };
  return { deps, stdout };
}

function find(report: Awaited<ReturnType<typeof runDoctor>>, name: string) {
  const check = report.checks.find((c) => c.name === name);
  if (check === undefined) throw new Error(`no check named ${name}`);
  return check;
}

describe("runDoctor", () => {
  it("reports all clear and returns ok when the system is healthy", async () => {
    const { deps, stdout } = baseDeps();

    const report = await runDoctor(deps);

    expect(report.ok).toBe(true);
    expect(report.checks.every((c) => c.status !== "fail")).toBe(true);
    expect(find(report, "backend").status).toBe("ok");
    expect(find(report, "hardware").status).toBe("ok");
    expect(find(report, "state").status).toBe("ok");
    expect(stdout.join("")).toMatch(/backend/i);
  });

  it("fails when the backend is not installed and surfaces the install hint", async () => {
    const { deps } = baseDeps({
      adapter: fakeAdapter({ isInstalled: async () => false, installHint: () => "brew install ollama" }),
    });

    const report = await runDoctor(deps);

    expect(report.ok).toBe(false);
    const backend = find(report, "backend");
    expect(backend.status).toBe("fail");
    expect(backend.detail).toContain("brew install ollama");
  });

  it("fails when hardware has insufficient usable memory to run any model", async () => {
    const { deps } = baseDeps({
      detectHardware: async () => ({
        arch: "x64",
        platform: "linux",
        totalRamBytes: 2 * GiB,
        freeRamBytes: 2 * GiB, // minus the 2 GiB OS reserve → 0 usable
        gpu: [{ vendor: "none", vramBytes: 0 }],
        freeDiskBytes: 100 * GiB,
      }),
    });

    const report = await runDoctor(deps);

    expect(report.ok).toBe(false);
    expect(find(report, "hardware").status).toBe("fail");
  });

  it("fails when the catalog is corrupt", async () => {
    const { deps } = baseDeps({
      loadCatalog: () => {
        throw new CatalogError("catalog is not valid JSON");
      },
    });

    const report = await runDoctor(deps);

    expect(report.ok).toBe(false);
    expect(find(report, "catalog").status).toBe("fail");
  });

  it("fails when the runtime state is corrupt", async () => {
    const { deps } = baseDeps({
      readState: () => {
        throw new StateError("state file is not valid JSON", "unparseable");
      },
    });

    const report = await runDoctor(deps);

    expect(report.ok).toBe(false);
    expect(find(report, "state").status).toBe("fail");
  });

  it("surfaces digestVerified:false as a warning without failing", async () => {
    const { deps, stdout } = baseDeps({
      loadCatalog: () => catalogWith([quant({ digestVerified: false })]),
    });

    const report = await runDoctor(deps);

    expect(report.ok).toBe(true);
    const catalog = find(report, "catalog");
    expect(catalog.status).toBe("warn");
    expect(catalog.detail.toLowerCase()).toContain("digestverified");
    expect(stdout.join("")).toContain("llama3.1:8b");
  });

  it("warns when the catalog contains no models without failing", async () => {
    const { deps } = baseDeps({
      loadCatalog: () => ({ schemaVersion: 1, generatedAt: "2026-01-01T00:00:00Z", models: [] }),
    });

    const report = await runDoctor(deps);

    expect(report.ok).toBe(true);
    expect(find(report, "catalog").status).toBe("warn");
  });

  it("warns when a recorded server is unreachable but does not fail", async () => {
    const activeState: RuntimeState = {
      schemaVersion: 1,
      active: {
        modelId: "llama3.1:8b",
        endpoint: "http://127.0.0.1:11434",
        pid: 9001,
        port: 11434,
        ownedByUs: true,
      },
    };
    const { deps } = baseDeps({
      readState: () => activeState,
      adapter: fakeAdapter({
        waitUntilReady: async () => {
          throw new Error("connection refused");
        },
      }),
    });

    const report = await runDoctor(deps);

    expect(report.ok).toBe(true);
    const state = find(report, "state");
    expect(state.status).toBe("warn");
    expect(state.detail).toContain("http://127.0.0.1:11434");
  });

  it("reports a reachable recorded server as ok", async () => {
    const activeState: RuntimeState = {
      schemaVersion: 1,
      active: {
        modelId: "llama3.1:8b",
        endpoint: "http://127.0.0.1:11434",
        pid: 9001,
        port: 11434,
        ownedByUs: true,
      },
    };
    const { deps } = baseDeps({
      readState: () => activeState,
      adapter: fakeAdapter({ waitUntilReady: async () => undefined }),
    });

    const report = await runDoctor(deps);

    expect(report.ok).toBe(true);
    expect(find(report, "state").status).toBe("ok");
    expect(find(report, "state").detail).toContain("llama3.1:8b");
  });
});
