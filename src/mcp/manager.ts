/**
 * Orchestrates MCP connectors for the GUI: it owns the persisted definitions
 * (via the store) and the live connections (via the client factory), and
 * exposes a small, UI-facing surface. Runtime status (connected tools, errors)
 * is held in memory and never persisted — only the definitions are durable.
 */
import { stripControl } from "../sanitize.js";
import { loadConfig, type Config } from "../config.js";
import { ValidationError } from "../errors.js";
import { loadConnectors, saveConnectors } from "./store.js";
import {
  CONNECTORS_SCHEMA_VERSION,
  parseAddConnectorRequest,
  parseConnectorsFile,
  type ConnectorsFile,
  type McpConnector,
} from "./schema.js";
import {
  createSdkClientFactory,
  type McpClientFactory,
  type McpConnection,
  type McpToolInfo,
  type McpToolResult,
} from "./client.js";

/** The lifecycle state of a single connector's live connection. */
export type ConnectorStatus = "disconnected" | "connecting" | "connected" | "error";

/**
 * A tool advertised by a connected connector, aggregated for the chat agent.
 * Carries the JSON Schema so the model can be told how to call it, plus the
 * owning connector id so results can be routed back to the right connection.
 */
export interface AgentTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema?: Record<string, unknown> | undefined;
  readonly connectorId: string;
}

/** A UI-facing view of one connector: its definition plus runtime status. */
export interface ConnectorView {
  readonly id: string;
  readonly name: string;
  readonly transport: "stdio" | "http";
  /** Human-readable target: the command for stdio, the URL for http. */
  readonly target: string;
  readonly status: ConnectorStatus;
  readonly tools: readonly McpToolInfo[];
  readonly error?: string;
}

/** The connector-management surface the GUI server depends on. */
export interface McpManager {
  /** All configured connectors with their current runtime status. */
  list(): readonly ConnectorView[];
  /** Add a connector from a validated GUI request; persists and returns it. */
  add(request: unknown): Promise<ConnectorView>;
  /** The raw persisted document (definitions only) for direct JSON editing. */
  snapshot(): ConnectorsFile;
  /**
   * Replace ALL connector definitions from a full document. Live connections
   * whose definition is unchanged are preserved; changed or removed ones are
   * disconnected first. Persists and returns the new list.
   */
  replaceAll(request: unknown): Promise<readonly ConnectorView[]>;
  /** Remove a connector by id, disconnecting it first if connected. */
  remove(id: string): Promise<void>;
  /** Connect to a connector and discover its tools. */
  connect(id: string): Promise<ConnectorView>;
  /** Disconnect a connector, leaving its definition in place. */
  disconnect(id: string): Promise<ConnectorView>;
  /** Every tool advertised by currently connected connectors, for the chat agent. */
  agentTools(): readonly AgentTool[];
  /** Invoke a tool by name on the connected connector that advertises it. */
  callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult>;
  /** Close every live connection (called on shutdown). */
  shutdown(): Promise<void>;
}

interface RuntimeEntry {
  status: ConnectorStatus;
  tools: readonly McpToolInfo[];
  connection: McpConnection | null;
  error?: string;
}

/** Injectable dependencies so the manager is testable with fakes. */
export interface McpManagerDeps {
  readonly config: Config;
  readonly factory: McpClientFactory;
  readonly load: (config: Config) => ReturnType<typeof loadConnectors>;
  readonly save: (config: Config, file: ReturnType<typeof loadConnectors>) => void;
}

function targetOf(connector: McpConnector): string {
  return connector.transport === "stdio"
    ? [connector.command, ...connector.args].join(" ")
    : connector.url;
}

function sameEnv(a?: Record<string, string>, b?: Record<string, string>): boolean {
  const aKeys = a !== undefined ? Object.keys(a).sort() : [];
  const bKeys = b !== undefined ? Object.keys(b).sort() : [];
  if (aKeys.length !== bKeys.length) {
    return false;
  }
  return aKeys.every((key, index) => key === bKeys[index] && a?.[key] === b?.[key]);
}

