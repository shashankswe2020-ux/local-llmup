/**
 * Thin adapter over the `@modelcontextprotocol/sdk` client. All direct SDK
 * usage lives here behind {@link McpClientFactory} / {@link McpConnection}, so
 * the manager (and its tests) depend only on the interface and never spawn a
 * real MCP server. Swapping the SDK or a transport only touches this file.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { assertLoopbackMcpUrl, type McpConnector } from "./schema.js";

/** Our own client identity announced to MCP servers during the handshake. */
const CLIENT_INFO = { name: "local-llmup", version: "0.9.1" } as const;

/** A discovered tool exposed by a connected MCP server. */
export interface McpToolInfo {
  readonly name: string;
  readonly description: string;
  /** JSON Schema for the tool's arguments, advertised to the model verbatim. */
  readonly inputSchema?: Record<string, unknown> | undefined;
}

/** The outcome of invoking a tool: its flattened text content and error flag. */
export interface McpToolResult {
  /** Concatenated text blocks returned by the tool. */
  readonly content: string;
  /** True when the server marked the result as an error. */
  readonly isError: boolean;
}

/** A live connection to one MCP server. */
export interface McpConnection {
  /** List the tools the server advertises. */
  listTools(): Promise<readonly McpToolInfo[]>;
  /** Invoke a tool by name with JSON arguments and return its text result. */
  callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult>;
  /** Close the connection and release the transport. */
  close(): Promise<void>;
}

/** Opens live connections from validated connector definitions. */
export interface McpClientFactory {
  connect(connector: McpConnector): Promise<McpConnection>;
}

function buildTransport(connector: McpConnector): Transport {
  if (connector.transport === "stdio") {
    // Args are passed as an array (no shell), so there is no shell-injection
    // surface. Inherit only PATH-relevant env plus the connector's explicit env.
    return new StdioClientTransport({
      command: connector.command,
      args: [...connector.args],
      ...(connector.env !== undefined ? { env: { ...connector.env } } : {}),
    });
  }

  // Re-assert loopback at connect time: the stored value was validated on write,
  // but this is the last line of defence before a socket is opened.
  const url = new URL(assertLoopbackMcpUrl(connector.url));
  // Prefer Streamable HTTP as the modern transport; SSE is the legacy fallback.
  // The `as Transport` narrows the SDK's concrete class, whose `sessionId` is
  // typed `string | undefined`, to the interface's optional `sessionId?`.
  return new StreamableHTTPClientTransport(url) as Transport;
}

function buildSseTransport(connector: McpConnector & { transport: "http" }): Transport {
  const url = new URL(assertLoopbackMcpUrl(connector.url));
  return new SSEClientTransport(url) as Transport;
}

/** Build the real SDK-backed client factory. */
export function createSdkClientFactory(): McpClientFactory {
  return {
    async connect(connector: McpConnector): Promise<McpConnection> {
      const client = new Client(CLIENT_INFO, { capabilities: {} });

      if (connector.transport === "http") {
        // Try Streamable HTTP first; if the server only speaks legacy SSE, retry.
        try {
          await client.connect(buildTransport(connector));
        } catch {
          await client.connect(buildSseTransport(connector));
        }
      } else {
        await client.connect(buildTransport(connector));
      }

      return {
        async listTools(): Promise<readonly McpToolInfo[]> {
          const result = await client.listTools();
          return result.tools.map((tool) => ({
            name: tool.name,
            description: typeof tool.description === "string" ? tool.description : "",
            ...(tool.inputSchema !== undefined && tool.inputSchema !== null
              ? { inputSchema: tool.inputSchema as Record<string, unknown> }
              : {}),
          }));
        },
        async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
          const result = await client.callTool({ name, arguments: args });
          const blocks = Array.isArray(result.content) ? result.content : [];
          const text = blocks
            .filter(
              (block): block is { type: "text"; text: string } =>
                typeof block === "object" &&
                block !== null &&
                (block as { type?: unknown }).type === "text" &&
                typeof (block as { text?: unknown }).text === "string",
            )
            .map((block) => block.text)
            .join("\n");
          return { content: text, isError: result.isError === true };
        },
        async close(): Promise<void> {
          await client.close();
        },
      };
    },
  };
}
