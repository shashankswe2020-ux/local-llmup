import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdin } from "ink";
import {
  createReadOnlyListState,
  reduceReadOnlyListState,
  visibleReadOnlyItems,
  type ReadOnlyListAction,
  type ReadOnlyListItem,
  type ReadOnlyListState,
} from "../read-only-list-state.js";
import { createUiKeyDecoder, type UiKey } from "../keys.js";
import type {
  CanRunViewModel,
  CatalogSourceViewModel,
  CatalogViewModel,
  DoctorViewModel,
  LsViewModel,
  RecommendRowViewModel,
  RecommendViewModel,
} from "../types.js";

export interface ReadOnlyScreenStyle {
  readonly color: boolean;
  readonly unicode: boolean;
  readonly columns: number;
  readonly rows: number;
}

interface ScreenActions {
  readonly onPrintCommand?: ((command: string) => void) | undefined;
}

interface ListEntry<T> extends ReadOnlyListItem {
  readonly value: T;
}

const GIB = 1024 ** 3;
const MAX_DETAIL_ITEMS = 20;
const MAX_MANIFEST_ITEMS = 10;

function summarized(values: readonly string[], limit: number = MAX_DETAIL_ITEMS): string {
  const visible = values.slice(0, limit);
  const omitted = values.length - visible.length;
  return `${visible.join(", ") || "none"}${omitted > 0 ? ` (+${String(omitted)} more)` : ""}`;
}

function gib(bytes: number): string {
  return `${(bytes / GIB).toFixed(1)} GiB`;
}

function displayId(value: { readonly display: string }): string {
  return value.display;
}

function stableId(
  value: { readonly actionable: boolean; readonly display: string; readonly canonical?: string },
  index: number,
): string {
  return value.actionable && value.canonical !== undefined
    ? value.canonical
    : `display:${String(index)}:${value.display}`;
}

function Header({ title, context }: { readonly title: string; readonly context?: string }): JSX.Element {
  return (
    <Box justifyContent="space-between">
      <Text bold>{`local-llmup / ${title}`}</Text>
      {context === undefined ? null : <Text dimColor>{context}</Text>}
    </Box>
  );
}

function Divider({ unicode }: { readonly unicode: boolean }): JSX.Element {
  return <Text dimColor>{unicode ? "─".repeat(72) : "-".repeat(72)}</Text>;
}

function StatusText({
  status,
  unicode,
}: {
  readonly status: "yes" | "slow" | "no" | "ok" | "warn" | "fail";
  readonly unicode: boolean;
}): JSX.Element {
  const labels = unicode
    ? { yes: "✓ yes", slow: "⚠ slow", no: "✗ no", ok: "✓ OK", warn: "⚠ WARN", fail: "✗ FAIL" }
    : { yes: "YES", slow: "SLOW", no: "NO", ok: "OK", warn: "WARN", fail: "FAIL" };
  return <Text>{labels[status]}</Text>;
}

function Help({ unicode }: { readonly unicode: boolean }): JSX.Element {
  return (
    <Box flexDirection="column">
      <Text bold>Keyboard help</Text>
      <Text>{`${unicode ? "↑/↓" : "Up/Down"} or j/k Navigate · PageUp/PageDown Page · Home/End Jump`}</Text>
      <Text>/ Search · Enter Details · Esc Back · ? Help · q Quit</Text>
      <Text>Model lists: Space Mark (max 4) · c Compare</Text>
    </Box>
  );
}

function StaticHelp(): JSX.Element {
  return (
    <Box flexDirection="column">
      <Text bold>Keyboard help</Text>
      <Text>? Toggle help · q/Esc Quit</Text>
      <Text>This screen is read-only; suggested commands are text only.</Text>
    </Box>
  );
}

function selectedValue<T>(entries: readonly ListEntry<T>[], state: ReadOnlyListState): T | null {
  return entries.find((entry) => entry.id === state.selectedId)?.value ?? null;
}

