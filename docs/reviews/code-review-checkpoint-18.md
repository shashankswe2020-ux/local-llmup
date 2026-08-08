# Code Review Checkpoint 18: Task B9 — `efficiencyByBackend` + per-backend throughput resolution

> **Reviewer:** Code Reviewer Agent (Staff Engineer)
> **Date:** 2026-08-06
> **Scope:** Task B9 (pluggable-backends plan) — uncommitted working-tree changes to `src/advisor/perf-data.ts` (widened `.strict()` `PerfClassSchema`/`PerfSourcesSchema` with optional per-backend efficiency scalars + provenance; `sanitizeDataset` extended over provenance URLs), `src/advisor/throughput.ts` (`resolveEfficiency` + optional `backend` option, default `ollama`), `src/advisor/verdict.ts` (threads optional `backend` through `evaluateVerdict`), and tests `tests/advisor/perf-data.test.ts`, `tests/advisor/throughput.test.ts`.
> **Test suite:** 750/750 passing (49 files); typecheck ✅; build ✅; lint ✅ on all five B9 files (the 2 pre-existing `site/main.js` `no-undef` errors are out of scope). `data/perf.json` confirmed unchanged via `git diff --stat`.

---

## Verdict: ✅ APPROVE

**Overview:** A clean, correctly-scoped, additive change. Every B9 acceptance criterion is met and directly proven: the `.strict()` schemas reject out-of-range values, unknown backend keys, and rogue provenance keys; `schemaVersion` stays `1`; the default-Ollama path is byte-identical (proven by a `bare === backend:'ollama'` test); and an absent `(class, backend)` such as `mlx` is honesty-gated to `known:false`. The `resolveEfficiency` helper encodes the shared-class rule (`ollama`/`llamacpp` reuse the class scalar, no invented delta; everything else → `unknown`) exactly per spec §2.7. No Critical issues. One Important coverage gap (the new `evaluateVerdict` `backend` param is untested) and four Suggestions.

---

## Critical Issues

None.

## Important Issues

### 1. The new `evaluateVerdict` `backend` param has zero test coverage

- **File:** `src/advisor/verdict.ts:65-89`, `tests/advisor/verdict.test.ts`
- **Problem:** `evaluateVerdict` gained a 5th param `backend?: BackendName` that flows into `estimateTokPerSec` and therefore into the yes/slow/no honesty gate — a non-fitting `(class, backend)` pair must downgrade a `yes` to `slow`. The threading typechecks and the underlying `estimateTokPerSec` resolution is thoroughly tested, but `verdict.test.ts` never passes a `backend` argument, so nothing proves the param is actually forwarded (a future refactor could drop it silently) nor that an unsourced backend yields `slow` at the verdict layer. In a TDD codebase, a public-API param feeding the honesty gate should carry at least one behavioral test.
- **Fix:** Add two cases to `tests/advisor/verdict.test.ts`:
  ```ts
  it("honesty-gates an unsourced backend to `slow` (mlx on a matched class)", () => {
    // 7B fits an NVIDIA 24GB class, but mlx has no efficiency scalar → unknown → slow.
    const v = evaluateVerdict(model("7B"), hw(), perf, undefined, "mlx");
    expect(v.runnable).toBe("slow");
    expect(v.throughput.known).toBe(false);
    expect(v.quant?.name).toBe("Q4_K_M");
  });

  it("defaults to ollama — omitting backend equals passing 'ollama'", () => {
    expect(evaluateVerdict(model("7B"), hw(), perf)).toEqual(
      evaluateVerdict(model("7B"), hw(), perf, undefined, "ollama"),
    );
  });
  ```
  (Requires importing `BackendName` only if you annotate; the string literal is enough.)

## Suggestions

### 1. No test proves the provenance-URL sanitize / `rejectOnSanitize` integrity path

