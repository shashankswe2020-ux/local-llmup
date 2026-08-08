import { describe, expect, it, vi } from "vitest";
import { BackendError, ValidationError } from "../../src/errors.js";
import { createRegistry } from "../../src/backend/registry.js";
import { ENV_BACKEND_OVERRIDE, select } from "../../src/backend/select.js";
import type {
  BackendAdapter,
  ChatRequest,
  ChatResult,
  EmbedRequest,
  EmbedResult,
  PullOptions,
  PullResult,
  ReadinessOptions,
  ServeHandle,
  ServeOptions,
} from "../../src/backend/adapter.js";
import type { BackendName } from "../../src/types.js";

interface FakeAdapterOptions {
  readonly name: BackendName;
  readonly installed?: boolean;
}

/** A fully-typed adapter double with an observable `isInstalled` probe. */
function fakeAdapter(options: FakeAdapterOptions): BackendAdapter {
  const installed = options.installed ?? true;
  return {
    name: options.name,
    capabilities: {
      canPull: true,
      canEmbed: true,
      openAiCompatible: true,
      formats: ["ollama"],
      defaultPort: 11434,
    },
    isInstalled: vi.fn(async () => installed),
    installHint(): string {
      return `install ${options.name}`;
    },
    async pull(_options: PullOptions): Promise<PullResult> {
      return { modelId: "m", digestVerified: false };
    },
    async serve(_options?: ServeOptions): Promise<ServeHandle> {
      return { endpoint: "http://127.0.0.1:1", pid: 0, port: 1, ownedByUs: false };
    },
    async waitUntilReady(_options: ReadinessOptions): Promise<void> {},
    async stop(_handle: ServeHandle): Promise<void> {},
    async chat(_request: ChatRequest): Promise<ChatResult> {
      return { content: "" };
    },
    async embed(_request: EmbedRequest): Promise<EmbedResult> {
      return { vectors: [], dimension: 0 };
    },
  };
}

