import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COMMANDS, buildCli } from "../src/cli.js";
import {
  expectNoninteractiveGolden,
  JSON_NONINTERACTIVE_FIXTURES,
  noninteractiveFixtureExists,
  PLAIN_NONINTERACTIVE_FIXTURES,
  withGoldenEnvironment,
} from "./fixtures/noninteractive-golden.js";

function resolveStaticImport(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const candidate = resolve(dirname(fromFile), specifier);
  const base = candidate.replace(/\.(?:c|m)?js$/u, "");
  const candidates = [
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mts`,
    `${base}.cts`,
    resolve(base, "index.ts"),
    resolve(base, "index.tsx"),
    resolve(base, "index.mts"),
    resolve(base, "index.cts"),
  ];
  return candidates.find(existsSync) ?? null;
}

function collectStaticImportGraph(entry: string): ReadonlySet<string> {
  const visited = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined || visited.has(file)) continue;
    visited.add(file);
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
      const moduleSpecifier = statement.moduleSpecifier;
      if (moduleSpecifier === undefined || !ts.isStringLiteral(moduleSpecifier)) continue;
      const imported = resolveStaticImport(file, moduleSpecifier.text);
      if (imported !== null) pending.push(imported);
    }
  }
  return visited;
}

afterEach(() => {
  process.exitCode = undefined;
});

describe("U0a noninteractive compatibility manifest", () => {
  it("requires one plain golden for every implemented command", () => {
    expect(Object.keys(PLAIN_NONINTERACTIVE_FIXTURES).sort()).toEqual(
      COMMANDS.map((command) => command.name).sort(),
    );
    expect(Object.values(PLAIN_NONINTERACTIVE_FIXTURES).every(noninteractiveFixtureExists)).toBe(
      true,
    );
  });

  it("pins JSON goldens for every command that currently registers --json", () => {
    const registered = buildCli().commands
      .filter(
        (command) =>
          command.name !== "" && command.options.some((option) => option.names.includes("json")),
      )
      .map((command) => command.name)
      .sort();
    expect(Object.keys(JSON_NONINTERACTIVE_FIXTURES).sort()).toEqual(registered);
    expect(Object.values(JSON_NONINTERACTIVE_FIXTURES).every(noninteractiveFixtureExists)).toBe(
      true,
    );
  });

  it("keeps the pre-TUI CLI static import graph free of TUI modules", () => {
    const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
    const tuiRoot = resolve(dirname(cliPath), "tui");
    const eagerTuiImports = [...collectStaticImportGraph(cliPath)].filter(
      (path) => path === `${tuiRoot}.ts` || path.startsWith(`${tuiRoot}/`),
    );
    expect(eagerTuiImports).toEqual([]);
  });

  it("preserves the global help output byte-for-byte", async () => {
    const chunks: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      chunks.push(`${args.map(String).join(" ")}\n`);
    });

    try {
      await withGoldenEnvironment(() => buildCli().outputHelp());
    } finally {
      log.mockRestore();
    }

    expectNoninteractiveGolden("help-plain.encoded.json", chunks.join(""));
  });

  it("preserves the version output byte-for-byte", async () => {
    const chunks: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      chunks.push(`${args.map(String).join(" ")}\n`);
    });

    try {
      await withGoldenEnvironment(() =>
        buildCli().parse(["node", "local-llmup", "--version"], { run: false }),
      );
    } finally {
      log.mockRestore();
    }

    const normalized = chunks
      .join("")
      .replace(/\b(?:darwin|linux|win32)-(?:arm64|x64|ia32)\b/u, "<platform>-<arch>")
      .replace(/\bnode-v\d+\.\d+\.\d+\b/u, "node-<version>");
    expectNoninteractiveGolden("version-plain.txt", normalized);
  });
});
