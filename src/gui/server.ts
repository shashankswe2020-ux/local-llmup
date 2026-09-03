/** HTTP server for the browser GUI. */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { randomBytes, createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { ValidationError } from "../errors.js";
import { createDefaultRegistry } from "../harness/registry.js";
import { stripControl } from "../sanitize.js";
import { appendConversation, createSession, type GuiSession } from "./session.js";
import { MAX_REQUEST_BYTES, parseGuiChatRequest, parseHarnessSwitch, parseRuntimeQuery, readJsonBody, validateHost } from "./handlers.js";
import { readStaticAsset, readVendorAsset } from "./static.js";
import {
  parseContextWindowPreset,
  parseGuiUpRequest,
  type GuiModelManager,
} from "./management.js";
import { toHardwareSummary, type HardwareProvider } from "./hardware.js";
import type { RuntimeController } from "./runtime.js";
import type { McpManager } from "../mcp/manager.js";
import { runAgentTurn, type AgentChat, type AgentEvent, type ToolApprover, type ToolCallContext } from "./agent.js";
import { toolGrantKey, type ToolDecision } from "./tool-policy.js";
import { RunCoordinator, RunConflictError, type Run } from "./run.js";
import { SessionConflictError, type SessionRepository } from "./session-repository.js";
import { GuiTextStreamSanitizer, sanitizeGuiText } from "./text-sanitize.js";
import { type WorkspaceService, type LineRange } from "./workspace/service.js";
import { EditProposalService } from "./workspace/edit-proposal.js";
import { PatchTransactionService } from "./workspace/patch-transaction.js";
import {
  MAX_ATTACHMENT_CONTEXT_BYTES,
  type AttachmentManifestEntry,
  type WorkspaceAttachmentRef,
  type ContextSourceRef,
} from "./contracts.js";
import { z } from "zod";
import { LibraryDraftSchema, LibraryUpdateSchema, type LibraryKind } from "../library/schema.js";
import type { LibraryService } from "../library/service.js";
import { readArtifactImage } from "./artifacts.js";
import { getUpdateStatus, type UpdateStatus } from "./update.js";

/** Upper bound on a composed agent+skill system prompt injected into a chat turn. */
const MAX_SYSTEM_PROMPT_CHARS = 48 * 1024;
/** Larger request cap for edit proposals, which carry hunk text. */
const MAX_EDIT_REQUEST_BYTES = 1024 * 1024;
const SESSION_CREATE_SCHEMA = z.object({ title: z.string().trim().max(200).optional() });

const SESSION_PATCH_SCHEMA = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  archived: z.boolean().optional(),
  expectedRevision: z.number().int().nonnegative().optional(),
});

function parseSessionPatch(input: unknown): z.infer<typeof SESSION_PATCH_SCHEMA> {
  const parsed = SESSION_PATCH_SCHEMA.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError("invalid session patch");
  }
  return parsed.data;
}

function parseSessionLimit(raw: string | null): number | undefined {
  if (raw === null) {
    return undefined;
  }
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function patchRevision(patch: { expectedRevision?: number | undefined }): {
  expectedRevision?: number;
} {
  return patch.expectedRevision !== undefined ? { expectedRevision: patch.expectedRevision } : {};
}

const WORKSPACE_ROOT_SCHEMA = z.object({ path: z.string().min(1).max(4096) });
const WORKSPACE_REVOKE_SCHEMA = z.object({ id: z.string().min(1).max(128) });

const TOOL_DECISION_SCHEMA = z.object({
  callId: z.string().min(1).max(128),
  decision: z.enum(["approve-once", "allow-session", "deny"]),
});

/** True when a harness sends data off the machine (anything but `local`). */
function isCloudHarness(harnessName: string): boolean {
  return harnessName !== "local";
}

function parseLineRange(
  startRaw: string | null,
  endRaw: string | null,
): LineRange | undefined {
  if (startRaw === null && endRaw === null) {
    return undefined;
  }
  const start = Number(startRaw);
  const end = Number(endRaw);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
    throw new ValidationError("invalid line range");
  }
  return { startLine: start, endLine: end };
}

export interface GuiChatRequest {
  readonly model: string;
  readonly harness?: string | undefined;
  readonly messages: readonly {
    readonly role: "system" | "user" | "assistant";
    readonly content: string;
  }[];
  readonly temperature?: number | undefined;
}

