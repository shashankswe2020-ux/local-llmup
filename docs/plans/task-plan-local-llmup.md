# Implementation Plan: local-llmup

> Source spec: [docs/specs/local-llmup.md](../specs/local-llmup.md)
> Status: **Approved — ready for implementation**
> Last updated: 2026-08-04

## Overview

Build `local-llmup`, a hardware-aware CLI that (1) recommends a ranked list of
open-weight local LLMs for the current machine, (2) installs + serves a model in
one line, (3) migrates memory between models, and (4) keeps its catalog fresh via
a weekly GitHub Actions pipeline. Work is sliced vertically so the **headline
`recommend` feature ships first** (Tasks 6–11, no backend/state/memory needed),
then serving, then memory/migrate, then the enrichment pipeline.

> **v2 revisions** (from code-review + test-engineering of the v1 plan): added a
> shared-types task (T2) and an output-formatter task (T10); extracted a reusable
> **model resolver** (T14); split oversized tasks — ranking (T8/T9), the Ollama
> adapter (T15/T16/T17), and migrate (T25/T26); kept the adapter **stateless**
> (state writes live in the command layer); restored the `catalog` command (T29);
> fixed dependency edges (`up` no longer depends on the `recommend` command;
> `down`/`ls`/`switch` depend on backend+state, not `up`); added cross-cutting
> testing conventions and a CI coverage gate.

## Architecture Decisions (from spec)

- **cac** CLI; **Zod** at every boundary; **Ollama** the sole v1 backend behind
  a stateless `BackendAdapter` interface.
- Single shared `memory-math` module feeds both the ranker and the pipeline.
- Deterministic ranking: recency pinned to `catalog.generatedAt`, explicit
  tie-break, five weights summing to 1, estimated `speedScore` (no live bench).
- Runtime truth in `~/.local-llmup/state.json` + lock file; memory store is
  `schemaVersion`'d, `0700/0600`, path-slugged.
- Security: `shell:false` spawns, model-id allow-list regex, host allow-list
  (anti-SSRF), SHA-256 weight verification, loopback-only by default.

## Dependency Graph

```
T0 scaffold ─► T1 config+errors ─► T2 shared types
                                     ├─► T3 schema ─► T4 loader ─► T5 seed
                                     ├─► T6 memory-math
                                     └─► T7 hardware detect
{T3,T6}►T8 rank-fit ►T9 rank-score          T1►T10 formatter
{T4,T5,T7,T9,T10}►────────────► T11 recommend      ◄── HEADLINE (demo)

T1►T12 state+lock      T2►T13 adapter iface+utils      {T4,T12}►T14 resolver
T13►T15 pull+verify ►T16 serve+health ►T17 daemon lifecycle+cleanup
{T4,T7,T10,T12,T14,T17}►T18 up
{T12,T14,T17}►T19 down+ls ; ►T20 switch ; {T7,T12,T13,T17}►T21 doctor

T1►T22 memory store
{T17,T22}►T23 chat capture ►{T12,T14,T23}►T24 chat cmd
{T17,T22}►T25 migrate logic ; T22►T26 migrate staging ; {T25,T26,T14}►T27 migrate cmd

{T3,T4,T5,T6,T13}►T28 enrich (dual-mode) ►T28b bootstrap full catalog
{T4,T28}►T29 catalog cmd
{T11,T28,T29}►T30 CI + refresh workflow (incremental) + coverage gate ►T31 docs+publish
```

## Cross-cutting testing conventions (apply to every task)

- **Mock boundaries only:** `fetch`, `child_process`, `fs`. No real downloads,
  servers, or network in unit/integration tests.
- **Frozen clock** (`vi.setSystemTime` + pinned `catalog.generatedAt`) gates
  every module that writes or reads time: ranking (T9), state (T12), migrate
  metadata (T25), enrich `generatedAt` (T28).
