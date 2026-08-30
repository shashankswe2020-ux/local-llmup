/** Start the browser GUI server for interactive chat. */
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createServer as createNetServer } from "node:net";
import { promisify } from "node:util";
import { createDefaultRegistry, type HarnessRegistry } from "../harness/registry.js";
import { createDefaultRegistry as createDefaultBackendRegistry } from "../backend/registry.js";
import { GuiServer, type GuiServerOptions } from "../gui/server.js";
import { SessionRepository } from "../gui/session-repository.js";
import { WorkspaceService } from "../gui/workspace/service.js";
import { createDefaultModelManager, type GuiModelManager } from "../gui/management.js";
import { createRuntimeController, type RuntimeController } from "../gui/runtime.js";
import { createDefaultHardwareProvider, type HardwareProvider } from "../gui/hardware.js";
import { createDefaultMcpManager, type McpManager } from "../mcp/manager.js";
import { createActiveBackendChat } from "../gui/agent.js";
import { createLibraryService, type LibraryService } from "../library/service.js";
import { DIR_MODE, loadConfig } from "../config.js";
import { ValidationError } from "../errors.js";

const execFileAsync = promisify(execFile);

export interface GuiOptions {
  readonly port?: number | undefined;
  readonly harness?: string | undefined;
  readonly noOpen?: boolean | undefined;
  readonly json?: boolean | undefined;
}

export interface GuiResult {
  readonly url: string;
  readonly harness: string;
  readonly port: number;
}

/** The subset of {@link GuiServer} `runGui` depends on, so it can be faked. */
export interface GuiServerLike {
  readonly session: { activeHarnessName: string };
  readonly url: string;
  readonly port: number;
  start(port: number): Promise<number>;
  stop(): Promise<void>;
}

export interface GuiDeps {
  readonly registry: HarnessRegistry;
  readonly createServer: () => {
    listen(port: number, host: string, callback: () => void): void;
    close(callback: () => void): void;
    once(event: string, listener: (error?: Error | undefined) => void): void;
    removeListener(event: string, listener: (error?: Error | undefined) => void): void;
  };
  readonly openUrl: (url: string) => Promise<void> | void;
  readonly waitForShutdown: () => Promise<void>;
  readonly write: (text: string) => void;
  readonly log: (text: string) => void;
  readonly env: NodeJS.ProcessEnv;
  readonly modelManager?: GuiModelManager | undefined;
  readonly mcpManager?: McpManager | undefined;
  readonly runtimeController?: RuntimeController | undefined;
  readonly hardwareProvider?: HardwareProvider | undefined;
  readonly library?: LibraryService | undefined;
  readonly sessions?: SessionRepository | undefined;
  readonly workspace?: WorkspaceService | undefined;
  readonly createGuiServer?: ((options: GuiServerOptions) => GuiServerLike) | undefined;
}

const DEFAULT_PORT = 4000;

function resolveHarnessName(rawHarness: string | undefined, registry: HarnessRegistry, env: NodeJS.ProcessEnv): string {
  const value = rawHarness ?? env.LOCAL_LLMUP_HARNESS ?? "local";
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new ValidationError("invalid harness: empty string");
  }
  registry.get(normalized);
  return normalized;
}

async function probePort(port: number, probe: GuiDeps["createServer"]): Promise<void> {
  const server = probe();
  await new Promise<void>((resolve, reject) => {
    const onError = (error?: Error & { code?: string }): void => {
      server.close(() => undefined);
      if (error !== undefined && error.code === "EADDRINUSE") {
        reject(new ValidationError(`port ${port} is already in use on 127.0.0.1`));
        return;
      }
      reject(error ?? new ValidationError(`port ${port} is unavailable on 127.0.0.1`));
    };
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.close(() => {
        server.removeListener("error", onError);
        resolve();
      });
    });
  });
}

async function openBrowser(url: string): Promise<void> {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "darwin" || process.platform === "linux" ? [url] : ["/c", "start", "", url];
  try {
    await execFileAsync(command, args, { windowsHide: true });
  } catch {
    // Best effort; still allow the command to continue.
  }
}

const createDefaultDeps = (): GuiDeps => ({
  registry: createDefaultRegistry(),
  createServer: () => createNetServer(),
  openUrl: openBrowser,
  waitForShutdown: async () => {
    await new Promise<void>((resolve) => {
      const onSignal = (): void => {
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
        resolve();
      };
      process.once("SIGINT", onSignal);
      process.once("SIGTERM", onSignal);
    });
  },
  write: (text) => process.stdout.write(text),
  log: (text) => process.stderr.write(text),
  env: process.env,
});

export async function runGui(
  options: GuiOptions,
  deps: GuiDeps = createDefaultDeps(),
): Promise<GuiResult> {
  const port = options.port ?? DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ValidationError(`invalid port: ${port} (expected an integer in 1..65535)`);
  }

  const harnessName = resolveHarnessName(options.harness, deps.registry, deps.env);
  await probePort(port, deps.createServer);

  const modelManager = deps.modelManager ?? createDefaultModelManager();
  const mcpManager = deps.mcpManager ?? createDefaultMcpManager();
  const runtimeController = deps.runtimeController ?? createRuntimeController(createDefaultBackendRegistry());
  const hardwareProvider = deps.hardwareProvider ?? createDefaultHardwareProvider();
  const library = deps.library ?? createLibraryService();
  const artifactsDir = loadConfig().artifactsDir;
  mkdirSync(artifactsDir, { recursive: true, mode: DIR_MODE });
  const sessions = deps.sessions ?? new SessionRepository(loadConfig());
  const workspace = deps.workspace ?? new WorkspaceService();
  const editRecordsDir = join(loadConfig().homeDir, "gui-edits");
  const createGuiServer = deps.createGuiServer ?? ((serverOptions) => new GuiServer(serverOptions));
  const server = createGuiServer({
    registry: deps.registry,
    modelManager,
    mcpManager,
    runtimeController,
    hardwareProvider,
    agentChat: createActiveBackendChat(),
    library,
    artifactsDir,
    sessions,
    workspace,
    editRecordsDir,
  });
  server.session.activeHarnessName = harnessName;
  await server.start(port);

  try {
    if (options.noOpen !== true && options.json !== true) {
      await deps.openUrl(server.url);
    }

    const payload = { url: server.url, harness: harnessName, port: server.port };
    if (options.json === true) {
      deps.write(`${JSON.stringify(payload)}\n`);
    } else {
      deps.write(`local-llmup GUI listening at ${server.url}\n`);
    }

    await deps.waitForShutdown();
    deps.write("Stopped.\n");
    return payload;
  } finally {
    await mcpManager.shutdown();
    await runtimeController.shutdown();
    await server.stop();
  }
}