export interface GuiServerOptions {
  readonly rootDir?: URL | string | undefined;
  readonly registry?: ReturnType<typeof createDefaultRegistry> | undefined;
  readonly sendChat?:
    | ((request: GuiChatRequest, signal?: AbortSignal) => Promise<readonly string[]>)
    | undefined;
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
  /** When set, chat sessions are durably persisted and multi-session APIs are enabled. */
  readonly sessions?: SessionRepository | undefined;
  /** When set, read-only workspace context APIs are enabled behind a launch token. */
  readonly workspace?: WorkspaceService | undefined;
  /** Owner-only directory for durable edit-apply records; enables apply/revert. */
  readonly editRecordsDir?: string | undefined;
  /** Latest-release status provider; injectable so tests and offline hosts stay deterministic. */
  readonly updateStatus?: (() => Promise<UpdateStatus>) | undefined;
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
  readonly sendChat?:
    | ((request: GuiChatRequest, signal?: AbortSignal) => Promise<readonly string[]>)
    | undefined;
  readonly modelManager?: GuiModelManager | undefined;
  readonly mcpManager?: McpManager | undefined;
  readonly runtimeController?: RuntimeController | undefined;
  readonly hardwareProvider?: HardwareProvider | undefined;
  readonly agentChat?: AgentChat | undefined;
  readonly library?: LibraryService | undefined;
  readonly artifactsDir?: string | undefined;
  readonly sessions?: SessionRepository | undefined;
  readonly workspace?: WorkspaceService | undefined;
  readonly updateStatus: () => Promise<UpdateStatus>;
  /** Per-launch capability token; a local CSRF/DNS-rebinding defense, not auth. */
  readonly launchToken: string = randomBytes(32).toString("hex");
  private activeSessionId: string | null = null;
  private activeWorkspaceId: string | null = null;
  private readonly runs = new RunCoordinator();
  /** Pending tool-approval resolvers keyed by call id, for the active run. */
  private readonly pendingApprovals = new Map<string, (decision: ToolDecision) => void>();
  /** Validates edit proposals into inert review diffs; present with a workspace. */
  private readonly editProposals: EditProposalService | undefined;
  /** Applies/reverts edit proposals transactionally; present with a records dir. */
  private readonly patchTransactions: PatchTransactionService | undefined;
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
    this.sessions = options.sessions;
    this.workspace = options.workspace;
    this.updateStatus = options.updateStatus ?? getUpdateStatus;
    this.editProposals =
      options.workspace !== undefined ? new EditProposalService(options.workspace) : undefined;
    this.patchTransactions =
      options.workspace !== undefined &&
      this.editProposals !== undefined &&
      options.editRecordsDir !== undefined
        ? new PatchTransactionService(options.workspace, this.editProposals, {
            recordsDir: options.editRecordsDir,
          })
        : undefined;
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
      if (
        (rawPath.startsWith("/static/") || rawPath.startsWith("/vendor/")) &&
        (rawPath.includes("..") || rawPath.includes("\\"))
      ) {
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

      if (req.method === "GET" && pathname.startsWith("/vendor/")) {
        await this.serveVendor(res, pathname);
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

      if (req.method === "GET" && pathname === "/api/update") {
        this.writeJson(res, 200, await this.updateStatus());
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

      if (req.method === "POST" && pathname === "/api/chat/cancel") {
        const cancelled = this.runs.cancel();
        this.writeJson(res, 200, { cancelled });
        return;
      }

      if (req.method === "POST" && pathname === "/api/chat/tool-decision") {
        const body = await readJsonBody(req, MAX_REQUEST_BYTES);
        const parsed = TOOL_DECISION_SCHEMA.safeParse(body);
        if (!parsed.success) {
          throw new ValidationError("invalid tool decision");
        }
        const resolve = this.pendingApprovals.get(parsed.data.callId);
        if (resolve === undefined) {
          this.writeJson(res, 404, { error: "no pending tool call" });
          return;
        }
        this.pendingApprovals.delete(parsed.data.callId);
        resolve(parsed.data.decision);
        this.writeJson(res, 200, { ok: true });
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

      if (pathname === "/api/sessions" || pathname.startsWith("/api/sessions/")) {
        await this.handleSessions(req, res, url, pathname);
        return;
      }

      if (pathname === "/api/workspace" || pathname.startsWith("/api/workspace/")) {
        await this.handleWorkspace(req, res, url, pathname);
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
      if (error instanceof RunConflictError) {
        this.writeJson(res, 409, { error: stripControl(error.message), code: error.code });
        return;
      }
      if (error instanceof SessionConflictError) {
        this.writeJson(res, 409, { error: stripControl(error.message), code: error.code });
        return;
      }
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
    // Inject the per-launch token so the client can authorize workspace calls;
    // a rebinding/cross-origin page never loads this shell and so never sees it.
    const meta = `<meta name="llmup-token" content="${this.launchToken}" />`;
    const withToken = content.includes("</head>")
      ? content.replace("</head>", `  ${meta}\n  </head>`)
      : `${meta}\n${content}`;
    const contentSecurityPolicy = [
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "frame-src 'self'",
      "font-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join("; ");
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": contentSecurityPolicy,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    });
    res.end(withToken);
  }

  private async serveStatic(res: ServerResponse, pathname: string): Promise<void> {
    const entry = await readStaticAsset(this.rootDir, pathname);
    res.writeHead(200, { "Content-Type": entry.contentType });
    res.end(entry.content);
  }

  private async serveVendor(res: ServerResponse, pathname: string): Promise<void> {
    const entry = await readVendorAsset(pathname);
    res.writeHead(200, { "Content-Type": entry.contentType });
    res.end(entry.content);
  }

  private async handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJsonBody(req, MAX_REQUEST_BYTES);
    const request = parseGuiChatRequest(body);
    const requestModel = request.model ?? "demo-model";

    // Own run identity before opening the stream so a concurrent request gets a
    // typed 409 conflict instead of a half-written event stream.
    const run = this.runs.begin();
    const signal = run.controller.signal;
    // A premature client disconnect cancels the in-flight run; a normal end
    // fires close after the run already settled, so cancel is then a no-op.
    res.on("close", () => {
      this.runs.cancel(run.id);
    });

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    // Flush headers immediately so the client observes an open stream even while
    // the first provider token is still pending (and can cancel it).
    res.flushHeaders();

    // The newest user turn; prior turns come from canonical session state, not
    // from client-supplied history, so multi-turn context appears exactly once.
    const latest = request.messages.at(-1);
    const newUserContent = sanitizeGuiText(latest?.content ?? "");
    const priorTurns = this.session.conversationWindow.map((message) => ({
      role: message.role,
      content: sanitizeGuiText(message.content),
    }));

    try {
      const harnessName = request.harness ?? this.session.activeHarnessName;
      const harness = this.registry.get(harnessName);
      const runtimeMessages = [
        ...priorTurns,
        { role: "user" as const, content: newUserContent },
      ];

      // Re-read each attachment server-side so the manifest and the model input
      // are the same immutable, bounded snapshot; then surface the ledger.
      const context = this.resolveContext(request.attachments, request.contextSources);

      // Data boundary: workspace context bound for an external provider requires
      // a recorded disclosure decision for this session/provider/context set.
      if (
        context.manifest.length > 0 &&
        isCloudHarness(harnessName) &&
        !this.grantDisclosure(harnessName, context.manifest, request.disclosureAck === true)
      ) {
        const included = context.manifest.filter((item) => item.included);
        res.write(
          `data: ${JSON.stringify({
            type: "disclosure-required",
            provider: harnessName,
            model: requestModel,
            items: context.manifest,
            totalBytes: included.reduce((sum, item) => sum + item.size, 0),
            excludedCount: context.manifest.length - included.length,
          })}\n\n`,
        );
        // Nothing left the machine; close the run so the next request is free.
        this.runs.settle(run, "completed");
        return;
      }

      if (context.manifest.length > 0) {
        res.write(
          `data: ${JSON.stringify({ type: "context", attachments: context.manifest })}\n\n`,
        );
      }

      const systemMessages: { role: "system"; content: string }[] = [];
      // A user-authored per-chat system prompt takes precedence over the
      // agent/skill persona and is applied on every backend.
      if (request.systemPrompt !== undefined && request.systemPrompt.trim().length > 0) {
        systemMessages.push({
          role: "system",
          content: sanitizeGuiText(request.systemPrompt).slice(0, MAX_SYSTEM_PROMPT_CHARS),
        });
      }
      const systemPrompt = this.library?.composeForChat(request.agentId, request.skillIds);
      if (systemPrompt !== undefined && systemPrompt.trim().length > 0) {
        systemMessages.push({
          role: "system",
          content: sanitizeGuiText(systemPrompt).slice(0, MAX_SYSTEM_PROMPT_CHARS),
        });
      }
      if (context.text.length > 0) {
        systemMessages.push({ role: "system", content: context.text });
      }
      const composedMessages =
        systemMessages.length > 0 ? [...systemMessages, ...runtimeMessages] : runtimeMessages;

      const agentTools = this.mcpManager?.agentTools() ?? [];
      if (this.agentChat !== undefined && this.mcpManager !== undefined && agentTools.length > 0) {
        const mcpManager = this.mcpManager;
        let assistantText = "";
        const assistantSanitizer = new GuiTextStreamSanitizer();
        for await (const event of runAgentTurn({
          chat: this.agentChat,
          tools: agentTools,
          callTool: (name, args) => mcpManager.callTool(name, args),
          messages: composedMessages,
          signal,
          approver: this.createToolApprover(run),
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        })) {
          if (event.type === "tool") {
            res.write(`data: ${JSON.stringify(this.toToolFrame(event))}\n\n`);
          } else {
            const cleaned = assistantSanitizer.push(event.content);
            assistantText += cleaned;
            if (cleaned.length > 0) {
              res.write(`data: ${JSON.stringify({ type: "delta", content: cleaned })}\n\n`);
            }
          }
        }
        const tail = assistantSanitizer.flush();
        assistantText += tail;
        if (tail.length > 0) {
          res.write(`data: ${JSON.stringify({ type: "delta", content: tail })}\n\n`);
        }
        this.finishChat(res, run, newUserContent, assistantText, context.manifest);
        return;
      }

      const asyncChunks = this.sendChat !== undefined
        ? this.sendChat(
            {
              model: requestModel,
              harness: harnessName,
              messages: composedMessages,
              ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
            },
            signal,
          )
        : harness.chatSync({
            model: requestModel,
            messages: composedMessages,
            signal,
            ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
          }).then((content) => [content]);

      const chunks = await asyncChunks;
      const assistantSanitizer = new GuiTextStreamSanitizer();
      let assistantText = "";
      for (const chunk of chunks) {
        const cleaned = assistantSanitizer.push(chunk);
        assistantText += cleaned;
        if (cleaned.length > 0) {
          res.write(`data: ${JSON.stringify({ type: "delta", content: cleaned })}\n\n`);
        }
      }
      const tail = assistantSanitizer.flush();
      assistantText += tail;
      if (tail.length > 0) {
        res.write(`data: ${JSON.stringify({ type: "delta", content: tail })}\n\n`);
      }
      this.finishChat(res, run, newUserContent, assistantText, context.manifest);
    } catch (error) {
      // A cancellation aborts the provider call; report an error only when this
      // run is still the one that owns the stream.
      if (this.runs.settle(run, "failed")) {
        const message = error instanceof Error ? stripControl(error.message) : "unknown error";
        res.write(`data: ${JSON.stringify({ type: "error", message })}\n\n`);
      }
    } finally {
      this.denyPendingApprovals();
      res.end();
    }
  }

  /**
   * Resolve every attached context source into immutable, bounded blocks and an
   * auditable manifest. File `@` references are re-read server-side; pasted
   * terminal/diagnostic text is bounded and never executed; Git sources are
   * computed read-only. Blocks are included in order until the aggregate byte
   * budget is exhausted; anything past it is recorded `included: false` rather
   * than silently dropped, and a source that fails closed is simply omitted.
   */
  private resolveContext(
    refs: readonly WorkspaceAttachmentRef[] | undefined,
    sources: readonly ContextSourceRef[] | undefined,
  ): { text: string; manifest: AttachmentManifestEntry[] } {
    const manifest: AttachmentManifestEntry[] = [];
    const blocks: string[] = [];
    const budget = { used: 0 };

    const consider = (
      entry: Omit<AttachmentManifestEntry, "included">,
      content: string,
      blockLabel: string,
    ): void => {
      const included = budget.used + entry.size <= MAX_ATTACHMENT_CONTEXT_BYTES;
      manifest.push({ ...entry, included });
      if (included) {
        budget.used += entry.size;
        blocks.push(`--- ${blockLabel} ---\n${content}`);
      }
    };

    if (this.workspace !== undefined) {
      const workspace = this.workspace;
      for (const ref of refs ?? []) {
        let snapshot;
        try {
          const range =
            ref.startLine !== undefined && ref.endLine !== undefined
              ? { startLine: ref.startLine, endLine: ref.endLine }
              : undefined;
          snapshot = workspace.read(ref.workspaceId, ref.path, range);
        } catch {
          continue; // fail closed: a bad reference contributes no context
        }
        const label =
          snapshot.range !== undefined
            ? `${snapshot.path} (lines ${snapshot.range.startLine}-${snapshot.range.endLine})`
            : snapshot.path;
        consider(
          {
            kind: "file",
            label: snapshot.path,
            path: snapshot.path,
            hash: snapshot.hash,
            size: snapshot.size,
            truncated: snapshot.truncated,
            ...(snapshot.range !== undefined ? { range: snapshot.range } : {}),
          },
          snapshot.content,
          `FILE: ${label}`,
        );
      }
    }

    for (const source of sources ?? []) {
      if (source.kind === "terminal" || source.kind === "diagnostics") {
        const content = sanitizeGuiText(source.content);
        if (content.trim().length === 0) {
          continue;
        }
        const label =
          source.label !== undefined && source.label.trim().length > 0
            ? stripControl(source.label).slice(0, 120)
            : source.kind === "terminal"
              ? "Terminal output"
              : "Diagnostics";
        consider(
          {
            kind: source.kind,
            label,
            hash: this.hashText(content),
            size: Buffer.byteLength(content, "utf8"),
            truncated: false,
          },
          content,
          `${source.kind === "terminal" ? "TERMINAL" : "DIAGNOSTICS"}: ${label}`,
        );
      } else if (source.kind === "git" && this.workspace !== undefined) {
        let snapshot;
        try {
          snapshot = this.workspace.gitContext(source.workspaceId, source.mode);
        } catch {
          continue; // unknown workspace: fail closed
        }
        if (!snapshot.available || snapshot.content.trim().length === 0) {
          continue; // honest: nothing to attach
        }
        consider(
          {
            kind: "git",
            label: snapshot.label,
            hash: snapshot.hash,
            size: snapshot.size,
            truncated: snapshot.truncated,
          },
          snapshot.content,
          `GIT ${snapshot.mode.toUpperCase()}`,
        );
      }
    }

    const text =
      blocks.length > 0
        ? `The user attached the following read-only context. Use it to inform ` +
          `your answer; do not assume any other files or state.\n\n${blocks.join("\n\n")}`
        : "";
    return { text, manifest };
  }

  private hashText(content: string): string {
    return createHash("sha256").update(content).digest("hex");
  }

  /**
   * Return true when this context set may be sent to `provider`: either a
   * matching disclosure was already recorded for this session, or `ack` is true
   * (record it now). Return false when the user must first confirm. The key
   * binds provider and the exact context identities, so any change re-prompts.
   */
  private grantDisclosure(
    provider: string,
    manifest: readonly AttachmentManifestEntry[],
    ack: boolean,
  ): boolean {
    const fingerprint = manifest
      .map((item) => {
        const range = item.range ? `${item.range.startLine}-${item.range.endLine}` : "";
        return `${item.kind ?? "file"}|${item.label ?? item.path ?? ""}|${item.hash}|${range}`;
      })
      .sort()
      .join("\n");
    const key = `${provider}:${this.hashText(fingerprint)}`;
    if (this.session.disclosedContexts.has(key)) {
      return true;
    }
    if (ack) {
      this.session.disclosedContexts.add(key);
      return true;
    }
    return false;
  }

  /** Grant key for a tool call in the current session. */
  private toolGrantKeyFor(ctx: ToolCallContext): string {
    return toolGrantKey({
      connectorId: ctx.connectorId ?? "",
      name: ctx.name,
      ...(ctx.schema !== undefined ? { schema: ctx.schema } : {}),
    });
  }

  /**
   * Build the approval gate for one run: a prior session grant pre-approves an
   * exact tool, otherwise the decision is parked until the client POSTs one to
   * `/api/chat/tool-decision`. A stop/disconnect denies any parked call.
   */
  private createToolApprover(run: Run): ToolApprover {
    const signal = run.controller.signal;
    return {
      isPreApproved: (ctx) => this.session.toolGrants.has(this.toolGrantKeyFor(ctx)),
      requestDecision: (ctx, sig) =>
        new Promise<ToolDecision>((resolve) => {
          const settle = (decision: ToolDecision): void => {
            this.pendingApprovals.delete(ctx.callId);
            if (decision === "allow-session") {
              this.session.toolGrants.add(this.toolGrantKeyFor(ctx));
            }
            resolve(decision);
          };
          if (signal.aborted || sig?.aborted === true) {
            settle("deny");
            return;
          }
          const onAbort = (): void => settle("deny");
          signal.addEventListener("abort", onAbort, { once: true });
          this.pendingApprovals.set(ctx.callId, (decision) => {
            signal.removeEventListener("abort", onAbort);
            settle(decision);
          });
        }),
    };
  }

  /** Deny and clear any tool calls still awaiting a decision. */
  private denyPendingApprovals(): void {
    const resolvers = [...this.pendingApprovals.values()];
    this.pendingApprovals.clear();
    for (const resolve of resolvers) {
      resolve("deny");
    }
  }

  /** Serialize an agent tool event into a control-stripped SSE frame object. */
  private toToolFrame(event: Extract<AgentEvent, { type: "tool" }>): Record<string, unknown> {
    return {
      type: "tool",
      phase: event.phase,
      callId: event.callId,
      name: stripControl(event.name),
      ...(event.connector !== undefined ? { connector: stripControl(event.connector) } : {}),
      ...(event.risk !== undefined ? { risk: event.risk } : {}),
      ...(event.arguments !== undefined ? { arguments: event.arguments } : {}),
      ...(event.result !== undefined ? { result: stripControl(event.result) } : {}),
      ...(event.resultTruncated !== undefined ? { resultTruncated: event.resultTruncated } : {}),
      ...(event.isError !== undefined ? { isError: event.isError } : {}),
      ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
    };
  }

  /**
   * Settle a completed run: record the exchange in canonical session state and
   * emit the terminal `done` event. A cancelled run settles to `false`, so no
   * late assistant message is appended and no `done` is emitted.
   */
  private finishChat(
    res: ServerResponse,
    run: Run,
    userContent: string,
    assistantText: string,
    attachments: readonly AttachmentManifestEntry[] = [],
  ): void {
    if (!this.runs.settle(run, "completed")) {
      return;
    }
    const cleanedAssistant = sanitizeGuiText(assistantText);
    appendConversation(this.session, { role: "user", content: userContent });
    appendConversation(this.session, { role: "assistant", content: cleanedAssistant });
    if (this.sessions !== undefined) {
      // Durable mirror of the exchange; best-effort so a storage fault never
      // discards a reply the client already received.
      try {
        const sessionId = this.ensureActiveSession();
        this.sessions.append(sessionId, {
          role: "user",
          content: userContent,
          ...(attachments.length > 0 ? { attachments } : {}),
        });
        this.sessions.append(sessionId, { role: "assistant", content: cleanedAssistant });
      } catch {
        // The in-memory window still holds this turn for the current process.
      }
    }
    res.write(
      `data: ${JSON.stringify({ type: "done", turnsAppended: 1, factsExtracted: 0, vectorsEmbedded: 0 })}\n\n`,
    );
  }

  /** Ensure a durable active session exists, creating one lazily. */
  private ensureActiveSession(): string {
    const repo = this.requireSessions();
    if (this.activeSessionId !== null && repo.get(this.activeSessionId) !== undefined) {
      return this.activeSessionId;
    }
    const created = repo.create();
    this.activeSessionId = created.id;
    return created.id;
  }

  /** Point the in-memory conversation window at a persisted session. */
  private activateSession(id: string): void {
    const repo = this.requireSessions();
    const doc = repo.get(id);
    if (doc === undefined) {
      throw new ValidationError(`session not found: ${id}`);
    }
    this.activeSessionId = id;
    this.session.conversationWindow = doc.messages
      .filter((message) => message.role === "user" || message.role === "assistant")
      .slice(-20)
      .map((message) => ({ role: message.role as "user" | "assistant", content: message.content }));
    // Disclosure is per session; a new active session starts with no grants.
    this.session.disclosedContexts.clear();
    this.session.toolGrants.clear();
  }

  private requireSessions(): SessionRepository {
    if (this.sessions === undefined) {
      throw new ValidationError("session persistence is not available");
    }
    return this.sessions;
  }

  /**
   * Route persistent multi-session requests. Paths:
   *   GET    /api/sessions                list or (with ?q=) search sessions
   *   POST   /api/sessions                create a session and activate it
   *   GET    /api/sessions/:id            read a session summary
   *   PATCH  /api/sessions/:id            rename and/or archive
   *   DELETE /api/sessions/:id            delete a session
   *   GET    /api/sessions/:id/messages   paginated messages
   *   POST   /api/sessions/:id/activate   make it the active session
   */
  private async handleSessions(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    pathname: string,
  ): Promise<void> {
    const repo = this.sessions;
    if (repo === undefined) {
      this.writeJson(res, 404, { error: "session persistence is not available" });
      return;
    }

    if (pathname === "/api/sessions") {
      if (req.method === "GET") {
        const query = url.searchParams.get("q");
        const includeArchived = url.searchParams.get("archived") === "1";
        if (query !== null && query.trim().length > 0) {
          this.writeJson(res, 200, { results: repo.search(query, { includeArchived }) });
          return;
        }
        const page = repo.list({
          limit: parseSessionLimit(url.searchParams.get("limit")),
          cursor: url.searchParams.get("cursor") ?? undefined,
          includeArchived,
        });
        this.writeJson(res, 200, {
          sessions: page.sessions,
          nextCursor: page.nextCursor,
          activeSessionId: this.activeSessionId,
        });
        return;
      }
      if (req.method === "POST") {
        const body = await readJsonBody(req, MAX_REQUEST_BYTES);
        const parsed = SESSION_CREATE_SCHEMA.safeParse(body);
        if (!parsed.success) {
          throw new ValidationError("invalid session payload");
        }
        const summary = repo.create(parsed.data.title);
        this.activateSession(summary.id);
        this.writeJson(res, 201, { session: summary });
        return;
      }
      this.writeJson(res, 405, { error: "method not allowed" });
      return;
    }

    const rest = pathname.slice("/api/sessions/".length);
    const segments = rest.split("/").filter((segment) => segment.length > 0);
    const id = segments[0] !== undefined ? decodeURIComponent(segments[0]) : "";
    if (id.length === 0 || segments.length > 2) {
      this.writeJson(res, 404, { error: "not found" });
      return;
    }
    const sub = segments[1];

    if (sub === undefined) {
      if (req.method === "GET") {
        const doc = repo.get(id);
        if (doc === undefined) {
          this.writeJson(res, 404, { error: "not found" });
          return;
        }
        this.writeJson(res, 200, {
          session: {
            id: doc.id,
            title: doc.title,
            createdAt: doc.createdAt,
            updatedAt: doc.updatedAt,
            revision: doc.revision,
            archived: doc.archived,
            messageCount: doc.messages.length,
          },
        });
        return;
      }
      if (req.method === "PATCH") {
        const body = await readJsonBody(req, MAX_REQUEST_BYTES);
        const patch = parseSessionPatch(body);
        if (patch.title === undefined && patch.archived === undefined) {
          this.writeJson(res, 400, { error: "no changes provided" });
          return;
        }
        let summary = null;
        if (patch.title !== undefined) {
          summary = repo.rename(id, patch.title, patchRevision(patch));
        }
        if (patch.archived !== undefined) {
          summary = repo.setArchived(id, patch.archived);
        }
        this.writeJson(res, 200, { session: summary });
        return;
      }
      if (req.method === "DELETE") {
        repo.remove(id);
        if (this.activeSessionId === id) {
          this.activeSessionId = null;
          this.session.conversationWindow = [];
        }
        this.writeJson(res, 200, { removed: id });
        return;
      }
      this.writeJson(res, 405, { error: "method not allowed" });
      return;
    }

    if (sub === "messages" && req.method === "GET") {
      const page = repo.readMessages(id, {
        limit: parseSessionLimit(url.searchParams.get("limit")),
        cursor: url.searchParams.get("cursor") ?? undefined,
      });
      this.writeJson(res, 200, { messages: page.messages, nextCursor: page.nextCursor });
      return;
    }

    if (sub === "activate" && req.method === "POST") {
      this.activateSession(id);
      this.writeJson(res, 200, { activeSessionId: id });
      return;
    }

    this.writeJson(res, 404, { error: "not found" });
  }

  /** True when the request carries the exact per-launch capability token. */
  private hasLaunchToken(req: IncomingMessage): boolean {
    const header = req.headers["x-llmup-token"];
    const value = Array.isArray(header) ? header[0] : header;
    return value === this.launchToken;
  }

  /** True when the request Origin is exactly this loopback server. */
  private hasSameOrigin(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    return origin === `http://127.0.0.1:${this.port}`;
  }

  /**
   * Route read-only workspace requests behind the launch token. Paths:
   *   GET  /api/workspace/status            active root (if any)
  *   POST /api/workspace/root              register + activate a root (Origin-checked)
  *   POST /api/workspace/root/create       create + activate a root (Origin-checked)
   *   POST /api/workspace/root/revoke       revoke a root (Origin-checked)
   *   GET  /api/workspace/tree?id=&path=    list one directory level
   *   GET  /api/workspace/file?id=&path=&startLine=&endLine=  read a bounded snapshot
   */
  private async handleWorkspace(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    pathname: string,
  ): Promise<void> {
    const workspace = this.workspace;
    if (workspace === undefined) {
      this.writeJson(res, 404, { error: "workspace access is not available" });
      return;
    }
    // The token blocks DNS-rebinding and cross-origin callers on every route.
    if (!this.hasLaunchToken(req)) {
      this.writeJson(res, 403, { error: "missing or invalid capability token" });
      return;
    }

    if (pathname === "/api/workspace/status") {
      const active =
        this.activeWorkspaceId !== null && workspace.has(this.activeWorkspaceId)
          ? this.activeWorkspaceId
          : null;
      this.writeJson(res, 200, { rootId: active });
      return;
    }

    if (pathname === "/api/workspace/root") {
      if (req.method !== "POST") {
        this.writeJson(res, 405, { error: "method not allowed" });
        return;
      }
      if (!this.hasSameOrigin(req)) {
        this.writeJson(res, 403, { error: "cross-origin request refused" });
        return;
      }
      const body = await readJsonBody(req, MAX_REQUEST_BYTES);
      const parsed = WORKSPACE_ROOT_SCHEMA.safeParse(body);
      if (!parsed.success) {
        throw new ValidationError("invalid workspace path");
      }
      const root = workspace.registerRoot(parsed.data.path);
      this.activeWorkspaceId = root.id;
      this.writeJson(res, 201, { root });
      return;
    }

    if (pathname === "/api/workspace/root/create") {
      if (req.method !== "POST") {
        this.writeJson(res, 405, { error: "method not allowed" });
        return;
      }
      if (!this.hasSameOrigin(req)) {
        this.writeJson(res, 403, { error: "cross-origin request refused" });
        return;
      }
      const body = await readJsonBody(req, MAX_REQUEST_BYTES);
      const parsed = WORKSPACE_ROOT_SCHEMA.safeParse(body);
      if (!parsed.success) {
        throw new ValidationError("invalid workspace path");
      }
      const root = workspace.createRoot(parsed.data.path);
      this.activeWorkspaceId = root.id;
      this.writeJson(res, 201, { root });
      return;
    }

    if (pathname === "/api/workspace/root/revoke") {
      if (req.method !== "POST") {
        this.writeJson(res, 405, { error: "method not allowed" });
        return;
      }
      if (!this.hasSameOrigin(req)) {
        this.writeJson(res, 403, { error: "cross-origin request refused" });
        return;
      }
      const body = await readJsonBody(req, MAX_REQUEST_BYTES);
      const parsed = WORKSPACE_REVOKE_SCHEMA.safeParse(body);
      if (!parsed.success) {
        throw new ValidationError("invalid workspace id");
      }
      workspace.revoke(parsed.data.id);
      if (this.activeWorkspaceId === parsed.data.id) {
        this.activeWorkspaceId = null;
      }
      this.writeJson(res, 200, { revoked: parsed.data.id });
      return;
    }

    if (pathname === "/api/workspace/tree" && req.method === "GET") {
      const id = url.searchParams.get("id") ?? "";
      const tree = workspace.tree(id, url.searchParams.get("path") ?? "");
      this.writeJson(res, 200, tree);
      return;
    }

    if (pathname === "/api/workspace/search" && req.method === "GET") {
      const id = url.searchParams.get("id") ?? "";
      const limitRaw = url.searchParams.get("limit");
      const page = workspace.search(id, url.searchParams.get("q") ?? "", {
        limit: limitRaw !== null ? Number(limitRaw) : undefined,
        cursor: url.searchParams.get("cursor") ?? undefined,
      });
      this.writeJson(res, 200, { ...page });
      return;
    }

    if (pathname === "/api/workspace/file" && req.method === "GET") {
      const id = url.searchParams.get("id") ?? "";
      const range = parseLineRange(
        url.searchParams.get("startLine"),
        url.searchParams.get("endLine"),
      );
      const snapshot = workspace.read(id, url.searchParams.get("path") ?? "", range);
      this.writeJson(res, 200, { snapshot });
      return;
    }

    if (pathname === "/api/workspace/git" && req.method === "GET") {
      const id = url.searchParams.get("id") ?? "";
      const mode = url.searchParams.get("mode") === "diff" ? "diff" : "status";
      const snapshot = workspace.gitContext(id, mode);
      this.writeJson(res, 200, { snapshot });
      return;
    }

    if (pathname === "/api/workspace/edits/review" && req.method === "POST") {
      if (!this.hasSameOrigin(req)) {
        this.writeJson(res, 403, { error: "cross-origin request refused" });
        return;
      }
      const body = await readJsonBody(req, MAX_EDIT_REQUEST_BYTES);
      const review = (this.editProposals ?? new EditProposalService(workspace)).review(body);
      this.writeJson(res, 200, { review });
      return;
    }

    if (pathname === "/api/workspace/edits/apply" && req.method === "POST") {
      if (this.patchTransactions === undefined) {
        this.writeJson(res, 404, { error: "edit apply is not available" });
        return;
      }
      if (!this.hasSameOrigin(req)) {
        this.writeJson(res, 403, { error: "cross-origin request refused" });
        return;
      }
      const body = await readJsonBody(req, MAX_EDIT_REQUEST_BYTES);
      const result = this.patchTransactions.apply(body);
      this.writeJson(res, 200, { result });
      return;
    }

    if (pathname === "/api/workspace/edits/revert" && req.method === "POST") {
      if (this.patchTransactions === undefined) {
        this.writeJson(res, 404, { error: "edit revert is not available" });
        return;
      }
      if (!this.hasSameOrigin(req)) {
        this.writeJson(res, 403, { error: "cross-origin request refused" });
        return;
      }
      const body = await readJsonBody(req, MAX_REQUEST_BYTES);
      const result = this.patchTransactions.revert(body);
      this.writeJson(res, 200, { result });
      return;
    }

    this.writeJson(res, 404, { error: "not found" });
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
