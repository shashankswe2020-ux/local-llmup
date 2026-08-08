import type {
  CatalogSourceViewModel,
  CatalogViewModel,
  CommandViewModelMap,
  RecommendRowViewModel,
  RecommendViewModel,
} from "./types.js";
import { sanitizeTerminalText, TERMINAL_TEXT_LIMITS } from "./sanitize.js";

export type AccessibleReadOnlyOutcome =
  | { readonly type: "exited" }
  | { readonly type: "print-command"; readonly command: string };

export type AccessibleReadOnlyOptions = {
  readonly [K in keyof CommandViewModelMap]: {
    readonly screen: K;
    readonly viewModel: CommandViewModelMap[K];
    readonly explicit: boolean;
    readonly readLine: () => Promise<string | null>;
    readonly write: (text: string) => void;
  };
}[keyof CommandViewModelMap];

const GIB = 1024 ** 3;
const MAX_COMMAND_BYTES = 256;
const MAX_ACCESSIBLE_ROWS = 20;
const MAX_ACCESSIBLE_NESTED_ITEMS = 10;

function withOmittedCount(values: readonly string[], limit: number): string {
  const visible = values.slice(0, limit);
  const omitted = values.length - visible.length;
  return `${visible.join(", ") || "none"}${omitted > 0 ? ` (+${String(omitted)} more)` : ""}`;
}

function boundAccessibleDocument(value: string): string {
  const notice = "[output bounded; refine the search or inspect a numbered item for more]\n";
  const budget = TERMINAL_TEXT_LIMITS.frameBytes - Buffer.byteLength(notice, "utf8");
  const lines = value.match(/.*(?:\n|$)/gu) ?? [];
  const kept: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (bytes + lineBytes > budget) return `${kept.join("")}${notice}`;
    kept.push(line);
    bytes += lineBytes;
  }
  return kept.join("");
}

function gib(bytes: number): string {
  return `${(bytes / GIB).toFixed(1)} GiB`;
}

function sourceLine(source: CatalogSourceViewModel): string {
  switch (source.type) {
    case "ollama":
      return `ollama ${source.id}`;
    case "hf":
      return `hf ${source.repo}`;
    case "gguf":
      return `gguf ${source.repo}@${source.revision} ${source.file} sha256:${source.sha256}`;
    case "mlx":
      return `mlx ${source.repo}@${source.revision}; ${withOmittedCount(source.files.map((file) => `${file.file} sha256:${file.sha256} ${String(file.bytes)} bytes`), MAX_ACCESSIBLE_NESTED_ITEMS)}`;
  }
}

function recommendRow(row: RecommendRowViewModel, index: number): string {
  const unknown = row.throughput.known ? "" : `; unknown reason ${row.throughput.reason}`;
  return `${String(index + 1)}. ${row.model.display}; rank ${String(row.rank)}; ${row.params}; ${row.quant}; ${gib(row.requiredBytes)}; verdict ${row.verdict}; throughput ${row.throughput.label}${unknown}; backends ${row.backends.join(", ") || "none"}; score ${row.score.toFixed(2)}; capabilities ${row.capabilities.join(", ") || "none"}; license ${row.license}; context ${String(row.contextLength)}; ${row.contextEvidence}; throughput backend ${row.throughputBackend}; source ${row.throughputEvidence}; scores quality ${row.scores.quality.toFixed(2)}, fit ${row.scores.fit.toFixed(2)}, speed ${row.scores.speed.toFixed(2)}, recency ${row.scores.recency.toFixed(2)}, capability ${row.scores.capability.toFixed(2)}`;
}

