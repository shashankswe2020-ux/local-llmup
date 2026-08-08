# Implementation Plan: local-llmup — Pluggable Inference Backends

> Source spec: [docs/specs/pluggable-inference-backends.md](../specs/pluggable-inference-backends.md) (Draft v0.5)
> Related: [docs/specs/local-llmup.md](../specs/local-llmup.md), [docs/specs/hardware-advisor.md](../specs/hardware-advisor.md)
> Status: **Draft — pending human approval + sub-agent review**
> Last updated: 2026-08-08

## Overview

Take `local-llmup` from a single-backend (Ollama) tool to a **pluggable
multi-runtime** tool, adding `llama.cpp`, `MLX`, and `LM Studio` adapters behind
the existing `BackendAdapter` contract — while preserving every domain
invariant (honesty gate, deterministic offline advice, fail-closed integrity,
loopback-only serving). vLLM (spec §10 Q4) is **deferred** and not tasked here.

Delivery is **five phases, each independently shippable and green**:

- **Phase 0 (B1–B6):** foundation refactor — registry, config, state schema v2,
  `select()`, capability flags; route **all six** command construction sites
  through them. **Ollama stays the only adapter; output byte-identical.**
- **Phase 1 (B7–B12):** catalog `source` extension, per-backend throughput
  plumbing, vector-less embedding gating, and `doctor`/`recommend` backend
  surfacing. **Still Ollama-only servable.**
- **Phase 2 (B13–B16):** first real second runtime — `llama.cpp` (GGUF), the
  self-managed weight-acquisition path, and the shared adapter contract suite.
- **Phase 3 (B17–B18):** `MLX` adapter + Apple-Silicon auto-detect priority.
- **Phase 4 (B19):** `LM Studio` adapter (attach-only trust boundary).

All backend logic lives **behind `BackendAdapter`**; command code branches only
through the registry/`select()`. Every new external input (config, extended
`source`, backend responses) is Zod-validated at the boundary. No `any`; named
exports; explicit return types.

## Confirmed decisions (spec §10 — all resolved, no blockers)

| # | Decision | Affects |
|---|---|---|
| Q1 | Auto-detect priority: Apple Silicon `mlx→ollama→llamacpp`; else `ollama→llamacpp` | B5, B18 |
| Q2 | GGUF/MLX pull via **direct native `fetch`**, no new dependency | B13 |
| Q3 | Embedding fallback is **vector-less** (no second process) | B10 |
| Q4 | **vLLM deferred** to a follow-up spec (not tasked) | — |
| Q5 | `--available-backends` is **opt-in** | B12 |
| Q6 | Emerging runtimes (SGLang, ktransformers, …) out of v1 scope | — |

## Blocking decisions (sign-off before the noted tasks)

These are **data/curation** decisions, not architecture; they do not block
Phase 0/1. Proposed defaults given.

| # | Decision | Blocks | Proposed default |
|---|---|---|---|
| D1 | Which catalog models get `gguf` sources + where digests come from | B15 | 3–5 popular models (e.g. Qwen3, Llama-3.1, Mistral) from official HF GGUF repos; `sha256` cross-checked against HF LFS pointer at ingest |
| D2 | `(class, llamacpp)` efficiency rows: reuse existing class scalar (shared with ollama) vs re-derive per §12.2b | B15 | Reuse existing class scalar (spec §2.7 — `ollama`/`llamacpp` share); no NVIDIA re-derivation in this effort |
| D3 | `(class, mlx)` efficiency: ship `unknown` vs seed a cited low-confidence value | B18 | Ship **`unknown`** (spec §12.2c — no reproducible primary source) |
| D4 | Minimum `llama-server` / `mlx_lm` / `lms` versions the adapters target | B14a, B16, B17, B19 | MLX permits audited `mlx-lm==0.31.3` only (latest non-yanked stable verified 2026-08-08); others recorded at implementation |

## Architecture decisions

- **Registry is the only construction site.** Commands receive a
  `BackendRegistry` in their `Deps` and never call `new *Adapter()`. A grep/lint
  guard forbids `new *Adapter()` under `src/commands/`.
- **`select()` splits by command intent** (spec §2.2): create-intent
  (`up`) = flag → env → config → auto-detect; attach-intent
  (`down`/`chat`/`switch`) = `state.active.backend` **dominates**, and a
  conflicting `--backend`/env is a `ValidationError`.
