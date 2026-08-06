/**
 * llama.cpp backend adapter (`llama-server`, GGUF).
 *
 * This slice (B14a) implements only the descriptor surface — the capability
 * flags, `isInstalled`, `installHint`, and a best-effort `version` probe — plus
 * registration in the default registry. The serve/ready/stop lifecycle lands in
 * B14b and pull/chat/embed in B14c; until then those methods throw a typed
 * {@link BackendError} rather than pretending to work.
 *
 * Like the Ollama adapter, this is stateless and its process seam is injectable
 * (`spawn`) so tests never touch a real `llama-server`. Every spawn is
 * `shell:false` with a discrete argument array.
 */
import { spawn as nodeSpawn } from "node:child_process";
import type { Readable } from "node:stream";
import { BackendError } from "../errors.js";
import { stripControl } from "../sanitize.js";
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
} from "./adapter.js";
import type { ProcessOutputStream, SpawnFn, SpawnedProcess } from "./ollama.js";
import type { BackendCapabilities } from "../types.js";

/** Default binary name resolved from `PATH`. */
const LLAMA_SERVER_BINARY = "llama-server";

/** llama.cpp / mlx-lm / llamafile all default to loopback port 8080 (spec §12.5). */
const LLAMACPP_DEFAULT_PORT = 8080;

/** Upper bound on how long the `--version` probe may run before it is aborted. */
const VERSION_PROBE_TIMEOUT_MS = 1_500;

/** Cap on captured probe output, bounding memory for newline-less streams. */
const VERSION_CAPTURE_MAX_BYTES = 8 * 1024;

/** Cap on characters kept from a non-semver version banner. */
const VERSION_BANNER_MAX_CHARS = 100;

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
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    signal: options.signal,
    ...(options.env ? { env: options.env } : {}),
  });
  return {
    pid: child.pid,
    stdout: adaptStream(child.stdout),
    stderr: adaptStream(child.stderr),
    onClose: (listener) => {
      child.on("close", (code) => listener(code));
    },
    onError: (listener) => {
      child.on("error", (error) => listener(error));
    },
    kill: (signal) => {
      child.kill(signal);
    },
  };
};

/** Map a spawn/child failure onto a typed {@link BackendError}. */
function wrapSpawnError(binary: string, error: unknown): BackendError {
  const err = error instanceof Error ? error : new Error(String(error));
  const code = (err as { code?: unknown }).code;
  if (err.name === "AbortError" || code === "ABORT_ERR") {
    return new BackendError(`${binary} was aborted`, { cause: err });
  }
  if (code === "ENOENT") {
    return new BackendError(`${binary} not found on PATH`, { cause: err });
  }
  return new BackendError(`failed to run ${binary}: ${err.message}`, { cause: err });
}

interface ProbeResult {
  readonly code: number;
  readonly text: string;
}

/**
 * Run `binary args`, returning the exit code and (optionally) the combined
 * stdout+stderr text, capped at {@link VERSION_CAPTURE_MAX_BYTES}. Rejects with a
 * {@link BackendError} if the spawn itself fails.
 */
function probe(
  spawn: SpawnFn,
  binary: string,
  args: readonly string[],
  signal: AbortSignal | undefined,
  capture: boolean,
): Promise<ProbeResult> {
  return new Promise<ProbeResult>((resolve, reject) => {
    let child: SpawnedProcess;
    try {
      child = spawn(binary, args, { signal });
    } catch (error) {
      reject(wrapSpawnError(binary, error));
      return;
    }
    let text = "";
    if (capture) {
      const onData = (chunk: string): void => {
        if (text.length < VERSION_CAPTURE_MAX_BYTES) {
          text += chunk;
        }
      };
      child.stdout?.onData(onData);
      child.stderr?.onData(onData);
    }
    child.onError((error) => reject(wrapSpawnError(binary, error)));
    child.onClose((code) => resolve({ code: code ?? -1, text }));
  });
}

/**
 * Extract a best-effort version from `llama-server --version` output. llama.cpp
 * reports a build number (e.g. `version: 3860 (a1b2c3d)`), often on stderr,
 * alongside a compiler banner (`built with Apple clang version 15.0.0 …`). The
 * `version:` line is authoritative, so match it first — matching a generic
 * semver token first would wrongly report the *compiler* version. Fall back to
 * a semver token, then the first non-empty line (length-bounded). The result is
 * still untrusted — callers `stripControl` before display.
 */
