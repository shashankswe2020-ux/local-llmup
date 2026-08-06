/**
 * The `ls` command: report the active model and its endpoint straight from
 * `state.json`. It is read-only (no lock, no process probing) — the single
 * source of truth is the state module, so what `ls` shows always agrees with
 * what `up`/`down`/`switch` recorded.
 */
import { loadConfig, type Config } from "../config.js";
import { renderTable, type Column } from "../output.js";
import { readState, type RuntimeState } from "../state/state.js";

/** Injectable side effects, so the command can be driven with fakes in tests. */
export interface LsDeps {
  readonly config: Config;
  readonly readState: (config: Config) => RuntimeState;
  /** Command result data → stdout. */
  readonly write: (text: string) => void;
}

const createDefaultDeps = (): LsDeps => ({
  config: loadConfig(),
  readState,
  write: (text) => process.stdout.write(text),
});

const TABLE_COLUMNS: readonly Column[] = [
  { header: "Model" },
  { header: "Backend" },
  { header: "Endpoint" },
  { header: "Port", align: "right" },
  { header: "Status" },
];

/** Print the active server recorded in state, or a note when there is none. */
export function runLs(deps: LsDeps = createDefaultDeps()): void {
  const active = deps.readState(deps.config).active;
  if (active === null) {
    deps.write("No active model.\n");
    return;
  }

  // renderTable sanitizes every cell, so registry-sourced strings are safe.
  const table = renderTable(TABLE_COLUMNS, [
    [
      active.modelId,
      active.backend,
      active.endpoint,
      String(active.port),
      active.ownedByUs ? "owned" : "attached",
    ],
  ]);
  deps.write(`${table}\n`);
}
