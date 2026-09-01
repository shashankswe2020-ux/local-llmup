/**
 * Boot the REAL loopback GuiServer with production default managers plus
 * deterministic fakes for the model and MCP tools (task 32.13). No cloud APIs
 * and no real inference runtime are contacted. Playwright launches this via
 * `webServer` and drives the actual static client over 127.0.0.1.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_HOME_DIR, E2E_PORT, E2E_WORKSPACE_DIR } from "./fixtures.js";

// Isolate all config-derived state (sessions, library, edits) under a temp home
// before any manager reads config.
process.env.LOCAL_LLMUP_HOME = E2E_HOME_DIR;

import { GuiServer } from "../../src/gui/server.js";
import { WorkspaceService } from "../../src/gui/workspace/service.js";
import { SessionRepository } from "../../src/gui/session-repository.js";
import { loadConfig } from "../../src/config.js";
import { createDefaultModelManager } from "../../src/gui/management.js";
import { createRuntimeController } from "../../src/gui/runtime.js";
import { createDefaultRegistry as createDefaultBackendRegistry } from "../../src/backend/registry.js";
import { createDefaultHardwareProvider } from "../../src/gui/hardware.js";
import { createLibraryService } from "../../src/library/service.js";
import type { AgentChat } from "../../src/gui/agent.js";
import type { AgentTool, ConnectorView, ConnectorsFile, McpManager } from "../../src/mcp/manager.js";
import type { McpToolResult } from "../../src/mcp/client.js";
import {
  FORMATTING_RESPONSE,
  FORMATTING_INCOMPLETE_RESPONSE,
  FORMATTING_INCOMPLETE_TRIGGER,
  FORMATTING_SCROLL_RESPONSE,
  FORMATTING_SCROLL_TRIGGER,
  FORMATTING_STREAM_TRIGGER,
  FORMATTING_TRIGGER,
} from "../fixtures/chat-formatting.js";

function resetDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

resetDir(E2E_HOME_DIR);
resetDir(E2E_WORKSPACE_DIR);
mkdirSync(join(E2E_WORKSPACE_DIR, "src"), { recursive: true });
writeFileSync(join(E2E_WORKSPACE_DIR, "src", "app.ts"), "export const answer = 42;\nconsole.log(answer);\n");
writeFileSync(join(E2E_WORKSPACE_DIR, "README.md"), "# demo workspace\n");

const TOOL: AgentTool = {
  name: "demo_tool",
  description: "read demo data",
  inputSchema: { type: "object", properties: { q: { type: "string" } } },
  connectorId: "demo",
};

function fakeMcpManager(): McpManager {
  const view: ConnectorView = {
    id: "demo",
    name: "demo",
    transport: "stdio",
    target: "demo server",
    status: "connected",
    tools: [{ name: TOOL.name, description: TOOL.description }],
  };
  const file: ConnectorsFile = { schemaVersion: 1, connectors: [] };
  const asView = async (): Promise<ConnectorView> => view;
  return {
    list: () => [view],
    add: asView,
    snapshot: () => file,
    replaceAll: async () => [view],
    remove: async () => undefined,
    connect: asView,
    disconnect: asView,
    agentTools: () => [TOOL],
    callTool: async (): Promise<McpToolResult> => ({ content: "demo tool result", isError: false }),
    shutdown: async () => undefined,
  };
}

// Deterministic model: echoes; "SLOW" delays (cancellable); "TOOL" calls a tool.
const agentChat: AgentChat = ({ messages, onToken, signal }) => {
  const last = messages[messages.length - 1];
  if (last?.role === "tool") {
    return Promise.resolve({ content: "Tool finished. Done." });
  }
  const text = last?.role === "user" ? last.content : "";
  if (text.includes("SLOW")) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({ content: "Slow reply done." }), 8000);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      });
    });
  }
  if (text.includes("TOOL")) {
    return Promise.resolve({ content: "", toolCalls: [{ name: "demo_tool", arguments: { q: "hi" } }] });
  }
  if (text === FORMATTING_TRIGGER) {
    return Promise.resolve({ content: FORMATTING_RESPONSE });
  }
  if (text === FORMATTING_STREAM_TRIGGER) {
    const cuts = [1, 2, 5, 9, 17, 31, 63, 127, 255, 511, 1023];
    let offset = 0;
    for (const length of cuts) {
      onToken?.(FORMATTING_RESPONSE.slice(offset, offset + length));
      offset += length;
    }
    while (offset < FORMATTING_RESPONSE.length) {
      onToken?.(FORMATTING_RESPONSE.slice(offset, offset + 37));
      offset += 37;
    }
    return Promise.resolve({ content: FORMATTING_RESPONSE });
  }
  if (text === FORMATTING_SCROLL_TRIGGER) {
    return (async () => {
      for (let offset = 0; offset < FORMATTING_SCROLL_RESPONSE.length; offset += 80) {
        onToken?.(FORMATTING_SCROLL_RESPONSE.slice(offset, offset + 80));
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return { content: FORMATTING_SCROLL_RESPONSE };
    })();
  }
  if (text === FORMATTING_INCOMPLETE_TRIGGER) {
    return (async () => {
      const split = FORMATTING_INCOMPLETE_RESPONSE.indexOf(" value");
      onToken?.(FORMATTING_INCOMPLETE_RESPONSE.slice(0, split));
      await new Promise((resolve) => setTimeout(resolve, 1500));
      onToken?.(FORMATTING_INCOMPLETE_RESPONSE.slice(split));
      return { content: FORMATTING_INCOMPLETE_RESPONSE };
    })();
  }
  return Promise.resolve({ content: `You said: ${text}` });
};

const config = loadConfig();
mkdirSync(config.artifactsDir, { recursive: true });
writeFileSync(
  join(config.artifactsDir, "formatting.png"),
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
);
const server = new GuiServer({
  rootDir: new URL("../../src/gui/static", import.meta.url),
  workspace: new WorkspaceService(),
  sessions: new SessionRepository(config),
  editRecordsDir: join(config.homeDir, "gui-edits"),
  modelManager: createDefaultModelManager(),
  runtimeController: createRuntimeController(createDefaultBackendRegistry()),
  hardwareProvider: createDefaultHardwareProvider(),
  library: createLibraryService(),
  artifactsDir: config.artifactsDir,
  mcpManager: fakeMcpManager(),
  agentChat,
});

await server.start(E2E_PORT);
process.stdout.write(`e2e server listening on ${server.url}\n`);