- **Atomicity/perms need a real tmpdir** (mocks can't prove them): T22, T25/T26.
- **Uniform exit-code matrix:** one table-driven test asserts each command's
  codes (0 success, user-error, backend-missing, internal).
- **Safe-default is conservative:** hardware fallbacks must under-report memory,
  never over-report (prevents OOM recommendations).
- **Coverage gate in CI** (T30) fails the build below the targets, so they are
  enforced, not aspirational.

---

## Task List

### Phase 0 — Scaffold

#### T0: Project scaffold + CLI skeleton ✅ done
**Description:** TypeScript ESM project + tooling + a `cac` CLI dispatching the
**nine** spec subcommands (`recommend`, `up`, `chat`, `down`, `switch`,
`migrate`, `ls`, `catalog`, `doctor`) as stubs.
**Acceptance:**
- [x] `package.json` (ESM, `bin: {llmup, local-llmup}`, scripts §7), strict `tsconfig`, ESLint+Prettier, `vitest.config.ts`.
- [x] `--help` and each `<cmd> --help` list the nine commands (asserted against a command registry).
**Verify:** `npm run build && npm run typecheck && npm run lint && npm test`; `node dist/cli.js --help`.
**Deps:** None **Files:** `package.json`, `tsconfig.json`, `.eslintrc.cjs`, `.prettierrc`, `vitest.config.ts`, `src/cli.ts` **Scope:** M

### Phase 1 — Foundation

#### T1: Config paths + typed errors ✅ done
**Acceptance:**
- [x] `config.ts` resolves `~/.local-llmup` paths; honors `LOCAL_LLMUP_HOME` (env cleaned between tests).
- [x] `errors.ts` base + subclasses (validation, backend, memory, catalog).
**Verify:** `npm test tests/config tests/errors` **Deps:** T0 **Files:** `src/config.ts`, `src/errors.ts`, +tests **Scope:** S

#### T2: Shared types ✅ done
**Description:** Central `HardwareProfile` and catalog model/quant types (or a
primitives-based sizing input) so ranking, hardware, and enrich don't cross-couple.
**Acceptance:**
- [x] `HardwareProfile` + catalog types exported; consumed by T6/T7/T8; no hardware import leaks into enrich.
**Verify:** `npm run typecheck` **Deps:** T1 **Files:** `src/types.ts`, +test **Scope:** XS

#### T3: Catalog Zod schema (dense/MoE + license gate)
**Acceptance:**
- [ ] Rejects non-allow-listed license (enumerated cases incl. missing/empty/unknown), `moe` without `activeParams`, negative/missing quant bytes.
- [ ] Optional `sha256`/`digestVerified`; exports inferred types.
**Verify:** `npm test tests/catalog/schema` **Deps:** T2 **Files:** `src/catalog/schema.ts`, +fixtures, +test **Scope:** S

#### T4: Catalog loader
**Acceptance:**
- [ ] Valid loads; **malformed-JSON vs schema-invalid** distinguished; both throw `CatalogError`.
- [ ] Control/ANSI stripped from display fields; optional integrity check on seed.
**Verify:** `npm test tests/catalog/load` **Deps:** T3 **Files:** `src/catalog/load.ts`, +test **Scope:** S

#### T5: Dev seed + test fixtures (`data/models.json` bootstrap-ready)
**Description:** A small, hand-curated `data/models.json` + fixtures sufficient
for dev and tests. The **exhaustive** production catalog (all open-weight models
to date) is generated later by the one-time bootstrap (T28b), not hand-written.
**Acceptance:**
- [ ] Validates vs schema (test); asserts by **capability class** (≥1 large MoE `kimi-k2`, several small-fit) not brittle IDs.
- [ ] Covers Kimi + Llama/Qwen/DeepSeek/Mistral/Gemma/Phi/GLM/SmolLM as dev data; fixtures cover ranking/enrich edge cases.
**Verify:** `npm test tests/catalog/seed` **Deps:** T3 **Files:** `data/models.json`, +fixtures, +test **Scope:** S

### Checkpoint: Foundation (T0–T5) — build/typecheck/lint/test green; seed validates.

### Phase 2 — Hardware + Ranking (headline slice)

#### T6: Memory math (dense + MoE)
**Acceptance:**
- [ ] `usableMemoryBytes`: unified/discrete-VRAM/free-RAM/no-double-count, each with an exactly-fits + off-by-one-byte boundary case.
- [ ] `requiredMemoryBytes` MoE uses **total** params; guards for zero/negative/NaN/missing quant bytes.
**Verify:** `npm test tests/hardware/memory-math` **Deps:** T2 **Files:** `src/hardware/memory-math.ts`, +test **Scope:** S

#### T7: Hardware detection
**Acceptance:**
- [ ] Mocked `systeminformation` → valid profile; no-GPU, multi-GPU (assert largest-single selection), integrated (VRAM null), **hung-probe timeout via fake timers**, malformed→**conservative** safe default.
**Verify:** `npm test tests/hardware/detect` **Deps:** T2 (parallel to T6) **Files:** `src/hardware/detect.ts`, +test **Scope:** M

#### T8: Ranking — fit + quant selection
**Acceptance:**
- [ ] Best-fitting quant per model; `fits()` filter with headroom; typed won't-fit reasons (`ram-bound`/`vram-bound`/`disk-bound`).
- [ ] `kimi-k2` excluded `ram-bound`; MoE that fits by active-params but not total → correct rule wins.
**Verify:** `npm test tests/ranking/fit` **Deps:** T3, T6 **Files:** `src/ranking/fit.ts`, +test **Scope:** S

#### T9: Ranking — scoring + tie-break
**Acceptance:**
- [ ] Five-dim score incl. deterministic `speedScore`; recency pinned to `catalog.generatedAt`; frozen-clock determinism.
- [ ] Tie-break benchmarkProxy→releaseDate→id (incl. all-keys-equal stable order); weights-sum-to-1 invariant asserted at boundary (0.999/1.001).
- [ ] Empty-catalog vs all-too-big return **distinct** clean results/messaging.
**Verify:** `npm test tests/ranking/score` **Deps:** T8 **Files:** `src/ranking/weights.ts`, `src/ranking/rank.ts`, +test **Scope:** M

#### T10: Output formatter
**Description:** Shared, ANSI-safe table + `--json` renderer used by `recommend`,
`ls`, `doctor`.
**Acceptance:**
- [ ] Stable `--json` shape (contract test); control chars stripped in table + json.
**Verify:** `npm test tests/output` **Deps:** T1 **Files:** `src/output.ts`, +test **Scope:** S

#### T11: `recommend` command
**Acceptance:**
- [ ] Integration (fixture catalog + fake hardware): ranked table + won't-fit section + `up` cmd for #1.
- [ ] `--task` neutral == no-flag (regression guard); `--json` schema asserted.
**Verify:** `npm test tests/commands/recommend` **Deps:** T4, T5, T7, T9, T10 **Files:** `src/commands/recommend.ts`, `src/cli.ts`, +test **Scope:** M

### Checkpoint: Headline (T6–T11) — `local-llmup` prints a correct ranked recommendation on real hardware. **Demo-able.**

### Phase 3 — State + Backend + Serve

#### T12: Runtime state + lock
**Acceptance:**
- [ ] Atomic temp+rename; **deterministic interleave** proves lock serialization (barrier, not timing); stale lock (dead PID) recovered, not deadlocked.
- [ ] Corrupt state distinguished: unparseable vs schema-invalid vs zero-byte.
**Verify:** `npm test tests/state` **Deps:** T1 **Files:** `src/state/state.ts`, +test **Scope:** M

#### T13: Backend adapter interface + safety utils
**Acceptance:**
- [ ] `BackendAdapter` interface (stateless); model-id allow-list (`^[a-z0-9._:\/-]+$`) and host allow-list reject invalid ids and non-HTTPS/private/`localhost`/`0.0.0.0`/link-local/`::1`/credentialed/odd-port URLs.
**Verify:** `npm test tests/backend/adapter` **Deps:** T2 **Files:** `src/backend/adapter.ts`, `src/backend/net.ts`, +test **Scope:** S

#### T14: Model resolver
**Description:** Fuzzy `resolve(input) → catalog/installed entry` reused by
`up`/`down`/`switch`/`migrate`; ambiguity lists candidates.
**Acceptance:**
- [ ] Resolves `llama3.1`/`llama3.1:8b`/`…-q4_K_M`; ambiguous→typed error with candidates; traversal-y ids rejected.
**Verify:** `npm test tests/resolver` **Deps:** T4, T12 **Files:** `src/resolver.ts`, +test **Scope:** S

#### T15: Ollama adapter — pull + digest verify
**Acceptance:**
- [ ] `spawn(...,{shell:false})` pull w/ progress; SHA-256 verify; **digest-unavailable → defined size-only fallback + `digestVerified:false`** (not fail-open); digest mismatch **fail-closed**.
**Verify:** `npm test tests/backend/ollama-pull` **Deps:** T13 **Files:** `src/backend/ollama.ts` (pull), +test **Scope:** S

#### T16: Ollama adapter — serve + health
**Acceptance:**
- [ ] `/v1/models` (fallback `/api/tags`) readiness with backoff; ready-on-Nth-attempt; **health timeout vs fail** both surface typed errors.
**Verify:** `npm test tests/backend/ollama-serve` **Deps:** T15 **Files:** `src/backend/ollama.ts` (serve/health), +test **Scope:** S

#### T17: Ollama adapter — daemon lifecycle + cleanup
**Acceptance:**
- [ ] Attach-vs-spawn returns a handle with `ownedByUs`; serve/health **failure or timeout** cleans up only spawned processes (no orphan); already-running daemon → `ownedByUs:false` and **never** killed.
**Verify:** `npm test tests/backend/ollama-lifecycle` **Deps:** T16 **Files:** `src/backend/ollama.ts` (lifecycle), +test **Scope:** M

#### T18: `up` command
**Acceptance:**
- [ ] Order: resolve → disk preflight → ensure backend → pull+verify → serve → health → **state write (in command layer)**; binds `127.0.0.1` (rejects `0.0.0.0` regression).
- [ ] Insufficient disk aborts (injectable disk probe); missing backend prints install cmd + nonzero exit.
**Verify:** `npm test tests/commands/up` **Deps:** T4, T7, T10, T12, T14, T17 **Files:** `src/commands/up.ts`, `src/cli.ts`, +test **Scope:** M

### Checkpoint: Serve-core (T12–T18) — `up` serves a model end-to-end (mocked backend), loopback verified.

#### T19: `down` + `ls`
**Acceptance:**
- [ ] `down` stops only `ownedByUs` daemons, idempotent no-op when none; `ls` reflects state.
**Verify:** `npm test tests/commands/down tests/commands/ls` **Deps:** T12, T14, T17 **Files:** `src/commands/down.ts`, `src/commands/ls.ts`, +tests **Scope:** S

#### T20: `switch`
**Acceptance:**
- [ ] Switches active model; failure preserves prior active; switching to already-active is a defined no-op.
**Verify:** `npm test tests/commands/switch` **Deps:** T12, T14, T17 **Files:** `src/commands/switch.ts`, +test **Scope:** S

#### T21: `doctor`
**Acceptance:**
- [ ] Reports missing backend/unsupported hw/corrupt catalog+state; surfaces `digestVerified:false`; **returns nonzero when problems found**.
**Verify:** `npm test tests/commands/doctor` **Deps:** T7, T12, T13, T17 **Files:** `src/commands/doctor.ts`, +test **Scope:** S

### Checkpoint: Serve (T19–T21) — all serve commands green; exit-code matrix asserted.

### Phase 4 — Memory + Migrate + Chat

#### T22: Memory store
**Acceptance:**
- [ ] `schemaVersion`'d read/write; id→safe-slug + `realpath` traversal defense; **slug-collision** must not silently overwrite; `0600` verified via `fs.stat` mode (umask-hostile env); corrupt store graceful.
**Verify:** `npm test tests/memory/store` **Deps:** T1 **Files:** `src/memory/store.ts`, +test **Scope:** M

#### T23: Chat capture logic
**Acceptance:**
- [ ] Appends turns; rule-based fact extraction; optional embeddings with model+dim in `meta.json`; control/ANSI stripped.
**Verify:** `npm test tests/memory/capture` **Deps:** T17, T22 **Files:** `src/memory/capture.ts`, +test **Scope:** S

#### T24: `chat` command
**Acceptance:**
- [ ] Forwards to backend, streams reply, invokes capture with the **asserted payload** (not just call count).
**Verify:** `npm test tests/commands/chat` **Deps:** T12, T14, T23 **Files:** `src/commands/chat.ts`, `src/cli.ts`, +test **Scope:** S

#### T25: Migrate logic (remap + summarize + re-embed)
**Acceptance:**
- [ ] Context remap **smaller** (summarizer called with overflow turns, keeps system+facts) **and larger** (no summarization).
- [ ] Re-embed **4-way matrix** (model×dim) fires only where required; `facts.json` byte-identical.
**Verify:** `npm test tests/memory/migrate-logic` **Deps:** T17, T22 **Files:** `src/memory/migrate.ts` (logic), +test **Scope:** M

#### T26: Migrate staging (atomic + rollback)
**Acceptance:**
- [ ] Stage in home-dir (same-fs) + rename; **crash between write and rename → original intact** (real tmpdir); `--move` preserves source on **write and post-copy verify** failure.
**Verify:** `npm test tests/memory/migrate-staging` **Deps:** T22 **Files:** `src/memory/migrate.ts` (staging), +test **Scope:** S

#### T27: `migrate` command
**Acceptance:**
- [ ] `--from --to [--move] [--dry-run]`; `--dry-run` asserts **zero fs writes** (spy); summary (carried/summarized/re-embedded/strategy).
**Verify:** `npm test tests/commands/migrate` **Deps:** T14, T25, T26 **Files:** `src/commands/migrate.ts`, `src/cli.ts`, +test **Scope:** S

### Checkpoint: Memory (T22–T27) — chat records memory; `migrate` moves it with re-embed + rollback safety.

### Phase 5 — Pipeline + CI + Release

#### T28: Catalog enrichment (`enrich.ts`, dual-mode)
**Description:** One code path with two modes: **backfill** (sweep the full
open-weight set — used once by T28b to build the exhaustive v1 catalog) and
**incremental** (weekly default — only releases newer than the catalog).
**Acceptance:**
- [ ] Mocked HF/Ollama fetch behind host allow-list; size via shared `memory-math`; license gate.
- [ ] **Incremental** considers only entries newer than the catalog's newest known ids/`releaseDate`; never re-seeds existing entries.
- [ ] **Merge-by-id**: idempotent across two runs (no diff on run 2); curated field survives an upstream value **change**; partial failure keeps prior data and **drops** a half-formed new entry; license transition (open→proprietary) removes on re-enrich; size cap enforced.
**Verify:** `npm test tests/catalog/enrich` **Deps:** T3, T4, T5, T6, T13 **Files:** `src/catalog/enrich.ts`, +registry fixtures, +test **Scope:** M

#### T28b: One-time full catalog bootstrap
**Description:** Run `enrich` in **backfill** mode (against recorded/live
registry data) to generate the **exhaustive** `data/models.json` — every
open-weight model released to date — and commit it as the shipped v1 catalog.
This is a data-generation task, not new runtime code.
**Acceptance:**
- [ ] Generated catalog validates vs schema and is materially complete (spot-checked against llmfit's `data/` for coverage, incl. all Kimi releases).
- [ ] Deterministic/reproducible from the recorded registry snapshot (frozen clock); committed catalog matches a re-run.
**Verify:** `npm test tests/catalog/bootstrap` (validate generated file) + manual coverage spot-check **Deps:** T28 **Files:** `data/models.json` (regenerated), `scripts/bootstrap-catalog.ts`, +test **Scope:** M

#### T29: `catalog` command (show + `--refresh`)
**Acceptance:**
- [ ] Shows catalog (fits/all filter, stable format); `--refresh` runs enrich **incremental** locally and reports the diff without committing.
**Verify:** `npm test tests/commands/catalog` **Deps:** T4, T28 **Files:** `src/commands/catalog.ts`, `src/cli.ts`, +test **Scope:** S

#### T30: CI + weekly catalog-refresh workflow + coverage gate
**Acceptance:**
- [ ] `ci.yml` runs lint/typecheck/test/build and **fails below coverage targets** — **≥80% line + ≥80% branch** on `src/{ranking,hardware,catalog,memory,backend,state}/`, **≥70% line overall** (Vitest `coverage.thresholds`).
- [ ] `catalog-refresh.yml`: weekly cron + `workflow_dispatch`; runs enrich in **incremental** mode (new models only); YAML-parse test asserts **minimal `permissions`**, **all `uses:` SHA-pinned** (not tags), **no `git push` to protected branch** (PR-only); runs enrich dry-run asserting **zero writes**.
**Verify:** `actionlint` + YAML-assertion test + `npm test tests/catalog/enrich`.
**Deps:** T11, T28 **Files:** `.github/workflows/ci.yml`, `.github/workflows/catalog-refresh.yml`, +workflow-assertion test **Scope:** M

#### T31: Docs + publish prep
**Acceptance:**
- [ ] README documents the four one-liners; a parity test checks README ↔ command registry.
- [ ] `npm pack --dry-run` **excludes** `tests/`, `.env`, tokens (allowlist test); `package.json` publish metadata + `.npmignore`.
**Verify:** `npm run build && npm pack --dry-run` + parity test **Deps:** T30 **Files:** `README.md`, `LICENSE`, `package.json`, `.npmignore` **Scope:** S

### Checkpoint: Complete (T28–T31) — exhaustive v1 catalog bootstrapped (T28b), weekly pipeline adds only new models, coverage gate green, ready for review + publish.

---

## Parallelization

- **Sequential spine:** T0 → T1 → T2 → (T3→T4→T5) → T6 → T8 → T9 → T11 (headline).
- **Parallel after T2:** T6 (memory-math) ∥ T7 (hardware detect); T10 (formatter) after T1.
- **Parallel after T11:** backend chain (T12/T13 → T14 → T15→T16→T17 → T18 → T19/T20/T21) ∥ enrichment (T28 needs T13). Memory chain (T22 → T23/T25 → T24/T26 → T27) needs T17 for the summarizer/embeddings path.
- **Contract-first:** land T2 (types) and T13 (`BackendAdapter`) before dependents so parallel work targets stable interfaces.

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| `systeminformation` variance; slow/hung GPU probe vs <5s goal | High | Fallback probes + fake-timer timeout → conservative default (T7); cache profile |
| Wrong catalog memory numbers → OOM recs | High | Shared `memory-math` (T6/T28); MoE total-param sizing; HEADROOM; conservative fallback |
| Ollama shared-daemon lifecycle mismatches `down`/`switch` | Med | Stateless adapter + `ownedByUs`; stop only owned daemons (T17/T19) |
| Registries lack per-quant SHA-256 | Med | Size-only fallback + `digestVerified:false` surfaced in `doctor` (T15/T21) |
| Migrate atomicity/rollback edge cases | Med | Home-dir same-fs rename; real-tmpdir crash tests; `--move` deletes only after commit+verify (T26) |
| Enrichment clobbers curated fields / unbounded growth / poisoned catalog | Med | Merge-by-id preserve rules + idempotency + size cap + integrity check (T28) |
| GitHub Actions supply-chain | Med | Least-privilege perms, SHA-pinned actions, PR-only, masked secrets; YAML-assertion test (T30) |
| Coverage targets stay aspirational | Low | CI gate fails build below thresholds (T30) |

## Open Questions (for human)

_None — all resolved._

## Resolved Decisions

- **Runtime deps:** `cac` + `systeminformation` approved as the only new runtime
  dependencies (2026-08-04).
- **Coverage gates:** recommended values confirmed (2026-08-04) — **≥80% line +
  branch** on `ranking/hardware/catalog/memory/backend/state`, **≥70% line
  overall**; enforced by the T30 CI gate.
- **Seed breadth:** v1 ships an **exhaustive** catalog of all open-weight models
  to date, generated once via the bootstrap (T28b); the weekly pipeline runs in
  **incremental** mode and only adds newly released models.
