#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cac, type Command } from "cac";
import {
  assertModesExclusive,
  parseBackendName,
  parseContextTokens,
  runRecommend,
} from "./commands/recommend.js";
import { runUp } from "./commands/up.js";
import { runDown } from "./commands/down.js";
import { runLs } from "./commands/ls.js";
import { runSwitch } from "./commands/switch.js";
import { runChat } from "./commands/chat.js";
import { parseHarnessName } from "./harness/adapter.js";
import { runMigrate } from "./commands/migrate.js";
import { runDoctor } from "./commands/doctor.js";
import { runCatalog } from "./commands/catalog.js";
import { runCanRun } from "./commands/can-run.js";
import { stripControl } from "./sanitize.js";
import { BACKEND_NAMES, CAPABILITIES, type Capability } from "./types.js";

export type CommandName =
  | "recommend"
  | "can-run"
  | "up"
  | "chat"
  | "gui"
  | "down"
  | "switch"
  | "migrate"
  | "ls"
  | "catalog"
  | "doctor";

export interface CommandSpec {
  readonly name: CommandName;
  /** cac usage suffix, e.g. "<model>" or "[model]". Empty when the command takes no positional. */
  readonly args: string;
  readonly description: string;
}

export const COMMANDS: readonly CommandSpec[] = [
  {
    name: "recommend",
    args: "",
    description: "Detect hardware and print ranked local LLMs + install commands.",
  },
  {
    name: "can-run",
    args: "<model>",
    description:
      "Answer yes|slow|no whether this machine can run <model>, with an estimated tok/s range.",
  },
  {
    name: "up",
    args: "<model>",
    description: "Install (if needed) and start a local server for <model>.",
  },
  { name: "chat", args: "", description: "Interactive/piped chat that records memory." },
  { name: "gui", args: "", description: "Launch the browser GUI for local/cloud chat harnesses." },
  {
    name: "down",
    args: "[model]",
    description:
      "Stop a server owned by local-llmup, or detach+forget an attached daemon without stopping it.",
  },
  {
    name: "switch",
    args: "<model>",
    description: "Make <model> the active served model (no memory move).",
  },
  { name: "migrate", args: "", description: "Move all memory from one model to another." },
  {
    name: "ls",
    args: "",
    description: "List active server state from local state (not installed-model inventory).",
  },
  { name: "catalog", args: "", description: "Show or refresh the model catalog." },
  { name: "doctor", args: "", description: "Diagnose hardware, backend, disk, ports, and state." },
];

const NAME = "local-llmup";

function notImplemented(command: CommandName): void {
  process.stderr.write(`${command}: not implemented yet\n`);
  process.exitCode = 1;
}

function isCapability(value: string): value is Capability {
  return (CAPABILITIES as readonly string[]).includes(value);
}

interface UiCliOptions {
  readonly tui?: boolean | readonly boolean[] | undefined;
  readonly accessible?: boolean | undefined;
  readonly noColor?: boolean | undefined;
}

function registerReadOnlyUiOptions(command: Command): Command {
  return command
    .option("--tui", "Use the interactive terminal UI (fails when incompatible)")
    .option("--no-tui", "Force existing plain noninteractive output")
    .option("--accessible", "Use the line-oriented accessible interactive UI")
    .option("--no-color", "Disable interactive color while retaining layout");
}

interface CliHelpSection {
  readonly title?: string;
  readonly body: string;
}

function preserveLegacyHelp(sections: CliHelpSection[]): CliHelpSection[] {
  const hiddenFlags = ["--tui", "--no-tui", "--accessible", "--no-color"];
  return sections.map((section) => ({
    ...section,
    body: section.body
      .split("\n")
      .filter((line) => !hiddenFlags.some((flag) => line.includes(flag)))
      .join("\n"),
  }));
}

async function resolveReadOnlyMode(
  options: UiCliOptions & { readonly json?: boolean | undefined },
  rawArgs: readonly string[],
): Promise<import("./tui/capabilities.js").UiModeSelection> {
  const { resolveUiModeFromSources } = await import("./tui/capabilities.js");
  return resolveUiModeFromSources({
    ...(options.json === true ? { json: true } : {}),
    ...(rawArgs.includes("--tui") ? { tui: true } : {}),
    ...(rawArgs.includes("--no-tui") ? { noTui: true } : {}),
    ...(options.accessible === true ? { accessible: true } : {}),
    ...(options.noColor === true || rawArgs.includes("--no-color") ? { noColor: true } : {}),
  });
}