- **Adapters stay stateless.** All runtime facts (backend, pid, endpoint, port,
  ownership) live in `state.json`; schema bumped **v1 → v2** with in-memory
  v1→v2 normalization (default `backend: "ollama"`).
- **Throughput stays a pure roofline.** Per-`(class, backend)` efficiency is an
  **absolute scalar** in `efficiencyByBackend`; `ollama` and `llamacpp` share
  the existing class `efficiency` (no invented delta); `mlx`/`vllm` are absent →
  honesty-gated `unknown`. The reported range remains the estimator's existing
  ±30% `DEFAULT_BAND_FRACTION` (no second stored band).
- **Advice path never probes installation.** `recommend`/`can-run` are
  deterministic and offline; `throughputBackend` defaults to `ollama` (not the
  serving-path auto-selection). `select()`'s `isInstalled()` branch is reachable
  only from the serving path.
- **Self-managed weight acquisition is a shared, guarded module** (B13): direct
  HTTPS `fetch` from pinned HF commit → `assertSafeFetchUrl` → temp `0600` file
  in `0700` cache → digest-verify → atomic rename. Never serve a partial.
- **Port-ownership preflight is a contract obligation.** Before spawning, `up`
  probes the target port (llama.cpp/mlx/llamafile share 8080) and refuses to
  claim ownership of a foreign server (attach `ownedByUs:false` or `BackendError`).

## Dependency graph

```
┌──────────────── Phase 0: foundation refactor (Ollama-only, no behavior change) ─────┐
 B1 capabilities+ModelFormat+Ollama descriptor
   B1 ► B2 registry.ts
   B1 ► B3 config loader (loadUserConfig)
   B1 ► B4 state schema v2 (+backend) + v1→v2 normalization
   {B2,B3,B4} ► B5 select.ts (create + attach precedence, conflict ValidationError)
   B5 ► B6 route ALL commands (up/down/switch/chat/ls/doctor/migrate) via registry+select
── Checkpoint A: Phase 0 green, grep-clean, Ollama behavior byte-identical ────────────

┌──────────────── Phase 1: source + advice surfacing + embedding gating ──────────────┐
 B1 ► B7 catalog source gguf/mlx schema + validators + types
   B7 ► B8 backendsForModel + source-key→ModelFormat map
   B7 ► B9 perf.json efficiencyByBackend + throughput resolution (backend param)
   {B4,B6} ► B10 embedding gating: vector-less capture + meta.json (capture/chat/migrate)
   B6 ► B11 doctor backends section (offline)
   {B8,B9} ► B12 recommend/can-run: backends, --backend, --available-backends
── Checkpoint B: Phase 1 green ───────────────────────────────────────────────────────

┌──────────────── Phase 2: llama.cpp (first second runtime) ──────────────────────────┐
 B7 ► B13 weight-acquisition module (fetch+assertSafeFetchUrl+digest+atomic cache)
   {B5,B13} ► B14a llamacpp: descriptor+install+capabilities+registration
      B14a ► B14b llamacpp: serve/ready/stop (loopback + port preflight)
         B14b ► B14c llamacpp: pull(via B13)+chat+embed
   {B8,B14c} ► B15 catalog gguf sources + cited (class,llamacpp) perf rows [D1,D2]
   B14c ► B16 shared adapter contract suite (ollama + llamacpp)
── Checkpoint C: Phase 2 shippable — two runtimes ────────────────────────────────────

┌──────────────── Phase 3: MLX (Apple Silicon) ───────────────────────────────────────┐
 {B13,B14c} ► B17 mlx.ts adapter (follows B14 a/b/c slices; mlx_lm.server, revision-pinned pull)
   {B5,B17} ► B18 Apple-Silicon auto-detect priority + platform gating [D3]
── Checkpoint D: Phase 3 shippable ───────────────────────────────────────────────────

┌──────────────── Phase 4: LM Studio ─────────────────────────────────────────────────┐
 {B5,B16} ► B19 lmstudio.ts adapter (lms CLI, canPull=false attach-only trust boundary)
── Checkpoint E: Phase 4 shippable ───────────────────────────────────────────────────
```

## Cross-cutting testing conventions (every task)

- **Mock every boundary** with `vi.fn()`: no real Ollama/llama.cpp/MLX/LM Studio
  process, no network, no fs outside a temp dir. Child-process spawns are mocked
  and asserted to be **arg arrays** (with `--` where positional args exist),
  `shell:false`.
