import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { BackendError, ValidationError } from "../errors.js";
import { assertLoopbackEndpoint } from "./adapter.js";
import { assertSafeModelId } from "./net.js";
import type { InstalledModel, InstalledModelSupport } from "./installed.js";

const DIGEST = z.string().regex(/^[a-f0-9]{64}$/);
const TAGS = z.object({
  models: z
    .array(
      z.object({
        name: z.string().min(1).max(256),
        digest: DIGEST,
        size: z.number().int().positive().safe(),
        remote_host: z.string().optional(),
        remote_model: z.string().optional(),
        details: z.object({ quantization_level: z.string().max(100).optional() }).optional(),
      }),
    )
    .max(10000),
});
const SHOW = z.object({
  model_info: z.record(z.unknown()).default({}),
  capabilities: z.array(z.string().max(100)).max(100).default([]),
  parameters: z.string().max(100000).optional(),
  remote_host: z.string().optional(),
});
const CONTEXT = z.number().int().min(1).max(10_000_000);
const LAYER = z.object({
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  size: z.number().int().nonnegative().safe(),
  mediaType: z.string(),
});
const MANIFEST = z.object({
  schemaVersion: z.literal(2),
  config: LAYER,
  layers: z.array(LAYER).min(1).max(10000),
});

export interface InstalledVerifierOptions {
  readonly modelsDir?: string;
  readonly readFile?: (path: string) => Promise<string>;
  readonly hashFile?: (path: string) => Promise<string>;
  readonly statFile?: (path: string) => Promise<{ size: number }>;
}