function usesDirectNoninteractivePath(
  options: UiCliOptions & { readonly json?: boolean | undefined },
  rawArgs: readonly string[],
): boolean {
  const tui = rawArgs.includes("--tui");
  const noTui = rawArgs.includes("--no-tui");
  const accessible = options.accessible === true;
  if (options.json === true && !tui && !accessible) return true;
  if (noTui && !tui && !accessible) return true;
  return (
    !tui &&
    !accessible &&
    (process.stdin.isTTY !== true ||
      process.stdout.isTTY !== true ||
      process.stderr.isTTY !== true)
  );
}

function isInteractiveSelection(
  selection: import("./tui/capabilities.js").UiModeSelection,
): selection is import("./tui/capabilities.js").UiModeSelection & {
  readonly mode: "tui" | "accessible";
} {
  return selection.mode === "tui" || selection.mode === "accessible";
}

/** Wire the shared `recommend` action onto a cac command (named and default). */
function registerRecommend(command: Command): void {
  registerReadOnlyUiOptions(command)
    .option("--task <task>", `Boost models for a task: ${CAPABILITIES.join("|")}`)
    .option("--context <tokens>", "Size the KV cache at this context (tokens) and re-rank")
    .option("--max-context", "Report the largest context each model can hold on this hardware")
    .option("--backend <name>", `Scope throughput to a runtime: ${BACKEND_NAMES.join("|")}`)
    .option("--available-backends", "Only show models an installed backend can serve")
    .option("--json", "Emit machine-readable JSON")
    .action(
      async (options: {
        task?: string;
        context?: string | number;
        maxContext?: boolean;
        backend?: string;
        availableBackends?: boolean;
        json?: boolean;
      } & UiCliOptions) => {
        try {
          if (options.task !== undefined && !isCapability(options.task)) {
            process.stderr.write(
              `recommend: invalid --task ${JSON.stringify(options.task)} (expected ${CAPABILITIES.join(
                "|",
              )})\n`,
            );
            process.exitCode = 1;
            return;
          }
          const context =
            options.context !== undefined ? parseContextTokens(String(options.context)) : undefined;
          assertModesExclusive(context, options.maxContext);
          const backend =
            options.backend !== undefined ? parseBackendName(String(options.backend)) : undefined;
          const commandOptions = {
            ...(options.task !== undefined ? { task: options.task as Capability } : {}),
            ...(context !== undefined ? { context } : {}),
            ...(options.maxContext === true ? { maxContext: true } : {}),
            ...(backend !== undefined ? { backend } : {}),
            ...(options.availableBackends === true ? { availableBackends: true } : {}),
            ...(options.json === true ? { json: true } : {}),
          };
          if (usesDirectNoninteractivePath(options, command.cli.rawArgs)) {
            await runRecommend(commandOptions);
            return;
          }
          const mode = await resolveReadOnlyMode(options, command.cli.rawArgs);
          if (isInteractiveSelection(mode)) {
            const { runInteractiveRecommend } = await import("./tui/read-only-entry.js");
            await runInteractiveRecommend(commandOptions, mode);
          } else {
            await runRecommend(commandOptions);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          process.stderr.write(`recommend: ${stripControl(message)}\n`);
          process.exitCode = 1;
        }
      },
    );
}

/** Wire the `up` action onto its cac command. */
function registerUp(command: Command): void {
  registerReadOnlyUiOptions(command)
    .option("--port <port>", "Port for the backend server (default 11434)")
    .option("--backend <name>", "Force a backend (ollama, llamacpp)")
    .action(async (model: string | undefined, options: { port?: string | number; backend?: string } & UiCliOptions) => {
      try {
        const port = options.port === undefined ? undefined : Number(options.port);
        if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
          process.stderr.write(
            `up: invalid --port ${JSON.stringify(options.port)} (expected an integer in 1..65535)\n`,
          );
          process.exitCode = 1;
          return;
        }
        const backend =
          options.backend !== undefined ? parseBackendName(String(options.backend)) : undefined;
        const commandOptions = {
          ...(model !== undefined ? { model } : {}),
          ...(port !== undefined ? { port } : {}),
          ...(backend !== undefined ? { backend } : {}),
        };
        if (usesDirectNoninteractivePath(options, command.cli.rawArgs)) {
          if (model === undefined) {
            process.stderr.write("up: model is required outside interactive mode\n");
            process.exitCode = 1;
            return;
          }
          await runUp({ ...commandOptions, model });
          return;
        }
        const mode = await resolveReadOnlyMode(options, command.cli.rawArgs);
        if (isInteractiveSelection(mode)) {
          const outcome = await (await import("./tui/lifecycle-entry.js")).runInteractiveUp(
            commandOptions,
            mode,
          );
          if (outcome.type === "cancelled") process.exitCode = 130;
        } else if (model !== undefined) {
          await runUp({ ...commandOptions, model });
        }
      } catch (error) {
        if (error instanceof Error && error.name === "LifecycleUiHandledError") {
          process.exitCode = 1;
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`up: ${stripControl(message)}\n`);
        process.exitCode = 1;
      }
    });
}