function useListInput<T>(
  entries: readonly ListEntry<T>[],
  state: ReadOnlyListState,
  setState: (state: ReadOnlyListState) => void,
  viewportSize: number,
  options: {
    readonly allowMark: boolean;
    readonly onPrint?: (() => void) | undefined;
  },
): void {
  const { exit } = useApp();
  const { stdin } = useStdin();
  const decoder = useRef(createUiKeyDecoder());
  const escapeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dispatch = (action: ReadOnlyListAction): void => {
    setState(reduceReadOnlyListState(entries, state, action, viewportSize));
  };

  useInput((input, key) => {
    if (state.searchActive) {
      if (key.escape || key.return) {
        dispatch({ type: "close-search" });
        return;
      }
      if (key.ctrl && input === "u") {
        dispatch({ type: "reset-query" });
        return;
      }
      if (key.backspace || key.delete) {
        dispatch({ type: "set-query", query: [...state.query].slice(0, -1).join("") });
        return;
      }
      if (!key.ctrl && !key.meta && input.length > 0) {
        dispatch({ type: "set-query", query: `${state.query}${input}` });
      }
      return;
    }

    if (input === "q" || (key.ctrl && input === "c")) {
      exit();
      return;
    }
    if (key.escape) {
      if (escapeTimer.current !== null) clearTimeout(escapeTimer.current);
      escapeTimer.current = setTimeout(() => {
        escapeTimer.current = null;
        if (state.detailOpen) dispatch({ type: "toggle-detail" });
        else if (state.helpOpen) dispatch({ type: "toggle-help" });
        else if (state.compareOpen) dispatch({ type: "toggle-compare" });
        else exit();
      }, 50);
      return;
    }
    if (input === "?") dispatch({ type: "toggle-help" });
    else if (input === "/") dispatch({ type: "open-search" });
    else if (key.upArrow || input === "k") dispatch({ type: "move", delta: -1 });
    else if (key.downArrow || input === "j") dispatch({ type: "move", delta: 1 });
    else if (key.pageUp) dispatch({ type: "page", delta: -1 });
    else if (key.pageDown) dispatch({ type: "page", delta: 1 });
    else if (key.return) dispatch({ type: "toggle-detail" });
    else if (options.allowMark && input === " " && state.selectedId !== null) {
      dispatch({ type: "toggle-mark", id: state.selectedId });
    } else if (options.allowMark && input === "c") dispatch({ type: "toggle-compare" });
    else if (input === "p" && options.onPrint !== undefined) {
      options.onPrint();
      exit();
    }
  });
  useEffect(() => {
    const emptyKey: UiKey = {
      upArrow: false,
      downArrow: false,
      pageUp: false,
      pageDown: false,
      return: false,
      escape: false,
      tab: false,
      shift: false,
      ctrl: false,
    };
    const handleHomeEnd = (chunk: Buffer | string): void => {
      const sequence = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const action = decoder.current.decode(sequence, emptyKey);
      if (action === "first") {
        if (escapeTimer.current !== null) clearTimeout(escapeTimer.current);
        escapeTimer.current = null;
        dispatch({ type: "home" });
      } else if (action === "last") {
        if (escapeTimer.current !== null) clearTimeout(escapeTimer.current);
        escapeTimer.current = null;
        dispatch({ type: "end" });
      }
    };
    stdin?.on("data", handleHomeEnd);
    return () => {
      stdin?.removeListener("data", handleHomeEnd);
      if (escapeTimer.current !== null) clearTimeout(escapeTimer.current);
    };
  });
}

function ListFooter({
  state,
  total,
  allowMark,
  extra,
  unicode,
}: {
  readonly state: ReadOnlyListState;
  readonly total: number;
  readonly allowMark: boolean;
  readonly extra?: string;
  readonly unicode: boolean;
}): JSX.Element {
  return (
    <Box flexDirection="column">
      <Text dimColor>{`Search: ${state.searchActive ? `${state.query}_` : state.query || "off"} · ${String(total)} result(s)${allowMark ? ` · Compare ${String(state.markedIds.length)}/4` : ""}`}</Text>
      <Text>{`${unicode ? "↑↓" : "Up/Down"} Navigate · Home/End Jump · / Search · Enter Details${allowMark ? " · Space Mark · c Compare" : ""} · ? Help · q Quit${extra === undefined ? "" : ` · ${extra}`}`}</Text>
    </Box>
  );
}

