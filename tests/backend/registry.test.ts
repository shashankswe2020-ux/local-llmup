import { describe, expect, it, vi } from "vitest";
import { ValidationError } from "../../src/errors.js";
import { OllamaAdapter } from "../../src/backend/ollama.js";
import { MlxAdapter } from "../../src/backend/mlx.js";
import { LmStudioAdapter } from "../../src/backend/lmstudio.js";
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
import { createDefaultRegistry, createRegistry } from "../../src/backend/registry.js";

interface FakeAdapterOptions {
  readonly name: string;
  readonly isInstalled: () => Promise<boolean>;
}

function fakeAdapter(options: FakeAdapterOptions): BackendAdapter {
  return {
    name: options.name,
    capabilities: {
      canPull: true,
      canEmbed: true,
      openAiCompatible: true,
      formats: ["ollama"],
      defaultPort: 11434,
    },
    isInstalled: options.isInstalled,
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

describe("createDefaultRegistry", () => {
  it("registers the Ollama adapter", () => {
    const registry = createDefaultRegistry();
    const ollama = registry.get("ollama");
    const mlx = registry.get("mlx");
    const lmstudio = registry.get("lmstudio");
    expect(ollama).toBeInstanceOf(OllamaAdapter);
    expect(mlx).toBeInstanceOf(MlxAdapter);
    expect(lmstudio).toBeInstanceOf(LmStudioAdapter);
    expect(registry.all().map((a) => a.name)).toEqual(["ollama", "llamacpp", "mlx", "lmstudio"]);
  });
});

describe("createRegistry", () => {
  it("returns a registered adapter by name", () => {
    const ollama = fakeAdapter({ name: "ollama", isInstalled: async () => true });
    const registry = createRegistry([ollama]);
    expect(registry.get("ollama")).toBe(ollama);
  });

  it("throws ValidationError for an unknown backend", () => {
    const registry = createRegistry([
      fakeAdapter({ name: "ollama", isInstalled: async () => true }),
    ]);
    expect(() => registry.get("bogus")).toThrow(ValidationError);
  });

  it("rejects duplicate adapter names", () => {
    expect(() =>
      createRegistry([
        fakeAdapter({ name: "ollama", isInstalled: async () => true }),
        fakeAdapter({ name: "ollama", isInstalled: async () => true }),
      ]),
    ).toThrow(ValidationError);
  });

  it("all() preserves registration order and is a stable snapshot", () => {
    const a = fakeAdapter({ name: "a", isInstalled: async () => true });
    const b = fakeAdapter({ name: "b", isInstalled: async () => true });
    const registry = createRegistry([a, b]);
    expect(registry.all().map((x) => x.name)).toEqual(["a", "b"]);
  });

  it("available() filters to installed adapters, preserving order", async () => {
    const a = fakeAdapter({ name: "a", isInstalled: async () => true });
    const b = fakeAdapter({ name: "b", isInstalled: async () => false });
    const c = fakeAdapter({ name: "c", isInstalled: async () => true });
    const registry = createRegistry([a, b, c]);
    expect((await registry.available()).map((x) => x.name)).toEqual(["a", "c"]);
  });

  it("available() treats a probe that throws as not installed", async () => {
    const good = fakeAdapter({ name: "good", isInstalled: async () => true });
    const boom = fakeAdapter({
      name: "boom",
      isInstalled: vi.fn(async () => {
        throw new Error("probe failed");
      }),
    });
    const registry = createRegistry([boom, good]);
    expect((await registry.available()).map((x) => x.name)).toEqual(["good"]);
  });
});