/** Wire the `down` action onto its cac command. */
function registerDown(command: Command): void {
  registerReadOnlyUiOptions(command)
    .option("--yes", "Skip the down confirmation (drift protection remains enabled)")
    .action(async (model: string | undefined, options: UiCliOptions & { readonly yes?: boolean }) => {
    try {
      const commandOptions = model !== undefined ? { model } : {};
      if (usesDirectNoninteractivePath(options, command.cli.rawArgs)) {
        await runDown(commandOptions);
        return;
      }
      const mode = await resolveReadOnlyMode(options, command.cli.rawArgs);
      if (isInteractiveSelection(mode)) {
        const outcome = await (await import("./tui/lifecycle-entry.js")).runInteractiveDown(
          commandOptions,
          mode,
          options.yes === true,
        );
        if (outcome.type === "cancelled") process.exitCode = 130;
      } else {
        await runDown(commandOptions);
      }
    } catch (error) {
      if (error instanceof Error && error.name === "LifecycleUiHandledError") {
        process.exitCode = 1;
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`down: ${stripControl(message)}\n`);
      process.exitCode = 1;
    }
    });
}

/** Wire the `ls` action onto its cac command. */
function registerLs(command: Command): void {
  registerReadOnlyUiOptions(command).action(async (options: UiCliOptions) => {
    try {
      if (usesDirectNoninteractivePath(options, command.cli.rawArgs)) {
        runLs();
        return;
      }
      const mode = await resolveReadOnlyMode(options, command.cli.rawArgs);
      if (isInteractiveSelection(mode)) {
        const { runInteractiveLs } = await import("./tui/read-only-entry.js");
        await runInteractiveLs(mode);
      } else {
        runLs();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`ls: ${stripControl(message)}\n`);
      process.exitCode = 1;
    }
  });
}

/** Wire the `switch` action onto its cac command. */
function registerSwitch(command: Command): void {
  registerReadOnlyUiOptions(command).action(async (model: string | undefined, options: UiCliOptions) => {
    try {
      if (usesDirectNoninteractivePath(options, command.cli.rawArgs)) {
        if (model === undefined) {
          process.stderr.write("switch: model is required outside interactive mode\n");
          process.exitCode = 1;
          return;
        }
        await runSwitch({ model });
        return;
      }
      const mode = await resolveReadOnlyMode(options, command.cli.rawArgs);
      if (isInteractiveSelection(mode)) {
        const outcome = await (await import("./tui/lifecycle-entry.js")).runInteractiveSwitch(
          model === undefined ? {} : { model },
          mode,
        );
        if (outcome.type === "cancelled") process.exitCode = 130;
      } else if (model !== undefined) {
        await runSwitch({ model });
      }
    } catch (error) {
      if (error instanceof Error && error.name === "LifecycleUiHandledError") {
        process.exitCode = 1;
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`switch: ${stripControl(message)}\n`);
      process.exitCode = 1;
    }
  });
}

