/**
 * MLX backend adapter (`mlx_lm.server`) for Apple Silicon.
 *
 * MLX is platform-gated to macOS arm64 and exposes an OpenAI-compatible chat
 * server. The adapter remains stateless; runtime ownership lives in state.json.
 * Source: https://github.com/ml-explore/mlx-lm/blob/main/mlx_lm/server.py
 */
import { spawn as nodeSpawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { z } from "zod";
import { BackendError, ValidationError } from "../errors.js";
import type { Arch, BackendCapabilities } from "../types.js";
import {
  assertLoopbackEndpoint,
  buildEndpoint,
  DEFAULT_BIND_HOST,
  type BackendAdapter,
  type ChatRequest,
  type ChatResult,
  type EmbedRequest,
  type EmbedResult,
  type PullOptions,
  type PullResult,
  type ReadinessOptions,
  type ServeHandle,
  type ServeOptions,
} from "./adapter.js";
import {
  acquireRepository,
  acquireWeight,
  createAcquireFetch,
  lockRepositorySnapshot,
  type AcquireRepositoryRequest,
  type AcquireRepositoryResult,
} from "./acquire.js";
import type {
  FetchFn,
  KillFn,
  ProcessOutputStream,
  SleepFn,
  SpawnFn,
  SpawnedProcess,
} from "./ollama.js";
import {
  probeListenerIdentity,
  probeProcessIdentity,
  sameListenerProcess,
  type ListenerIdentity,
  type ProcessIdentity,
} from "./listener.js";
import { backendSupportsPlatform } from "./platform.js";

const MLX_PYTHON_BINARY = "python3";
const MLX_SERVER_MODULE = "mlx_lm.server";
const MLX_DEFAULT_PORT = 8080;
const INSTALL_PROBE_TIMEOUT_MS = 5_000;
const MINIMUM_MLX_LM_VERSION = "0.31.3";
const AUDITED_MLX_LM_VERSION = "0.31.3";
const MLX_INSTALL_PROBE = String.raw`import importlib.metadata as m
from mlx_lm import server as s
assert hasattr(s, "_run_http_server") and hasattr(s, "APIHandler")
print(m.version("mlx-lm"))`;
const DEFAULT_READINESS_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_READINESS_RETRIES = 150;
const READINESS_REQUEST_TIMEOUT_MS = 5_000;
const CHAT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_CHAT_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_JSON_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_GENERATED_CONTENT_BYTES = 1024 * 1024;
const MAX_MLX_CONFIG_BYTES = 1024 * 1024;
const EXECUTABLE_MODEL_FILE_RE = /\.(?:py|pyc|pyo|so|dylib|dll|bundle)$/i;
const MLX_SERVER_WRAPPER = String.raw`
import hmac, io, json, os, sys
from mlx_lm import server as _server

_original_run = _server._run_http_server

class GuardedHandler(_server.APIHandler):
  def _reject(self, status):
    self.send_response(status)
    self.send_header("Content-Length", "0")
    self.end_headers()

  def do_OPTIONS(self):
    self._reject(403)

  def _authenticated(self):
    expected = "Bearer " + os.environ["LLMUP_MLX_AUTH_TOKEN"]
    return hmac.compare_digest(self.headers.get("Authorization", ""), expected)

  def do_GET(self):
    if not self._authenticated():
      self._reject(401)
      return
    super().do_GET()

  def do_POST(self):
    origin = self.headers.get("Origin")
    if origin not in (None, "http://127.0.0.1", "http://localhost"):
      self._reject(403)
      return
    if not self._authenticated():
      self._reject(401)
      return
    content_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
    if content_type != "application/json":
      self._reject(415)
      return
    try:
      content_length = int(self.headers.get("Content-Length", ""))
    except ValueError:
      self._reject(411)
      return
    if content_length < 0 or content_length > 4194304:
      self._reject(413)
      return
    raw = self.rfile.read(content_length)
    try:
      body = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
      self._reject(400)
      return
    if not isinstance(body, dict) or body.get("model", "default_model") != "default_model":
      self._reject(400)
      return
    max_tokens = body.get("max_completion_tokens", body.get("max_tokens", 512))
    if not isinstance(max_tokens, int) or isinstance(max_tokens, bool) or not 0 <= max_tokens <= 4096:
      self._reject(400)
      return
    self.rfile = io.BytesIO(raw)
    super().do_POST()

def _guarded_run(host, port, response_generator, server_class=_server.ThreadingHTTPServer, handler_class=GuardedHandler):
  return _original_run(host, port, response_generator, server_class, GuardedHandler)

_server._run_http_server = _guarded_run
sys.argv.pop(1)
_server.main()
`;
const READINESS_BACKOFF_MS = 250;
const SHUTDOWN_POLL_MS = 50;
const SHUTDOWN_ATTEMPTS = 20;
const SPAWN_CLEANUP_GRACE_MS = 500;

const HealthSchema = z.object({ status: z.literal("ok") });
const ModelsSchema = z.object({
  object: z.literal("list"),
  data: z.array(z.object({ id: z.string().min(1) })),
});
const ChatResponseSchema = z.object({
  choices: z
    .array(z.object({ message: z.object({ content: z.string().optional() }) }))
    .min(1)
    .max(8),
});

function adaptStream(stream: Readable | null): ProcessOutputStream | null {
  if (stream === null) return null;
  stream.setEncoding("utf8");
  return {
    onData: (listener) => {
      stream.on("data", (chunk: string) => listener(chunk));
    },
  };
}

const defaultSpawn: SpawnFn = (command, args, options) => {
  const child = nodeSpawn(command, [...args], {
    stdio: options.stdio === "ignore" ? ["ignore", "ignore", "ignore"] : ["ignore", "pipe", "pipe"],
    shell: false,
    signal: options.signal,
    ...(options.env ? { env: options.env } : {}),
  });
  return {
    pid: child.pid,
    stdout: adaptStream(child.stdout),
    stderr: adaptStream(child.stderr),
    onClose: (listener) => child.on("close", (code) => listener(code)),
    onError: (listener) => child.on("error", listener),
    kill: (signal) => child.kill(signal),
  };
};

const defaultFetch: FetchFn = (url, init) =>
  fetch(url, {
    redirect: "error",
    ...(init?.signal !== undefined ? { signal: init.signal } : {}),
    ...(init?.method !== undefined ? { method: init.method } : {}),
    ...(init?.headers !== undefined ? { headers: init.headers } : {}),
    ...(init?.body !== undefined ? { body: init.body } : {}),
  });

const defaultSleep: SleepFn = (ms, signal) =>
  new Promise<void>((resolveSleep, reject) => {
    if (signal?.aborted) {
      reject(new BackendError("MLX wait aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolveSleep();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new BackendError("MLX wait aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

const defaultKill: KillFn = (pid, signal) => process.kill(pid, signal);

function probeAuditedMlxRuntime(
  spawn: SpawnFn,
  binary: string,
  args: readonly string[],
  signal: AbortSignal,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let child: SpawnedProcess;
    try {
      child = spawn(binary, args, { shell: false, stdio: "pipe", signal });
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    let stdout = "";
    let overflow = false;
    const finish = (installed: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(installed);
    };
    child.stdout?.onData((chunk) => {
      if (stdout.length + chunk.length > 128) {
        overflow = true;
        return;
      }
      stdout += chunk;
    });
    child.onError(() => finish(false));
    child.onClose((code) =>
      finish(code === 0 && !overflow && stdout.trim() === AUDITED_MLX_LM_VERSION),
    );
  });
}

export interface MlxAdapterOptions {
  readonly spawn?: SpawnFn | undefined;
  readonly binary?: string | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  readonly arch?: Arch | string | undefined;
  readonly acquireRepository?: AcquireRepositoryFn | undefined;
  readonly fetch?: FetchFn | undefined;
  readonly sleep?: SleepFn | undefined;
  readonly kill?: KillFn | undefined;
  readonly listenerProbe?:
    ((port: number, host: string) => Promise<ListenerIdentity | null>) | undefined;
  readonly processProbe?: ((pid: number) => Promise<ProcessIdentity | null>) | undefined;
  readonly modelDirectoryVerifier?: ((path: string) => void) | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly serverModule?: string | undefined;
  readonly authTokenFactory?: (() => string) | undefined;
}

export interface AcquireRepositoryRuntimeOptions {
  readonly signal?: AbortSignal | undefined;
  readonly onProgress?:
    ((completedBytes: number, totalBytes: number, file: string) => void) | undefined;
}

export type AcquireRepositoryFn = (
  request: AcquireRepositoryRequest,
  options?: AcquireRepositoryRuntimeOptions,
) => Promise<AcquireRepositoryResult>;

const defaultAcquireRepository: AcquireRepositoryFn = (request, options = {}) =>
  acquireRepository(request, {
    lockRepository: lockRepositorySnapshot,
    acquire: (artifact, artifactOptions) =>
      acquireWeight(artifact, {
        fetch: createAcquireFetch(),
        signal: artifactOptions?.signal,
        maxBytes: artifactOptions?.maxBytes,
        onProgress: artifactOptions?.onProgress,
      }),
    signal: options.signal,
    onProgress: (event) => options.onProgress?.(event.completedBytes, event.totalBytes, event.file),
  });

/** Apple-Silicon MLX runtime adapter. */
export class MlxAdapter implements BackendAdapter {
  readonly name = "mlx" as const;
  readonly capabilities: BackendCapabilities = {
    canPull: true,
    canEmbed: false,
    embeddingOffload: "unknown",
    openAiCompatible: true,
    formats: ["mlx"],
    defaultPort: MLX_DEFAULT_PORT,
  };

  private readonly spawn: SpawnFn;
  private readonly binary: string;
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;
  private readonly acquireRepository: AcquireRepositoryFn;
  private readonly fetch: FetchFn;
  private readonly sleep: SleepFn;
  private readonly kill: KillFn;
  private readonly listenerProbe: (port: number, host: string) => Promise<ListenerIdentity | null>;
  private readonly processProbe: (pid: number) => Promise<ProcessIdentity | null>;
  private readonly modelDirectoryVerifier: (path: string) => void;
  private readonly env: NodeJS.ProcessEnv;
  private readonly serverModule: string;
  private readonly authTokenFactory: () => string;

  constructor(options: MlxAdapterOptions = {}) {
    this.spawn = options.spawn ?? defaultSpawn;
    this.binary = options.binary ?? MLX_PYTHON_BINARY;
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.acquireRepository = options.acquireRepository ?? defaultAcquireRepository;
    this.fetch = options.fetch ?? defaultFetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.kill = options.kill ?? defaultKill;
    this.listenerProbe = options.listenerProbe ?? probeListenerIdentity;
    this.processProbe = options.processProbe ?? probeProcessIdentity;
    this.modelDirectoryVerifier = options.modelDirectoryVerifier ?? assertSafeMlxModelDirectory;
    this.env = options.env ?? process.env;
    this.serverModule = options.serverModule ?? MLX_SERVER_MODULE;
    this.authTokenFactory = options.authTokenFactory ?? (() => randomBytes(32).toString("hex"));
  }

  async isInstalled(): Promise<boolean> {
    if (
      !backendSupportsPlatform(this.name, {
        platform: this.platform === "darwin" ? "darwin" : undefined,
        arch: this.arch === "arm64" ? "arm64" : undefined,
      })
    ) {
      return false;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), INSTALL_PROBE_TIMEOUT_MS);
    try {
      return await probeAuditedMlxRuntime(
        this.spawn,
        this.binary,
        ["-I", "-c", MLX_INSTALL_PROBE],
        controller.signal,
      );
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  installHint(): string {
    return `python3 -m pip install "mlx-lm==${MINIMUM_MLX_LM_VERSION}"`;
  }

  async pull(options: PullOptions): Promise<PullResult> {
    const repository = options.repository;
    if (repository === undefined) {
      throw new BackendError(
        `refusing to pull ${options.modelId}: mlx requires a pinned repository manifest`,
      );
    }
    options.onProgress?.({ status: "downloading MLX repository", completedBytes: 0 });
    const result = await this.acquireRepository(
      { backend: this.name, ...repository },
      {
        signal: options.signal,
        onProgress: (completedBytes, totalBytes, file) =>
          options.onProgress?.({
            status: `downloading ${file}`,
            completedBytes,
            totalBytes,
          }),
      },
    );
    if (!result.digestVerified) {
      throw new BackendError(
        `refusing to serve ${options.modelId}: MLX repository failed digest verification`,
      );
    }
    this.modelDirectoryVerifier(result.path);
    options.onProgress?.({
      status: result.cached ? "cached MLX repository" : "downloaded MLX repository",
      completedBytes: result.bytes,
      totalBytes: result.bytes,
    });
    return {
      modelId: options.modelId,
      digestVerified: true,
      modelPath: result.path,
    };
  }

  async serve(options?: ServeOptions): Promise<ServeHandle> {
    if (
      !backendSupportsPlatform(this.name, {
        platform: this.platform === "darwin" ? "darwin" : undefined,
        arch: this.arch === "arm64" ? "arm64" : undefined,
      })
    ) {
      throw new BackendError("MLX serving requires Apple Silicon (darwin/arm64)");
    }
    const host = options?.host ?? DEFAULT_BIND_HOST;
    const port = options?.port ?? MLX_DEFAULT_PORT;
    if (!(options?.allowNonLoopback ?? false) && !isLoopbackHost(host)) {
      throw new ValidationError(
        `refusing to bind non-loopback host "${host}" without an explicit opt-in`,
      );
    }
    const endpoint = buildEndpoint(host, port);
    if (options?.signal?.aborted) throw new BackendError(`MLX serve aborted for ${endpoint}`);
    const modelPath = options?.modelPath?.trim();
    if (modelPath === undefined || modelPath.length === 0 || !isAbsolute(modelPath)) {
      throw new BackendError(
        `refusing to serve ${endpoint}: verified absolute model path required`,
      );
    }
    this.modelDirectoryVerifier(modelPath);

    // mlx_lm.server has no authoritative unauthenticated runtime identity
    // endpoint. Never attach to a pre-existing port; only an exact spawned PID
    // plus model path may establish ownership.
    const listenerBefore = await this.listenerProbe(port, host);
    if (
      listenerBefore !== null ||
      (await this.healthReachable(endpoint, options?.signal, READINESS_REQUEST_TIMEOUT_MS))
    ) {
      throw new BackendError(`refusing to attach to occupied MLX endpoint ${endpoint}`);
    }
    if (options?.signal?.aborted) throw new BackendError(`MLX serve aborted for ${endpoint}`);
    const authToken = this.authTokenFactory();
    if (!/^[a-f0-9]{64}$/.test(authToken)) {
      throw new BackendError("MLX session token generator returned an invalid token");
    }

    const args = [
      "-I",
      "-c",
      MLX_SERVER_WRAPPER,
      this.serverModule,
      "--model",
      modelPath,
      "--host",
      host,
      "--port",
      String(port),
      "--allowed-origins",
      "",
      "--log-level",
      "ERROR",
    ];
    let child: SpawnedProcess;
    try {
      child = this.spawn(this.binary, args, {
        shell: false,
        stdio: "ignore",
        env: minimalMlxEnvironment(this.env, authToken),
      });
    } catch (cause) {
      throw new BackendError(`failed to run ${this.binary}`, { cause });
    }
    let childClosed = false;
    let resolveChildClosed: (() => void) | undefined;
    const childClose = new Promise<void>((resolveClose) => {
      resolveChildClosed = resolveClose;
    });
    const earlyFailure = new Promise<never>((_resolve, reject) => {
      child.onError((cause) => reject(new BackendError(`failed to run ${this.binary}`, { cause })));
      child.onClose((code) => {
        childClosed = true;
        resolveChildClosed?.();
        reject(new BackendError(`${this.binary} exited before readiness (code ${code})`));
      });
    });
    earlyFailure.catch(() => {});
    const pid = child.pid;
    if (!isUsablePid(pid)) {
      await stopSpawnedChild(child, childClose, () => childClosed);
      throw new BackendError(`${this.binary} did not report a usable pid`);
    }

    try {
      await Promise.race([
        this.pollUntilReady(
          endpoint,
          DEFAULT_READINESS_TIMEOUT_MS,
          DEFAULT_READINESS_RETRIES,
          options?.signal,
          modelPath,
          authToken,
        ),
        earlyFailure,
      ]);
      const identity = await this.listenerProbe(port, host);
      if (
        identity === null ||
        identity.pid !== pid ||
        !(await this.modelReady(
          endpoint,
          modelPath,
          options?.signal,
          true,
          READINESS_REQUEST_TIMEOUT_MS,
          authToken,
        ))
      ) {
        throw new BackendError(`MLX readiness did not belong to spawned pid ${pid}`);
      }
      return {
        endpoint,
        pid,
        port,
        ownedByUs: true,
        processExecutable: identity.executable,
        processStartedAt: identity.started,
        authToken,
      };
    } catch (error) {
      const cleaned = await stopSpawnedChild(child, childClose, () => childClosed);
      if (!cleaned) {
        throw new BackendError(`MLX failed readiness and spawned process cleanup`, {
          cause: error instanceof Error ? error : new Error(String(error)),
        });
      }
      throw error instanceof BackendError
        ? error
        : new BackendError(`MLX failed to become ready at ${endpoint}`, { cause: error });
    }
  }

  async waitUntilReady(options: ReadinessOptions): Promise<void> {
    const endpoint = assertLoopbackEndpoint(options.endpoint);
    await this.pollUntilReady(
      endpoint,
      options.timeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS,
      Math.max(1, options.retries ?? DEFAULT_READINESS_RETRIES),
      options.signal,
      undefined,
      options.authToken,
    );
  }

  async stop(handle: ServeHandle): Promise<void> {
    if (!handle.ownedByUs) return;
    if (
      !isUsablePid(handle.pid) ||
      handle.processExecutable === undefined ||
      handle.processStartedAt === undefined
    ) {
      throw new BackendError("refusing to stop MLX process without complete identity");
    }
    const endpoint = assertLoopbackEndpoint(handle.endpoint);
    const host = new URL(endpoint).hostname.replace(/^\[/, "").replace(/\]$/, "");
    const observed = await this.listenerProbe(handle.port, host);
    const expected: ListenerIdentity = {
      pid: handle.pid,
      process: observed?.process ?? "",
      executable: handle.processExecutable,
      started: handle.processStartedAt,
      localAddress: observed?.localAddress ?? host,
    };
    if (observed === null || !sameListenerProcess(observed, expected)) {
      throw new BackendError("refusing to stop MLX process: listener identity changed");
    }
    const expectedProcess: ProcessIdentity = {
      pid: handle.pid,
      process: observed.process,
      executable: handle.processExecutable,
      started: handle.processStartedAt,
    };
    if ((await this.processIdentityStatus(expectedProcess)) !== "same") {
      throw new BackendError("refusing to stop MLX process: process identity changed");
    }
    try {
      this.kill(handle.pid, "SIGTERM");
      for (let attempt = 0; attempt < SHUTDOWN_ATTEMPTS; attempt += 1) {
        try {
          this.kill(handle.pid, 0);
        } catch (error) {
          if (isEsrch(error)) return;
          throw error;
        }
        const status = await this.processIdentityStatus(expectedProcess);
        if (status === "changed") return;
        await this.sleep(SHUTDOWN_POLL_MS);
      }
      const beforeKill = await this.processIdentityStatus(expectedProcess);
      if (beforeKill === "changed") return;
      if (beforeKill === "unknown") {
        throw new BackendError(
          `refusing to SIGKILL MLX process ${handle.pid}: identity unavailable`,
        );
      }
      this.kill(handle.pid, "SIGKILL");
      for (let attempt = 0; attempt < SHUTDOWN_ATTEMPTS; attempt += 1) {
        try {
          this.kill(handle.pid, 0);
        } catch (error) {
          if (isEsrch(error)) return;
          throw error;
        }
        const status = await this.processIdentityStatus(expectedProcess);
        if (status === "changed") return;
        await this.sleep(SHUTDOWN_POLL_MS);
      }
      throw new BackendError(`MLX process ${handle.pid} remained alive after SIGKILL`);
    } catch (cause) {
      if (isEsrch(cause)) return;
      throw new BackendError(`failed to stop MLX process ${handle.pid}`, { cause });
    }
  }

  async chat(request: ChatRequest): Promise<ChatResult> {
    const endpoint = assertLoopbackEndpoint(
      request.endpoint ?? buildEndpoint(DEFAULT_BIND_HOST, MLX_DEFAULT_PORT),
    );
    const body = JSON.stringify({
      model: "default_model",
      messages: request.messages,
      stream: false,
    });
    if (Buffer.byteLength(body, "utf8") > MAX_CHAT_REQUEST_BYTES) {
      throw new BackendError("MLX chat request exceeds byte limit");
    }
    const authToken = requireAuthToken(request.authToken);
    await this.assertExpectedInferenceProcess(endpoint, request.expectedProcess);
    let response;
    let payload: unknown;
    try {
      ({ response, payload } = await this.fetchJsonWithin(
        `${endpoint}/v1/chat/completions`,
        {
          method: "POST",
          headers: authorizationHeaders(authToken, true),
          body,
          signal: request.signal,
        },
        CHAT_REQUEST_TIMEOUT_MS,
        request.signal,
        "MLX chat",
      ));
    } catch (cause) {
      throw new BackendError(`MLX chat request failed`, { cause });
    }
    if (!response.ok) {
      throw new BackendError(`MLX chat failed with HTTP ${response.status}`);
    }
    const parsed = ChatResponseSchema.safeParse(payload);
    if (!parsed.success) throw new BackendError("MLX chat returned a malformed response");
    const content = parsed.data.choices[0]?.message.content;
    if (content === undefined) throw new BackendError("MLX chat returned no content");
    if (Buffer.byteLength(content, "utf8") > MAX_GENERATED_CONTENT_BYTES) {
      throw new BackendError("MLX chat content exceeds byte limit");
    }
    await this.assertExpectedInferenceProcess(endpoint, request.expectedProcess);
    return { content };
  }

  async embed(_request: EmbedRequest): Promise<EmbedResult> {
    throw new BackendError("mlx embeddings are unsupported");
  }

  private async pollUntilReady(
    endpoint: string,
    timeoutMs: number,
    attempts: number,
    signal?: AbortSignal,
    modelPath?: string,
    authToken?: string,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (signal?.aborted) throw new BackendError(`MLX readiness aborted for ${endpoint}`);
      try {
        const requestTimeoutMs = Math.min(
          READINESS_REQUEST_TIMEOUT_MS,
          Math.max(1, deadline - Date.now()),
        );
        if (
          await this.modelReady(
            endpoint,
            modelPath,
            signal,
            modelPath !== undefined,
            requestTimeoutMs,
            authToken,
          )
        )
          return;
      } catch (error) {
        lastError = error;
      }
      if (attempt === attempts || Date.now() >= deadline) break;
      await this.sleep(READINESS_BACKOFF_MS, signal);
    }
    throw new BackendError(`MLX did not become ready at ${endpoint}`, { cause: lastError });
  }

  private async healthReachable(
    endpoint: string,
    signal: AbortSignal | undefined,
    timeoutMs: number,
    authToken?: string,
  ): Promise<boolean> {
    try {
      const { response, payload } = await this.fetchJsonWithin(
        `${endpoint}/health`,
        { signal, headers: authToken === undefined ? undefined : authorizationHeaders(authToken) },
        timeoutMs,
        signal,
        "MLX health",
      );
      if (!response.ok) return false;
      return HealthSchema.safeParse(payload).success;
    } catch {
      return false;
    }
  }

  private async modelReady(
    endpoint: string,
    modelPath: string | undefined,
    signal: AbortSignal | undefined,
    requireIdentityCompletion: boolean,
    requestTimeoutMs = READINESS_REQUEST_TIMEOUT_MS,
    authToken?: string,
  ): Promise<boolean> {
    if (!(await this.healthReachable(endpoint, signal, requestTimeoutMs, authToken))) return false;
    const { response: modelsResponse, payload: modelsPayload } = await this.fetchJsonWithin(
      `${endpoint}/v1/models`,
      { signal, headers: authToken === undefined ? undefined : authorizationHeaders(authToken) },
      requestTimeoutMs,
      signal,
      "MLX models",
    );
    if (!modelsResponse.ok) return false;
    const models = ModelsSchema.safeParse(modelsPayload);
    if (!models.success) return false;
    if (
      modelPath !== undefined &&
      !models.data.data.some((entry) => resolve(entry.id) === resolve(modelPath))
    ) {
      return false;
    }
    if (!requireIdentityCompletion) return true;
    const { response: completion, payload: completionPayload } = await this.fetchJsonWithin(
      `${endpoint}/v1/chat/completions`,
      {
        method: "POST",
        headers:
          authToken === undefined
            ? { "content-type": "application/json" }
            : authorizationHeaders(authToken, true),
        body: JSON.stringify({
          model: "default_model",
          messages: [{ role: "user", content: "Reply briefly." }],
          max_tokens: 1,
          stream: false,
        }),
        signal,
      },
      requestTimeoutMs,
      signal,
      "MLX identity completion",
    );
    if (!completion.ok) return false;
    return ChatResponseSchema.safeParse(completionPayload).success;
  }

  private async fetchJsonWithin(
    url: string,
    init: Parameters<FetchFn>[1],
    timeoutMs: number,
    callerSignal: AbortSignal | undefined,
    label: string,
  ): Promise<{
    readonly response: Awaited<ReturnType<FetchFn>>;
    readonly payload: unknown;
  }> {
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    if (callerSignal?.aborted) controller.abort();
    callerSignal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
    try {
      const response = await this.fetch(url, { ...init, signal: controller.signal });
      const payload = await readBoundedJson(response, MAX_JSON_RESPONSE_BYTES, label);
      return { response, payload };
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onAbort);
    }
  }

  private async assertExpectedInferenceProcess(
    endpoint: string,
    expected: ChatRequest["expectedProcess"],
  ): Promise<void> {
    if (expected === undefined) {
      throw new BackendError(`refusing MLX inference without expected process identity`);
    }
    const url = new URL(endpoint);
    const port = url.port === "" ? 80 : Number(url.port);
    const host = url.hostname.replace(/^\[/, "").replace(/\]$/, "");
    let observed: ListenerIdentity | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      observed = await this.listenerProbe(port, host);
      if (observed !== null) break;
      if (attempt < 2) await this.sleep(SHUTDOWN_POLL_MS);
    }
    if (
      observed === null ||
      observed.pid !== expected.pid ||
      observed.executable !== expected.executable ||
      observed.started !== expected.started
    ) {
      throw new BackendError(`refusing MLX inference: active process identity changed`);
    }
  }

  private async processIdentityStatus(
    expected: ProcessIdentity,
  ): Promise<"same" | "changed" | "unknown"> {
    const observed = await this.processProbe(expected.pid);
    if (observed === null) return "unknown";
    return observed.pid === expected.pid &&
      observed.executable === expected.executable &&
      observed.started === expected.started
      ? "same"
      : "changed";
  }
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized)
  );
}

function isUsablePid(pid: number | undefined): pid is number {
  return pid !== undefined && Number.isInteger(pid) && pid > 0;
}

function isEsrch(error: unknown): boolean {
  return (error as { readonly code?: unknown }).code === "ESRCH";
}

function minimalMlxEnvironment(env: NodeJS.ProcessEnv, authToken: string): NodeJS.ProcessEnv {
  const allowed = [
    "PATH",
    "HOME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
  ] as const;
  const result: NodeJS.ProcessEnv = {};
  for (const name of allowed) {
    const value = env[name];
    if (value !== undefined) result[name] = value;
  }
  result["LLMUP_MLX_AUTH_TOKEN"] = authToken;
  return result;
}

function requireAuthToken(token: string | undefined): string {
  if (token === undefined || !/^[a-f0-9]{64}$/.test(token)) {
    throw new BackendError("refusing MLX request without a valid active session token");
  }
  return token;
}

function authorizationHeaders(token: string, json = false): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    ...(json ? { "content-type": "application/json" } : {}),
  };
}