function formatRecommend(viewModel: RecommendViewModel): string {
  const lines = [
    "local-llmup / Recommend / Accessible",
    "1. Machine",
    `${viewModel.hardware.platform}/${viewModel.hardware.arch}; ${gib(viewModel.hardware.usableBytes)} usable ${viewModel.hardware.memoryKind}; RAM ${gib(viewModel.hardware.totalRamBytes)} total, ${gib(viewModel.hardware.freeRamBytes)} free; disk ${gib(viewModel.hardware.freeDiskBytes)} free; GPUs ${viewModel.hardware.gpu.map((gpu) => `${gpu.vendor} ${gib(gpu.vramBytes)}`).join(", ") || "none"}`,
    `Scope: task ${viewModel.scope.task ?? "any"}; context ${viewModel.scope.context === null ? viewModel.scope.maxContextMode ? "maximum" : "default" : String(viewModel.scope.context)}; backend ${viewModel.scope.backend}; ${viewModel.scope.availableBackendsOnly ? "installed backends only" : "all compatible backends"}`,
    "2. Ranked models",
    ...viewModel.rows.slice(0, MAX_ACCESSIBLE_ROWS).map(recommendRow),
    ...(viewModel.rows.length > MAX_ACCESSIBLE_ROWS
      ? [`Showing first ${String(MAX_ACCESSIBLE_ROWS)} of ${String(viewModel.rows.length)}; use /text to refine.`]
      : []),
    "3. Won't fit",
    ...(viewModel.wontFit.length === 0
      ? ["None"]
      : viewModel.wontFit.slice(0, MAX_ACCESSIBLE_ROWS).map(
          (entry, index) => `${String(index + 1)}. ${entry.model.display}; ${entry.reason}`,
        )),
    ...(viewModel.wontFit.length > MAX_ACCESSIBLE_ROWS
      ? [`Showing first ${String(MAX_ACCESSIBLE_ROWS)} of ${String(viewModel.wontFit.length)}; use catalog --all to inspect the rest.`]
      : []),
    "4. Controls",
    `Commands: /text search; number details; ? help;${viewModel.command === null ? "" : " p finish and print result;"} q quit`,
  ];
  return `${lines.join("\n")}\n`;
}

function formatCanRun(viewModel: CommandViewModelMap["canRun"]): string {
  const unknown = viewModel.throughput.known
    ? ""
    : `\nUnknown reason: ${viewModel.throughput.reason}`;
  const next =
    viewModel.verdict === "no" || !viewModel.model.actionable
      ? ""
      : `\nNext: local-llmup up ${viewModel.model.canonical}`;
  return `local-llmup / Can Run / Accessible\n1. Target\n${viewModel.model.display}\n2. Verdict\n${viewModel.verdict}; quant ${viewModel.quant ?? "unknown"}; reason ${viewModel.reason ?? "none"}; ${viewModel.fitEvidence}\n3. Throughput\n${viewModel.throughput.label}; source ${viewModel.throughputEvidence}; backend ${viewModel.throughputBackend}${unknown}\n4. Backends\n${withOmittedCount(viewModel.backends, MAX_ACCESSIBLE_NESTED_ITEMS)}${next}\n5. Controls\nCommands: ? help; q quit\n`;
}

function formatDoctor(viewModel: CommandViewModelMap["doctor"]): string {
  const checks = viewModel.checks.slice(0, MAX_ACCESSIBLE_ROWS).map(
    (check, index) => `${String(index + 1)}. ${check.status.toUpperCase()} ${check.name}: ${check.detail}`,
  );
  const backends = viewModel.backends.slice(0, MAX_ACCESSIBLE_ROWS).map(
    (backend, index) =>
      `${String(index + 1)}. ${backend.name}; ${backend.installed ? "installed" : "not installed"}; version ${backend.version ?? "unknown"}; ${backend.isDefault ? "default" : "not default"}; ${backend.installHint}`,
  );
  const score =
    viewModel.score === null || viewModel.scoreSub === null
      ? "Unknown (not sourced)"
      : `${String(viewModel.score)}/100; bottleneck ${viewModel.bottleneck ?? "unknown"}; VRAM ${String(viewModel.scoreSub.vram)}; RAM ${String(viewModel.scoreSub.ram)}; Compute ${String(viewModel.scoreSub.compute)}; Storage ${String(viewModel.scoreSub.storage)}`;
  return `local-llmup / Doctor / Accessible\n1. Diagnostics\n${checks.join("\n")}${viewModel.checks.length > MAX_ACCESSIBLE_ROWS ? `\n+${String(viewModel.checks.length - MAX_ACCESSIBLE_ROWS)} more checks` : ""}\n2. Backends\n${backends.join("\n")}${viewModel.backends.length > MAX_ACCESSIBLE_ROWS ? `\n+${String(viewModel.backends.length - MAX_ACCESSIBLE_ROWS)} more backends` : ""}\n3. Hardware score\n${score}\n4. Controls\nCommands: ? help; q quit. Suggested commands are text only.\n`;
}