- **Determinism guard:** advice-path tests assert `isInstalled()` is **never**
  called and output is byte-identical with/without any backend installed.
- **Shared adapter contract suite** (B16): parameterized over every adapter —
  **explicit loopback bind (via a `--host` arg *or* runtime env** so `ollama
  serve` with `OLLAMA_HOST` passes honestly), non-loopback refusal, **arg-array
  spawns with `--` where positional args exist**, fail-closed on digest/revision/
  exact-file/size-floor, readiness timeout, and **port-ownership preflight**.
- **Fail-closed fixtures:** digest-mismatch, revision-mismatch, exact-file
  zero/multi-match, and partial-download-discard must each raise and never
  promote/serve weights.
- **Shared fake infrastructure:** a fake child-process factory (records argv,
  asserts `shell:false`, controllable exit/stdout), a fake HF `fetch` (streams
  bytes + LFS pointer + controllable resolved-commit), a temp-dir fs cache, and
  a frozen clock for readiness-timeout tests — built once and reused across
  adapters.
- **Registry/command parity:** each command that gains a flag updates the
  `--help`/registry test; every new file has a mirrored `tests/**/*.test.ts`.
- Run `npm test && npm run typecheck && npm run lint && npm run build` per task.

---

## Task list

### Phase 0 — Foundation refactor (no new runtime, no behavior change)

#### B1: Adapter capability flags + `ModelFormat` + Ollama descriptor
**Description:** Add `BackendCapabilities` to the `BackendAdapter` interface and
a `ModelFormat` union to `types.ts`; give `OllamaAdapter` its descriptor
(`canPull:true`, `canEmbed:true`, `openAiCompatible:true`, `formats:["ollama"]`,
`defaultPort:11434`). No behavior change.
**Acceptance:**
- [ ] `BackendCapabilities` + `ModelFormat` (`"gguf"|"mlx"|"ollama"|"safetensors"`) exported from `types.ts`.
- [ ] `BackendAdapter` gains readonly `capabilities`; `OllamaAdapter` implements it.
- [ ] Existing Ollama tests pass unchanged.
**Verify:** `npm run typecheck && npm test tests/backend/adapter tests/backend/ollama-lifecycle`
**Deps:** — **Files:** `src/types.ts`, `src/backend/adapter.ts`, `src/backend/ollama.ts`, `tests/backend/adapter.test.ts` **Scope:** XS

#### B2: `registry.ts` — backend registry
**Description:** `createDefaultRegistry()` + `BackendRegistry` (`all()`,
`get(name)`→`ValidationError` on unknown, `available()` probing `isInstalled()`).
Phase 0 registers Ollama only.
**Acceptance:**
- [ ] `get("ollama")` returns the adapter; `get("bogus")` throws `ValidationError`.
- [ ] `all()` returns a stable-ordered readonly array; `available()` filters by `isInstalled()` (mocked).
**Verify:** `npm test tests/backend/registry`
**Deps:** B1 **Files:** `src/backend/registry.ts`, `tests/backend/registry.test.ts` **Scope:** S

#### B3: User config loader (`~/.local-llmup/config.json`)
**Description:** `loadUserConfig()` in `config.ts` — Zod
`{ schemaVersion: z.literal(1), defaultBackend: z.enum([...names]) }.strict()`,
byte-capped, owner-only. Fails **closed** on invalid/corrupt/symlink/world-writable.
**Acceptance:**
- [ ] Valid config parses; unknown keys/oversized/wrong-version → `ValidationError`.
- [ ] Symlink or group/other-writable file rejected (mirrors 0600/0700 posture).
- [ ] Absent/blank → `undefined` (no preference). Loader is **not** called on the advice path.
**Verify:** `npm test tests/config`
**Deps:** B1 **Files:** `src/config.ts`, `tests/config.test.ts` **Scope:** S

#### B4: State schema v2 (+`backend`) + v1→v2 normalization
**Description:** Bump `STATE_SCHEMA_VERSION` 1→2; add `backend` to the common
schema, preserving the `ownedByUs` union and owned `pid`. Normalize v1 in memory
(set `schemaVersion:2` + `active.backend:"ollama"`) before validation; rewrite v2
on next mutation. **Moved into Phase 0** because attach-intent `select()` (B5)
must type-read `state.active.backend` (review finding C1).
**Acceptance:**
- [ ] v1 file (`schemaVersion:1`, no `backend`) loads as v2 with `backend:"ollama"`, `pid` preserved on owned.
- [ ] Attached (`ownedByUs:false`) v1 round-trips to v2 (no `pid`).
- [ ] Migration is in-memory before validation; file rewritten v2 on next mutation.
**Verify:** `npm test tests/state`
**Deps:** B1 **Files:** `src/state/state.ts`, `tests/state/state.test.ts` **Scope:** M

