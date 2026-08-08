/**
 * Attach-only LM Studio backend adapter.
 *
 * Official CLI/API references:
 * - https://lmstudio.ai/docs/cli
 * - https://lmstudio.ai/docs/cli/serve/server-status
 * - https://lmstudio.ai/docs/developer/openai-compat
 */
import { spawn as nodeSpawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  createReadStream,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { z } from "zod";
import { BackendError, ValidationError } from "../errors.js";
import { stripControl } from "../sanitize.js";
import type { BackendCapabilities } from "../types.js";
import type {
  BackendAdapter,
  ChatRequest,
  ChatResult,
  EmbedRequest,
  EmbedResult,
  PullDelegatedSource,
  PullOptions,
  PullResult,
  ReadinessOptions,
  ServeHandle,
  ServeOptions,
} from "./adapter.js";
import { assertLoopbackEndpoint, buildEndpoint, DEFAULT_BIND_HOST } from "./adapter.js";
import { probeListenerIdentity, sameListenerProcess, type ListenerIdentity } from "./listener.js";
import { assertSafeModelId } from "./net.js";
import type { FetchFn, ProcessOutputStream, SleepFn, SpawnFn, SpawnedProcess } from "./ollama.js";

const LMS_BINARY = "lms";
const LM_STUDIO_DEFAULT_PORT = 1234;
const PROBE_TIMEOUT_MS = 5_000;
const MAX_VERSION_BYTES = 8 * 1024;
const COMMAND_TIMEOUT_MS = 5 * 60_000;
const READINESS_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 10_000;
const CHAT_TIMEOUT_MS = 120_000;
const BACKOFF_MS = 250;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_CONTENT_BYTES = 1024 * 1024;
const LISTENER_PROBE_ATTEMPTS = 5;
const LISTENER_PROBE_BACKOFF_MS = 100;

const DownloadedModelSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => stripControl(value) === value),
    modelKey: z
      .string()
      .min(1)
      .max(1024)
      .refine((value) => stripControl(value) === value)
      .optional(),
    type: z.enum(["llm", "embedding"]).optional(),
  })
  .passthrough();
const DownloadedModelGroupSchema = z.object({
  model: z.object({ modelKey: z.string().min(1).max(1024) }).passthrough(),
  variants: z.array(DownloadedModelSchema).max(10_000),
});
const DownloadedModelsSchema = z
  .array(z.union([DownloadedModelSchema, DownloadedModelGroupSchema]))
  .max(10_000);
const GreetingSchema = z.object({ lmstudio: z.literal(true) }).passthrough();
const ModelsSchema = z.object({
  object: z.literal("list").optional(),
  data: z.array(z.object({ id: z.string().min(1).max(1024) }).passthrough()).max(10_000),
});
const ServerStatusSchema = z.object({
  running: z.literal(true),
  port: z.number().int().min(1).max(65_535),
});
const LoadedModelsSchema = z
  .array(
    z
      .object({
        identifier: z.string().min(1).max(1024),
        path: z.string().min(1).max(4096),
      })
      .passthrough(),
  )
  .max(1024);
const ChatResponseSchema = z.object({
  choices: z
    .array(z.object({ message: z.object({ content: z.string() }) }))
    .min(1)
    .max(8),
});
const EmbeddingResponseSchema = z.object({
  data: z
    .array(
      z.object({
        index: z.number().int().nonnegative(),
        embedding: z.array(z.number().finite()).min(1).max(65_536),
      }),
    )
    .max(1024),
});

function adaptStream(stream: Readable | null): ProcessOutputStream | null {
  if (stream === null) return null;
  stream.setEncoding("utf8");
  return { onData: (listener) => stream.on("data", (chunk: string) => listener(chunk)) };
}

const defaultSpawn: SpawnFn = (command, args, options) => {
  const child = nodeSpawn(command, [...args], {
    stdio: options.stdio === "ignore" ? ["ignore", "ignore", "ignore"] : ["ignore", "pipe", "pipe"],
    shell: false,
    signal: options.signal,
    ...(options.env !== undefined ? { env: options.env } : {}),
  });
  return {
    pid: child.pid,
    stdout: adaptStream(child.stdout),
    stderr: adaptStream(child.stderr),
    onClose: (listener) => child.on("close", listener),
    onError: (listener) => child.on("error", listener),
    kill: (signal) => child.kill(signal),
  };
};

