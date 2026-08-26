/** HTTP server for the browser GUI. */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { ValidationError } from "../errors.js";
import { createDefaultRegistry } from "../harness/registry.js";
import { stripControl } from "../sanitize.js";
import { appendConversation, createSession, type GuiSession } from "./session.js";
import { MAX_REQUEST_BYTES, parseGuiChatRequest, parseHarnessSwitch, readJsonBody, validateHost } from "./handlers.js";
import { readStaticAsset } from "./static.js";
import { parseGuiUpRequest, type GuiModelManager } from "./management.js";

export interface GuiChatRequest {
  readonly model: string;
  readonly harness?: string | undefined;
  readonly messages: readonly { readonly role: "user" | "assistant"; readonly content: string }[];
}

export interface GuiServerOptions {
  readonly rootDir?: URL | string | undefined;
  readonly registry?: ReturnType<typeof createDefaultRegistry> | undefined;
  readonly sendChat?: ((request: GuiChatRequest) => Promise<readonly string[]>) | undefined;
  readonly modelManager?: GuiModelManager | undefined;
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
  private server: HttpServer | null = null;
  port = 0;
  url = "";

  constructor(options: GuiServerOptions = {}) {
    this.rootDir = options.rootDir ?? resolveGuiRootDir(new URL(import.meta.url));
    this.registry = options.registry ?? createDefaultRegistry();
    this.session = createSession();
    this.sendChat = options.sendChat;
    this.modelManager = options.modelManager;
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
        const models = await manager.recommended();
        this.writeJson(res, 200, { models });
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

      const asyncChunks = this.sendChat !== undefined
        ? this.sendChat({ model: requestModel, harness: harnessName, messages: runtimeMessages })
        : harness.chatSync({
            model: requestModel,
            messages: runtimeMessages,
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

  private writeJson(res: ServerResponse, status: number, payload: Record<string, unknown>): void {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(payload));
  }
}