function RecommendDetail({ row }: { readonly row: RecommendRowViewModel }): JSX.Element {
  return (
    <Box flexDirection="column">
      <Text bold>{`Evidence / ${displayId(row.model)}`}</Text>
      <Text>{`Verdict: ${row.verdict} · Quant: ${row.quant} · Memory: ${gib(row.requiredBytes)}`}</Text>
      <Text>{`Throughput: ${row.throughput.label} · Source: ${row.throughputEvidence}`}</Text>
      {!row.throughput.known ? <Text>{`Unknown reason: ${row.throughput.reason}`}</Text> : null}
      <Text>{`Context: ${row.contextEvidence} · Limit: ${String(row.contextLength)}`}</Text>
      <Text>{`Capabilities: ${summarized(row.capabilities)}`}</Text>
      <Text>{`License: ${row.license} · Backends: ${summarized(row.backends)}`}</Text>
      <Text>{`Why: quality ${row.scores.quality.toFixed(2)} · fit ${row.scores.fit.toFixed(2)} · speed ${row.scores.speed.toFixed(2)} · recency ${row.scores.recency.toFixed(2)} · capability ${row.scores.capability.toFixed(2)}`}</Text>
    </Box>
  );
}

function RecommendCompare({ rows }: { readonly rows: readonly RecommendRowViewModel[] }): JSX.Element {
  return (
    <Box flexDirection="column">
      <Text bold>{`Compare ${String(rows.length)} models`}</Text>
      {rows.map((row) => (
        <Box key={displayId(row.model)} flexDirection="column" marginTop={1}>
          <Text bold>{displayId(row.model)}</Text>
          <Text>{`${row.verdict} · ${row.quant} · ${gib(row.requiredBytes)} · ${row.throughput.label}`}</Text>
          <Text>{`quality ${row.scores.quality.toFixed(2)} · fit ${row.scores.fit.toFixed(2)} · speed ${row.scores.speed.toFixed(2)} · recency ${row.scores.recency.toFixed(2)}`}</Text>
          <Text>{`context ${String(row.contextLength)} · ${summarized(row.capabilities)} · ${row.license}`}</Text>
        </Box>
      ))}
    </Box>
  );
}