#### B5: `select.ts` — intent-split selection precedence
**Description:** `select()` implementing create-intent (flag→env→config→auto) and
attach-intent (`state.active.backend` dominates; conflicting flag/env →
`ValidationError`). Auto-detect ranks installed backends per Q1
(`mlx→ollama→llamacpp` on Apple Silicon; else `ollama→llamacpp`). Unknown-serve →
`BackendError` with `installHint()`s.
**Acceptance:**
- [ ] Create-intent precedence order verified (flag > env > config > auto).
- [ ] Attach-intent: `active.backend` (from B4 v2 state) wins; conflicting `--backend`/env throws `ValidationError`.
- [ ] Auto-detect only ranks **installed** backends; platform order honored (mocked OS/arch).
- [ ] "No installed backend can serve" → `BackendError` listing servable backends + hints.
- [ ] Advice path never reaches the `isInstalled()` branch (asserted).
**Verify:** `npm test tests/backend/select`
**Deps:** B2, B3, B4 **Files:** `src/backend/select.ts`, `tests/backend/select.test.ts` **Scope:** M

#### B6: Route ALL commands through registry + `select()`
**Description:** Replace **every** `new OllamaAdapter()` in `src/commands/` —
`up`, `down`, `switch`, `chat`, `doctor`, `migrate` (**six** sites) — with a
registry-injected `Deps` + `select()` resolution (review findings C2/C3; feature
work for doctor/migrate lands in Phase 1 but the construction site is routed
now). `up` uses the selected adapter's `defaultPort` when `--port` absent and
performs the **port-ownership preflight**. `ls` (a pure state read, no adapter)
gains an active-`backend` column from the B4 field (review finding I3).
**Acceptance:**
- [x] `grep -R "new OllamaAdapter()" src/commands` returns **nothing** (all six files).
- [x] `up`/`down`/`switch`/`chat`/`migrate` behavior **byte-identical** to today for Ollama.
- [x] Attach-intent commands (`down`/`switch`/`chat`/`migrate`) resolve the adapter from `active.backend`.
- [x] Foreign server on the target port → `up` attaches or `BackendError`; never `ownedByUs:true` for a process it didn't start.
- [x] `ls` shows the active-backend column (reads `active.backend`; constructs no adapter).
**Verify:** `npm test tests/commands tests/workflows && npm run build`
**Deps:** B5 **Files:** `src/commands/{up,down,switch,chat,doctor,migrate,ls}.ts`, `tests/commands/*`, `tests/workflows/*` **Scope:** L

> **Checkpoint A — Phase 0 shippable.** All existing tests green;
> `grep -R "new OllamaAdapter()" src/commands` is empty; Ollama lifecycle
> byte-identical; state migrates v1→v2 transparently. No user-visible change
> (doctor backends section + migrate embedding gating arrive in Phase 1).

---

### Phase 1 — `source` extension + advice surfacing + embedding gating

#### B7: Catalog `source` extension (`gguf`/`mlx`) + validators
**Description:** Extend `ModelSource` + `ModelSourceSchema` with optional
`gguf{repo,revision,file,sha256}` and `mlx{repo,revision}` (all `.strict()`).
Add HF-repo-id validator, 40-hex-SHA `revision`, glob/`..`-rejecting `file`.
Keep the "≥1 source" refine.
**Acceptance:**
- [x] `gguf`/`mlx` parse; unknown keys rejected; `revision` must be 40-hex (reject `main`); `file` rejects globs/`..`.
- [x] HF-repo-id validator accepts `mlx-community/Qwen3-14B`; rejects `../x`, absolute, leading `-`.
- [x] "≥1 source" refine still holds; existing catalog still validates.
**Verify:** `npm test tests/catalog`
**Deps:** B1 **Files:** `src/catalog/schema.ts`, `src/types.ts`, `tests/catalog/schema.test.ts` **Scope:** S

