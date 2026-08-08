import { freezeDeep } from "../immutable.js";
import { sanitizeTerminalText } from "./sanitize.js";

export interface ReadOnlyListItem {
  readonly id: string;
  readonly searchText: string;
}

export interface ReadOnlyListState {
  readonly selectedId: string | null;
  readonly query: string;
  readonly searchActive: boolean;
  readonly detailOpen: boolean;
  readonly helpOpen: boolean;
  readonly compareOpen: boolean;
  readonly markedIds: readonly string[];
}

export type ReadOnlyListAction =
  | { readonly type: "move"; readonly delta: -1 | 1 }
  | { readonly type: "page"; readonly delta: -1 | 1 }
  | { readonly type: "home" }
  | { readonly type: "end" }
  | { readonly type: "select"; readonly id: string }
  | { readonly type: "set-query"; readonly query: string }
  | { readonly type: "reset-query" }
  | { readonly type: "open-search" }
  | { readonly type: "close-search" }
  | { readonly type: "toggle-detail" }
  | { readonly type: "toggle-help" }
  | { readonly type: "toggle-compare" }
  | { readonly type: "toggle-mark"; readonly id: string };

export interface VisibleReadOnlyItems<T extends ReadOnlyListItem> {
  readonly items: readonly T[];
  readonly offset: number;
  readonly total: number;
}

const MAX_MARKED_ITEMS = 4;
const DEFAULT_VIEWPORT_SIZE = 20;
const DEFAULT_OVERSCAN = 2;

function matchingItems<T extends ReadOnlyListItem>(
  items: readonly T[],
  query: string,
): readonly T[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return items;
  return items.filter((item) => item.searchText.toLowerCase().includes(needle));
}

function selectedFor<T extends ReadOnlyListItem>(
  items: readonly T[],
  selectedId: string | null,
): string | null {
  if (selectedId !== null && items.some((item) => item.id === selectedId)) return selectedId;
  return items[0]?.id ?? null;
}

function nextState(
  state: ReadOnlyListState,
  patch: Partial<ReadOnlyListState>,
): ReadOnlyListState {
  return freezeDeep({ ...state, ...patch });
}

export function createReadOnlyListState(
  items: readonly ReadOnlyListItem[],
): ReadOnlyListState {
  return freezeDeep({
    selectedId: items[0]?.id ?? null,
    query: "",
    searchActive: false,
    detailOpen: false,
    helpOpen: false,
    compareOpen: false,
    markedIds: [],
  });
}

export function reduceReadOnlyListState<T extends ReadOnlyListItem>(
  items: readonly T[],
  state: ReadOnlyListState,
  action: ReadOnlyListAction,
  viewportSize: number = DEFAULT_VIEWPORT_SIZE,
): ReadOnlyListState {
  const filtered = matchingItems(items, state.query);
  const selectedIndex = Math.max(
    0,
    filtered.findIndex((item) => item.id === state.selectedId),
  );

  switch (action.type) {
    case "move": {
      if (filtered.length === 0) return state;
      const index = Math.max(0, Math.min(filtered.length - 1, selectedIndex + action.delta));
      return nextState(state, { selectedId: filtered[index]?.id ?? null });
    }
    case "page": {
      if (filtered.length === 0) return state;
      const page = Math.max(1, viewportSize);
      const index = Math.max(
        0,
        Math.min(filtered.length - 1, selectedIndex + action.delta * page),
      );
      return nextState(state, { selectedId: filtered[index]?.id ?? null });
    }
    case "home":
      return nextState(state, { selectedId: filtered[0]?.id ?? null });
    case "end":
      return nextState(state, { selectedId: filtered.at(-1)?.id ?? null });
    case "select":
      return items.some((item) => item.id === action.id)
        ? nextState(state, { selectedId: action.id })
        : state;
    case "set-query": {
      const query = sanitizeTerminalText(action.query, "single_line", {
        maxBytes: 256,
        maxColumns: 256,
      });
      const nextItems = matchingItems(items, query);
      return nextState(state, {
        query,
        selectedId: selectedFor(nextItems, state.selectedId),
        detailOpen: false,
        compareOpen: false,
      });
    }
    case "reset-query":
      return nextState(state, {
        query: "",
        selectedId: selectedFor(items, state.selectedId),
        searchActive: false,
      });
    case "open-search":
      return nextState(state, { searchActive: true, helpOpen: false });
    case "close-search":
      return nextState(state, { searchActive: false });
    case "toggle-detail":
      return nextState(state, { detailOpen: !state.detailOpen, helpOpen: false });
    case "toggle-help":
      return nextState(state, { helpOpen: !state.helpOpen, detailOpen: false });
    case "toggle-compare":
      return state.markedIds.length < 2
        ? state
        : nextState(state, {
            compareOpen: !state.compareOpen,
            detailOpen: false,
            helpOpen: false,
            searchActive: false,
          });
    case "toggle-mark": {
      if (!items.some((item) => item.id === action.id)) return state;
      if (state.markedIds.includes(action.id)) {
        return nextState(state, {
          markedIds: state.markedIds.filter((id) => id !== action.id),
          compareOpen: false,
        });
      }
      if (state.markedIds.length >= MAX_MARKED_ITEMS) return state;
      return nextState(state, { markedIds: [...state.markedIds, action.id] });
    }
  }
}

export function visibleReadOnlyItems<T extends ReadOnlyListItem>(
  items: readonly T[],
  state: ReadOnlyListState,
  viewportSize: number = DEFAULT_VIEWPORT_SIZE,
  overscan: number = DEFAULT_OVERSCAN,
): VisibleReadOnlyItems<T> {
  const filtered = matchingItems(items, state.query);
  const viewport = Math.max(1, Math.floor(viewportSize));
  const extra = Math.max(0, Math.floor(overscan));
  const selectedIndex = Math.max(
    0,
    filtered.findIndex((item) => item.id === state.selectedId),
  );
  const coreStart = Math.max(0, Math.min(selectedIndex, filtered.length - viewport));
  const targetLength = Math.min(filtered.length, viewport + extra * 2);
  const offset = Math.max(0, Math.min(coreStart - extra, filtered.length - targetLength));
  return freezeDeep({
    items: filtered.slice(offset, offset + targetLength),
    offset,
    total: filtered.length,
  });
}