export function RecommendScreen({
  viewModel,
  style,
  actions,
}: {
  readonly viewModel: RecommendViewModel;
  readonly style: ReadOnlyScreenStyle;
  readonly actions: ScreenActions;
}): JSX.Element {
  const entries = useMemo<readonly ListEntry<RecommendRowViewModel>[]>(
    () =>
      viewModel.rows.map((row, index) => ({
        id: stableId(row.model, index),
        searchText: `${row.model.actionable ? row.model.canonical : ""} ${row.capabilities.join(" ")} ${row.backends.join(" ")} ${row.verdict}`,
        value: row,
      })),
    [viewModel],
  );
  const [state, setState] = useState(() => createReadOnlyListState(entries));
  const viewportSize = Math.max(3, style.rows - 14);
  const visible = visibleReadOnlyItems(entries, state, viewportSize, 1);
  const selected = selectedValue(entries, state);
  const compared = state.markedIds
    .map((id) => entries.find((entry) => entry.id === id)?.value)
    .filter((row): row is RecommendRowViewModel => row !== undefined);
  useListInput(entries, state, setState, viewportSize, {
    allowMark: true,
    onPrint:
      viewModel.command === null
        ? undefined
        : () => actions.onPrintCommand?.(viewModel.command?.display ?? ""),
  });

  const context = `${viewModel.hardware.platform}/${viewModel.hardware.arch} · ${gib(viewModel.hardware.usableBytes)} ${viewModel.hardware.memoryKind} · task ${viewModel.scope.task ?? "any"} · context ${viewModel.scope.context === null ? viewModel.scope.maxContextMode ? "maximum" : "default" : String(viewModel.scope.context)} · backend ${viewModel.scope.backend}${viewModel.scope.availableBackendsOnly ? " · installed only" : ""}`;
  return (
    <Box flexDirection="column" width={style.columns}>
      <Header title="Recommend" context={context} />
      <Divider unicode={style.unicode} />
      {state.helpOpen ? (
        <Help unicode={style.unicode} />
      ) : state.compareOpen ? (
        <RecommendCompare rows={compared} />
      ) : state.detailOpen && selected !== null ? (
        <RecommendDetail row={selected} />
      ) : (
        <>
          <Text bold>  #  Model                     Quant     Memory    Verdict  tok/s             Score</Text>
          <Text>{`Machine: RAM ${gib(viewModel.hardware.totalRamBytes)} total / ${gib(viewModel.hardware.freeRamBytes)} free · disk ${gib(viewModel.hardware.freeDiskBytes)} free · GPUs ${summarized(viewModel.hardware.gpu.map((gpu) => `${gpu.vendor} ${gib(gpu.vramBytes)}`))}`}</Text>
          {visible.items.map((entry) => {
            const row = entry.value;
            const selectedRow = entry.id === state.selectedId;
            const marked = state.markedIds.includes(entry.id);
            const throughput = row.throughput.known
              ? row.throughput.label
              : `${row.throughput.label} (${row.throughput.reason})`;
            return (
              <Box key={entry.id}>
                <Text bold={selectedRow}>{`${selectedRow ? ">" : " "}${marked ? "*" : " "} ${String(row.rank).padStart(2)} ${displayId(row.model).padEnd(25).slice(0, 25)} ${String(row.quant).padEnd(9).slice(0, 9)} ${gib(row.requiredBytes).padEnd(9)} ${row.verdict.padEnd(8)} ${throughput} · ${row.score.toFixed(2)}`}</Text>
              </Box>
            );
          })}
          {visible.total === 0 ? <Text>{`No results for “${state.query}”. Ctrl+U resets search.`}</Text> : null}
          <Box marginTop={1} flexDirection="column">
            <Text bold>{`Won't fit (${String(viewModel.wontFit.length)})`}</Text>
            {viewModel.wontFit.slice(0, 3).map((entry) => (
              <Text key={entry.model.display}>{`${displayId(entry.model)} · ${entry.reason}`}</Text>
            ))}
          </Box>
          {selected === null ? null : <RecommendDetail row={selected} />}
        </>
      )}
      <Divider unicode={style.unicode} />
      <ListFooter
        state={state}
        total={visible.total}
        allowMark
        unicode={style.unicode}
        {...(viewModel.command === null ? {} : { extra: "p Finish and print result" })}
      />
    </Box>
  );
}

export function CanRunScreen({
  viewModel,
  style,
}: {
  readonly viewModel: CanRunViewModel;
  readonly style: ReadOnlyScreenStyle;
}): JSX.Element {
  const [help, setHelp] = useState(false);
  useStaticExit(() => setHelp((value) => !value));
  const symbol = style.unicode
    ? viewModel.verdict === "yes"
      ? "✓"
      : viewModel.verdict === "slow"
        ? "⚠"
        : "✗"
    : viewModel.verdict.toUpperCase();
  return (
    <Box flexDirection="column" width={style.columns}>
      <Header title="Can Run" context={displayId(viewModel.model)} />
      <Divider unicode={style.unicode} />
      {help ? <StaticHelp /> : (
      <>
      <Text bold>{`${symbol} Verdict: ${viewModel.verdict}`}</Text>
      <Text>{`Quant: ${viewModel.quant ?? "unknown"} · Reason: ${viewModel.reason ?? "none"}`}</Text>
      <Text>{`Memory evidence: ${viewModel.fitEvidence}`}</Text>
      <Text>{`Throughput: ${viewModel.throughput.label}`}</Text>
      {!viewModel.throughput.known ? <Text>{`Unknown reason: ${viewModel.throughput.reason}`}</Text> : null}
      <Text>{`Throughput source: ${viewModel.throughputEvidence} · Backend scope: ${viewModel.throughputBackend}`}</Text>
      <Text>{`Compatible backends: ${summarized(viewModel.backends)}`}</Text>
      {viewModel.verdict === "no" || !viewModel.model.actionable ? null : (
        <Text>{`Next: local-llmup up ${viewModel.model.canonical}`}</Text>
      )}
      </>
      )}
      <Divider unicode={style.unicode} />
      <Text>q/Esc Quit · ? Help</Text>
    </Box>
  );
}

