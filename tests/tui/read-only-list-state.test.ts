import { describe, expect, it } from "vitest";
import {
  createReadOnlyListState,
  reduceReadOnlyListState,
  visibleReadOnlyItems,
  type ReadOnlyListItem,
} from "../../src/tui/read-only-list-state.js";

const ITEMS: readonly ReadOnlyListItem[] = [
  { id: "qwen3:14b", searchText: "qwen3:14b qwen3 reasoning ollama" },
  { id: "llama3.1:8b", searchText: "llama3.1:8b llama chat ollama" },
  { id: "deepseek-r1:14b", searchText: "deepseek-r1:14b deepseek reasoning llamacpp" },
  { id: "gemma2:2b", searchText: "gemma2:2b gemma chat ollama" },
  { id: "phi4:14b", searchText: "phi4:14b phi reasoning ollama" },
  { id: "mistral:7b", searchText: "mistral:7b mistral chat ollama" },
];

describe("read-only list state", () => {
  it("navigates by stable id across arrows, pages, home, and end", () => {
    let state = createReadOnlyListState(ITEMS);
    state = reduceReadOnlyListState(ITEMS, state, { type: "move", delta: 1 }, 3);
    expect(state.selectedId).toBe("llama3.1:8b");
    state = reduceReadOnlyListState(ITEMS, state, { type: "page", delta: 1 }, 3);
    expect(state.selectedId).toBe("phi4:14b");
    state = reduceReadOnlyListState(ITEMS, state, { type: "home" }, 3);
    expect(state.selectedId).toBe("qwen3:14b");
    state = reduceReadOnlyListState(ITEMS, state, { type: "end" }, 3);
    expect(state.selectedId).toBe("mistral:7b");
  });

  it("searches case-insensitively and keeps selection keyed by id", () => {
    let state = createReadOnlyListState(ITEMS);
    state = reduceReadOnlyListState(ITEMS, state, { type: "select", id: "deepseek-r1:14b" }, 4);
    state = reduceReadOnlyListState(ITEMS, state, { type: "set-query", query: "REASONING" }, 4);
    expect(visibleReadOnlyItems(ITEMS, state).items.map((item) => item.id)).toEqual([
      "qwen3:14b",
      "deepseek-r1:14b",
      "phi4:14b",
    ]);
    expect(state.selectedId).toBe("deepseek-r1:14b");
  });

  it("moves selection deterministically when filtering removes the selected id", () => {
    let state = createReadOnlyListState(ITEMS);
    state = reduceReadOnlyListState(ITEMS, state, { type: "select", id: "llama3.1:8b" }, 4);
    state = reduceReadOnlyListState(ITEMS, state, { type: "set-query", query: "deepseek" }, 4);
    expect(state.selectedId).toBe("deepseek-r1:14b");
  });

  it("virtualizes to the viewport plus bounded overscan", () => {
    let state = createReadOnlyListState(ITEMS);
    state = reduceReadOnlyListState(ITEMS, state, { type: "end" }, 2);
    const visible = visibleReadOnlyItems(ITEMS, state, 2, 1);
    expect(visible.items.map((item) => item.id)).toEqual([
      "deepseek-r1:14b",
      "gemma2:2b",
      "phi4:14b",
      "mistral:7b",
    ]);
    expect(visible.offset).toBe(2);
    expect(visible.total).toBe(6);
  });

  it("marks at most four unique actionable model ids", () => {
    let state = createReadOnlyListState(ITEMS);
    for (const item of ITEMS.slice(0, 5)) {
      state = reduceReadOnlyListState(ITEMS, state, { type: "toggle-mark", id: item.id }, 4);
    }
    expect(state.markedIds).toEqual([
      "qwen3:14b",
      "llama3.1:8b",
      "deepseek-r1:14b",
      "gemma2:2b",
    ]);
    state = reduceReadOnlyListState(ITEMS, state, { type: "toggle-mark", id: "qwen3:14b" }, 4);
    expect(state.markedIds).not.toContain("qwen3:14b");
  });

  it("tracks search, details, help, and comparison modes explicitly", () => {
    let state = createReadOnlyListState(ITEMS);
    state = reduceReadOnlyListState(ITEMS, state, { type: "open-search" }, 4);
    expect(state.searchActive).toBe(true);
    state = reduceReadOnlyListState(ITEMS, state, { type: "close-search" }, 4);
    state = reduceReadOnlyListState(ITEMS, state, { type: "toggle-detail" }, 4);
    expect(state.detailOpen).toBe(true);
    state = reduceReadOnlyListState(ITEMS, state, { type: "toggle-help" }, 4);
    expect(state).toMatchObject({ detailOpen: false, helpOpen: true });
    state = reduceReadOnlyListState(ITEMS, state, { type: "toggle-mark", id: "qwen3:14b" }, 4);
    state = reduceReadOnlyListState(ITEMS, state, { type: "toggle-mark", id: "llama3.1:8b" }, 4);
    state = reduceReadOnlyListState(ITEMS, state, { type: "toggle-compare" }, 4);
    expect(state).toMatchObject({ detailOpen: false, helpOpen: false, compareOpen: true });
  });

  it("shows an explicit empty-filter state and supports reset", () => {
    let state = createReadOnlyListState(ITEMS);
    state = reduceReadOnlyListState(ITEMS, state, { type: "set-query", query: "absent" }, 4);
    expect(visibleReadOnlyItems(ITEMS, state).items).toEqual([]);
    expect(state.selectedId).toBeNull();
    state = reduceReadOnlyListState(ITEMS, state, { type: "reset-query" }, 4);
    expect(state.query).toBe("");
    expect(state.selectedId).toBe("qwen3:14b");
  });

  it("ignores selections and marks for unknown ids", () => {
    const initial = createReadOnlyListState(ITEMS);
    const selected = reduceReadOnlyListState(ITEMS, initial, { type: "select", id: "unknown" }, 4);
    const marked = reduceReadOnlyListState(ITEMS, initial, { type: "toggle-mark", id: "unknown" }, 4);
    expect(selected).toEqual(initial);
    expect(marked).toEqual(initial);
  });
});
