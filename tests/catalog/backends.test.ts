import { describe, expect, it } from "vitest";
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
import { createRegistry } from "../../src/backend/registry.js";
import { backendsForModel, formatsForModel } from "../../src/catalog/backends.js";
import type { CatalogModel, ModelFormat, ModelSource } from "../../src/types.js";
import { denseModel } from "./fixtures.js";

function fakeAdapter(name: BackendAdapter["name"], formats: readonly ModelFormat[]): BackendAdapter {
  return {
    name,
    capabilities: {
      canPull: true,
      canEmbed: true,
      openAiCompatible: true,
      formats,
      defaultPort: 8080,
    },
    async isInstalled(): Promise<boolean> {
      return true;
    },
    installHint(): string {
      return `install ${name}`;
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

const ollamaAdapter = fakeAdapter("ollama", ["ollama"]);
const llamacppAdapter = fakeAdapter("llamacpp", ["gguf"]);
const mlxAdapter = fakeAdapter("mlx", ["mlx"]);
const APPLE_TARGET = { platform: "darwin", arch: "arm64" } as const;
const LINUX_TARGET = { platform: "linux", arch: "x64" } as const;

function modelWithSource(source: ModelSource): CatalogModel {
  return { ...denseModel, source };
}

const validGguf = {
  repo: "Qwen/Qwen3-14B-GGUF",
  revision: "a".repeat(40),
  file: "qwen3-14b-q4_k_m.gguf",
} as const;
const validMlx = {
  repo: "mlx-community/Qwen3-14B-4bit",
  revision: "b".repeat(40),
  files: [
    { file: "config.json", sha256: "c".repeat(64), bytes: 100 },
    { file: "tokenizer_config.json", sha256: "d".repeat(64), bytes: 200 },
    { file: "model.safetensors", sha256: "e".repeat(64), bytes: 1_000 },
  ],
} as const;

describe("formatsForModel", () => {
  it("maps an ollama source to the ollama format", () => {
    expect(formatsForModel(modelWithSource({ ollama: "llama3.1:8b" }))).toEqual(["ollama"]);
  });

  it("maps a gguf source to the gguf format", () => {
    expect(formatsForModel(modelWithSource({ gguf: validGguf }))).toEqual(["gguf"]);
  });

  it("maps an mlx source to the mlx format", () => {
    expect(formatsForModel(modelWithSource({ mlx: validMlx }))).toEqual(["mlx"]);
  });

  it("does not map an hf source to any format (advisory only)", () => {
    expect(formatsForModel(modelWithSource({ hf: "meta-llama/Llama-3.1-8B" }))).toEqual([]);
  });

  it("collects multiple source formats in canonical order", () => {
    expect(
      formatsForModel(modelWithSource({ gguf: validGguf, ollama: "llama3.1:8b" })),
    ).toEqual(["ollama", "gguf"]);
  });

  it("ignores hf when other servable sources are present", () => {
    expect(
      formatsForModel(modelWithSource({ hf: "meta-llama/Llama-3.1-8B", mlx: validMlx })),
    ).toEqual(["mlx"]);
  });
});

describe("backendsForModel", () => {
  it("returns the ollama backend for an ollama-only model (never dropped)", () => {
    const registry = createRegistry([ollamaAdapter, llamacppAdapter, mlxAdapter]);
    const backends = backendsForModel(
      modelWithSource({ ollama: "llama3.1:8b" }),
      registry,
      LINUX_TARGET,
    );
    expect(backends.map((a) => a.name)).toEqual(["ollama"]);
  });

  it("returns both llama.cpp and ollama for a gguf+ollama model", () => {
    const registry = createRegistry([ollamaAdapter, llamacppAdapter, mlxAdapter]);
    const backends = backendsForModel(
      modelWithSource({ gguf: validGguf, ollama: "llama3.1:8b" }),
      registry,
      LINUX_TARGET,
    );
    expect(backends.map((a) => a.name)).toEqual(["ollama", "llamacpp"]);
  });

  it("returns no backends for an hf-only model", () => {
    const registry = createRegistry([ollamaAdapter, llamacppAdapter, mlxAdapter]);
    const backends = backendsForModel(
      modelWithSource({ hf: "meta-llama/Llama-3.1-8B" }),
      registry,
      LINUX_TARGET,
    );
    expect(backends).toEqual([]);
  });

  it("returns the mlx backend for an mlx-only model", () => {
    const registry = createRegistry([ollamaAdapter, llamacppAdapter, mlxAdapter]);
    const backends = backendsForModel(modelWithSource({ mlx: validMlx }), registry, APPLE_TARGET);
    expect(backends.map((a) => a.name)).toEqual(["mlx"]);
  });

  it("omits MLX for a non-Apple target without probing installation", () => {
    const registry = createRegistry([ollamaAdapter, mlxAdapter]);
    const model = modelWithSource({ mlx: validMlx });

    expect(
      backendsForModel(model, registry, LINUX_TARGET).map(
        (adapter) => adapter.name,
      ),
    ).toEqual([]);
    expect(
      backendsForModel(model, registry, APPLE_TARGET).map(
        (adapter) => adapter.name,
      ),
    ).toEqual(["mlx"]);
  });

  it("omits a gguf backend that is not registered", () => {
    const registry = createRegistry([ollamaAdapter]);
    const backends = backendsForModel(
      modelWithSource({ gguf: validGguf, ollama: "llama3.1:8b" }),
      registry,
      LINUX_TARGET,
    );
    expect(backends.map((a) => a.name)).toEqual(["ollama"]);
  });

  it("returns backends in registration order, not source order", () => {
    const registry = createRegistry([llamacppAdapter, ollamaAdapter]);
    const backends = backendsForModel(
      modelWithSource({ ollama: "llama3.1:8b", gguf: validGguf }),
      registry,
      LINUX_TARGET,
    );
    expect(backends.map((a) => a.name)).toEqual(["llamacpp", "ollama"]);
  });
});