/** True when two connector definitions are field-for-field identical. */
function sameConnector(a: McpConnector, b: McpConnector): boolean {
  if (a.transport !== b.transport || a.name !== b.name) {
    return false;
  }
  if (a.transport === "stdio" && b.transport === "stdio") {
    return (
      a.command === b.command &&
      a.args.length === b.args.length &&
      a.args.every((value, index) => value === b.args[index]) &&
      sameEnv(a.env, b.env)
    );
  }
  if (a.transport === "http" && b.transport === "http") {
    return a.url === b.url;
  }
  return false;
}

function viewOf(connector: McpConnector, runtime: RuntimeEntry): ConnectorView {
  const base: ConnectorView = {
    id: connector.id,
    name: connector.name,
    transport: connector.transport,
    target: targetOf(connector),
    status: runtime.status,
    // Strip inputSchema from the UI payload: the browser only shows name +
    // description, and schemas can be large. The schema is retained on the
    // runtime entry for the chat agent (see agentTools).
    tools: runtime.tools.map((tool) => ({ name: tool.name, description: tool.description })),
  };
  return runtime.error !== undefined ? { ...base, error: runtime.error } : base;
}

/** Build an MCP manager over explicit dependencies. */
export function createMcpManager(deps: McpManagerDeps): McpManager {
  const connectors = new Map<string, McpConnector>();
  const runtime = new Map<string, RuntimeEntry>();

  for (const connector of deps.load(deps.config).connectors) {
    connectors.set(connector.id, connector);
    runtime.set(connector.id, { status: "disconnected", tools: [], connection: null });
  }

  function runtimeFor(id: string): RuntimeEntry {
    const entry = runtime.get(id);
    if (entry === undefined) {
      throw new ValidationError(`unknown connector: ${id}`);
    }
    return entry;
  }

  function connectorFor(id: string): McpConnector {
    const connector = connectors.get(id);
    if (connector === undefined) {
      throw new ValidationError(`unknown connector: ${id}`);
    }
    return connector;
  }

  function persist(): void {
    deps.save(deps.config, {
      schemaVersion: 1,
      connectors: [...connectors.values()],
    });
  }

  return {
    list(): readonly ConnectorView[] {
      return [...connectors.values()].map((connector) => viewOf(connector, runtimeFor(connector.id)));
    },

    async add(request: unknown): Promise<ConnectorView> {
      const connector = parseAddConnectorRequest(request, [...connectors.keys()]);
      connectors.set(connector.id, connector);
      const entry: RuntimeEntry = { status: "disconnected", tools: [], connection: null };
      runtime.set(connector.id, entry);
      persist();
      return viewOf(connector, entry);
    },

    snapshot(): ConnectorsFile {
      return {
        schemaVersion: CONNECTORS_SCHEMA_VERSION,
        connectors: [...connectors.values()],
      };
    },

    async replaceAll(request: unknown): Promise<readonly ConnectorView[]> {
      const file = parseConnectorsFile(request);
      const next = new Map<string, McpConnector>();
      for (const connector of file.connectors) {
        next.set(connector.id, connector);
      }

      // Close live connections for connectors that were removed or changed.
      for (const [id, entry] of runtime) {
        const prevDef = connectors.get(id);
        const nextDef = next.get(id);
        const unchanged =
          prevDef !== undefined && nextDef !== undefined && sameConnector(prevDef, nextDef);
        if (!unchanged && entry.connection !== null) {
          try {
            await entry.connection.close();
          } catch {
            // Best-effort: the definition is being replaced regardless.
          }
          entry.connection = null;
        }
      }

      // Rebuild both maps, preserving live runtime state for unchanged entries.
      const nextRuntime = new Map<string, RuntimeEntry>();
      for (const [id, def] of next) {
        const prevDef = connectors.get(id);
        const prevEntry = runtime.get(id);
        if (
          prevDef !== undefined &&
          prevEntry !== undefined &&
          prevEntry.connection !== null &&
          sameConnector(prevDef, def)
        ) {
          nextRuntime.set(id, prevEntry);
        } else {
          nextRuntime.set(id, { status: "disconnected", tools: [], connection: null });
        }
      }

      connectors.clear();
      for (const [id, def] of next) {
        connectors.set(id, def);
      }
      runtime.clear();
      for (const [id, entry] of nextRuntime) {
        runtime.set(id, entry);
      }

      persist();
      return [...connectors.values()].map((connector) => viewOf(connector, runtimeFor(connector.id)));
    },

    async remove(id: string): Promise<void> {
      const entry = runtimeFor(id);
      if (entry.connection !== null) {
        try {
          await entry.connection.close();
        } catch {
          // Best-effort: we are discarding this connector regardless.
        }
      }
      connectors.delete(id);
      runtime.delete(id);
      persist();
    },

    async connect(id: string): Promise<ConnectorView> {
      const connector = connectorFor(id);
      const entry = runtimeFor(id);

      if (entry.connection !== null) {
        try {
          await entry.connection.close();
        } catch {
          // Ignore: we are about to replace this connection.
        }
        entry.connection = null;
      }

      entry.status = "connecting";
      delete entry.error;
      try {
        const connection = await deps.factory.connect(connector);
        const tools = await connection.listTools();
        entry.connection = connection;
        entry.tools = tools.map((tool) => ({
          name: stripControl(tool.name),
          description: stripControl(tool.description),
          ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
        }));
        entry.status = "connected";
      } catch (error) {
        entry.connection = null;
        entry.tools = [];
        entry.status = "error";
        entry.error = stripControl(error instanceof Error ? error.message : "connection failed");
      }
      return viewOf(connector, entry);
    },

    async disconnect(id: string): Promise<ConnectorView> {
      const connector = connectorFor(id);
      const entry = runtimeFor(id);
      if (entry.connection !== null) {
        try {
          await entry.connection.close();
        } catch {
          // Best-effort close; the definition survives regardless.
        }
        entry.connection = null;
      }
      entry.status = "disconnected";
      entry.tools = [];
      delete entry.error;
      return viewOf(connector, entry);
    },

    agentTools(): readonly AgentTool[] {
      const seen = new Set<string>();
      const tools: AgentTool[] = [];
      for (const [id, entry] of runtime) {
        if (entry.status !== "connected" || entry.connection === null) {
          continue;
        }
        for (const tool of entry.tools) {
          // First connected connector to advertise a name wins; later duplicates
          // are skipped so a tool name always routes to a single connection.
          if (seen.has(tool.name)) {
            continue;
          }
          seen.add(tool.name);
          tools.push({
            name: tool.name,
            description: tool.description,
            ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
            connectorId: id,
          });
        }
      }
      return tools;
    },

    async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
      for (const entry of runtime.values()) {
        if (entry.status !== "connected" || entry.connection === null) {
          continue;
        }
        if (entry.tools.some((tool) => tool.name === name)) {
          return entry.connection.callTool(name, args);
        }
      }
      throw new ValidationError(`no connected connector advertises tool: ${name}`);
    },

    async shutdown(): Promise<void> {
      await Promise.all(
        [...runtime.values()].map(async (entry) => {
          if (entry.connection !== null) {
            try {
              await entry.connection.close();
            } catch {
              // Best-effort shutdown.
            }
            entry.connection = null;
          }
        }),
      );
    },
  };
}

/** Build the default SDK-backed MCP manager rooted at the user's config dir. */
export function createDefaultMcpManager(config: Config = loadConfig()): McpManager {
  return createMcpManager({
    config,
    factory: createSdkClientFactory(),
    load: loadConnectors,
    save: saveConnectors,
  });
}