function parseVersion(output: string): string | null {
  const build = /version:\s*([0-9A-Za-z.+-]+)/i.exec(output);
  if (build !== null && build[1] !== undefined) {
    return build[1];
  }
  const semver = /\d+\.\d+\.\d+(?:[.-][0-9A-Za-z.-]+)?/.exec(output);
  if (semver !== null) {
    return semver[0];
  }
  const firstLine = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return firstLine !== undefined ? firstLine.slice(0, VERSION_BANNER_MAX_CHARS) : null;
}

/** Options for constructing a {@link LlamaCppAdapter}. */
export interface LlamaCppAdapterOptions {
  readonly spawn?: SpawnFn | undefined;
  readonly binary?: string | undefined;
  readonly platform?: NodeJS.Platform | undefined;
}

/** Stateless adapter over the llama.cpp `llama-server` backend. */
export class LlamaCppAdapter implements BackendAdapter {
  readonly name = "llamacpp";
  readonly capabilities: BackendCapabilities = {
    canPull: true,
    // A single chat-serving `llama-server` instance cannot also serve
    // embeddings (that requires a dedicated `--embedding` server), so declare
    // `false`: memory capture then degrades to the vector-less path (honest, no
    // fabricated vectors) rather than calling an endpoint that isn't enabled.
    canEmbed: false,
    openAiCompatible: true,
    formats: ["gguf"],
    defaultPort: LLAMACPP_DEFAULT_PORT,
  };

  private readonly spawn: SpawnFn;
  private readonly binary: string;
  private readonly platform: NodeJS.Platform;

  constructor(options: LlamaCppAdapterOptions = {}) {
    this.spawn = options.spawn ?? defaultSpawn;
    this.binary = options.binary ?? LLAMA_SERVER_BINARY;
    this.platform = options.platform ?? process.platform;
  }

  async isInstalled(): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), VERSION_PROBE_TIMEOUT_MS);
    try {
      const { code } = await probe(
        this.spawn,
        this.binary,
        ["--version"],
        controller.signal,
        false,
      );
      return code === 0;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  installHint(): string {
    switch (this.platform) {
      case "darwin":
        return "brew install llama.cpp";
      case "linux":
        return "brew install llama.cpp  # or build/download llama-server from https://github.com/ggml-org/llama.cpp/releases";
      case "win32":
        return "winget install ggml.llamacpp  # or download llama-server from https://github.com/ggml-org/llama.cpp/releases";
      default:
        return "Install llama.cpp (llama-server) from https://github.com/ggml-org/llama.cpp";
    }
  }

  /**
   * Best-effort version via `llama-server --version` (arg array, `shell:false`).
   * Bounded by an abort deadline so a wedged binary cannot block `doctor`, and
   * `stripControl`-clean at the source: display-safe or `null`. Never throws — a
   * probe failure or non-zero exit reports `null` rather than aborting.
   */
  async version(): Promise<string | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), VERSION_PROBE_TIMEOUT_MS);
    try {
      const { code, text } = await probe(
        this.spawn,
        this.binary,
        ["--version"],
        controller.signal,
        true,
      );
      if (code !== 0) return null;
      const parsed = parseVersion(text);
      return parsed === null ? null : stripControl(parsed);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  pull(_options: PullOptions): Promise<PullResult> {
    return Promise.reject(this.notImplemented("pull"));
  }

  serve(_options?: ServeOptions): Promise<ServeHandle> {
    return Promise.reject(this.notImplemented("serve"));
  }

  waitUntilReady(_options: ReadinessOptions): Promise<void> {
    return Promise.reject(this.notImplemented("waitUntilReady"));
  }

  stop(_handle: ServeHandle): Promise<void> {
    return Promise.reject(this.notImplemented("stop"));
  }

  chat(_request: ChatRequest): Promise<ChatResult> {
    return Promise.reject(this.notImplemented("chat"));
  }

  embed(_request: EmbedRequest): Promise<EmbedResult> {
    return Promise.reject(this.notImplemented("embed"));
  }

  private notImplemented(method: string): BackendError {
    return new BackendError(`llamacpp ${method} is not implemented yet`);
  }
}
