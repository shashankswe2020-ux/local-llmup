/** HTTP server for the browser GUI. */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { ValidationError } from "../errors.js";
import { createDefaultRegistry } from "../harness/registry.js";
import { stripControl } from "../sanitize.js";
import { appendConversation, createSession, type GuiSession } from "./session.js";
import { MAX_REQUEST_BYTES, parseGuiChatRequest, parseHarnessSwitch, parseRuntimeQuery, readJsonBody, validateHost } from "./handlers.js";
import { readStaticAsset } from "./static.js";
import {
  parseContextWindowPreset,
  parseGuiUpRequest,
  type GuiModelManager,
} from "./management.js";
import { toHardwareSummary, type HardwareProvider } from "./hardware.js";
import type { RuntimeController } from "./runtime.js";
import type { McpManager } from "../mcp/manager.js";
import { runAgentTurn, type AgentChat } from "./agent.js";
import { LibraryDraftSchema, LibraryUpdateSchema, type LibraryKind } from "../library/schema.js";
import type { LibraryService } from "../library/service.js";
import { readArtifactImage } from "./artifacts.js";

/** Upper bound on a composed agent+skill system prompt injected into a chat turn. */
const MAX_SYSTEM_PROMPT_CHARS = 48 * 1024;

export interface GuiChatRequest {
  readonly model: string;
  readonly harness?: string | undefined;
  readonly messages: readonly {
    readonly role: "system" | "user" | "assistant";
    readonly content: string;
  }[];
}

export interface GuiServerOptions {
  readonly rootDir?: URL | string | undefined;
  readonly registry?: ReturnType<typeof createDefaultRegistry> | undefined;
  readonly sendChat?: ((request: GuiChatRequest) => Promise<readonly string[]>) | undefined;
  readonly modelManager?: GuiModelManager | undefined;
  readonly mcpManager?: McpManager | undefined;
  readonly runtimeController?: RuntimeController | undefined;
  readonly hardwareProvider?: HardwareProvider | undefined;
  /** When set, chat turns with connected MCP tools run the agentic tool loop. */
  readonly agentChat?: AgentChat | undefined;
  /** Agent/skill library backing the Library UI and per-message system prompts. */
  readonly library?: LibraryService | undefined;
  /** Directory of generated images/graphs served inline in the chat panel. */
  readonly artifactsDir?: string | undefined;
}

export function resolveGuiRootDir(baseUrl: URL): URL {
  const direct = new URL("./static", baseUrl);
  if (existsSync(fileURLToPath(direct))) {
    return direct;
  }

  const sourceFallback = new URL("../../src/gui/static", baseUrl);
  if (existsSync(fileURLToPath(sourceFallback))) {
    return sourceFallback;
  }

  return direct;
}

export class GuiServer {
  readonly rootDir: URL | string;
  readonly session: GuiSession;
  readonly registry: ReturnType<typeof createDefaultRegistry>;
  readonly sendChat?: ((request: GuiChatRequest) => Promise<readonly string[]>) | undefined;
  readonly modelManager?: GuiModelManager | undefined;
  readonly mcpManager?: McpManager | undefined;
  readonly runtimeController?: RuntimeController | undefined;
  readonly hardwareProvider?: HardwareProvider | undefined;
  readonly agentChat?: AgentChat | undefined;
  readonly library?: LibraryService | undefined;
  readonly artifactsDir?: string | undefined;
  private server: HttpServer | null = null;
  port = 0;
  url = "";

  constructor(options: GuiServerOptions = {}) {
    this.rootDir = options.rootDir ?? resolveGuiRootDir(new URL(import.meta.url));
    this.registry = options.registry ?? createDefaultRegistry();
    this.session = createSession();
    this.sendChat = options.sendChat;
    this.modelManager = options.modelManager;
    this.mcpManager = options.mcpManager;
    this.runtimeController = options.runtimeController;
    this.hardwareProvider = options.hardwareProvider;
    this.agentChat = options.agentChat;
    this.library = options.library;
    this.artifactsDir = options.artifactsDir;
  }

