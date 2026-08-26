#!/usr/bin/env node
/**
 * Minimal Model Context Protocol (MCP) stdio server exposing a single
 * `run_python` tool that executes Python in the workspace. Zero dependencies:
 * it speaks newline-delimited JSON-RPC 2.0 directly so it can be launched as a
 * plain `node scripts/mcp-python-runner.mjs` connector from any cwd without
 * resolving the MCP SDK.
 *
 * Env:
 *   SOLVER_PYTHON     absolute path to the python interpreter (default: python3)
 *   SOLVER_WORKSPACE  working directory for executed code (default: cwd)
 *   SOLVER_TIMEOUT_MS per-run timeout in ms (default: 30000)
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const PYTHON = process.env.SOLVER_PYTHON ?? "python3";
const WORKSPACE = process.env.SOLVER_WORKSPACE ?? process.cwd();
const TIMEOUT_MS = Number(process.env.SOLVER_TIMEOUT_MS ?? "30000") || 30000;
const MAX_OUTPUT = 24 * 1024;

const TOOL = {
  name: "run_python",
  description:
    "Execute Python code in the workspace and return its stdout and stderr. " +
    "sympy, numpy, and matplotlib are available. To create a graph, use " +
    "matplotlib with the Agg backend and call plt.savefig('<name>.png'); the " +
    "file is written into the workspace. Always print results you want to see.",
  inputSchema: {
    type: "object",
    properties: {
      code: { type: "string", description: "The Python source to execute." },
    },
    required: ["code"],
    additionalProperties: false,
  },
};

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function clip(text) {
  return text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n…[truncated]` : text;
}

async function runPython(code) {
  const dir = mkdtempSync(join(tmpdir(), "llmup-run-"));
  const file = join(dir, "snippet.py");
  writeFileSync(file, code, "utf8");
  return new Promise((resolve) => {
    const child = spawn(PYTHON, [file], { cwd: WORKSPACE, env: process.env });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      rmSync(dir, { recursive: true, force: true });
      const parts = [];
      if (stdout.trim().length > 0) parts.push(stdout.trimEnd());
      if (stderr.trim().length > 0) parts.push(`[stderr]\n${stderr.trimEnd()}`);
      if (parts.length === 0) parts.push(`(no output; exit code ${exitCode ?? 0})`);
      resolve({ text: clip(parts.join("\n\n")), isError: (exitCode ?? 0) !== 0 });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      rmSync(dir, { recursive: true, force: true });
      resolve({ text: `failed to launch python (${PYTHON}): ${error.message}`, isError: true });
    });
  });
}

async function handle(message) {
  const { id, method, params } = message;
  const isRequest = id !== undefined && id !== null;

  if (method === "initialize") {
    reply(id, {
      protocolVersion: params?.protocolVersion ?? "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "llmup-python-runner", version: "1.0.0" },
    });
    return;
  }
  if (method === "tools/list") {
    reply(id, { tools: [TOOL] });
    return;
  }
  if (method === "ping") {
    reply(id, {});
    return;
  }
  if (method === "tools/call") {
    const name = params?.name;
    if (name !== TOOL.name) {
      replyError(id, -32602, `unknown tool: ${name}`);
      return;
    }
    const code = params?.arguments?.code;
    if (typeof code !== "string" || code.length === 0) {
      reply(id, { content: [{ type: "text", text: "error: `code` argument is required" }], isError: true });
      return;
    }
    const { text, isError } = await runPython(code);
    reply(id, { content: [{ type: "text", text }], isError });
    return;
  }

  // Notifications (no id) are silently accepted; unknown requests error out.
  if (isRequest) {
    replyError(id, -32601, `method not found: ${method}`);
  }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }
  handle(message).catch((error) => {
    if (message?.id !== undefined && message?.id !== null) {
      replyError(message.id, -32603, `internal error: ${error?.message ?? error}`);
    }
  });
});