- **File:** `src/advisor/perf-data.ts:135-160`, `tests/advisor/perf-data.test.ts`
- The task explicitly extended `sanitizeDataset` so the trusted-dataset integrity gate (`rejectOnSanitize`) covers provenance `url`s, but no test exercises it. A BiDi/control char in a provenance `url` passes `z.string().url()` (the WHATWG parser doesn't throw) yet should be stripped when untrusted and rejected when `rejectOnSanitize` is set. Add one case that a `\u202e`-bearing provenance URL is stripped (default) and another that `parsePerf(raw, { rejectOnSanitize: true })` throws `ValidationError`. This closes the only new security-relevant path in B9 that is currently unverified.

### 2. Per-backend scalars can ship without provenance (asymmetric with D2)

- **File:** `src/advisor/perf-data.ts:40, 76-79`
- Base `sources.bandwidth`/`sources.efficiency` are required (`.min(1)`), but a `efficiencyByBackend` **scalar** carries no obligation to have a matching `sources.efficiencyByBackend` provenance entry. A class could therefore ship `efficiencyByBackend: { mlx: 0.5 }` with no citation and still produce a `known:true` number — softly at odds with decision D2 ("every figure cites its source") and the honesty principle. No live violation today (the dataset has no scalars), so this is a design note for when real scalars land (plan B18). Consider a `.refine()` on `PerfClassSchema` requiring a provenance entry for each backend present in `efficiencyByBackend`.

### 3. Provenance `url` scheme is unrestricted

- **File:** `src/advisor/perf-data.ts:59`
- `z.string().url()` accepts `javascript:`, `file:`, `data:`, etc. Harmless today because the URL is never dereferenced (determinism: advice is offline) nor rendered as a link. Worth constraining to `http(s)` (e.g. `.url().refine(u => /^https?:/i.test(u))`) before any command surfaces provenance to the user, so the constraint predates the first display site rather than trailing it.

### 4. `cleanProvenance`'s intermediate type is hard to read

- **File:** `src/advisor/perf-data.ts:143-152`
- `Record<string, (typeof prov)[keyof typeof prov]>` is an accurate but dense way to type the accumulator. A named alias (e.g. `type BackendProvenance = NonNullable<PerfClass["sources"]["efficiencyByBackend"]>`) reused for the param, return, and `out` would read more directly and remove the indexed-access gymnastics. Cosmetic.

## What's Done Well

- **Honesty gate preserved structurally.** `resolveEfficiency` returns `undefined` for any backend that is neither explicitly scored nor in `SHARED_CLASS_EFFICIENCY_BACKENDS`, and both `estimateTokPerSec` guard clauses (`efficiency === undefined`, then `bytesPerToken`) collapse to the single `UNKNOWN` constant — no fabricated number can escape. The `mlx → known:false` test proves it end-to-end.
- **Byte-identical default is proven, not asserted.** The `bare` vs `backend:'ollama'` equality test, plus `llamacpp` equalling `ollama` when unscored, directly encode the "no invented delta" rule (§2.7) rather than trusting a code comment. The unchanged calibration suite (AC6) still passes, confirming the default path did not shift.
- **Additive schema discipline.** Both new fields are `.optional()`, `schemaVersion` stays `1`, and `git diff --stat` confirms `data/perf.json` is untouched — exactly the "additive/optional, no data change" contract the task demanded. The `.strict()` on both the class and the provenance entry means the schema fails closed on typos and smuggled keys (tested for `rogue`, unknown backend, and bad `trustTier`).
- **The integrity gate was extended, not bypassed.** Provenance URLs run through the same shared `clean` closure that flips the `changed` flag, so `rejectOnSanitize` transparently covers the new strings without a parallel code path.

## Verification Story

| Check            | Status | Notes                                                                                                                                                                                                                                                                  |
| ---------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tests reviewed   | ✅     | 20 new/changed assertions across perf-data & throughput; all four B9 AC directly covered. Gap: `verdict.ts` `backend` param untested (Important 1); provenance-URL sanitize path untested (Suggestion 1).                                                              |
| Build verified   | ✅     | `npm test` 750/750; `tsc --noEmit` clean; `tsc` build clean; ESLint clean on all five B9 files.                                                                                                                                                                        |
| Security checked | ✅     | New input (provenance) fully Zod-validated (`.strict()`, enum keys, `url()`, positive numbers, enum `trustTier`); URLs folded into the `stripControl` integrity gate; URL never dereferenced (offline). Unrestricted URL scheme noted (Suggestion 3), currently inert. |
| Coverage         | ⚠️     | Throughput resolution strongly covered; verdict-level threading and the provenance-sanitize path are the two open gaps.                                                                                                                                                |

## Action Items

| #   | Priority   | Issue                                                                                               | Target    |
| --- | ---------- | --------------------------------------------------------------------------------------------------- | --------- |
| 1   | Important  | Add behavioral tests for `evaluateVerdict`'s `backend` param (honesty-gate `slow` + ollama default) | this task |
| 2   | Suggestion | Test provenance-URL strip (untrusted) + `rejectOnSanitize` rejection (trusted)                      | backlog   |
| 3   | Suggestion | `.refine()` requiring provenance for each `efficiencyByBackend` scalar (D2 parity)                  | B18       |
| 4   | Suggestion | Constrain provenance `url` to `http(s)` before it is surfaced                                       | backlog   |
| 5   | Suggestion | Introduce a named `BackendProvenance` alias to simplify `cleanProvenance` typing                    | backlog   |