#### B8: `backendsForModel` + source-key→`ModelFormat` map
**Description:** Map `ollama→ollama`, `gguf→gguf`, `mlx→mlx`, `hf→advisory (no
match)`; `backendsForModel(model, registry)` returns adapters whose
`capabilities.formats` intersect the model's mapped formats.
**Acceptance:**
- [x] Ollama-only model → `["ollama"]` (annotated, never dropped).
- [x] `gguf`+`ollama` model → both llama.cpp (when registered) and ollama.
- [x] `hf`-only does not match any backend.
**Verify:** `npm test tests/catalog tests/backend/registry`
**Deps:** B7 **Files:** `src/catalog/*.ts` (or `src/backend/registry.ts`), `tests/**` **Scope:** S

#### B9: `efficiencyByBackend` + throughput resolution
**Description:** Extend `data/perf.json` by **widening the `.strict()`
`PerfSourcesSchema`** with optional `efficiencyByBackend` (absolute scalars) +
provenance (`trustTier`, `basisBytesPerToken`, `url`). Thread an **optional
`backend` param (defaulting to `ollama`)** through `estimateTokPerSec` and its
call sites so the ripple stays additive (review findings I4/S1). Resolution:
`eff = efficiencyByBackend[backend] ?? (backend∈{ollama,llamacpp} ? efficiency :
undefined)`; `undefined` → honesty-gate `UNKNOWN`. Dataset `schemaVersion`
unchanged (additive/optional); no data values change (ollama unchanged).
**Acceptance:**
- [x] `.strict()` `PerfSourcesSchema` widened for `efficiencyByBackend` provenance; rejects out-of-range/unknown keys; `schemaVersion` still `1`.
- [x] `backend` param optional, defaults to `ollama`; all call sites (`throughput`/`verdict`/`rank`/`fit` as applicable) still typecheck.
- [x] Default Ollama throughput **byte-identical** to today.
- [x] Absent `(class, backend)` (e.g. `mlx`) → `known:false`.
**Verify:** `npm test tests/advisor/perf-data tests/advisor/throughput && npm run typecheck`
**Deps:** B7 **Files:** `src/advisor/perf-data.ts`, `src/advisor/throughput.ts`, `data/perf.json`, `tests/advisor/*` **Scope:** M

#### B10: Embedding capability gating — vector-less capture + `meta.json`
**Description:** Make the embedding path `canEmbed`-aware across
`src/memory/capture.ts`, `src/commands/chat.ts`, and `src/commands/migrate.ts`
(review findings C3/I1): when the serving backend lacks `canEmbed`, capture
proceeds **vector-less** (no throw, no fabrication) and the memory store's
`meta.json` records that vectors are absent (§3.3, §10 Q3).
**Acceptance:**
- [x] `canEmbed:false` backend → entries stored with no vectors; `meta.json` flags absence.
- [x] No fabricated vectors, no hard failure; `canEmbed:true` path unchanged (byte-identical).
- [x] Both `chat` and `migrate` honor the gate.
**Verify:** `npm test tests/memory tests/commands/chat tests/commands/migrate`
**Deps:** B4, B6 **Files:** `src/memory/capture.ts`, `src/commands/{chat,migrate}.ts`, `tests/memory/*`, `tests/commands/*` **Scope:** M

#### B11: `doctor` backends section (offline)
**Description:** Add installed-backends + best-effort versions
(`stripControl`-clean, arg-array/`shell:false` probes) + the machine's
auto-selected default; missing backends show `installHint()`. Fully offline.
**Acceptance:**
- [x] Lists installed backends offline (mocked probes); missing show hints.
- [x] Version strings pass through `stripControl` (hostile escape neutralized).
- [x] Exit code unchanged; no network.
**Verify:** `npm test tests/commands/doctor`
**Deps:** B2, B6 **Files:** `src/commands/doctor.ts`, `tests/commands/doctor.test.ts` **Scope:** S

#### B12: `recommend`/`can-run` backend surfacing
**Description:** Add `--backend <name>` (scope throughput) and opt-in
`--available-backends` filter; text `Backends` annotation; `--json`
`backends: string[]` + `throughputBackend` **pinned to `ollama`** (deterministic,
never `isInstalled()`-derived). Unsourced `(class,backend)` → `unknown`.
**Acceptance:**
- [x] `--json` exposes `backends` and `throughputBackend:"ollama"` by default.
- [x] Output byte-identical with/without any backend installed (determinism test).
- [x] `--available-backends` filters only when explicitly passed; default never drops models.
- [x] `can-run` exit-code contract unchanged (non-zero only for `no`).
**Verify:** `npm test tests/cli tests/commands/can-run tests/commands/recommend`
**Deps:** B8, B9 **Files:** `src/commands/{recommend,can-run}.ts`, `src/output.ts`, `tests/**` **Scope:** M

