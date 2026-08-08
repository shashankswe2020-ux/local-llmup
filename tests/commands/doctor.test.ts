import { describe, expect, it } from "vitest";
import type { Config } from "../../src/config.js";
import type { BackendAdapter } from "../../src/backend/adapter.js";
import { createRegistry } from "../../src/backend/registry.js";
import { CatalogError, StateError } from "../../src/errors.js";
import { STATE_SCHEMA_VERSION, type RuntimeState } from "../../src/state/state.js";
import type { Catalog, HardwareProfile, Quantization } from "../../src/types.js";
import { runDoctor, type DoctorDeps } from "../../src/commands/doctor.js";
import {
  expectNoninteractiveGolden,
  jsonGoldenName,
  plainGoldenName,
  withGoldenEnvironment,
} from "../fixtures/noninteractive-golden.js";

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
    capabilities: {
      canPull: true,
      canEmbed: true,
      openAiCompatible: true,
      formats: ["ollama"],
      defaultPort: 11434,
    },
    isInstalled: async () => true,
    installHint: () => "brew install ollama",
    pull: async () => ({ modelId: "x", digestVerified: true }),
    serve: async () => ({
      endpoint: "http://127.0.0.1:11434",
      pid: 1,
      port: 11434,
      ownedByUs: true,
    }),
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
    readState: () => ({ schemaVersion: STATE_SCHEMA_VERSION, active: null }),
    registry: createRegistry([fakeAdapter()]),
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

    const report = await withGoldenEnvironment(() => runDoctor(deps));

    expect(report.ok).toBe(true);
    expect(report.checks.every((c) => c.status !== "fail")).toBe(true);
    expect(find(report, "backend").status).toBe("ok");
    expect(find(report, "hardware").status).toBe("ok");
    expect(find(report, "state").status).toBe("ok");
    expectNoninteractiveGolden(plainGoldenName("doctor"), stdout.join(""));
  });

  it("fails when the backend is not installed and surfaces the install hint", async () => {
    const { deps } = baseDeps({
      registry: createRegistry([
        fakeAdapter({ isInstalled: async () => false, installHint: () => "brew install ollama" }),
      ]),
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
      schemaVersion: STATE_SCHEMA_VERSION,
      active: {
        backend: "ollama",
        modelId: "llama3.1:8b",
        endpoint: "http://127.0.0.1:11434",
        pid: 9001,
        port: 11434,
        ownedByUs: true,
      },
    };
    const { deps } = baseDeps({
      readState: () => activeState,
      registry: createRegistry([
        fakeAdapter({
          waitUntilReady: async () => {
            throw new Error("connection refused");
          },
        }),
      ]),
    });

    const report = await runDoctor(deps);

    expect(report.ok).toBe(true);
    const state = find(report, "state");
    expect(state.status).toBe("warn");
    expect(state.detail).toContain("http://127.0.0.1:11434");
  });

  it("reports a reachable recorded server as ok", async () => {
    const activeState: RuntimeState = {
      schemaVersion: STATE_SCHEMA_VERSION,
      active: {
        backend: "ollama",
        modelId: "llama3.1:8b",
        endpoint: "http://127.0.0.1:11434",
        pid: 9001,
        port: 11434,
        ownedByUs: true,
      },
    };
    const { deps } = baseDeps({
      readState: () => activeState,
      registry: createRegistry([fakeAdapter({ waitUntilReady: async () => undefined })]),
    });

    const report = await runDoctor(deps);

    expect(report.ok).toBe(true);
    expect(find(report, "state").status).toBe("ok");
    expect(find(report, "state").detail).toContain("llama3.1:8b");
  });
});