describe("select — create intent precedence", () => {
  it("prefers the explicit flag over env, config, and auto-detect", async () => {
    const ollama = fakeAdapter({ name: "ollama" });
    const llamacpp = fakeAdapter({ name: "llamacpp" });
    const registry = createRegistry([ollama, llamacpp]);

    const result = await select({
      intent: "create",
      registry,
      flag: "llamacpp",
      env: { [ENV_BACKEND_OVERRIDE]: "ollama" },
      configBackend: "ollama",
      platform: "linux",
      arch: "x64",
    });

    expect(result.adapter).toBe(llamacpp);
    expect(result.source).toBe("flag");
  });

  it("prefers env over config and auto-detect when no flag is given", async () => {
    const ollama = fakeAdapter({ name: "ollama" });
    const llamacpp = fakeAdapter({ name: "llamacpp" });
    const registry = createRegistry([ollama, llamacpp]);

    const result = await select({
      intent: "create",
      registry,
      env: { [ENV_BACKEND_OVERRIDE]: "llamacpp" },
      configBackend: "ollama",
      platform: "linux",
      arch: "x64",
    });

    expect(result.adapter).toBe(llamacpp);
    expect(result.source).toBe("env");
  });

  it("prefers a registered config backend over auto-detect", async () => {
    const ollama = fakeAdapter({ name: "ollama" });
    const llamacpp = fakeAdapter({ name: "llamacpp" });
    const registry = createRegistry([ollama, llamacpp]);

    const result = await select({
      intent: "create",
      registry,
      configBackend: "llamacpp",
      platform: "linux",
      arch: "x64",
    });

    expect(result.adapter).toBe(llamacpp);
    expect(result.source).toBe("config");
  });

  it("auto-detects when no flag, env, or config preference is given", async () => {
    const ollama = fakeAdapter({ name: "ollama" });
    const llamacpp = fakeAdapter({ name: "llamacpp" });
    const registry = createRegistry([ollama, llamacpp]);

    const result = await select({
      intent: "create",
      registry,
      platform: "linux",
      arch: "x64",
    });

    expect(result.adapter).toBe(ollama);
    expect(result.source).toBe("auto");
  });

  it("throws ValidationError for an unknown explicit flag", async () => {
    const registry = createRegistry([fakeAdapter({ name: "ollama" })]);

    await expect(
      select({ intent: "create", registry, flag: "bogus" }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("ignores a blank flag and falls through to the next source", async () => {
    const ollama = fakeAdapter({ name: "ollama" });
    const registry = createRegistry([ollama]);

    const result = await select({
      intent: "create",
      registry,
      flag: "   ",
      configBackend: "ollama",
      platform: "linux",
      arch: "x64",
    });

    expect(result.source).toBe("config");
  });

  it("never probes isInstalled when an explicit flag resolves (advice-path guard)", async () => {
    const ollama = fakeAdapter({ name: "ollama" });
    const llamacpp = fakeAdapter({ name: "llamacpp" });
    const registry = createRegistry([ollama, llamacpp]);

    await select({ intent: "create", registry, flag: "ollama" });

    expect(ollama.isInstalled).not.toHaveBeenCalled();
    expect(llamacpp.isInstalled).not.toHaveBeenCalled();
  });
});

describe("select — auto-detect priority", () => {
  it("ranks mlx first on Apple Silicon", async () => {
    const ollama = fakeAdapter({ name: "ollama" });
    const mlx = fakeAdapter({ name: "mlx" });
    const registry = createRegistry([ollama, mlx]);

    const result = await select({
      intent: "create",
      registry,
      platform: "darwin",
      arch: "arm64",
    });

    expect(result.adapter).toBe(mlx);
    expect(result.source).toBe("auto");
  });

  it("ranks ollama first on non-Apple hardware", async () => {
    const ollama = fakeAdapter({ name: "ollama" });
    const llamacpp = fakeAdapter({ name: "llamacpp" });
    const registry = createRegistry([llamacpp, ollama]);

    const result = await select({
      intent: "create",
      registry,
      platform: "linux",
      arch: "x64",
    });

    expect(result.adapter).toBe(ollama);
  });

  it("only ranks installed backends, skipping a higher-priority uninstalled one", async () => {
    const ollama = fakeAdapter({ name: "ollama", installed: false });
    const llamacpp = fakeAdapter({ name: "llamacpp", installed: true });
    const registry = createRegistry([ollama, llamacpp]);

    const result = await select({
      intent: "create",
      registry,
      platform: "linux",
      arch: "x64",
    });

    expect(result.adapter).toBe(llamacpp);
  });

  it("never auto-selects lmstudio even when it is the only installed backend", async () => {
    const lmstudio = fakeAdapter({ name: "lmstudio", installed: true });
    const ollama = fakeAdapter({ name: "ollama", installed: false });
    const registry = createRegistry([ollama, lmstudio]);

    await expect(
      select({ intent: "create", registry, platform: "linux", arch: "x64" }),
    ).rejects.toBeInstanceOf(BackendError);
    expect(lmstudio.isInstalled).not.toHaveBeenCalled();
  });

  it("throws BackendError listing install hints when nothing is installed", async () => {
    const ollama = fakeAdapter({ name: "ollama", installed: false });
    const registry = createRegistry([ollama]);

    await expect(
      select({ intent: "create", registry, platform: "linux", arch: "x64" }),
    ).rejects.toThrow(/install ollama/);
  });

  it("falls through to auto-detect when config names a known-but-unregistered backend", async () => {
    // Phase 0 registers ollama only; a config default of "llamacpp" is a valid
    // BackendName but not registered — it must NOT be passed to registry.get()
    // (which throws on unknown), and instead fall through to auto-detect.
    const ollama = fakeAdapter({ name: "ollama" });
    const registry = createRegistry([ollama]);

    const result = await select({
      intent: "create",
      registry,
      configBackend: "llamacpp",
      platform: "linux",
      arch: "x64",
    });

    expect(result.adapter).toBe(ollama);
    expect(result.source).toBe("auto");
  });
});

describe("select — attach intent", () => {
  it("resolves the active backend and reports the state source", async () => {
    const ollama = fakeAdapter({ name: "ollama" });
    const llamacpp = fakeAdapter({ name: "llamacpp" });
    const registry = createRegistry([ollama, llamacpp]);

    const result = await select({
      intent: "attach",
      registry,
      activeBackend: "llamacpp",
    });

    expect(result.adapter).toBe(llamacpp);
    expect(result.source).toBe("state");
  });

  it("accepts a flag that matches the active backend", async () => {
    const ollama = fakeAdapter({ name: "ollama" });
    const registry = createRegistry([ollama]);

    const result = await select({
      intent: "attach",
      registry,
      activeBackend: "ollama",
      flag: "ollama",
    });

    expect(result.adapter).toBe(ollama);
    expect(result.source).toBe("state");
  });

  it("rejects a flag that conflicts with the active backend", async () => {
    const ollama = fakeAdapter({ name: "ollama" });
    const llamacpp = fakeAdapter({ name: "llamacpp" });
    const registry = createRegistry([ollama, llamacpp]);

    await expect(
      select({ intent: "attach", registry, activeBackend: "ollama", flag: "llamacpp" }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects an env override that conflicts with the active backend", async () => {
    const ollama = fakeAdapter({ name: "ollama" });
    const llamacpp = fakeAdapter({ name: "llamacpp" });
    const registry = createRegistry([ollama, llamacpp]);

    await expect(
      select({
        intent: "attach",
        registry,
        activeBackend: "ollama",
        env: { [ENV_BACKEND_OVERRIDE]: "llamacpp" },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects a conflicting env override even when the flag matches the active backend", async () => {
    const ollama = fakeAdapter({ name: "ollama" });
    const llamacpp = fakeAdapter({ name: "llamacpp" });
    const registry = createRegistry([ollama, llamacpp]);

    await expect(
      select({
        intent: "attach",
        registry,
        activeBackend: "ollama",
        flag: "ollama",
        env: { [ENV_BACKEND_OVERRIDE]: "llamacpp" },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("throws ValidationError when there is no active backend to attach to", async () => {
    const registry = createRegistry([fakeAdapter({ name: "ollama" })]);

    await expect(select({ intent: "attach", registry })).rejects.toBeInstanceOf(ValidationError);
  });

  it("never probes isInstalled when attaching (advice-path guard)", async () => {
    const ollama = fakeAdapter({ name: "ollama" });
    const registry = createRegistry([ollama]);

    await select({ intent: "attach", registry, activeBackend: "ollama" });

    expect(ollama.isInstalled).not.toHaveBeenCalled();
  });
});