> **Checkpoint B — Phase 1 shippable.** Catalog accepts `gguf`/`mlx`;
> `doctor`/`recommend` surface backends; embedding capture is vector-less when
> unsupported; advice remains deterministic and Ollama-identical. Still
> Ollama-only servable.

---

### Phase 2 — llama.cpp adapter (`llama-server`, GGUF)

#### B13: Weight-acquisition module (shared, guarded)
**Description:** `src/backend/acquire.ts` (or similar): direct HTTPS `fetch` from
HF resolve URL pinned to commit `revision` → `assertSafeFetchUrl`
(HTTPS-only, HF allowlist, no-credential, no-private-host) → temp `0600` file in
`0700` cache `~/.local-llmup/cache/<backend>/<repo>@<revision>/<file>` →
digest-verify → **atomic rename**. Reject cache symlinks; discard partials.
**Acceptance:**
- [x] Non-HTTPS / non-allowlisted / private-host URL rejected (anti-SSRF).
- [x] temp→verify→atomic-rename happy path; digest mismatch discards partial, never promotes.
- [x] Resolved commit ≠ pinned `revision` → fail closed; exact-file zero/multi-match → hard error.
- [x] Cache symlink rejected; files `0600`, dirs `0700`.
**Verify:** `npm test tests/backend/acquire`
**Deps:** B7 **Files:** `src/backend/acquire.ts`, `tests/backend/acquire.test.ts` **Scope:** M

#### B14a: `llamacpp.ts` — descriptor + install + registration
**Description:** `LlamaCppAdapter` skeleton — `isInstalled`/`installHint`,
capabilities (`canPull:true`, `canEmbed` per `llama-server`, `formats:["gguf"]`,
`defaultPort:8080`), registered in `createDefaultRegistry`. No serve/pull yet.
**Acceptance:**
- [x] Adapter appears in `registry.all()`; `get("llamacpp")` resolves it.
- [x] Capabilities descriptor correct; `installHint()` records the target version [D4].
**Verify:** `npm test tests/backend/llamacpp tests/backend/registry`
**Deps:** B5, B13 **Files:** `src/backend/llamacpp.ts`, `src/backend/registry.ts`, `tests/backend/llamacpp.test.ts` **Scope:** S

#### B14b: `llamacpp.ts` — serve/ready/stop lifecycle (loopback + port preflight)
**Description:** `serve` spawns `llama-server` with **explicit `--host
127.0.0.1`** (arg array, `shell:false`, `--` where positional args exist),
OpenAI-compatible `waitUntilReady`, `stop`, and the **port-ownership preflight**.
**Acceptance:**
- [x] `serve` forces loopback; a resolved non-loopback endpoint is refused (state not written).
- [x] Foreign server on 8080 → attach or `BackendError`, never `ownedByUs:true`.
- [x] Readiness-probe timeout raises; `stop` terminates only an owned process.
**Verify:** `npm test tests/backend/llamacpp`
**Deps:** B14a **Files:** `src/backend/llamacpp.ts`, `tests/backend/llamacpp.test.ts` **Scope:** M

#### B14c: `llamacpp.ts` — pull + chat + embed
**Description:** `pull` via B13 (fail-closed digest/revision/exact-file), `chat`,
and `embed` (or `canEmbed:false`) over the OpenAI-compatible API.
**Acceptance:**
- [x] `pull` fails closed on digest/revision/exact-file mismatch (via B13).
- [x] `chat` round-trips against a mocked server; `embed` honors `canEmbed`.
- [x] `up --backend llamacpp <model>` end-to-end (mocked) records `backend:"llamacpp"`.
**Verify:** `npm test tests/backend/llamacpp tests/workflows`
**Deps:** B14b **Files:** `src/backend/llamacpp.ts`, `tests/backend/llamacpp.test.ts`, `tests/workflows/*` **Scope:** M