function catalogRow(row: CatalogViewModel["rows"][number], index: number): string {
  return `${String(index + 1)}. ${row.model.display}; family ${row.family}; params ${row.params}${row.activeParams === null ? "" : `, ${row.activeParams} active`}; architecture ${row.architecture}; selected quant ${row.quant}; need ${gib(row.requiredBytes)}; fit ${row.fit}; release ${row.releaseDate}; license ${row.license}; open weight ${row.openWeight ? "yes" : "no"}; context ${String(row.contextLength)}; KV bytes/token ${row.kvBytesPerToken === null ? "unknown (attention geometry not sourced)" : String(row.kvBytesPerToken)}; benchmark ${row.benchmarkProxy === null ? "unknown (not sourced)" : String(row.benchmarkProxy)}; capabilities ${withOmittedCount(row.capabilities, MAX_ACCESSIBLE_NESTED_ITEMS)}; backends ${withOmittedCount(row.supportedBackends, MAX_ACCESSIBLE_NESTED_ITEMS)}; sources ${withOmittedCount(row.sources.map(sourceLine), MAX_ACCESSIBLE_NESTED_ITEMS)}; quantizations ${withOmittedCount(row.quantizations.map((quant) => `${quant.name} disk ${gib(quant.diskBytes)} RAM ${gib(quant.minRamBytes)} VRAM ${gib(quant.minVramBytes)} SHA-256 ${quant.sha256 ?? "unknown (not sourced)"} Digest: ${quant.digestVerified === true ? "verified" : quant.sha256 === null ? "size-only" : "not verified"}`), MAX_ACCESSIBLE_NESTED_ITEMS)}`;
}

function formatCatalog(viewModel: CatalogViewModel): string {
  const refresh =
    viewModel.refresh === null
      ? "Not requested"
      : `Dry-run diff: added ${withOmittedCount(viewModel.refresh.added, MAX_ACCESSIBLE_NESTED_ITEMS)}; updated ${withOmittedCount(viewModel.refresh.updated, MAX_ACCESSIBLE_NESTED_ITEMS)}; removed ${withOmittedCount(viewModel.refresh.removed, MAX_ACCESSIBLE_NESTED_ITEMS)}; skipped ${withOmittedCount(viewModel.refresh.skipped, MAX_ACCESSIBLE_NESTED_ITEMS)}; capped ${withOmittedCount(viewModel.refresh.capped, MAX_ACCESSIBLE_NESTED_ITEMS)}`;
  const rows = viewModel.rows.slice(0, MAX_ACCESSIBLE_ROWS);
  const omitted = viewModel.rows.length - rows.length;
  return `local-llmup / Catalog / Accessible\n1. Machine\n${viewModel.hardware.platform}/${viewModel.hardware.arch}; RAM ${gib(viewModel.hardware.totalRamBytes)} total / ${gib(viewModel.hardware.freeRamBytes)} free; ${gib(viewModel.hardware.usableBytes)} usable ${viewModel.hardware.memoryKind}; disk ${gib(viewModel.hardware.freeDiskBytes)} free; GPUs ${withOmittedCount(viewModel.hardware.gpu.map((gpu) => `${gpu.vendor} ${gib(gpu.vramBytes)}`), MAX_ACCESSIBLE_NESTED_ITEMS)}\n2. Catalog (${viewModel.filter}; ${String(viewModel.rows.length)}/${String(viewModel.total)})\n${rows.map(catalogRow).join("\n") || `Empty: ${viewModel.emptyReason ?? "unknown"}`}${omitted > 0 ? `\nShowing first ${String(MAX_ACCESSIBLE_ROWS)} of ${String(viewModel.rows.length)}; use /text to refine.` : ""}\n3. Refresh\n${refresh}\n4. Controls\nCommands: /text search; number details; ? help; q quit\n`;
}

function formatLs(viewModel: CommandViewModelMap["ls"]): string {
  return viewModel.type === "empty"
    ? `local-llmup / Active Server / Accessible\n1. Status\nNo active model.\n2. Next\n${viewModel.nextCommand}\n`
    : `local-llmup / Active Server / Accessible\n1. Model\n${viewModel.model.display}\n2. Runtime\nBackend: ${viewModel.backend}\nEndpoint: ${viewModel.endpoint}\nPort: ${String(viewModel.port)}\nOwnership: ${viewModel.ownership}\n`;
}

/** Format all read-only evidence as stable numbered, line-oriented sections. */
export function formatAccessibleReadOnlyScreen<K extends keyof CommandViewModelMap>(
  screen: K,
  rawViewModel: CommandViewModelMap[K],
): string {
  switch (screen) {
    case "recommend":
      return boundAccessibleDocument(formatRecommend(rawViewModel as RecommendViewModel));
    case "canRun":
      return boundAccessibleDocument(formatCanRun(rawViewModel as CommandViewModelMap["canRun"]));
    case "doctor":
      return boundAccessibleDocument(formatDoctor(rawViewModel as CommandViewModelMap["doctor"]));
    case "catalog":
      return boundAccessibleDocument(formatCatalog(rawViewModel as CatalogViewModel));
    case "ls":
      return boundAccessibleDocument(formatLs(rawViewModel as CommandViewModelMap["ls"]));
  }
}