interface ProcessResult {
  readonly code: number | null;
  readonly stdout: string;
}

export interface LmsCommandResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export type LmsCommandFn = (
  args: readonly string[],
  signal?: AbortSignal,
) => Promise<LmsCommandResult>;

function runProbe(spawn: SpawnFn, binary: string): Promise<ProcessResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  return new Promise<ProcessResult>((resolve) => {
    let settled = false;
    let stdout = "";
    let overflow = false;
    const finish = (result: ProcessResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    let child: SpawnedProcess;
    try {
      child = spawn(binary, ["--version"], {
        shell: false,
        stdio: "pipe",
        signal: controller.signal,
      });
    } catch {
      finish({ code: null, stdout: "" });
      return;
    }
    child.stdout?.onData((chunk) => {
      if (stdout.length + chunk.length > MAX_VERSION_BYTES) {
        overflow = true;
        return;
      }
      stdout += chunk;
    });
    child.onError(() => finish({ code: null, stdout: "" }));
    child.onClose((code) => finish({ code, stdout: overflow ? "" : stdout }));
  });
}

function runCommand(
  spawn: SpawnFn,
  binary: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<LmsCommandResult> {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), COMMAND_TIMEOUT_MS);
  return new Promise<LmsCommandResult>((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let overflow = false;
    const finish = (result: LmsCommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    let child: SpawnedProcess;
    try {
      child = spawn(binary, args, { shell: false, stdio: "pipe", signal: controller.signal });
    } catch {
      finish({ code: null, stdout: "", stderr: "" });
      return;
    }
    const append = (current: string, chunk: string): string => {
      if (current.length + chunk.length > MAX_RESPONSE_BYTES) {
        overflow = true;
        return current;
      }
      return current + chunk;
    };
    child.stdout?.onData((chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.onData((chunk) => {
      stderr = append(stderr, chunk);
    });
    child.onError(() => finish({ code: null, stdout: "", stderr: "" }));
    child.onClose((code) =>
      finish({ code, stdout: overflow ? "" : stdout, stderr: overflow ? "" : stderr }),
    );
  });
}

const defaultFetch: FetchFn = (url, init) =>
  fetch(url, {
    redirect: "error",
    ...(init?.signal !== undefined ? { signal: init.signal } : {}),
    ...(init?.method !== undefined ? { method: init.method } : {}),
    ...(init?.headers !== undefined ? { headers: init.headers } : {}),
    ...(init?.body !== undefined ? { body: init.body } : {}),
  });

const defaultSleep: SleepFn = (ms, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new BackendError("LM Studio wait aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new BackendError("LM Studio wait aborted"));
      },
      { once: true },
    );
  });

export interface LmStudioAdapterOptions {
  readonly spawn?: SpawnFn | undefined;
  readonly binary?: string | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  readonly runCommand?: LmsCommandFn | undefined;
  readonly fetch?: FetchFn | undefined;
  readonly sleep?: SleepFn | undefined;
  readonly listenerProbe?:
    ((port: number, host: string) => Promise<ListenerIdentity | null>) | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly modelsRoot?: string | undefined;
  readonly trustedExecutables?: readonly string[] | undefined;
}

/** LM Studio adapter using its documented CLI and OpenAI-compatible API. */
export class LmStudioAdapter implements BackendAdapter {
  readonly name = "lmstudio" as const;
  readonly capabilities: BackendCapabilities = {
    canPull: false,
    canEmbed: true,
    openAiCompatible: true,
    formats: ["gguf", "mlx"],
    defaultPort: LM_STUDIO_DEFAULT_PORT,
  };

  private readonly spawn: SpawnFn;
  private readonly binary: string;
  private readonly platform: NodeJS.Platform;
  private readonly runCommand: LmsCommandFn;
  private readonly fetch: FetchFn;
  private readonly sleep: SleepFn;
  private readonly listenerProbe: (port: number, host: string) => Promise<ListenerIdentity | null>;
  private readonly apiToken: string | undefined;
  private readonly modelsRoot: string;
  private readonly trustedExecutables: ReadonlySet<string>;

