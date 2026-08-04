#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { cac, type Command } from "cac";
import { runRecommend } from "./commands/recommend.js";
import { CAPABILITIES, type Capability } from "./types.js";

export type CommandName =
  | "recommend"
  | "up"
  | "chat"
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
  { name: "recommend", args: "", description: "Detect hardware and print ranked local LLMs + install commands." },
  { name: "up", args: "<model>", description: "Install (if needed) and start a local server for <model>." },
  { name: "chat", args: "", description: "Interactive/piped chat that records memory." },
  { name: "down", args: "[model]", description: "Stop the local server owned by local-llmup." },
  { name: "switch", args: "<model>", description: "Make <model> the active served model (no memory move)." },
  { name: "migrate", args: "", description: "Move all memory from one model to another." },
  { name: "ls", args: "", description: "List installed models and which one is active." },
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

/** Wire the shared `recommend` action onto a cac command (named and default). */
function registerRecommend(command: Command): void {
  command
    .option("--task <task>", `Boost models for a task: ${CAPABILITIES.join("|")}`)
    .option("--json", "Emit machine-readable JSON")
    .action(async (options: { task?: string; json?: boolean }) => {
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
        await runRecommend({
          ...(options.task !== undefined ? { task: options.task as Capability } : {}),
          ...(options.json === true ? { json: true } : {}),
        });
      } catch (error) {
        process.stderr.write(`recommend: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
      }
    });
}

export function buildCli(): ReturnType<typeof cac> {
  const cli = cac(NAME);

  for (const spec of COMMANDS) {
    const usage = spec.args ? `${spec.name} ${spec.args}` : spec.name;
    const command = cli.command(usage, spec.description);
    if (spec.name === "recommend") {
      registerRecommend(command);
    } else {
      command.action(() => {
        notImplemented(spec.name);
      });
    }
  }

  // Default command mirrors `recommend`.
  registerRecommend(cli.command("", COMMANDS[0]?.description ?? ""));

  cli.help();
  cli.version("0.1.0");
  return cli;
}

export function run(argv: readonly string[] = process.argv): void {
  const cli = buildCli();
  cli.parse(argv as string[]);
}

const invokedDirectly =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  run();
}
