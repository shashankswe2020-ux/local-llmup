/**
 * Zod schemas and types for MCP connector definitions. A connector describes
 * how to reach one Model Context Protocol server, either by spawning a local
 * process (`stdio`) or connecting to a loopback HTTP/SSE endpoint (`http`).
 *
 * All external input (the persisted `connectors.json` file and the GUI
 * "add connector" request) is validated here and nowhere else, so the rest of
 * the MCP module can trust its inputs.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ValidationError } from "../errors.js";

/** Bumped when the on-disk connectors layout changes incompatibly. */
export const CONNECTORS_SCHEMA_VERSION = 1 as const;

/** Upper bound on how many connectors a single workspace may define. */
export const MAX_CONNECTORS = 32;

/** Upper bound on stdio argument / env entries, to bound spawn surface. */
const MAX_ARGS = 64;
const MAX_ENV_ENTRIES = 64;

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Validate that a URL targets loopback over HTTP(S) with no embedded
 * credentials. MCP servers reached over the network are never permitted: the
 * transport is unauthenticated from our side, so we refuse anything that could
 * leave the local machine.
 */
export function assertLoopbackMcpUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (cause) {
    throw new ValidationError(`invalid connector URL: ${raw}`, { cause });
  }
  const host = url.hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  const loopback =
    host === "localhost" || host === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
  const httpScheme = url.protocol === "http:" || url.protocol === "https:";
  if (!httpScheme || url.username !== "" || url.password !== "" || !loopback) {
    throw new ValidationError(`refusing non-loopback connector URL: ${raw}`);
  }
  return url.toString();
}

const StdioConnectorSchema = z
  .object({
    id: z.string().regex(ID_PATTERN),
    name: z.string().trim().min(1).max(120),
    transport: z.literal("stdio"),
    command: z.string().trim().min(1).max(512),
    args: z.array(z.string().max(512)).max(MAX_ARGS).default([]),
    env: z.record(z.string().max(256), z.string().max(4096)).refine(
      (env) => Object.keys(env).length <= MAX_ENV_ENTRIES,
      { message: `at most ${MAX_ENV_ENTRIES} env entries` },
    ).optional(),
  })
  .strict();

const HttpConnectorSchema = z
  .object({
    id: z.string().regex(ID_PATTERN),
    name: z.string().trim().min(1).max(120),
    transport: z.literal("http"),
    url: z
      .string()
      .trim()
      .min(1)
      .max(2048)
      .refine((value) => {
        try {
          assertLoopbackMcpUrl(value);
          return true;
        } catch {
          return false;
        }
      }, { message: "url must be a loopback http(s) endpoint" }),
  })
  .strict();

/** A single validated MCP connector definition. */
export const McpConnectorSchema = z.discriminatedUnion("transport", [
  StdioConnectorSchema,
  HttpConnectorSchema,
]);

/** The persisted connectors document (`connectors.json`). */
export const ConnectorsFileSchema = z
  .object({
    schemaVersion: z.literal(CONNECTORS_SCHEMA_VERSION),
    connectors: z.array(McpConnectorSchema).max(MAX_CONNECTORS),
  })
  .strict()
  .superRefine((file, ctx) => {
    const seen = new Set<string>();
    for (const [index, connector] of file.connectors.entries()) {
      if (seen.has(connector.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["connectors", index, "id"],
          message: `duplicate connector id: ${connector.id}`,
        });
      }
      seen.add(connector.id);
    }
  });

/** A validated MCP connector definition. */
export type McpConnector = z.infer<typeof McpConnectorSchema>;

/** A validated connectors document. */
export type ConnectorsFile = z.infer<typeof ConnectorsFileSchema>;

/** An empty connectors document (no connectors configured). */
export function emptyConnectorsFile(): ConnectorsFile {
  return { schemaVersion: CONNECTORS_SCHEMA_VERSION, connectors: [] };
}

/**
 * Parse and validate a full connectors document supplied by the GUI's direct
 * JSON editor. Every connector is re-validated (ids, transports, loopback
 * URLs) and http URLs are canonicalized, so a hand-edited document is held to
 * exactly the same rules as the "add connector" form. Throws
 * {@link ValidationError} on any malformed field, duplicate id, or non-loopback
 * URL, with a message that points at the offending path.
 */
export function parseConnectorsFile(input: unknown): ConnectorsFile {
  const parsed = ConnectorsFileSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue !== undefined && issue.path.length > 0 ? ` at ${issue.path.join(".")}` : "";
    throw new ValidationError(
      `invalid connectors document: ${issue?.message ?? "bad request"}${where}`,
    );
  }
  const connectors = parsed.data.connectors.map((connector) =>
    connector.transport === "http"
      ? { ...connector, url: assertLoopbackMcpUrl(connector.url) }
      : connector,
  );
  return { schemaVersion: parsed.data.schemaVersion, connectors };
}

/**
 * The GUI "add connector" request. The client supplies everything except the
 * `id`, which the server assigns from `name` so ids stay stable and readable.
 */
const AddStdioRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    transport: z.literal("stdio"),
    command: z.string().trim().min(1).max(512),
    args: z.array(z.string().max(512)).max(MAX_ARGS).optional(),
    env: z.record(z.string().max(256), z.string().max(4096)).optional(),
  })
  .strict();

const AddHttpRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    transport: z.literal("http"),
    url: z.string().trim().min(1).max(2048),
  })
  .strict();

const AddConnectorRequestSchema = z.discriminatedUnion("transport", [
  AddStdioRequestSchema,
  AddHttpRequestSchema,
]);

/** Derive a stable, url-safe slug id from a connector name. */
function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug.length > 0 ? slug : "connector";
}

/**
 * Parse and validate a GUI "add connector" request, assigning a unique id that
 * does not collide with `existingIds`. Throws {@link ValidationError} on any
 * malformed field, unknown key, or non-loopback URL.
 */
export function parseAddConnectorRequest(
  input: unknown,
  existingIds: readonly string[],
): McpConnector {
  const parsed = AddConnectorRequestSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(
      `invalid connector: ${parsed.error.issues[0]?.message ?? "bad request"}`,
    );
  }

  const taken = new Set(existingIds);
  const base = slugify(parsed.data.name);
  let id = base;
  while (taken.has(id)) {
    id = `${base}-${randomUUID().slice(0, 6)}`;
  }

  if (parsed.data.transport === "http") {
    const url = assertLoopbackMcpUrl(parsed.data.url);
    return { id, name: parsed.data.name, transport: "http", url };
  }

  const connector: McpConnector = {
    id,
    name: parsed.data.name,
    transport: "stdio",
    command: parsed.data.command,
    args: parsed.data.args ?? [],
    ...(parsed.data.env !== undefined ? { env: parsed.data.env } : {}),
  };
  return connector;
}