  constructor(options: LmStudioAdapterOptions = {}) {
    this.spawn = options.spawn ?? defaultSpawn;
    this.binary = options.binary ?? LMS_BINARY;
    this.platform = options.platform ?? process.platform;
    this.runCommand =
      options.runCommand ?? ((args, signal) => runCommand(this.spawn, this.binary, args, signal));
    this.fetch = options.fetch ?? defaultFetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.listenerProbe = options.listenerProbe ?? probeListenerIdentity;
    const token = (options.env ?? process.env)["LM_API_TOKEN"];
    if (
      token !== undefined &&
      (token.length === 0 || token.length > 4096 || stripControl(token) !== token)
    ) {
      throw new ValidationError("LM_API_TOKEN is malformed");
    }
    this.apiToken = token;
    this.modelsRoot = options.modelsRoot ?? join(homedir(), ".lmstudio", "models");
    const env = options.env ?? process.env;
    this.trustedExecutables = new Set(
      (options.trustedExecutables ?? defaultTrustedExecutables(this.platform, env)).map((path) =>
        executableKey(path, this.platform),
      ),
    );
  }

  async isInstalled(): Promise<boolean> {
    return (await runProbe(this.spawn, this.binary)).code === 0;
  }

  installHint(): string {
    if (this.platform === "darwin") return "Install LM Studio from https://lmstudio.ai/download";
    if (this.platform === "win32") return "Install LM Studio from https://lmstudio.ai/download";
    return "Install LM Studio or llmster from https://lmstudio.ai/docs/developer/core/headless";
  }

  async version(): Promise<string | null> {
    const result = await runProbe(this.spawn, this.binary);
    if (result.code !== 0) return null;
    const value = stripControl(result.stdout).trim().slice(0, 200);
    return value.length > 0 ? value : null;
  }

  async pull(options: PullOptions): Promise<PullResult> {
    try {
      assertSafeModelId(options.modelId);
    } catch (cause) {
      throw new BackendError("LM Studio delegated model id is invalid", { cause });
    }
    const result = await this.runCommand(["ls", "--json", "--llm", "--quiet"], options.signal);
    if (result.code !== 0) {
      throw new BackendError("failed to list downloaded LM Studio models");
    }
    const listing = parseJson(DownloadedModelsSchema, result.stdout, "lms ls");
    const models = listing.flatMap((entry) => {
      const group = DownloadedModelGroupSchema.safeParse(entry);
      if (group.success) {
        return group.data.variants.map((variant) => ({
          ...variant,
          modelKey: variant.modelKey ?? group.data.model.modelKey,
        }));
      }
      const model = DownloadedModelSchema.safeParse(entry);
      return model.success ? [model.data] : [];
    });
    const candidates: readonly PullDelegatedSource[] =
      options.delegatedSources ??
      (options.source !== undefined
        ? [{ format: "gguf", source: options.source }]
        : options.repository !== undefined
          ? [{ format: "mlx", repository: options.repository }]
          : []);
    const matches: Array<{
      readonly model: z.infer<typeof DownloadedModelSchema>;
      readonly source: PullDelegatedSource | undefined;
    }> = [];
    for (const model of models) {
      if (candidates.length === 0) {
        if (
          model.modelKey === options.modelId ||
          normalizeModelPath(model.path) === options.modelId
        ) {
          matches.push({ model, source: undefined });
        }
        continue;
      }
      for (const source of candidates) {
        const suffix =
          source.format === "gguf"
            ? `${source.source.repo}/${source.source.file}`
            : source.repository.repo;
        if (matchesModelSuffix(model.path, suffix)) {
          matches.push({ model, source });
        }
      }
    }
    if (matches.length === 0) {
      throw new BackendError(
        `model ${options.modelId} is not downloaded in LM Studio; install it with lms get or the LM Studio UI`,
      );
    }
    if (matches.length !== 1) {
      throw new BackendError(
        `multiple LM Studio models match ${options.modelId}; exact selection required`,
      );
    }
    const selected = matches[0];
    const path = selected?.model.path;
    if (path === undefined) throw new BackendError(`LM Studio model match had no path`);
    const localPath = resolveLocalModelPath(path, this.modelsRoot);
    const digestVerified =
      selected?.source?.format === "gguf" &&
      selected.source.source.sha256 !== undefined &&
      localPath !== undefined
        ? await verifyLocalDigest(localPath, selected.source.source.sha256)
        : false;
    return { modelId: options.modelId, digestVerified, modelPath: path };
  }