describe("runDoctor — AI Hardware Score (T34)", () => {
  it("appends score + bottleneck lines and exposes them on the report", async () => {
    const { deps, stdout } = baseDeps();

    const report = await runDoctor(deps);

    expect(report.hardwareScore).not.toBeNull();
    expect(report.hardwareScore?.total).toBeGreaterThanOrEqual(0);
    expect(report.hardwareScore?.total).toBeLessThanOrEqual(100);
    const out = stdout.join("");
    expect(out).toMatch(/AI Hardware Score: \d{1,3}\/100/);
    expect(out).toMatch(/Primary bottleneck:/i);
  });

  it("does not fail the exit verdict for a weak-but-runnable machine (AC3)", async () => {
    const { deps } = baseDeps({
      detectHardware: async () => ({
        arch: "x64",
        platform: "linux",
        totalRamBytes: 8 * GiB,
        freeRamBytes: 6 * GiB,
        gpu: [{ vendor: "none", vramBytes: 0 }],
        freeDiskBytes: 40 * GiB,
      }),
    });

    const report = await runDoctor(deps);

    // Low score, but the machine can still run a small model → not a FAIL.
    expect(report.ok).toBe(true);
    expect(report.hardwareScore).not.toBeNull();
    expect(report.hardwareScore!.total).toBeLessThan(60);
  });

  it("emits hardwareScore + bottleneck in --json and omits the table", async () => {
    const { deps, stdout } = baseDeps();

    const report = await runDoctor(deps, { json: true });

    const out = stdout.join("");
    const parsed = JSON.parse(out) as {
      ok: boolean;
      hardwareScore: { total: number; bottleneck: string } | null;
    };
    expect(parsed.ok).toBe(report.ok);
    expect(parsed.hardwareScore?.total).toBe(report.hardwareScore?.total);
    expect(typeof parsed.hardwareScore?.bottleneck).toBe("string");
    // JSON mode is machine-readable only — no human table/verdict text.
    expect(out).not.toContain("All checks passed");
  });

  it("degrades gracefully to a null score when detection throws", async () => {
    const { deps } = baseDeps({
      detectHardware: async () => {
        throw new Error("probe exploded");
      },
    });

    const report = await runDoctor(deps);

    expect(report.hardwareScore).toBeNull();
    expect(find(report, "hardware").status).toBe("fail");
  });
});