/** Wire the `chat` action onto its cac command. */
function registerChat(command: Command): void {
  command
    .option("-m, --model <model>", "Model to chat with (defaults to the active model)")
    .option("--harness <name>", "Route the chat through a chat harness instead of the active backend")
    .action(async (options: { model?: string; harness?: string }) => {
      try {
        await runChat({
          ...(options.model !== undefined ? { model: options.model } : {}),
          ...(options.harness !== undefined ? { harness: parseHarnessName(options.harness) } : {}),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`chat: ${stripControl(message)}\n`);
        process.exitCode = 1;
      }
    });
}

/** Wire the `gui` action onto its cac command. */
function registerGui(command: Command): void {
  command
    .option("--port <port>", "Port to bind on 127.0.0.1 (default: 4000)")
    .option("--harness <name>", "Start with this chat harness active")
    .option("--no-open", "Do not open the browser automatically")
    .option("--json", "Print the server URL as JSON instead of opening the browser")
    .action(async (options: { port?: string | number; harness?: string; noOpen?: boolean; json?: boolean }) => {
      try {
        const { runGui } = await import("./commands/gui.js");
        const port = options.port === undefined ? undefined : Number(options.port);
        if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
          process.stderr.write(
            `gui: invalid --port ${JSON.stringify(options.port)} (expected an integer in 1..65535)\n`,
          );
          process.exitCode = 1;
          return;
        }
        await runGui({
          ...(port !== undefined ? { port } : {}),
          ...(options.harness !== undefined ? { harness: options.harness } : {}),
          ...(options.noOpen === true ? { noOpen: true } : {}),
          ...(options.json === true ? { json: true } : {}),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`gui: ${stripControl(message)}\n`);
        process.exitCode = 1;
      }
    });
}

/** Wire the `migrate` action onto its cac command. */
function registerMigrate(command: Command): void {
  registerReadOnlyUiOptions(command)
    .option("--from <model>", "Source model to migrate memory from")
    .option("--to <model>", "Target model to migrate memory to")
    .option("--move", "Delete the source memory after a successful migration")
    .option("--dry-run", "Print the migration plan without writing anything")
    .option("--yes", "Skip confirmation for --move only (drift protection remains enabled)")
    .action(async (options: { from?: string; to?: string; move?: boolean; dryRun?: boolean; yes?: boolean } & UiCliOptions) => {
      try {
        if (options.yes === true && options.move !== true) {
          process.stderr.write("migrate: --yes is accepted only with --move\n");
          process.exitCode = 1;
          return;
        }
        if (usesDirectNoninteractivePath(options, command.cli.rawArgs)) {
          if (options.from === undefined || options.to === undefined) {
            process.stderr.write("migrate: --from and --to are required\n");
            process.exitCode = 1;
            return;
          }
          await runMigrate({
            from: options.from,
            to: options.to,
            ...(options.move === true ? { move: true } : {}),
            ...(options.dryRun === true ? { dryRun: true } : {}),
          });
          return;
        }
        const mode = await resolveReadOnlyMode(options, command.cli.rawArgs);
        if (isInteractiveSelection(mode)) {
          await (await import("./tui/lifecycle-entry.js")).runInteractiveMigrateUnavailable(mode);
          return;
        }
        if (options.from === undefined || options.to === undefined) {
          process.stderr.write("migrate: --from and --to are required\n");
          process.exitCode = 1;
          return;
        }
        await runMigrate({
          from: options.from,
          to: options.to,
          ...(options.move === true ? { move: true } : {}),
          ...(options.dryRun === true ? { dryRun: true } : {}),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`migrate: ${stripControl(message)}\n`);
        process.exitCode = 1;
      }
    });
}

/** Wire the `doctor` action onto its cac command. */
function registerDoctor(command: Command): void {
  registerReadOnlyUiOptions(command)
    .option("--json", "Emit machine-readable JSON")
    .action(async (options: { json?: boolean } & UiCliOptions) => {
      try {
        if (usesDirectNoninteractivePath(options, command.cli.rawArgs)) {
          const report = await runDoctor(
            undefined,
            options.json === true ? { json: true } : {},
          );
          if (!report.ok) process.exitCode = 1;
          return;
        }
        const mode = await resolveReadOnlyMode(options, command.cli.rawArgs);
        const report =
          isInteractiveSelection(mode)
            ? await (await import("./tui/read-only-entry.js")).runInteractiveDoctor(mode)
            : await runDoctor(undefined, options.json === true ? { json: true } : {});
        if (!report.ok) process.exitCode = 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`doctor: ${stripControl(message)}\n`);
        process.exitCode = 1;
      }
    });
}

/** Wire the `can-run` action onto its cac command. Non-zero exit only for `no`. */
function registerCanRun(command: Command): void {
  registerReadOnlyUiOptions(command)
    .option("--backend <name>", `Scope throughput to a runtime: ${BACKEND_NAMES.join("|")}`)
    .option("--json", "Emit machine-readable JSON")
    .action(async (model: string | undefined, options: { backend?: string; json?: boolean } & UiCliOptions) => {
      try {
        const backend =
          options.backend !== undefined ? parseBackendName(String(options.backend)) : undefined;
        const commandOptions = {
          ...(model !== undefined ? { model } : {}),
          ...(backend !== undefined ? { backend } : {}),
          ...(options.json === true ? { json: true } : {}),
        };
        if (usesDirectNoninteractivePath(options, command.cli.rawArgs)) {
          if (model === undefined) {
            process.stderr.write("can-run: model is required outside interactive mode\n");
            process.exitCode = 1;
            return;
          }
          const result = await runCanRun({ ...commandOptions, model });
          if (result.runnable === "no") process.exitCode = 1;
          return;
        }
        const mode = await resolveReadOnlyMode(options, command.cli.rawArgs);
        const result =
          isInteractiveSelection(mode)
            ? await (await import("./tui/read-only-entry.js")).runInteractiveCanRun(
                commandOptions,
                mode,
              )
            : model === undefined
              ? null
              : await runCanRun({ ...commandOptions, model });
        if (result === null) {
          process.exitCode = 130;
          return;
        }
        if (result === undefined) return;
        if (result.runnable === "no") process.exitCode = 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`can-run: ${stripControl(message)}\n`);
        process.exitCode = 1;
      }
    });
}