/**
 * Refuse MLX snapshots that could execute repository-supplied Python/native
 * code. mlx-lm can import `config.json.model_file` independently of tokenizer
 * `trust_remote_code`, so both executable files and custom loader fields are
 * forbidden before spawn.
 */
export function assertSafeMlxModelDirectory(root: string): void {
  if (!isAbsolute(root)) throw new BackendError("MLX model directory must be absolute");
  let rootStats;
  try {
    rootStats = lstatSync(root);
  } catch (cause) {
    throw new BackendError("MLX model directory is unavailable", { cause });
  }
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new BackendError("MLX model path must be a non-symlinked directory");
  }

  const files = new Set<string>();
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new BackendError(`refusing symlink in MLX model directory`);
      }
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (!entry.isFile()) throw new BackendError("refusing special file in MLX model directory");
      const file = relative(root, path).split(sep).join("/");
      if (file.startsWith("../") || EXECUTABLE_MODEL_FILE_RE.test(file)) {
        throw new BackendError(`refusing executable content in MLX model directory`);
      }
      files.add(file);
    }
  };
  visit(root);
  if (
    !files.has("config.json") ||
    !files.has("tokenizer_config.json") ||
    ![...files].some((file) => file.endsWith(".safetensors"))
  ) {
    throw new BackendError("MLX model directory is missing required data files");
  }

  const configPath = join(root, "config.json");
  let raw: string;
  try {
    const stats = lstatSync(configPath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_MLX_CONFIG_BYTES) {
      throw new BackendError("MLX config.json is unsafe or oversized");
    }
    raw = readFileSync(configPath, "utf8");
  } catch (cause) {
    if (cause instanceof BackendError) throw cause;
    throw new BackendError("failed to read MLX config.json", { cause });
  }
  let config: unknown;
  try {
    config = JSON.parse(raw) as unknown;
  } catch (cause) {
    throw new BackendError("MLX config.json is invalid JSON", { cause });
  }
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw new BackendError("MLX config.json must be an object");
  }
  const record = config as Readonly<Record<string, unknown>>;
  if (record["model_file"] !== undefined || record["auto_map"] !== undefined) {
    throw new BackendError("MLX custom model code is not allowed");
  }
}

function waitForChildClose(childClose: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolveClose) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolveClose(false);
    }, timeoutMs);
    childClose.then(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveClose(true);
    });
  });
}

async function stopSpawnedChild(
  child: SpawnedProcess,
  childClose: Promise<void>,
  isClosed: () => boolean,
): Promise<boolean> {
  if (isClosed()) return true;
  try {
    child.kill("SIGTERM");
  } catch {
    return false;
  }
  if (isClosed() || (await waitForChildClose(childClose, SPAWN_CLEANUP_GRACE_MS))) return true;
  try {
    child.kill("SIGKILL");
  } catch {
    return false;
  }
  return isClosed() || waitForChildClose(childClose, SPAWN_CLEANUP_GRACE_MS);
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
        bytes += next.value.byteLength;
        if (bytes > maxBytes) {
          await reader.cancel(`${label} response byte limit exceeded`);
          throw new BackendError(`${label} response exceeds byte limit`);
        }
        chunks.push(next.value);
      }
    } finally {
      reader.releaseLock();
    }
    return JSON.parse(
      Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8"),
    ) as unknown;
  }
  if (response.json !== undefined) return response.json();
  throw new BackendError(`${label} returned a malformed response body`);
}