function useStaticExit(onHelp?: (() => void) | undefined): void {
  const { exit } = useApp();
  useInput((input, key) => {
    if (input === "?" && onHelp !== undefined) onHelp();
    else if (input === "q" || key.escape || (key.ctrl && input === "c")) exit();
  });
}

export function DoctorScreen({
  viewModel,
  style,
}: {
  readonly viewModel: DoctorViewModel;
  readonly style: ReadOnlyScreenStyle;
}): JSX.Element {
  const [help, setHelp] = useState(false);
  useStaticExit(() => setHelp((value) => !value));
  return (
    <Box flexDirection="column" width={style.columns}>
      <Header title="Doctor" context={viewModel.ok ? "healthy" : "problems found"} />
      <Divider unicode={style.unicode} />
      {help ? (
        <StaticHelp />
      ) : (
        <>
          <Text bold>Diagnostics</Text>
          {viewModel.checks.slice(0, MAX_DETAIL_ITEMS).map((check) => (
            <Box key={String(check.name)}>
              <Box width={10}><StatusText status={check.status} unicode={style.unicode} /></Box>
              <Text>{`${check.name}: ${check.detail}`}</Text>
            </Box>
          ))}
          {viewModel.checks.length > MAX_DETAIL_ITEMS ? <Text>{`+${String(viewModel.checks.length - MAX_DETAIL_ITEMS)} more checks`}</Text> : null}
          <Box marginTop={1} flexDirection="column">
            <Text bold>Backends</Text>
            {viewModel.backends.slice(0, MAX_DETAIL_ITEMS).map((backend) => (
              <Text key={String(backend.name)}>{`${backend.name} · ${backend.installed ? "installed" : "not installed"} · version ${backend.version ?? "unknown"} · ${backend.isDefault ? "default" : "not default"} · ${backend.installHint}`}</Text>
            ))}
            {viewModel.backends.length > MAX_DETAIL_ITEMS ? <Text>{`+${String(viewModel.backends.length - MAX_DETAIL_ITEMS)} more backends`}</Text> : null}
          </Box>
          {viewModel.score === null || viewModel.scoreSub === null ? null : (
            <Box marginTop={1} flexDirection="column">
              <Text>{`Score: ${String(viewModel.score)}/100 · Bottleneck: ${viewModel.bottleneck ?? "unknown"}`}</Text>
              <Text>{`VRAM ${String(viewModel.scoreSub.vram)} · RAM ${String(viewModel.scoreSub.ram)} · Compute ${String(viewModel.scoreSub.compute)} · Storage ${String(viewModel.scoreSub.storage)}`}</Text>
            </Box>
          )}
          {viewModel.score === null || viewModel.scoreSub === null ? (
            <Text>Hardware score: unknown (not sourced)</Text>
          ) : null}
        </>
      )}
      <Divider unicode={style.unicode} />
      <Text>q/Esc Quit · ? Help · Suggested commands are text only</Text>
    </Box>
  );
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
      return `mlx ${source.repo}@${source.revision} (${String(source.files.length)} files: ${summarized(source.files.map((file) => `${file.file} sha256:${file.sha256} ${String(file.bytes)} bytes`), MAX_MANIFEST_ITEMS)})`;
  }
}