/** Wire the `catalog` action onto its cac command. */
function registerCatalog(command: Command): void {
  registerReadOnlyUiOptions(command)
    .option("--all", "Show every model (including non-fitting models)")
    .option("--refresh", "Run incremental enrichment locally and print the dry-run diff")
    .action(async (options: { all?: boolean; refresh?: boolean } & UiCliOptions) => {
      try {
        const commandOptions = {
          ...(options.all === true ? { all: true } : {}),
          ...(options.refresh === true ? { refresh: true } : {}),
        };
        if (usesDirectNoninteractivePath(options, command.cli.rawArgs)) {
          await runCatalog(commandOptions);
          return;
        }
        const mode = await resolveReadOnlyMode(options, command.cli.rawArgs);
        if (isInteractiveSelection(mode)) {
          const { runInteractiveCatalog } = await import("./tui/read-only-entry.js");
          await runInteractiveCatalog(commandOptions, mode);
        } else {
          await runCatalog(commandOptions);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`catalog: ${stripControl(message)}\n`);
        process.exitCode = 1;
      }
    });
}

/**
 * Read the package version from the bundled `package.json` so `--version` always
 * matches the installed release (rather than a hand-maintained literal that can
 * drift). `package.json` sits one directory above the compiled `dist/cli.js`
 * (and above `src/cli.ts`), and npm always ships it. Falls back to `"0.0.0"` if
 * it cannot be read or parsed.
 */
function readPackageVersion(): string {
  try {
    const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
    const parsed: unknown = JSON.parse(readFileSync(pkgPath, "utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "version" in parsed &&
      typeof (parsed as { version: unknown }).version === "string"
    ) {
      return (parsed as { version: string }).version;
    }
  } catch {
    // Fall through to the sentinel below.
  }
  return "0.0.0";
}

export function buildCli(): ReturnType<typeof cac> {
  const cli = cac(NAME);

  for (const spec of COMMANDS) {
    const registrationArgs = ["can-run", "up", "switch"].includes(spec.name)
      ? "[model]"
      : spec.args;
    const usage = registrationArgs ? `${spec.name} ${registrationArgs}` : spec.name;
    const command = cli.command(usage, spec.description);
    if (spec.name === "can-run") command.rawName = "can-run <model>";
    if (spec.name === "up") command.rawName = "up <model>";
    if (spec.name === "switch") command.rawName = "switch <model>";
    if (spec.name === "recommend") {
      registerRecommend(command);
    } else if (spec.name === "can-run") {
      registerCanRun(command);
    } else if (spec.name === "up") {
      registerUp(command);
    } else if (spec.name === "down") {
      registerDown(command);
    } else if (spec.name === "ls") {
      registerLs(command);
    } else if (spec.name === "switch") {
      registerSwitch(command);
    } else if (spec.name === "chat") {
      registerChat(command);
    } else if (spec.name === "gui") {
      registerGui(command);
    } else if (spec.name === "migrate") {
      registerMigrate(command);
    } else if (spec.name === "doctor") {
      registerDoctor(command);
    } else if (spec.name === "catalog") {
      registerCatalog(command);
    } else {
      command.action(() => {
        notImplemented(spec.name);
      });
    }
  }

  // Default command mirrors `recommend`.
  registerRecommend(cli.command("", COMMANDS[0]?.description ?? ""));

  cli.help(preserveLegacyHelp);
  cli.version(readPackageVersion());
  return cli;
}

export function run(argv: readonly string[] = process.argv): void {
  const cli = buildCli();
  cli.parse(argv as string[]);
}

const invokedDirectly =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  run();
}