async function hashBlob(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export function createInstalledModelVerifier(
  options: InstalledVerifierOptions = {},
): InstalledModelSupport["verify"] {
  const root =
    options.modelsDir ?? process.env["OLLAMA_MODELS"] ?? join(homedir(), ".ollama", "models");
  const read = options.readFile ?? ((path: string) => readFile(path, "utf8"));
  const hash = options.hashFile ?? hashBlob;
  const measure = options.statFile ?? stat;
  return async (modelId, digest, expectedSha256, expectedSizeBytes) => {
    assertSafeModelId(modelId);
    if (!DIGEST.safeParse(digest).success) throw new ValidationError("invalid manifest digest");
    const segments = modelId.split("/");
    if (segments.length > 3) throw new ValidationError("invalid installed model path");
    const last = segments.pop()!;
    const parts = last.split(":");
    const name = parts[0]!;
    const tag = parts[1] ?? "latest";
    const namespace = segments.pop() ?? "library";
    const registry = segments.pop() ?? "registry.ollama.ai";
    if (
      parts.length > 2 ||
      ![registry, namespace, name, tag].every((part) => /^[a-z0-9][a-z0-9._-]*$/.test(part))
    ) {
      throw new ValidationError("invalid installed model path");
    }
    const path = join(root, "manifests", registry, namespace, name, tag);
    try {
      const raw = await read(path);
      if (
        raw.length > 4 * 1024 * 1024 ||
        createHash("sha256").update(raw).digest("hex") !== digest
      ) {
        throw new BackendError("local manifest integrity mismatch");
      }
      const manifest = MANIFEST.parse(JSON.parse(raw) as unknown);
      const weights = manifest.layers.filter(
        (layer) => layer.mediaType === "application/vnd.ollama.image.model",
      );
      if (
        expectedSha256 !== undefined &&
        !weights.some((layer) => layer.digest === `sha256:${expectedSha256}`)
      ) {
        throw new BackendError("installed weights do not match the catalog digest");
      }
      if (
        expectedSizeBytes !== undefined &&
        weights.reduce((total, layer) => total + layer.size, 0) < expectedSizeBytes * 0.5
      ) {
        throw new BackendError("installed weights do not meet the catalog size floor");
      }
      if (
        !manifest.layers.some((layer) => layer.mediaType === "application/vnd.ollama.image.model")
      ) {
        throw new BackendError("local manifest has no model weights");
      }
      for (const layer of [manifest.config, ...manifest.layers]) {
        const blob = join(root, "blobs", layer.digest.replace(":", "-"));
        if (
          (await measure(blob)).size !== layer.size ||
          (await hash(blob)) !== layer.digest.slice(7)
        ) {
          throw new BackendError("local blob integrity mismatch");
        }
      }
      if ((await read(path)) !== raw)
        throw new BackendError("local manifest changed during verification");
    } catch (cause) {
      throw new BackendError(
        `installed model integrity verification failed for ${modelId}: ${cause instanceof Error ? cause.message : "unavailable content"}`,
        { cause },
      );
    }
  };
}

export interface OllamaInstalledOptions {
  readonly request: (
    endpoint: string,
    path: string,
    body?: Record<string, unknown>,
  ) => Promise<unknown>;
  readonly verify: InstalledModelSupport["verify"];
  readonly uniqueId?: () => string;
}

export class OllamaInstalledModels implements InstalledModelSupport {
  readonly verify: InstalledModelSupport["verify"];
  constructor(private readonly deps: OllamaInstalledOptions) {
    this.verify = deps.verify;
  }

  async list(endpoint: string): Promise<readonly InstalledModel[]> {
    endpoint = assertLoopbackEndpoint(endpoint);
    const parsed = TAGS.safeParse(await this.deps.request(endpoint, "/api/tags"));
    if (!parsed.success)
      throw new BackendError("invalid installed model inventory", { cause: parsed.error });
    return parsed.data.models
      .filter((entry) => !entry.remote_host && !entry.remote_model)
      .map((entry) => {
        assertSafeModelId(entry.name);
        return {
          id: entry.name,
          digest: entry.digest,
          sizeBytes: entry.size,
          quant: entry.details?.quantization_level ?? null,
          contextLength: null,
          kvBytesPerToken: null,
          capabilities: [],
        };
      });
  }

  async inspect(endpoint: string, modelId: string): Promise<InstalledModel> {
    assertSafeModelId(modelId);
    const selected = (await this.list(endpoint)).find((entry) => entry.id === modelId);
    if (selected === undefined)
      throw new ValidationError(`model ${modelId} is not installed locally`);
    const result = SHOW.safeParse(
      await this.deps.request(assertLoopbackEndpoint(endpoint), "/api/show", { model: modelId }),
    );
    if (!result.success || result.data.remote_host)
      throw new BackendError("invalid local model metadata");
    const info = result.data.model_info;
    const architecture = z.string().safeParse(info["general.architecture"]);
    const family = architecture.success ? architecture.data : "";
    const context = CONTEXT.safeParse(info[`${family}.context_length`]);
    let kvBytesPerToken: number | null = null;
    if (["llama", "qwen2"].includes(family)) {
      const geometry = z
        .array(z.number().int().positive().max(100000))
        .length(4)
        .safeParse([
          info[`${family}.block_count`],
          info[`${family}.attention.head_count_kv`],
          info[`${family}.attention.key_length`],
          info[`${family}.attention.value_length`],
        ]);
      if (geometry.success) {
        const [layers, heads, key, value] = geometry.data as [number, number, number, number];
        kvBytesPerToken = layers * heads * (key + value) * 2;
      }
    }
    return {
      ...selected,
      contextLength: context.success ? context.data : null,
      kvBytesPerToken,
      capabilities: result.data.capabilities,
    };
  }

  async activate(endpoint: string, model: InstalledModel, context?: number): Promise<string> {
    endpoint = assertLoopbackEndpoint(endpoint);
    if (context !== undefined && !CONTEXT.safeParse(context).success)
      throw new ValidationError("invalid context");
    await this.verify(model.id, model.digest);
    const current = (await this.list(endpoint)).find((entry) => entry.id === model.id);
    if (current?.digest !== model.digest)
      throw new BackendError("installed model manifest changed; retry");
    if (context === undefined) return model.id;
    const variant = `llmup-context-${(this.deps.uniqueId ?? randomUUID)()}:${String(context)}`;
    assertSafeModelId(variant);
    const created = z.object({ status: z.literal("success") }).safeParse(
      await this.deps.request(endpoint, "/api/create", {
        model: variant,
        from: model.id,
        parameters: { num_ctx: context },
        stream: false,
      }),
    );
    if (!created.success) throw new BackendError("context variant creation failed");
    const metadata = SHOW.safeParse(
      await this.deps.request(endpoint, "/api/show", { model: variant }),
    );
    if (
      !metadata.success ||
      !metadata.data.parameters?.split("\n").some((line) => {
        const [name, value] = line.trim().split(/\s+/);
        return name === "num_ctx" && Number(value) === context;
      })
    )
      throw new BackendError("runtime did not retain requested context");
    const variantModel = (await this.list(endpoint)).find((entry) => entry.id === variant);
    if (variantModel === undefined) throw new BackendError("context variant is not installed");
    await this.verify(variantModel.id, variantModel.digest);
    const after = (await this.list(endpoint)).find((entry) => entry.id === model.id);
    if (after?.digest !== model.digest)
      throw new BackendError("source model changed while configuring context");
    return variant;
  }
}