function boundedLine(line: string): string {
  return sanitizeTerminalText(line, "single_line", {
    maxBytes: MAX_COMMAND_BYTES,
    maxColumns: MAX_COMMAND_BYTES,
  });
}

function accessibleHelp(screen: keyof CommandViewModelMap, canPrint: boolean): string {
  if (screen === "recommend") {
    return `Commands: /text search; number details; ? help;${canPrint ? " p finish and print result;" : ""} q quit\n`;
  }
  if (screen === "catalog") {
    return "Commands: /text search; number details; ? help; q quit\n";
  }
  return "Commands: ? help; q quit\n";
}

function filteredRecommend(viewModel: RecommendViewModel, query: string): readonly RecommendRowViewModel[] {
  const needle = query.toLowerCase();
  return viewModel.rows.filter((row) =>
    `${row.model.actionable ? row.model.canonical : ""} ${row.capabilities.join(" ")} ${row.backends.join(" ")} ${row.verdict}`
      .toLowerCase()
      .includes(needle),
  );
}

function filteredCatalog(
  viewModel: CatalogViewModel,
  query: string,
): readonly CatalogViewModel["rows"][number][] {
  const needle = query.toLowerCase();
  return viewModel.rows.filter((row) =>
    `${row.model.actionable ? row.model.canonical : ""} ${row.family} ${row.capabilities.join(" ")} ${row.architecture} ${row.fit} ${String(row.releaseDate).slice(0, 4)}`
      .toLowerCase()
      .includes(needle),
  );
}

/** Run a cooked, line-oriented read-only screen. Never enables raw mode or cursor control. */
export async function runAccessibleReadOnlyScreen(
  options: AccessibleReadOnlyOptions,
): Promise<AccessibleReadOnlyOutcome> {
  options.write(formatAccessibleReadOnlyScreen(options.screen, options.viewModel));
  if (options.screen === "ls" && !options.explicit) return { type: "exited" };
  let query = "";
  for (;;) {
    const rawLine = await options.readLine();
    if (rawLine === null) return { type: "exited" };
    const line = boundedLine(rawLine).trim();
    if (line === "q") return { type: "exited" };
    if (line === "?") {
      const canPrint = options.screen === "recommend" && options.viewModel.command !== null;
      options.write(boundAccessibleDocument(accessibleHelp(options.screen, canPrint)));
      continue;
    }
    if (line.startsWith("/")) {
      query = line.slice(1).trim();
      if (options.screen === "recommend") {
        const rows = filteredRecommend(options.viewModel, query);
        options.write(boundAccessibleDocument(`Filter: ${query || "off"}\n${rows.slice(0, MAX_ACCESSIBLE_ROWS).map(recommendRow).join("\n") || "No results"}${rows.length > MAX_ACCESSIBLE_ROWS ? `\nShowing first ${String(MAX_ACCESSIBLE_ROWS)} of ${String(rows.length)}; refine search for more.` : ""}\n`));
      } else if (options.screen === "catalog") {
        const rows = filteredCatalog(options.viewModel, query);
        options.write(boundAccessibleDocument(`Filter: ${query || "off"}\n${rows.slice(0, MAX_ACCESSIBLE_ROWS).map(catalogRow).join("\n") || "No results"}${rows.length > MAX_ACCESSIBLE_ROWS ? `\nShowing first ${String(MAX_ACCESSIBLE_ROWS)} of ${String(rows.length)}; refine search for more.` : ""}\n`));
      } else {
        options.write("Search is available on model-list screens only.\n");
      }
      continue;
    }
    if (/^[1-9][0-9]{0,2}$/u.test(line)) {
      const index = Number(line) - 1;
      if (options.screen === "recommend") {
        const row = filteredRecommend(options.viewModel, query)[index];
        options.write(boundAccessibleDocument(row === undefined ? "No such result.\n" : `Details: ${row.model.display}\n${recommendRow(row, index)}\n`));
      } else if (options.screen === "catalog") {
        const row = filteredCatalog(options.viewModel, query)[index];
        options.write(boundAccessibleDocument(row === undefined ? "No such result.\n" : `Details: ${row.model.display}\n${catalogRow(row, index)}\n`));
      } else {
        options.write("Numbered details are available on model-list screens only.\n");
      }
      continue;
    }
    if (line === "p" && options.screen === "recommend" && options.viewModel.command !== null) {
      return { type: "print-command", command: options.viewModel.command.display };
    }
    options.write("Unknown command. Enter ? for help.\n");
  }
}