  async start(port: number): Promise<number> {
    const server = createServer((req, res) => this.handleRequest(req, res));
    this.server = server;

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });

    const address = server.address();
    if (typeof address === "object" && address !== null) {
      this.port = address.port;
      this.url = `http://127.0.0.1:${address.port}`;
      return address.port;
    }
    this.port = port;
    this.url = `http://127.0.0.1:${port}`;
    return port;
  }

  async stop(): Promise<void> {
    if (this.server === null) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      this.server?.close((error) => {
        if (error !== undefined && error !== null) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    this.server = null;
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const hostHeader = req.headers.host ?? "";
      validateHost(hostHeader, this.port);

      const rawPath = req.url ?? "/";
      if (rawPath.startsWith("/static/") && (rawPath.includes("..") || rawPath.includes("\\"))) {
        throw new ValidationError(`path traversal refused: ${rawPath}`);
      }

      const url = new URL(rawPath, `http://${hostHeader || "127.0.0.1"}`);
      const pathname = url.pathname;

      if (req.method === "GET" && pathname === "/") {
        await this.serveIndex(res);
        return;
      }

      if (req.method === "GET" && pathname.startsWith("/static/")) {
        await this.serveStatic(res, pathname);
        return;
      }

      if (req.method === "GET" && pathname === "/api/status") {
        this.writeJson(res, 200, {
          harness: this.session.activeHarnessName,
          model: this.session.modelId,
          memory: {
            turns: this.session.conversationWindow.length,
          },
        });
        return;
      }

      if (req.method === "GET" && pathname === "/api/harnesses") {
        const harnesses = this.registry.all().map((entry) => entry.name);
        this.writeJson(res, 200, { harnesses });
        return;
      }

      if (req.method === "GET" && pathname === "/api/runtimes") {
        const manager = this.requireModelManager();
        this.writeJson(res, 200, { runtimes: manager.runtimes() });
        return;
      }

      if (req.method === "GET" && pathname === "/api/hardware") {
        const provider = this.requireHardwareProvider();
        const profile = await provider();
        this.writeJson(res, 200, { hardware: toHardwareSummary(profile) });
        return;
      }

      if (pathname === "/api/runtimes/status" || pathname.startsWith("/api/runtimes/")) {
        await this.handleRuntimes(req, res, pathname);
        return;
      }

      if (req.method === "GET" && pathname === "/api/history") {
        this.writeJson(res, 200, { history: this.session.conversationWindow });
        return;
      }

      if (req.method === "POST" && pathname === "/api/harness") {
        const body = await readJsonBody(req, MAX_REQUEST_BYTES);
        const switchRequest = parseHarnessSwitch(body);
        this.session.activeHarnessName = switchRequest.harness;
        this.writeJson(res, 200, { harness: this.session.activeHarnessName });
        return;
      }

      if (req.method === "GET" && pathname === "/api/models/recommended") {
        const manager = this.requireModelManager();
        const runtime = parseRuntimeQuery(url.searchParams.get("runtime"));
        const contextPreset = parseContextWindowPreset(url.searchParams.get("context"));
        const models = await manager.recommended({
          ...(runtime !== undefined ? { runtime } : {}),
          ...(contextPreset !== undefined ? { contextPreset } : {}),
        });
        this.writeJson(res, 200, {
          models,
          runtime: runtime ?? null,
          contextPreset: contextPreset ?? null,
        });
        return;
      }

      if (req.method === "GET" && pathname === "/api/models/active") {
        const manager = this.requireModelManager();
        this.writeJson(res, 200, { active: manager.active() });
        return;
      }

      if (req.method === "POST" && pathname === "/api/models/up") {
        const manager = this.requireModelManager();
        const body = await readJsonBody(req, MAX_REQUEST_BYTES);
        const upRequest = parseGuiUpRequest(body);
        const active = await manager.up(upRequest);
        this.session.modelId = active.modelId;
        this.writeJson(res, 200, { active });
        return;
      }

      if (req.method === "POST" && pathname === "/api/chat") {
        await this.handleChat(req, res);
        return;
      }

      if (req.method === "GET" && pathname.startsWith("/api/images/")) {
        await this.handleArtifactImage(res, pathname);
        return;
      }

      if (pathname === "/api/connectors" || pathname.startsWith("/api/connectors/")) {
        await this.handleConnectors(req, res, pathname);
        return;
      }

      if (pathname === "/api/agents" || pathname.startsWith("/api/agents/")) {
        await this.handleLibrary(req, res, pathname, "agent");
        return;
      }

      if (pathname === "/api/skills" || pathname.startsWith("/api/skills/")) {
        await this.handleLibrary(req, res, pathname, "skill");
        return;
      }

      this.writeJson(res, 404, { error: "not found" });
    } catch (error) {
      if (error instanceof ValidationError) {
        const message = stripControl(error.message);
        if (message.includes("host header mismatch")) {
          this.writeJson(res, 400, { error: message });
          return;
        }
        if (message.includes("request body exceeds 64 KiB limit")) {
          this.writeJson(res, 413, { error: message });
          return;
        }
        this.writeJson(res, 400, { error: message });
        return;
      }
      this.writeJson(res, 500, { error: "internal server error" });
    }
  }

  private async serveIndex(res: ServerResponse): Promise<void> {
    const indexPath = fileURLToPath(new URL("./static/index.html", import.meta.url));
    const content = await readFile(indexPath, "utf8");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(content);
  }

  private async serveStatic(res: ServerResponse, pathname: string): Promise<void> {
    const entry = await readStaticAsset(this.rootDir, pathname);
    res.writeHead(200, { "Content-Type": entry.contentType });
    res.end(entry.content);
  }

  private async handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJsonBody(req, MAX_REQUEST_BYTES);
    const request = parseGuiChatRequest(body);
    const requestModel = request.model ?? "demo-model";

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    try {
      const harnessName = request.harness ?? this.session.activeHarnessName;
      const harness = this.registry.get(harnessName);
      const runtimeMessages = request.messages.map((message) => ({
        role: message.role,
        content: stripControl(message.content),
      }));

      const systemPrompt = this.library?.composeForChat(request.agentId, request.skillIds);
      const composedMessages =
        systemPrompt !== undefined && systemPrompt.trim().length > 0
          ? [
              { role: "system" as const, content: stripControl(systemPrompt).slice(0, MAX_SYSTEM_PROMPT_CHARS) },
              ...runtimeMessages,
            ]
          : runtimeMessages;

      const agentTools = this.mcpManager?.agentTools() ?? [];
      if (this.agentChat !== undefined && this.mcpManager !== undefined && agentTools.length > 0) {
        const mcpManager = this.mcpManager;
        let assistantText = "";
        for await (const event of runAgentTurn({
          chat: this.agentChat,
          tools: agentTools,
          callTool: (name, args) => mcpManager.callTool(name, args),
          messages: composedMessages,
        })) {
          if (event.type === "tool") {
            res.write(
              `data: ${JSON.stringify({
                type: "tool",
                name: stripControl(event.name),
                phase: event.phase,
                ...(event.isError !== undefined ? { isError: event.isError } : {}),
              })}\n\n`,
            );
          } else {
            const cleaned = stripControl(event.content);
            assistantText += cleaned;
            res.write(`data: ${JSON.stringify({ type: "delta", content: cleaned })}\n\n`);
          }
        }
        appendConversation(this.session, {
          role: "user",
          content: request.messages.at(-1)?.content ?? "",
        });
        appendConversation(this.session, { role: "assistant", content: stripControl(assistantText) });
        res.write(
          `data: ${JSON.stringify({ type: "done", turnsAppended: 1, factsExtracted: 0, vectorsEmbedded: 0 })}\n\n`,
        );
        return;
      }

      const asyncChunks = this.sendChat !== undefined
        ? this.sendChat({ model: requestModel, harness: harnessName, messages: composedMessages })
        : harness.chatSync({
            model: requestModel,
            messages: composedMessages,
          }).then((content) => [content]);

      const chunks = await asyncChunks;
      for (const chunk of chunks) {
        const cleaned = stripControl(chunk);
        res.write(`data: ${JSON.stringify({ type: "delta", content: cleaned })}\n\n`);
      }
      const assistantText = chunks.join("");
      appendConversation(this.session, { role: "user", content: request.messages.at(-1)?.content ?? "" });
      appendConversation(this.session, { role: "assistant", content: stripControl(assistantText) });
      res.write(
        `data: ${JSON.stringify({ type: "done", turnsAppended: 1, factsExtracted: 0, vectorsEmbedded: 0 })}\n\n`,
      );
    } catch (error) {
      const message = error instanceof Error ? stripControl(error.message) : "unknown error";
      res.write(`data: ${JSON.stringify({ type: "error", message })}\n\n`);
    } finally {
      res.end();
    }
  }

  private requireModelManager(): GuiModelManager {
    if (this.modelManager === undefined) {
      throw new ValidationError("model management is not available");
    }
    return this.modelManager;
  }

  private requireHardwareProvider(): HardwareProvider {
    if (this.hardwareProvider === undefined) {
      throw new ValidationError("hardware detection is not available");
    }
    return this.hardwareProvider;
  }

  private requireRuntimeController(): RuntimeController {
    if (this.runtimeController === undefined) {
      throw new ValidationError("runtime control is not available");
    }
    return this.runtimeController;
  }

  /**
   * Route inference-runtime requests. Paths:
   *   GET  /api/runtimes/status         status of every runtime
   *   POST /api/runtimes/:name/start    start a daemon runtime's server
   *   POST /api/runtimes/:name/stop     stop a daemon this process started
   */
  private async handleRuntimes(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
  ): Promise<void> {
    const controller = this.requireRuntimeController();

    if (pathname === "/api/runtimes/status") {
      if (req.method !== "GET") {
        this.writeJson(res, 405, { error: "method not allowed" });
        return;
      }
      const runtimes = await controller.list();
      this.writeJson(res, 200, { runtimes });
      return;
    }

    const rest = pathname.slice("/api/runtimes/".length);
    const segments = rest.split("/").filter((segment) => segment.length > 0);
    if (segments.length === 2 && req.method === "POST") {
      const [name, action] = segments as [string, string];
      if (action === "start") {
        const runtime = await controller.start(decodeURIComponent(name));
        this.writeJson(res, 200, { runtime });
        return;
      }
      if (action === "stop") {
        const runtime = await controller.stop(decodeURIComponent(name));
        this.writeJson(res, 200, { runtime });
        return;
      }
    }

    this.writeJson(res, 404, { error: "not found" });
  }

  private requireMcpManager(): McpManager {
    if (this.mcpManager === undefined) {
      throw new ValidationError("connector management is not available");
    }
    return this.mcpManager;
  }

  /**
   * Route MCP connector requests. Paths:
   *   GET    /api/connectors                    list
   *   POST   /api/connectors                    add
   *   GET    /api/connectors/config             raw definitions document
   *   PUT    /api/connectors/config             replace all definitions
   *   DELETE /api/connectors/:id                remove
   *   POST   /api/connectors/:id/connect        connect + discover tools
   *   POST   /api/connectors/:id/disconnect     disconnect
   */
  private async handleConnectors(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
  ): Promise<void> {
    const manager = this.requireMcpManager();

    if (pathname === "/api/connectors/config") {
      if (req.method === "GET") {
        this.writeJson(res, 200, { config: manager.snapshot() });
        return;
      }
      if (req.method === "PUT") {
        const body = await readJsonBody(req, MAX_REQUEST_BYTES);
        const connectors = await manager.replaceAll(body);
        this.writeJson(res, 200, { connectors });
        return;
      }
      this.writeJson(res, 405, { error: "method not allowed" });
      return;
    }

    if (pathname === "/api/connectors") {
      if (req.method === "GET") {
        this.writeJson(res, 200, { connectors: manager.list() });
        return;
      }
      if (req.method === "POST") {
        const body = await readJsonBody(req, MAX_REQUEST_BYTES);
        const connector = await manager.add(body);
        this.writeJson(res, 201, { connector });
        return;
      }
      this.writeJson(res, 405, { error: "method not allowed" });
      return;
    }

    const rest = pathname.slice("/api/connectors/".length);
    const segments = rest.split("/").filter((segment) => segment.length > 0);
    const id = segments[0] !== undefined ? decodeURIComponent(segments[0]) : "";
    const action = segments[1];

    if (id.length === 0 || segments.length > 2) {
      this.writeJson(res, 404, { error: "not found" });
      return;
    }

    if (action === undefined) {
      if (req.method === "DELETE") {
        await manager.remove(id);
        this.writeJson(res, 200, { removed: id });
        return;
      }
      this.writeJson(res, 405, { error: "method not allowed" });
      return;
    }

    if (req.method !== "POST") {
      this.writeJson(res, 405, { error: "method not allowed" });
      return;
    }

    if (action === "connect") {
      const connector = await manager.connect(id);
      this.writeJson(res, 200, { connector });
      return;
    }
    if (action === "disconnect") {
      const connector = await manager.disconnect(id);
      this.writeJson(res, 200, { connector });
      return;
    }

    this.writeJson(res, 404, { error: "not found" });
  }

  private requireLibrary(): LibraryService {
    if (this.library === undefined) {
      throw new ValidationError("agent & skill library is not available");
    }
    return this.library;
  }

  private async handleArtifactImage(res: ServerResponse, pathname: string): Promise<void> {
    if (this.artifactsDir === undefined) {
      this.writeJson(res, 404, { error: "not found" });
      return;
    }
    const name = pathname.slice("/api/images/".length);
    try {
      const { content, contentType } = await readArtifactImage(this.artifactsDir, name);
      res.writeHead(200, {
        "Content-Type": contentType,
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      });
      res.end(content);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.writeJson(res, 404, { error: "not found" });
        return;
      }
      throw error;
    }
  }

  /**
   * Route agent/skill library requests. Paths (with `:kind` = agents|skills):
   *   GET    /api/:kind        list
   *   POST   /api/:kind        create (name, description?, body?, enabled?)
   *   GET    /api/:kind/:id    read one (includes body)
   *   PUT    /api/:kind/:id    partial update (any field, e.g. { enabled })
   *   DELETE /api/:kind/:id    remove
   */
  private async handleLibrary(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
    kind: LibraryKind,
  ): Promise<void> {
    const library = this.requireLibrary();
    const base = kind === "agent" ? "/api/agents" : "/api/skills";

    if (pathname === base) {
      if (req.method === "GET") {
        this.writeJson(res, 200, { items: library.list(kind) });
        return;
      }
      if (req.method === "POST") {
        const body = await readJsonBody(req, MAX_REQUEST_BYTES);
        const draft = LibraryDraftSchema.safeParse(body);
        if (!draft.success) {
          throw new ValidationError(
            `invalid ${kind}: ${draft.error.issues[0]?.message ?? "bad request"}`,
          );
        }
        const item = library.create(kind, draft.data);
        this.writeJson(res, 201, { item });
        return;
      }
      this.writeJson(res, 405, { error: "method not allowed" });
      return;
    }

    const rest = pathname.slice(base.length + 1);
    const segments = rest.split("/").filter((segment) => segment.length > 0);
    const id = segments[0] !== undefined ? decodeURIComponent(segments[0]) : "";
    if (id.length === 0 || segments.length > 1) {
      this.writeJson(res, 404, { error: "not found" });
      return;
    }

    if (req.method === "GET") {
      const item = library.get(kind, id);
      if (item === undefined) {
        this.writeJson(res, 404, { error: "not found" });
        return;
      }
      this.writeJson(res, 200, { item });
      return;
    }
    if (req.method === "PUT") {
      const body = await readJsonBody(req, MAX_REQUEST_BYTES);
      const patch = LibraryUpdateSchema.safeParse(body);
      if (!patch.success) {
        throw new ValidationError(
          `invalid ${kind}: ${patch.error.issues[0]?.message ?? "bad request"}`,
        );
      }
      const item = library.update(kind, id, patch.data);
      this.writeJson(res, 200, { item });
      return;
    }
    if (req.method === "DELETE") {
      library.remove(kind, id);
      this.writeJson(res, 200, { removed: id });
      return;
    }
    this.writeJson(res, 405, { error: "method not allowed" });
  }

  private writeJson(res: ServerResponse, status: number, payload: Record<string, unknown>): void {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(payload));
  }
}