function CatalogDetail({ row }: { readonly row: CatalogViewModel["rows"][number] }): JSX.Element {
  return (
    <Box flexDirection="column">
      <Text bold>{`Details / ${displayId(row.model)}`}</Text>
      <Text>{`${row.family} · ${row.params}${row.activeParams === null ? "" : ` (${row.activeParams} active)`} · ${row.architecture}`}</Text>
      <Text>{`Fit: ${row.fit} · Selected quant: ${row.quant} · Need: ${gib(row.requiredBytes)}`}</Text>
      <Text>{`License: ${row.license} · Open weight: ${row.openWeight ? "yes" : "no"} · Release: ${row.releaseDate}`}</Text>
      <Text>{`Context: ${String(row.contextLength)} · KV bytes/token: ${row.kvBytesPerToken === null ? "unknown (attention geometry not sourced)" : String(row.kvBytesPerToken)} · Benchmark: ${row.benchmarkProxy === null ? "unknown (not sourced)" : String(row.benchmarkProxy)}`}</Text>
      <Text>{`Capabilities: ${summarized(row.capabilities)} · Backends: ${summarized(row.supportedBackends)}`}</Text>
      <Text bold>Sources</Text>
      {row.sources.slice(0, MAX_MANIFEST_ITEMS).map((source, index) => <Text key={`${source.type}:${String(index)}`}>{sourceLine(source)}</Text>)}
      {row.sources.length > MAX_MANIFEST_ITEMS ? <Text>{`+${String(row.sources.length - MAX_MANIFEST_ITEMS)} more sources`}</Text> : null}
      <Text bold>Quantizations</Text>
      {row.quantizations.slice(0, MAX_MANIFEST_ITEMS).map((quant) => (
        <Text key={String(quant.name)}>{`${quant.name} · disk ${gib(quant.diskBytes)} · RAM ${gib(quant.minRamBytes)} · VRAM ${gib(quant.minVramBytes)} · SHA-256 ${quant.sha256 ?? "unknown (not sourced)"} · Digest: ${quant.digestVerified === true ? "verified" : quant.sha256 === null ? "size-only" : "not verified"}`}</Text>
      ))}
      {row.quantizations.length > MAX_MANIFEST_ITEMS ? <Text>{`+${String(row.quantizations.length - MAX_MANIFEST_ITEMS)} more quantizations`}</Text> : null}
    </Box>
  );
}

function CatalogCompare({
  rows,
}: {
  readonly rows: readonly CatalogViewModel["rows"][number][];
}): JSX.Element {
  return (
    <Box flexDirection="column">
      <Text bold>{`Compare ${String(rows.length)} catalog models`}</Text>
      {rows.map((row) => (
        <Box key={displayId(row.model)} flexDirection="column" marginTop={1}>
          <Text bold>{displayId(row.model)}</Text>
          <Text>{`${row.fit} · ${row.quant} · ${gib(row.requiredBytes)} · ${row.architecture}`}</Text>
          <Text>{`Context ${String(row.contextLength)} · KV bytes/token ${row.kvBytesPerToken === null ? "unknown" : String(row.kvBytesPerToken)}`}</Text>
          <Text>{`Capabilities ${summarized(row.capabilities)} · License ${row.license}`}</Text>
          <Text>{`Backends ${summarized(row.supportedBackends)} · Sources ${summarized(row.sources.map(sourceLine), MAX_MANIFEST_ITEMS)}`}</Text>
        </Box>
      ))}
    </Box>
  );
}