describe("runDoctor — backends section (B11)", () => {
  it("lists every registered backend with installed status, and surfaces install hints for missing ones", async () => {
    const { deps, stdout } = baseDeps({
      registry: createRegistry([
        fakeAdapter({ name: "ollama", isInstalled: async () => true }),
        fakeAdapter({
          name: "llamacpp",
          isInstalled: async () => false,
          installHint: () => "brew install llama.cpp",
        }),
      ]),
    });

    const report = await runDoctor(deps);

    expect(report.backends.map((b) => b.name)).toEqual(["ollama", "llamacpp"]);
    const ollama = report.backends.find((b) => b.name === "ollama");
    const llamacpp = report.backends.find((b) => b.name === "llamacpp");
    expect(ollama?.installed).toBe(true);
    expect(llamacpp?.installed).toBe(false);

    const out = stdout.join("");
    expect(out).toMatch(/Backends/);
    expect(out).toContain("llamacpp");
    expect(out).toContain("brew install llama.cpp");
  });

  it("reports a best-effort version for an installed backend", async () => {
    const { deps, stdout } = baseDeps({
      registry: createRegistry([
        fakeAdapter({
          name: "ollama",
          isInstalled: async () => true,
          version: async () => "0.3.14",
        }),
      ]),
    });

    const report = await runDoctor(deps);

    expect(report.backends[0]?.version).toBe("0.3.14");
    expect(stdout.join("")).toContain("0.3.14");
  });

  it("passes hostile version strings through stripControl", async () => {
    const { deps, stdout } = baseDeps({
      registry: createRegistry([
        fakeAdapter({
          name: "ollama",
          isInstalled: async () => true,
          version: async () => "0.3.14\u001b[31m\u0007evil",
        }),
      ]),
    });

    const report = await runDoctor(deps);

    expect(report.backends[0]?.version).toBe("0.3.14evil");
    const out = stdout.join("");
    expect(out).not.toContain("\u001b");
    expect(out).not.toContain("\u0007");
  });

  it("treats a null version and a throwing version probe as unknown without failing", async () => {
    const { deps } = baseDeps({
      registry: createRegistry([
        fakeAdapter({ name: "ollama", isInstalled: async () => true, version: async () => null }),
        fakeAdapter({
          name: "llamacpp",
          isInstalled: async () => true,
          version: async () => {
            throw new Error("probe blew up");
          },
        }),
      ]),
    });

    const report = await runDoctor(deps);

    expect(report.ok).toBe(true);
    expect(report.backends.find((b) => b.name === "ollama")?.version).toBeNull();
    expect(report.backends.find((b) => b.name === "llamacpp")?.version).toBeNull();
  });

  it("marks MLX as the auto-selected default on Apple Silicon when installed", async () => {
    const { deps } = baseDeps({
      detectHardware: async () => healthyHardware(), // arm64/darwin
      registry: createRegistry([
        fakeAdapter({ name: "ollama", isInstalled: async () => true }),
        fakeAdapter({ name: "mlx", isInstalled: async () => true }),
      ]),
    });

    const report = await runDoctor(deps);

    expect(report.backends.find((b) => b.name === "mlx")?.isDefault).toBe(true);
    expect(report.backends.find((b) => b.name === "ollama")?.isDefault).toBe(false);
  });

  it("prefers Ollama as the default on non-Apple hardware", async () => {
    const { deps } = baseDeps({
      detectHardware: async () => ({
        arch: "x64",
        platform: "linux",
        totalRamBytes: 32 * GiB,
        freeRamBytes: 24 * GiB,
        gpu: [{ vendor: "none", vramBytes: 0 }],
        freeDiskBytes: 500 * GiB,
      }),
      registry: createRegistry([
        fakeAdapter({ name: "llamacpp", isInstalled: async () => true }),
        fakeAdapter({ name: "ollama", isInstalled: async () => true }),
      ]),
    });

    const report = await runDoctor(deps);

    expect(report.backends.find((b) => b.name === "ollama")?.isDefault).toBe(true);
    expect(report.backends.find((b) => b.name === "llamacpp")?.isDefault).toBe(false);
  });

  it("selects no default when no backend is installed", async () => {
    const { deps } = baseDeps({
      registry: createRegistry([fakeAdapter({ name: "ollama", isInstalled: async () => false })]),
    });

    const report = await runDoctor(deps);

    expect(report.backends.every((b) => b.isDefault === false)).toBe(true);
  });

  it("treats a throwing isInstalled probe as not installed without failing the report", async () => {
    const { deps } = baseDeps({
      registry: createRegistry([
        fakeAdapter({ name: "ollama", isInstalled: async () => true }),
        fakeAdapter({
          name: "llamacpp",
          isInstalled: async () => {
            throw new Error("probe exploded");
          },
        }),
      ]),
    });

    const report = await runDoctor(deps);

    expect(report.ok).toBe(true);
    expect(report.backends.find((b) => b.name === "llamacpp")?.installed).toBe(false);
  });

  it("includes the backends array in --json output", async () => {
    const { deps, stdout } = baseDeps({
      registry: createRegistry([
        fakeAdapter({
          name: "ollama",
          isInstalled: async () => true,
          version: async () => "0.3.14",
        }),
      ]),
    });

    await withGoldenEnvironment(() => runDoctor(deps, { json: true }));
    expectNoninteractiveGolden(jsonGoldenName("doctor"), stdout.join(""));

    const parsed = JSON.parse(stdout.join("")) as {
      backends: ReadonlyArray<{
        name: string;
        installed: boolean;
        version: string | null;
        isDefault: boolean;
      }>;
    };
    expect(parsed.backends[0]?.name).toBe("ollama");
    expect(parsed.backends[0]?.installed).toBe(true);
    expect(parsed.backends[0]?.version).toBe("0.3.14");
  });
});