  async serve(options: ServeOptions = {}): Promise<ServeHandle> {
    const host = options.host ?? DEFAULT_BIND_HOST;
    if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
      throw new ValidationError(`LM Studio attach requires a loopback host: ${host}`);
    }
    const port = options.port ?? LM_STUDIO_DEFAULT_PORT;
    const endpoint = buildEndpoint(host, port);
    const modelId = options.modelId;
    if (modelId === undefined) throw new BackendError("LM Studio attach requires a model id");
    assertSafeModelId(modelId);
    const observed = await this.probeListenerReliable(port, host, options.signal);
    if (observed === null) {
      throw new BackendError(
        `LM Studio server is not running at ${endpoint}; start it with lms server start --port ${port}`,
      );
    }
    this.assertTrustedListener(observed);
    if (!(await this.isLmStudio(endpoint, options.signal))) {
      throw new BackendError(`listener at ${endpoint} is not an authoritative LM Studio server`);
    }
    const status = await this.runCommand(["server", "status", "--json", "--quiet"], options.signal);
    if (status.code !== 0) throw new BackendError("failed to query LM Studio server status");
    const parsedStatus = parseJson(ServerStatusSchema, status.stdout, "lms server status");
    if (parsedStatus.port !== port) {
      throw new BackendError(
        `LM Studio reports port ${parsedStatus.port}, not requested port ${port}`,
      );
    }
    const afterIdentity = await this.probeListenerReliable(port, host, options.signal);
    if (afterIdentity === null || !sameListenerProcess(observed, afterIdentity)) {
      throw new BackendError("LM Studio listener identity changed during attachment");
    }
    if (!(await this.modelAvailable(endpoint, modelId, options.signal))) {
      throw new BackendError(
        `model ${modelId} is not loaded in LM Studio; load it with lms load --identifier ${modelId}`,
      );
    }
    if (options.modelPath === undefined) {
      throw new BackendError(
        `LM Studio attach requires the exact delegated model path for ${modelId}`,
      );
    }
    await this.assertLoadedModel(modelId, options.modelPath, options.signal, REQUEST_TIMEOUT_MS);
    const finalIdentity = await this.probeListenerReliable(port, host, options.signal);
    if (finalIdentity === null || !sameListenerProcess(observed, finalIdentity)) {
      throw new BackendError("LM Studio listener identity changed during model validation");
    }
    return {
      endpoint,
      pid: observed.pid,
      port,
      ownedByUs: false,
      processExecutable: observed.executable,
      processStartedAt: observed.started,
      modelPath: options.modelPath,
    };
  }

  async waitUntilReady(options: ReadinessOptions): Promise<void> {
    const endpoint = assertLoopbackEndpoint(options.endpoint);
    if (
      options.expectedProcess === undefined ||
      options.modelId === undefined ||
      options.expectedModelPath === undefined
    ) {
      throw new BackendError(
        "LM Studio readiness requires process, model, and delegated path identity",
      );
    }
    await this.pollReady(
      endpoint,
      options.modelId,
      options.timeoutMs ?? READINESS_TIMEOUT_MS,
      options.signal,
      Math.max(1, options.retries ?? 20),
      options.expectedProcess,
      options.expectedModelPath,
    );
  }

  async stop(_handle: ServeHandle): Promise<void> {}

  async chat(request: ChatRequest): Promise<ChatResult> {
    assertSafeModelId(request.model);
    const endpoint = assertLoopbackEndpoint(
      request.endpoint ?? buildEndpoint(DEFAULT_BIND_HOST, LM_STUDIO_DEFAULT_PORT),
    );
    await this.assertInferenceTarget(
      endpoint,
      request.model,
      request.expectedProcess,
      request.expectedModelPath,
      request.signal,
    );
    const body = JSON.stringify({
      model: request.model,
      messages: request.messages,
      stream: false,
    });
    if (Buffer.byteLength(body) > MAX_REQUEST_BYTES)
      throw new BackendError("LM Studio chat request exceeds byte limit");
    const { response, payload } = await this.fetchJson(
      `${endpoint}/v1/chat/completions`,
      { method: "POST", headers: this.headers(true), body, signal: request.signal },
      CHAT_TIMEOUT_MS,
      request.signal,
      "LM Studio chat",
    );
    if (!response.ok) throw new BackendError(`LM Studio chat failed with HTTP ${response.status}`);
    const parsed = ChatResponseSchema.safeParse(payload);
    if (!parsed.success) throw new BackendError("LM Studio chat returned malformed JSON");
    const content = parsed.data.choices[0]?.message.content;
    if (content === undefined || Buffer.byteLength(content) > MAX_CONTENT_BYTES) {
      throw new BackendError("LM Studio chat returned invalid content");
    }
    await this.assertInferenceTarget(
      endpoint,
      request.model,
      request.expectedProcess,
      request.expectedModelPath,
      request.signal,
    );
    return { content };
  }

  async embed(request: EmbedRequest): Promise<EmbedResult> {
    assertSafeModelId(request.model);
    const endpoint = assertLoopbackEndpoint(
      request.endpoint ?? buildEndpoint(DEFAULT_BIND_HOST, LM_STUDIO_DEFAULT_PORT),
    );
    await this.assertInferenceTarget(
      endpoint,
      request.model,
      request.expectedProcess,
      request.expectedModelPath,
      request.signal,
    );
    if (request.input.length === 0 || request.input.length > 1024) {
      throw new BackendError("LM Studio embedding input count is invalid");
    }
    const body = JSON.stringify({ model: request.model, input: request.input });
    if (Buffer.byteLength(body) > MAX_REQUEST_BYTES)
      throw new BackendError("LM Studio embedding request exceeds byte limit");
    const { response, payload } = await this.fetchJson(
      `${endpoint}/v1/embeddings`,
      { method: "POST", headers: this.headers(true), body, signal: request.signal },
      CHAT_TIMEOUT_MS,
      request.signal,
      "LM Studio embeddings",
    );
    if (!response.ok)
      throw new BackendError(`LM Studio embeddings failed with HTTP ${response.status}`);
    const parsed = EmbeddingResponseSchema.safeParse(payload);
    if (!parsed.success || parsed.data.data.length !== request.input.length) {
      throw new BackendError("LM Studio embeddings returned malformed JSON");
    }
    const ordered = [...parsed.data.data].sort((a, b) => a.index - b.index);
    const dimension = ordered[0]?.embedding.length;
    if (
      dimension === undefined ||
      ordered.some((item, index) => item.index !== index || item.embedding.length !== dimension)
    ) {
      throw new BackendError("LM Studio embeddings returned inconsistent vectors");
    }
    await this.assertInferenceTarget(
      endpoint,
      request.model,
      request.expectedProcess,
      request.expectedModelPath,
      request.signal,
    );
    return { vectors: ordered.map((item) => item.embedding), dimension };
  }

  private headers(json = false): Record<string, string> {
    return {
      ...(json ? { "content-type": "application/json" } : {}),
      ...(this.apiToken !== undefined ? { authorization: `Bearer ${this.apiToken}` } : {}),
    };
  }

  private async isLmStudio(
    endpoint: string,
    signal?: AbortSignal,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<boolean> {
    try {
      const { response, payload } = await this.fetchJson(
        `${endpoint}/lmstudio-greeting`,
        { headers: this.headers(), signal },
        timeoutMs,
        signal,
        "LM Studio greeting",
      );
      return response.ok && GreetingSchema.safeParse(payload).success;
    } catch {
      return false;
    }
  }

  private async modelAvailable(
    endpoint: string,
    modelId: string,
    signal?: AbortSignal,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<boolean> {
    try {
      const { response, payload } = await this.fetchJson(
        `${endpoint}/v1/models`,
        { headers: this.headers(), signal },
        timeoutMs,
        signal,
        "LM Studio models",
      );
      if (!response.ok) return false;
      const parsed = ModelsSchema.safeParse(payload);
      return parsed.success && parsed.data.data.some((model) => model.id === modelId);
    } catch {
      return false;
    }
  }

  private async assertInferenceTarget(
    endpoint: string,
    modelId: string,
    expected: ChatRequest["expectedProcess"],
    expectedModelPath: string | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    if (expected === undefined || expectedModelPath === undefined) {
      throw new BackendError(
        "refusing LM Studio inference without process and model-path identity",
      );
    }
    const url = new URL(endpoint);
    const host = url.hostname.replace(/^\[/, "").replace(/\]$/, "");
    const port = Number(url.port || "80");
    const before = await this.probeListenerReliable(port, host, signal);
    if (before === null) {
      throw new BackendError("refusing inference: LM Studio listener identity is unavailable");
    }
    this.assertTrustedListener(before);
    if (!matchesExpectedListener(before, expected) || !(await this.isLmStudio(endpoint, signal))) {
      throw new BackendError("refusing inference: LM Studio process identity changed");
    }
    if (!(await this.modelAvailable(endpoint, modelId, signal))) {
      throw new BackendError(`refusing inference: model ${modelId} is not available in LM Studio`);
    }
    await this.assertLoadedModel(modelId, expectedModelPath, signal, REQUEST_TIMEOUT_MS);
    const after = await this.probeListenerReliable(port, host, signal);
    if (after === null || !sameListenerProcess(before, after)) {
      throw new BackendError("refusing inference: LM Studio listener changed during validation");
    }
  }

  private async pollReady(
    endpoint: string,
    modelId: string | undefined,
    timeoutMs: number,
    signal?: AbortSignal,
    attempts = 20,
    expected?: ReadinessOptions["expectedProcess"],
    expectedModelPath?: string,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (signal?.aborted) throw new BackendError("LM Studio readiness aborted");
      let remaining = deadline - Date.now();
      if (remaining <= 0) break;
      if (expected !== undefined) {
        const url = new URL(endpoint);
        const host = url.hostname.replace(/^\[/, "").replace(/\]$/, "");
        const port = Number(url.port || "80");
        const identity = await this.probeListenerWithin(port, host, remaining, signal);
        if (identity === null || !matchesExpectedListener(identity, expected)) {
          throw new BackendError("LM Studio readiness process identity changed");
        }
        this.assertTrustedListener(identity);
      }
      remaining = deadline - Date.now();
      if (remaining <= 0) break;
      if (
        (await this.isLmStudio(endpoint, signal, Math.min(REQUEST_TIMEOUT_MS, remaining))) &&
        (modelId === undefined ||
          (await this.modelAvailable(
            endpoint,
            modelId,
            signal,
            Math.min(REQUEST_TIMEOUT_MS, Math.max(1, deadline - Date.now())),
          )))
      ) {
        if (modelId !== undefined && expectedModelPath !== undefined) {
          await this.assertLoadedModel(
            modelId,
            expectedModelPath,
            signal,
            Math.max(1, deadline - Date.now()),
          );
        }
        if (expected !== undefined) {
          const url = new URL(endpoint);
          const host = url.hostname.replace(/^\[/, "").replace(/\]$/, "");
          const port = Number(url.port || "80");
          const finalIdentity = await this.probeListenerWithin(
            port,
            host,
            Math.max(1, deadline - Date.now()),
            signal,
          );
          if (finalIdentity === null || !matchesExpectedListener(finalIdentity, expected)) {
            throw new BackendError("LM Studio readiness listener changed during validation");
          }
        }
        return;
      }
      if (Date.now() >= deadline || attempt === attempts - 1) break;
      await this.sleep(Math.min(BACKOFF_MS, Math.max(1, deadline - Date.now())), signal);
    }
    throw new BackendError(`LM Studio did not become ready at ${endpoint}`);
  }

  private async assertLoadedModel(
    modelId: string,
    modelPath: string,
    signal?: AbortSignal,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<void> {
    const loaded = await this.runCommandWithin(["ps", "--json", "--quiet"], signal, timeoutMs);
    if (loaded.code !== 0) throw new BackendError("failed to query loaded LM Studio models");
    const loadedModels = parseJson(LoadedModelsSchema, loaded.stdout, "lms ps");
    const exactLoaded = loadedModels.filter(
      (model) =>
        model.identifier === modelId &&
        normalizeModelPath(model.path) === normalizeModelPath(modelPath),
    );
    if (exactLoaded.length !== 1) {
      throw new BackendError(
        `LM Studio model ${modelId} is not loaded from the exact delegated path`,
      );
    }
  }

  private async runCommandWithin(
    args: readonly string[],
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<LmsCommandResult> {
    if (timeoutMs <= 0 || signal?.aborted) {
      throw new BackendError("LM Studio command deadline elapsed");
    }
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await Promise.race([
        this.runCommand(args, controller.signal),
        new Promise<never>((_resolve, reject) => {
          controller.signal.addEventListener(
            "abort",
            () => reject(new BackendError("LM Studio command deadline elapsed")),
            { once: true },
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  private async probeListenerWithin(
    port: number,
    host: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ListenerIdentity | null> {
    if (timeoutMs <= 0 || signal?.aborted) return null;
    const deadline = Date.now() + timeoutMs;
    for (let attempt = 0; attempt < LISTENER_PROBE_ATTEMPTS; attempt += 1) {
      if (Date.now() >= deadline || signal?.aborted) return null;
      const identity = await this.probeListenerOnceWithin(
        port,
        host,
        Math.max(1, deadline - Date.now()),
        signal,
      );
      if (identity !== null) return identity;
      if (attempt < LISTENER_PROBE_ATTEMPTS - 1 && Date.now() < deadline) {
        await this.sleep(
          Math.min(LISTENER_PROBE_BACKOFF_MS, Math.max(1, deadline - Date.now())),
          signal,
        );
      }
    }
    return null;
  }

  private async probeListenerOnceWithin(
    port: number,
    host: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ListenerIdentity | null> {
    return new Promise<ListenerIdentity | null>((resolveProbe) => {
      let settled = false;
      const finish = (identity: ListenerIdentity | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolveProbe(identity);
      };
      const onAbort = (): void => finish(null);
      const timer = setTimeout(() => finish(null), timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.listenerProbe(port, host).then(finish, () => finish(null));
    });
  }

  private async probeListenerReliable(
    port: number,
    host: string,
    signal?: AbortSignal,
  ): Promise<ListenerIdentity | null> {
    return this.probeListenerWithin(port, host, REQUEST_TIMEOUT_MS, signal);
  }

  private assertTrustedListener(identity: ListenerIdentity): void {
    if (!this.trustedExecutables.has(executableKey(identity.executable, this.platform))) {
      throw new BackendError("listener executable is not a trusted LM Studio installation");
    }
  }

  private async fetchJson(
    url: string,
    init: Parameters<FetchFn>[1],
    timeoutMs: number,
    callerSignal: AbortSignal | undefined,
    label: string,
  ): Promise<{ readonly response: Awaited<ReturnType<FetchFn>>; readonly payload: unknown }> {
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    if (callerSignal?.aborted) controller.abort();
    callerSignal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetch(url, { ...init, signal: controller.signal });
      const payload = await readBoundedJson(response, MAX_RESPONSE_BYTES, label);
      return { response, payload };
    } catch (cause) {
      controller.abort();
      throw cause;
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onAbort);
    }
  }
}

function matchesExpectedListener(
  identity: ListenerIdentity,
  expected: NonNullable<ChatRequest["expectedProcess"]>,
): boolean {
  return (
    identity.pid === expected.pid &&
    identity.executable === expected.executable &&
    identity.started === expected.started
  );
}

function defaultTrustedExecutables(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): readonly string[] {
  if (platform === "darwin") {
    return [
      "/Applications/LM Studio.app/Contents/MacOS/LM Studio",
      join(homedir(), "Applications", "LM Studio.app", "Contents", "MacOS", "LM Studio"),
    ];
  }
  if (platform === "win32") {
    const localAppData = env["LOCALAPPDATA"];
    return [
      "C:\\Program Files\\LM Studio\\LM Studio.exe",
      "C:\\Program Files\\LM Studio\\llmster.exe",
      ...(localAppData !== undefined
        ? [
            `${localAppData}\\Programs\\LM Studio\\LM Studio.exe`,
            `${localAppData}\\Programs\\LM Studio\\llmster.exe`,
          ]
        : []),
    ];
  }
  return ["/usr/bin/llmster", "/usr/local/bin/llmster", "/opt/lm-studio/bin/llmster"];
}

function executableKey(path: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? path.replace(/\//g, "\\").toLowerCase() : path;
}

function normalizeModelPath(value: string): string {
  return value.replace(/\\/g, "/");
}

function matchesModelSuffix(path: string, suffix: string): boolean {
  const normalizedPath = normalizeModelPath(path);
  const normalizedSuffix = normalizeModelPath(suffix).replace(/^\/+/, "");
  return normalizedPath === normalizedSuffix || normalizedPath.endsWith(`/${normalizedSuffix}`);
}

function resolveLocalModelPath(path: string, modelsRoot: string): string | undefined {
  const rootAbsolute = resolve(modelsRoot);
  const candidate = isAbsolute(path) ? resolve(path) : resolve(rootAbsolute, path);
  const lexicalFromRoot = relative(rootAbsolute, candidate);
  if (lexicalFromRoot === ".." || lexicalFromRoot.startsWith(`..${sep}`)) {
    throw new BackendError("LM Studio model path escapes the configured model root");
  }
  if (!existsSync(modelsRoot) || !existsSync(candidate)) return undefined;
  let rootReal: string;
  let candidateReal: string;
  try {
    rootReal = realpathSync(modelsRoot);
    candidateReal = realpathSync(candidate);
  } catch (cause) {
    throw new BackendError("failed to resolve LM Studio model path", { cause });
  }
  const fromRoot = relative(rootReal, candidateReal);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) {
    throw new BackendError("LM Studio model path escapes the configured model root");
  }
  return candidate;
}

function parseJson<T>(schema: z.ZodType<T>, raw: string, label: string): T {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (cause) {
    throw new BackendError(`${label} returned invalid JSON`, { cause });
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BackendError(`${label} returned an invalid response`);
  return parsed.data;
}

async function verifyLocalDigest(path: string, expected: string): Promise<boolean> {
  let before;
  try {
    before = lstatSync(path);
  } catch (cause) {
    throw new BackendError("failed to inspect LM Studio model path", { cause });
  }
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new BackendError("refusing unsafe LM Studio model path");
  }
  let fd: number;
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  try {
    fd = openSync(path, constants.O_RDONLY | noFollow);
  } catch (cause) {
    throw new BackendError(`failed to open LM Studio model path safely`, { cause });
  }
  try {
    const after = fstatSync(fd);
    if (
      !after.isFile() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      (noFollow === 0 && (before.ino === 0 || after.ino === 0))
    ) {
      throw new BackendError("refusing changed or unsafe LM Studio model path");
    }
    const hash = createHash("sha256");
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(path, { fd, autoClose: false });
      stream.on("data", (chunk: string | Buffer) => hash.update(chunk));
      stream.on("error", reject);
      stream.on("end", resolve);
    });
    const actual = hash.digest("hex");
    if (actual !== expected.toLowerCase()) {
      throw new BackendError("LM Studio model digest mismatch");
    }
    return true;
  } finally {
    closeSync(fd);
  }
}

async function readBoundedJson(
  response: Awaited<ReturnType<FetchFn>>,
  maxBytes: number,
  label: string,
): Promise<unknown> {
  if (response.body !== undefined && response.body !== null) {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        if (next.value === undefined) continue;
        bytes += next.value.byteLength;
        if (bytes > maxBytes) throw new BackendError(`${label} response exceeds byte limit`);
        chunks.push(next.value);
      }
    } catch (cause) {
      try {
        await reader.cancel();
      } catch {
        // Preserve the original bounded-read failure.
      }
      throw cause;
    } finally {
      reader.releaseLock();
    }
    try {
      return JSON.parse(
        Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8"),
      ) as unknown;
    } catch (cause) {
      throw new BackendError(`${label} returned invalid JSON`, { cause });
    }
  }
  throw new BackendError(`${label} returned no bounded response body`);
}