export function CatalogScreen({
  viewModel,
  style,
}: {
  readonly viewModel: CatalogViewModel;
  readonly style: ReadOnlyScreenStyle;
}): JSX.Element {
  const entries = useMemo<readonly ListEntry<CatalogViewModel["rows"][number]>[]>(
    () =>
      viewModel.rows.map((row, index) => ({
        id: stableId(row.model, index),
        searchText: `${row.model.actionable ? row.model.canonical : ""} ${row.family} ${row.capabilities.join(" ")} ${row.architecture} ${row.fit} ${String(row.releaseDate).slice(0, 4)}`,
        value: row,
      })),
    [viewModel],
  );
  const [state, setState] = useState(() => createReadOnlyListState(entries));
  const viewportSize = Math.max(3, style.rows - 14);
  const visible = visibleReadOnlyItems(entries, state, viewportSize, 1);
  const selected = selectedValue(entries, state);
  const compared = state.markedIds
    .map((id) => entries.find((entry) => entry.id === id)?.value)
    .filter(
      (row): row is CatalogViewModel["rows"][number] => row !== undefined,
    );
  useListInput(entries, state, setState, viewportSize, { allowMark: true });
  return (
    <Box flexDirection="column" width={style.columns}>
      <Header title="Catalog" context={`${viewModel.hardware.platform}/${viewModel.hardware.arch}`} />
      <Divider unicode={style.unicode} />
      {state.helpOpen ? <Help unicode={style.unicode} /> : state.compareOpen ? <CatalogCompare rows={compared} /> : state.detailOpen && selected !== null ? <CatalogDetail row={selected} /> : (
        <>
          <Text bold>{`Catalog · ${viewModel.filter} · ${String(visible.total)}/${String(viewModel.total)}`}</Text>
          <Text>{`Machine: RAM ${gib(viewModel.hardware.totalRamBytes)} total / ${gib(viewModel.hardware.freeRamBytes)} free · ${gib(viewModel.hardware.usableBytes)} usable ${viewModel.hardware.memoryKind} · disk ${gib(viewModel.hardware.freeDiskBytes)} free · GPUs ${summarized(viewModel.hardware.gpu.map((gpu) => `${gpu.vendor} ${gib(gpu.vramBytes)}`))}`}</Text>
          {viewModel.refresh === null ? null : (
            <Text>{`Dry-run diff · added ${summarized(viewModel.refresh.added)} · updated ${summarized(viewModel.refresh.updated)} · removed ${summarized(viewModel.refresh.removed)} · skipped ${summarized(viewModel.refresh.skipped)} · capped ${summarized(viewModel.refresh.capped)}`}</Text>
          )}
          {visible.items.map((entry) => {
            const row = entry.value;
            return <Text key={entry.id} bold={entry.id === state.selectedId}>{`${entry.id === state.selectedId ? ">" : " "} ${displayId(row.model).padEnd(25).slice(0, 25)} ${String(row.architecture).padEnd(8)} ${String(row.quant).padEnd(9)} ${gib(row.requiredBytes).padEnd(9)} ${row.fit} · ${row.releaseDate}`}</Text>;
          })}
          {visible.total === 0 ? <Text>{`No results for “${state.query}”. Ctrl+U resets search.`}</Text> : null}
          {selected === null ? null : <CatalogDetail row={selected} />}
        </>
      )}
      <Divider unicode={style.unicode} />
      <ListFooter state={state} total={visible.total} allowMark unicode={style.unicode} />
    </Box>
  );
}

export function LsScreen({
  viewModel,
  style,
  explicit,
}: {
  readonly viewModel: LsViewModel;
  readonly style: ReadOnlyScreenStyle;
  readonly explicit: boolean;
}): JSX.Element {
  const { exit } = useApp();
  useStaticExit();
  useEffect(() => {
    if (!explicit) exit();
  }, [exit, explicit]);
  return (
    <Box flexDirection="column" width={style.columns}>
      <Header title="Active Server" />
      <Divider unicode={style.unicode} />
      {viewModel.type === "empty" ? (
        <>
          <Text>No active model.</Text>
          <Text>{`Next: ${viewModel.nextCommand}`}</Text>
        </>
      ) : (
        <>
          <Text>{`Model: ${displayId(viewModel.model)}`}</Text>
          <Text>{`Backend: ${viewModel.backend}`}</Text>
          <Text>{`Endpoint: ${viewModel.endpoint}`}</Text>
          <Text>{`Port: ${String(viewModel.port)}`}</Text>
          <Text>{`Ownership: ${viewModel.ownership}`}</Text>
        </>
      )}
      {explicit ? <Text>q/Esc Quit</Text> : null}
    </Box>
  );
}