#### B15: Catalog `gguf` sources + cited `(class, llamacpp)` perf rows  *(blocked on D1/D2)*
**Description:** Add `gguf` sources (pinned commit + exact file + `sha256`) to
3–5 catalog models; add `llamacpp` to `efficiencyByBackend` sharing each class's
existing scalar with provenance. Real pinned SHAs cross-checked vs HF LFS
pointers at ingest — **data curation, not code**. No fabricated numbers.
**Acceptance:**
- [x] Chosen models validate with `gguf` sources (real pinned revisions/digests).
- [x] `recommend --backend llamacpp` scopes throughput; unsourced class → `unknown`.
- [x] `llamacpp` output equals `ollama` for shared classes (no invented delta).
**Verify:** `npm test tests/catalog tests/advisor/throughput tests/commands/recommend`
**Deps:** B8, B14c **Files:** `data/models.json`, `data/perf.json`, `tests/**` **Scope:** M

#### B16: Shared adapter contract suite
**Description:** Parameterized contract test over **every** adapter (ollama,
llamacpp): **loopback bind is explicit** — via a `--host` arg *or* runtime env,
so `ollama serve` with `OLLAMA_HOST` passes honestly (review finding I2);
non-loopback refusal (state not written, owned server stopped); **arg-array
spawns with `--` where positional args exist** (review finding S2); fail-closed
on digest/revision/exact-file/size-floor; readiness-probe timeout;
**port-ownership preflight** (foreign server on shared 8080 → attach or
`BackendError`, never `ownedByUs:true`).
**Acceptance:**
- [x] Suite green for ollama + llamacpp; adding a future adapter only registers it.
- [x] Every clause has an asserting case; ollama's env-based loopback and arg-less `serve` pass without special-casing.
**Verify:** `npm test tests/backend`
**Deps:** B14c **Files:** `tests/backend/adapter-contract.test.ts` **Scope:** M

> **Checkpoint C — Phase 2 shippable.** Two runtimes. `up --backend llamacpp`
> pulls→verifies→serves→ready→records `backend:"llamacpp"`; fail-closed
> integrity proven; advice honesty-gated. Loopback + port preflight enforced.

---

### Phase 3 — MLX adapter (Apple Silicon)

#### B17: `mlx.ts` adapter
**Description:** `MlxAdapter`, following the B14 a/b/c slices — Apple-Silicon
`isInstalled` gate, capabilities (`canPull:true`, `canEmbed` per `mlx_lm`,
`formats:["mlx"]`, `defaultPort:8080`), revision-pinned MLX repo pull via B13
(per-file digests), `mlx_lm.server` loopback-forced serve, OpenAI readiness.
Register in `createDefaultRegistry`.
**Acceptance:**
- [x] Not "installed" off Apple Silicon (mocked arch); loopback-forced serve; fail-closed multi-file repository pull.
- [x] Contract suite (B16) green for `mlx`.
**Production smoke (2026-08-08):** `mlx-lm==0.31.3` served the immutable
`mlx-community/SmolLM2-360M-Instruct-6bit` snapshot on `127.0.0.1:18082`;
authenticated health and exact-marker chat passed, unauthenticated/foreign-origin/
wrong-media-type/oversized/excess-token requests failed closed, embeddings were
rejected, and ownership-safe stop released the PID and port without disturbing
the pre-existing listener on port 8080. This exercised the direct production
adapter; catalog/CLI MLX smoke awaits a curated MLX catalog entry.
**Verify:** `npm test tests/backend/mlx tests/backend/adapter-contract`
**Deps:** B13, B14c **Files:** `src/backend/mlx.ts`, `src/backend/registry.ts`, `tests/backend/mlx.test.ts` **Scope:** L

#### B18: Apple-Silicon auto-detect priority + platform gating  *(D3)*
**Description:** Wire `select()` auto-detect to rank `mlx` first on Apple Silicon
(installed-only). Ship `(apple, mlx)` efficiency as **`unknown`** (no cited
number). Ensure `mlx` never surfaces as servable on non-Apple hardware.
**Acceptance:**
- [ ] Apple-Silicon profile with MLX installed → auto-selects `mlx` (mocked).
- [ ] `recommend --backend mlx` → `unknown` throughput (honesty gate), model still ranked.
- [ ] Non-Apple profile never lists `mlx` as servable.
**Verify:** `npm test tests/backend/select tests/commands/recommend`
**Deps:** B5, B17 **Files:** `src/backend/select.ts`, `data/perf.json`, `tests/**` **Scope:** S

> **Checkpoint D — Phase 3 shippable.** MLX auto-selected on Apple Silicon;
> honesty-gated throughput; three runtimes.

---

### Phase 4 — LM Studio adapter

#### B19: `lmstudio.ts` adapter (attach-only trust boundary)
**Description:** `LmStudioAdapter` driving the `lms` CLI / local server
(`defaultPort:1234`, `formats:["gguf","mlx"]`, `canPull` reflecting LM Studio's
own manager — likely `false`). When `canPull:false`, `up` **attaches + verifies
presence**; where the resolved GGUF is locatable, verify its digest, else surface
`digestVerified:false` + a delegated-integrity warning (M1).
**Acceptance:**
- [ ] Attach-and-serve path (mocked `lms`); graceful message when model absent in LM Studio.
- [ ] `canPull:false` path records the delegated-integrity trust boundary (no silent pass).
- [ ] Contract suite (B16) green for `lmstudio`.
**Verify:** `npm test tests/backend/lmstudio tests/backend/adapter-contract`
**Deps:** B5, B16 **Files:** `src/backend/lmstudio.ts`, `src/backend/registry.ts`, `tests/backend/lmstudio.test.ts` **Scope:** L

> **Checkpoint E — Phase 4 shippable.** Four backends registered; LM Studio's
> attach-only trust boundary documented and enforced. vLLM remains deferred (§10 Q4).

---

## Rollup acceptance (mirrors spec §11)

- [ ] No `new OllamaAdapter()` in `src/commands/` — all six sites routed (B6).
- [ ] `state.json` records `backend`; v1→v2 migration preserves `pid` (B4).
- [ ] `ModelSourceSchema` accepts `gguf`/`mlx`, rejects globs/unknown keys/floating tags (B7).
- [x] `recommend`/`can-run` identical with/without backends installed; `throughputBackend` pinned `ollama`; `ollama`/`llamacpp` share scalars; absent pair → `unknown` (B9, B12).
- [ ] `up --backend <name>` per adapter pulls→verifies→serves→ready, fail-closed on digest/revision/exact-file mismatch (B14c, B17, B19).
- [ ] Every adapter binds loopback explicitly (arg or env), refuses non-loopback; spawns are arg arrays (with `--` where positional args exist); port-ownership preflight enforced (B16).
- [ ] `down`/`switch`/`chat`/`migrate` route via `active.backend`; cross-backend `switch` → `ValidationError`; `canEmbed:false` capture is vector-less + `meta.json`-flagged (B6, B10).
- [x] Self-managed downloads pass `assertSafeFetchUrl`, verify-before-activate via atomic rename, never promote a partial (B13).
- [ ] Invalid/symlink/world-writable/unknown-key config fails closed (B3).
- [x] `doctor` lists installed backends + default offline, `stripControl`-clean (B11).
- [ ] `npm test && npm run typecheck && npm run lint && npm run build` pass at every checkpoint.

## Risks & mitigations (plan-level)

| Risk | Mitigation |
|---|---|
| Phase 0 refactor silently changes Ollama behavior | Byte-identical assertion tests before merging B6; no data changes in Phase 0/1. |
| Attach-intent needs `active.backend` before it exists | State v2 (B4) is pulled into Phase 0 ahead of `select()` (B5) and command routing (B6). |
| Real HF digests/revisions unavailable or drift (B15) | D1 cross-checks `sha256` vs HF LFS pointer at ingest; pinned commit SHAs fail closed on drift. |
| MLX/LM Studio spawn shapes differ from assumptions | Adapters mocked in tests; D4 pins target versions; contract suite (B16) enforces the shared obligations. |
| Fabricated MLX/vLLM speed numbers creeping in | Honesty gate: `mlx`/`vllm` absent from `efficiencyByBackend` → `unknown` (B9, B18). |
| Weight-acquisition SSRF / path traversal | `assertSafeFetchUrl` allowlist + traversal guards + atomic rename, all tested in B13. |

## Suggested parallelization

- After **B1**: B2, B3, B4 run in parallel; B5 joins all three.
- After **B6** (Checkpoint A): B7 and B10 run in parallel; B8/B9 branch from B7;
  B11 branches from B6; B12 joins B8+B9.
- Phase 2 is mostly sequential (B13→B14a→B14b→B14c→{B15,B16}); Phase 3
  (B17→B18) starts once B13/B14c land; Phase 4 (B19) needs only B5+B16.
