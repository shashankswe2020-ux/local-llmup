# Spec: Pluggable Inference Backends

> Status: **Draft (v0.5) — ready for implementation.** v0.2 revised after
> code-review + security-audit; v0.3 added a cited market/performance research
> appendix (§12); v0.4 reconciled the empirical anchors with `data/perf.json`
> after a third code-review round; v0.5 resolves all §10 open questions at their
> recommended defaults (direct-`fetch` GGUF pull with no new dependency; MLX-first
> auto-detect on Apple Silicon; vector-less embedding fallback; vLLM deferred to a
> follow-up spec). Pending human approval to start Phase 0.
> Last updated: 2026-08-06
> Related: `docs/specs/local-llmup.md` (§2 Tech Stack, §3.2 `up`, §3.6 runtime
> state), `docs/specs/hardware-advisor.md` (throughput/verdict),
> `docs/specs/context-window-sizing.md` (KV-cache math).

---

## 0. Terminology note (read first)

The triggering request mentioned "MoE" alongside `llama.cpp` as things to
"support." To be precise:

- **MoE (Mixture-of-Experts) is a _model architecture_, not a runtime.** It is
  **already supported** end-to-end: `MODEL_ARCHITECTURES = ["dense", "moe"]`,
  the schema requires `activeParams` for MoE, and the throughput estimator reads
  only the **active** parameter set per token while memory sizing uses the
  **total** parameters. No work is needed here beyond adding more MoE entries to
  the catalog.
- The real ask is **pluggable inference _runtimes_**: today Ollama is the only
  backend. This spec adds a general mechanism plus concrete adapters for
  **llama.cpp**, **MLX** (Apple Silicon), and **LM Studio**, with **vLLM**
  deferred to a follow-up spec (§10 Q4).

If MoE-specific advisor work is desired later (e.g. per-runtime expert-offload
behavior), it will be a separate spec.

---

## 1. Objective

Let `local-llmup` install, serve, rank, and drive local LLMs across **more than
one inference runtime**, chosen automatically from what the user's machine can
run — while preserving every domain invariant: the honesty gate, deterministic
offline advice, fail-closed integrity, and loopback-only serving.

Today the `BackendAdapter` interface exists and is stateless, but:

- command code hardcodes `new OllamaAdapter()` (no registry, no selection);
- the catalog `source` only carries an Ollama coordinate;
- runtime `state.json` does not record **which** backend owns the active server;
- throughput efficiency is keyed on hardware only, not on the runtime.

This spec closes those gaps and defines concrete adapters.

### Target users

- Apple-Silicon users who want **MLX** speed instead of the Ollama/llama.cpp
  path.
- Power users who already run **llama.cpp** (`llama-server`) or **LM Studio**
  and want `local-llmup`'s advice + lifecycle on top of their runtime.
- Linux/CUDA users who want **vLLM** throughput (deferred to a follow-up spec,
  §10 Q4; llama.cpp serves the CUDA path in v1).

### Success looks like

- `doctor` reports every installed backend and the auto-selected default.
- `recommend` can annotate/filter by the backend(s) that can actually serve each
  model, and `--backend <name>` biases the ranking to one runtime.
- `up --backend mlx qwen3:14b` pulls, verifies, serves, and health-checks via
  MLX, then records `backend: "mlx"` in `state.json`; `down`/`switch`/`chat`
  route to that backend automatically.
- Throughput estimates remain **honest**: if a runtime's efficiency for the
  detected hardware class is not in the dataset, the estimate is `unknown`, not
  a fabricated cross-runtime speedup.

### Non-goals (v1 of this spec)

- Remote/cloud backends or any non-loopback default.
- Running two backends simultaneously (the active server stays singular).
- GPU cluster / multi-node serving.
- Auto-converting weights between runtime formats (GGUF ↔ MLX ↔ safetensors).

---

## 2. Architecture

### 2.1 What stays the same

- The `BackendAdapter` interface (`src/backend/adapter.ts`) stays the contract.
  Adapters remain **stateless**; all runtime facts live in `state.json`.
- `pull`/`serve`/`waitUntilReady`/`stop`/`chat`/`embed` keep their shapes.
- Servers bind `127.0.0.1` by default; `--host` remains an explicit opt-in.
- Advice commands (`recommend`, `can-run`, `doctor`) make **no** network calls.

### 2.2 New: backend registry + selection

Add `src/backend/registry.ts`:

```ts
export interface BackendRegistry {
  /** All known adapters, in stable priority order. */
  all(): readonly BackendAdapter[];
  /** Adapter by stable name, or throw ValidationError on unknown name. */
  get(name: string): BackendAdapter;
  /** Installed adapters only (probes isInstalled()). */
  available(): Promise<readonly BackendAdapter[]>;
}

export function createDefaultRegistry(): BackendRegistry; // ollama, llamacpp, mlx, lmstudio, [vllm]
```

**Selection precedence is split by command intent** (a v0.1 review finding: a
single uniform order let `chat --backend mlx` mis-route to a backend that doesn't
own the active server). Implemented once in `src/backend/select.ts`:

**A. Commands that _create_ a server (`up`):**

1. Explicit `--backend <name>` flag.
2. `LOCAL_LLMUP_BACKEND` env var.
3. Config file preference (`~/.local-llmup/config.json`, new; see §2.6).
4. Auto-detect: highest-priority **installed** backend that can serve the target
   model (see §2.4). Priority order is platform-aware (§10 Q1, decided): Apple
   Silicon `mlx` → `ollama` → `llamacpp`; everything else (incl. Linux+CUDA in
   v1) `ollama` → `llamacpp`. vLLM is **not** in the v1 order (deferred, §10 Q4).

**B. Commands that _attach to_ the active server (`down`, `chat`, `switch`):**

- `active.backend` from `state.json` **dominates**. A `--backend`/env value that
  **conflicts** with `active.backend` is a `ValidationError` (not a silent
  override) — you cannot `chat` to a backend that isn't the one currently
  serving. `switch` is **same-backend only** (see §3.3 / C2 resolution).

If no installed backend can serve the model (path A step 4), throw a typed
`BackendError` listing what would serve it and each backend's `installHint()`.

**Advice commands never probe installation.** `select()`'s
`isInstalled()`-probing branch is reachable **only** on the serving path
(`up`/`down`/`switch`/`chat`), never from `recommend`/`can-run`/`doctor`
advice output (§2.7, §3.1) — preserving determinism/offline advice. (`doctor`
does probe installation, but as diagnostics, not as advice numbers.)

Commands stop constructing `new OllamaAdapter()`; they receive a
`BackendRegistry` in their `Deps` and resolve an adapter via `select()`.

### 2.3 Adapter capability flags

Runtimes differ (LM Studio manages its own downloads; not all serve embeddings).
Extend the interface with a declarative capability descriptor rather than
per-call feature detection:

```ts
export interface BackendCapabilities {
  readonly canPull: boolean;        // false → user installs the model via the runtime's own UI/CLI
  readonly canEmbed: boolean;       // false → embeddings must use a different backend
  readonly openAiCompatible: boolean;
  /** Weight formats this backend can serve. */
  readonly formats: readonly ModelFormat[]; // "gguf" | "mlx" | "ollama" | "safetensors"
  /** Loopback default serve port for this runtime (Ollama 11434, llama-server 8080, LM Studio 1234…). */
  readonly defaultPort: number;
}
export interface BackendAdapter {
  readonly name: string;
  readonly capabilities: BackendCapabilities; // NEW
  // …existing methods…
}
```

`defaultPort` replaces `up.ts`'s hardcoded `?? DEFAULT_OLLAMA_PORT`
(review finding I4): a shared `up` uses the selected adapter's `defaultPort`
when `--port` is absent. **Port-ownership preflight is a first-class contract
obligation (review finding I5), not just a caveat:** `llama-server`,
`mlx_lm.server`, and `llamafile` all default to **8080** (§12.5), so before
spawning, `up` **must** probe the target port and, if a server already responds
there, refuse to claim ownership — either attach (recording `ownedByUs:false`)
when it is the expected backend/model, or fail with a `BackendError` naming the
conflict. `up` never spawns a second process onto an occupied port and never
records `ownedByUs:true` for a server it did not start. This obligation is part
of the adapter contract and is covered by a shared contract test (§6).

Callers gate on capabilities (e.g. `migrate`/`chat` embedding needs a
`canEmbed` backend; when none is available, embedding degrades to **no vectors**
rather than fabricating or hard-failing — honesty gate; see §3.3 / I2).

### 2.4 Catalog `source` extension (which runtimes can serve a model)

`ModelSource` today is `{ ollama?, hf? }`. Extend it (additive, backward
compatible) so the advisor and `up` know each model's per-runtime coordinates.
**Integrity is modeled per source** (review findings H1–H3): a single
`quant.sha256` is an Ollama _manifest layer_ digest and cannot verify a raw
GGUF file or an MLX repo — so each self-managed source carries its own pinned
revision + exact file + digest.

```ts
export interface ModelSource {
  readonly ollama?: string;                 // existing: ollama registry id
  readonly hf?: string;                      // existing: generic HF repo id (advisory only)
  readonly gguf?: {                          // llama.cpp / LM Studio
    readonly repo: string;                   // HF repo id (owner/name)
    readonly revision: string;               // full commit SHA — never a floating tag
    readonly file: string;                   // EXACT filename, no wildcards
    readonly sha256: string;                 // digest of that exact GGUF file
  };
  readonly mlx?: {                           // mlx-community
    readonly repo: string;                   // HF repo id (owner/name)
    readonly revision: string;               // full commit SHA — never `main`
  };
}
```

- Zod `ModelSourceSchema` gains optional `gguf`/`mlx` objects (all `.strict()`);
  `revision` is validated as a 40-hex commit SHA, `file` rejects `..`/`/`/glob
  metacharacters, `repo` uses the dedicated HF-repo-id validator (§2.8 H4). The
  existing `.refine` (at least one source) still holds.
- **Source-key → `ModelFormat` map** (review finding I6) drives
  `backendsForModel`:

  | `source` key | `ModelFormat` | Servable by |
  | --- | --- | --- |
  | `ollama` | `ollama` | Ollama |
  | `gguf` | `gguf` | llama.cpp, LM Studio |
  | `mlx` | `mlx` | MLX |
  | `hf` | — (advisory) | none directly — does **not** participate in backend matching |

- `backendsForModel(model, registry)` returns adapters whose
  `capabilities.formats` intersect the model's mapped source formats.
- **Honesty:** a model with only an `ollama` source is servable only by Ollama;
  it is **not** dropped from advice — it is annotated `backends: ["ollama"]`.

### 2.5 Runtime state gains a `backend` field (schema v2)

`ServerState` must record the owning backend so non-`up` commands route
correctly. Bump `STATE_SCHEMA_VERSION` **1 → 2**; add `backend` to the
**common** schema, preserving the existing `ownedByUs` discriminated union and
the owned variant's `pid` (review finding C3):

```ts
// STATE_SCHEMA_VERSION = 2
ServerStateCommonSchema = { backend: string; modelId; endpoint; port }  // + backend
OwnedServerStateSchema    = Common + { ownedByUs: true;  pid }          // unchanged pid
AttachedServerStateSchema = Common + { ownedByUs: false }
RuntimeStateSchema        = { schemaVersion: z.literal(2); active: … }
```

- Migration: a v1 file (`schemaVersion: 1`, no `active.backend`) is normalized
  **in memory before validation** — the successor to
  `normalizeLegacyRuntimeState` sets **both** `schemaVersion: 2` **and**
  `active.backend = "ollama"` (when `active` is non-null), then the file is
  rewritten as v2 on the next mutation. No user action required.
- Round-trip example: `{schemaVersion:1, active:{ownedByUs:true, pid:42,
  modelId:"llama3.1:8b", endpoint, port}}` → loads as `{schemaVersion:2,
  active:{backend:"ollama", ownedByUs:true, pid:42, …}}`.
- `down`/`switch`/`ls`/`chat` read `active.backend` and resolve that adapter
  from the registry instead of assuming Ollama.

### 2.6 New config file (optional, additive)

`~/.local-llmup/config.json`, validated by Zod, owner-only (`0600`):

```jsonc
{ "schemaVersion": 1, "defaultBackend": "mlx" }
```

- Schema is `z.object({ schemaVersion: z.literal(1), defaultBackend:
  z.enum([…registryNames]) }).strict()` with a small byte cap on the file. An
  **invalid/corrupt config fails closed** with a typed `ValidationError` — it is
  never silently coerced (review finding M3).
- Defense-in-depth: reject the file if it is a symlink or group/other-writable
  (M/L2), mirroring the `0600`/`0700` posture elsewhere.
- Absent/blank → no preference (selection falls through to auto-detect). This is
  the only persistent user preference introduced; loading it stays **off** the
  advice path (advice remains deterministic and reads only `data/`).

### 2.7 Advisor: runtime-aware throughput, honesty-gated

`estimateTokPerSec` is a memory-bandwidth roofline: `tok/s ≈ (bandwidth ×
efficiency) / weightBytesPerToken`. The memory math is runtime-agnostic, but
**efficiency is not** — MLX on Metal, llama.cpp on CUDA, and Ollama differ.

- Extend `data/perf.json` with an optional per-runtime **efficiency map**,
  `efficiencyByBackend: Record<backendName, number>`, added to each perf class
  **alongside** the existing scalar `efficiency`. Each value is an **absolute**
  efficiency for that `(class, backend)` pair (0–1), **not** a multiplier on
  another backend — the estimator plugs it straight into the roofline the same
  way it uses today's scalar `efficiency` (review findings I2/I3). The reported
  range still comes solely from the existing `DEFAULT_BAND_FRACTION` (±30%); no
  separate stored `[min,max]` band is introduced (that conflicted with the
  estimator — the fine-grained perf classes already separate memory tiers).
- **`ollama` and `llamacpp` share the existing class `efficiency` — no invented
  delta** (review findings C1/I4/S3). The current rows were **already**
  back-computed from **llama.cpp** decode (each row's `sources.efficiency` says
  so: e.g. "Back-computed from llama.cpp Metal Q4_K_M 7B decode"). Since the
  Ollama↔llama.cpp overhead delta is `unknown` (§12.2e), both backends resolve to
  the class's existing scalar. This keeps default Ollama output **byte-identical**
  to today **and** makes `llamacpp` output identical to it — honest, because the
  research supports "≈ equal," not a fabricated speedup. (Byte-identical covers
  this **mechanical re-keying only**; correcting a class scalar against a
  better-cited benchmark — e.g. the NVIDIA reconciliation in §12.2b — is a
  separate, provenance-tracked data change, not claimed byte-identical.)
- **One declared weight-bytes/token basis for every efficiency figure**
  (review findings C2/S1). All existing rows and any new figure are derived on
  the **same** basis — Q4_K_M, 7B, ≈ 4.4 GB weights/token — recorded in each
  row's provenance. The §12.2a Apple anchors (originally quoted on a 3.8 GB Q4_0
  basis) are **renormalized to the 4.4 GB Q4_K_M basis** before comparison; once
  renormalized they **agree** with the existing 0.70-class values (the apparent
  0.45–0.63 vs 0.70 gap was a units artifact, not a real disagreement). Efficiency
  is not invariant to this constant, so the constant is fixed dataset-wide.
- **Runtimes with no reproducible primary benchmark stay `unknown`** (honesty
  gate). Market search for MLX-vs-llama.cpp and vLLM/SGLang single-stream
  numbers surfaced only AI-content-farm pages (§12.2c–d); these are **not**
  encoded. `(apple, mlx)` and `(cuda, vllm)` are simply **absent** from
  `efficiencyByBackend`, so `recommend --backend mlx|vllm` returns
  `{ known: false }` (models still ranked by weights) until a first-party
  measurement exists. No "modeled ≈ its llama.cpp peer" borrowing (review
  finding I1) — absence means `unknown`, full stop.
- **Advice-path default backend is pinned to `ollama`** (review findings C1/C3).
  `recommend`/`can-run` never call `isInstalled()`; without `--backend`,
  `throughputBackend` is the **fixed baseline `ollama`** for every model with an
  `ollama` source (not the OS/arch auto-selection, which would flip Apple-Silicon
  users to the `unknown` `mlx` band and regress today's output). This means the
  **advice-path default (`ollama`) can legitimately differ from the serving-path
  auto-selection** (`up` may pick `mlx`/`vllm`, §2.2 A4); §3.1/§10 Q1 call this
  out so users aren't surprised. Every model still lists all servable `backends`;
  `recommend --backend <name>` scopes throughput to that runtime (or `unknown`).
- **Every efficiency figure must be cited** in `data/perf.json` provenance with
  its trust tier (§12: `session-verified` / `spec-grade` / `low-confidence`). A
  `low-confidence` figure is **not** encoded — it ships as `unknown`. No figure
  ⇒ `unknown`.

Concrete row shape (additive to the existing `PerfClass`; keyed by the current
fine-grained class `id`, so per-memory-tier resolution is preserved):

```jsonc
{
  "id": "apple-silicon-max",
  "vendor": "apple",
  "memBandwidthGBps": 400,
  "efficiency": 0.70,                 // unchanged; used by ollama + llamacpp
  "efficiencyByBackend": {            // NEW, optional, absolute per-backend scalars
    "ollama": 0.70,                   // may be omitted → falls back to `efficiency`
    "llamacpp": 0.70                  // mlx/vllm ABSENT here → `unknown` on that backend
  },
  "sources": {
    "efficiencyByBackend": {
      "llamacpp": { "value": 0.70, "trustTier": "session-verified",
        "basisBytesPerToken": 4.4e9, "url": "https://github.com/ggml-org/llama.cpp/discussions/4167" }
    }
  }
}
```

Resolution rule in `throughput.ts`: `eff = efficiencyByBackend[backend] ??
(backend ∈ {ollama, llamacpp} ? efficiency : undefined)`; `undefined` ⇒ the
existing honesty-gate `UNKNOWN` return. The scalar feeds the roofline exactly as
today; the reported range remains the estimator's ±30% `DEFAULT_BAND_FRACTION`
(no second stored band). `basisBytesPerToken` is recorded so figures stay
comparable across rows (§2.7 basis rule).

**Modeling notes from recent research (§12.4) — bounded, honesty-gated:**

- **Single-user decode is bandwidth-bound for _all_ backends**, so the roofline
  is the right shared model; batched-throughput runtimes (vLLM/SGLang) win on
  _concurrency_, which the single-active-server model (§1 non-goal) deliberately
  does **not** credit. vLLM's concurrency advantage is therefore **not** encoded
  as a per-request speedup; absent a cited single-stream figure it stays
  `unknown` (review finding I1).
- **Prefill vs decode diverge sharply** (GPUs ~7–20× faster at prefill, only
  ~2–4× at decode; §12.2b). The current estimate models **decode** tok/s; any
  future prefill/TTFT estimate is a separate figure, separately cited.
- **MoE stays active-params-based** (already implemented) and, when expert
  offload to CPU/RAM is in play (ktransformers, llama.cpp `-ot`; §12.4),
  effective bandwidth is capped by the **slowest tier** (PCIe/DDR). Modeling
  offload is **out of scope** for v1; such configs emit `unknown` rather than a
  GPU-bandwidth number.
- **Speculative decoding, KV-cache quantization, FlashAttention** all break or
  shift the pure-bandwidth roofline (§12.4). They are **not** modeled in v1;
  their presence is not assumed, so estimates remain conservative. KV-cache
  quantization interacts with `context-window-sizing.md` and is noted there.

Memory footprint / verdict (`fit.ts`, `verdict.ts`, `memory-math.ts`) stay
largely runtime-agnostic (weights + fp16 KV + overhead); only the flat runtime
overhead constant may be parameterized per backend if cited.

### 2.8 Integrity & security (fail-closed, per backend)

Each adapter's `pull` verifies weights and **fails closed** on mismatch. The
v0.1 security audit tightened this section:

- **Per-source digest (H1).** `up` selects the digest matching the chosen
  backend: `source.gguf.sha256` for GGUF, the pinned MLX revision's per-file
  digests for MLX, `quant.sha256` for Ollama. No per-source digest ⇒
  `PullResult.digestVerified = false` is surfaced — never a fabricated pass.
- **Revision pinning (H2).** `gguf.revision` and `mlx.revision` are full commit
  SHAs; adapters resolve exactly that commit and **fail closed** if the resolved
  commit differs. Floating tags (`main`) are forbidden by schema and at runtime.
- **Exact artifact (H3).** `gguf.file` is an exact filename; zero-match or
  multi-match is a hard error. Globs are rejected by schema.
- **Input validation (H4).** A dedicated **HF-repo-id validator** (`owner/name`,
  per-segment `[A-Za-z0-9._-]`, reject `..`/absolute/leading `-`) validates
  every `repo`. Every downloaded `file` passes the existing
  `isSafePathSegment`/`isWithin` traversal guards before touching disk. Every
  child process is spawned with an **arg array** including a `--`
  end-of-options terminator; never a shell string.
- **Loopback enforcement (H5).** Each adapter passes an **explicit**
  `--host 127.0.0.1` (never trusting a runtime's default, which may be
  `0.0.0.0`). After readiness, the resolved endpoint host is **asserted
  loopback**; a non-loopback endpoint is refused (state not written, server
  stopped if owned) unless `allowNonLoopback` was explicitly set.
- **Attach-only trust boundary (M1).** A `canPull:false` backend (LM Studio)
  serves weights `local-llmup` did not download. Where the resolved GGUF is
  locatable, verify its digest; otherwise treat it as a **named trust boundary**
  — `PullResult.digestVerified = false` and a printed warning that integrity was
  delegated to the runtime. The “refuse to serve unverified weights” invariant is
  documented as _delegated_, not silently exempted.
- **Self-managed downloads (M2).** Every download URL passes `assertSafeFetchUrl`
  (HTTPS-only, HF host allowlist, no-credential, no-private-host). Files download
  to a `0600` temp file in a `0700` cache under `homeDir`, are digest-verified,
  then **atomically renamed** into place (mirrors `writeState`); symlinks in the
  cache are rejected; never serve from the temp path.
- **`doctor` version probing (M4).** Best-effort version strings come from
  arg-array, `shell:false` probes and pass through `stripControl()` before
  printing, so a hostile binary cannot inject terminal escape sequences. Selector
  inputs (`--backend`, env) echoed in errors are `stripControl`-sanitized (L3).
- No secrets are read or written; the new config file holds only a backend name.

### 2.9 GGUF / MLX weight acquisition (new pull path)

Unlike Ollama (whose daemon owns a content-addressed store), llama.cpp/MLX
require `local-llmup` to fetch weights itself. This is the riskiest new piece,
so it is specified explicitly (review finding I5):

1. **Downloader:** direct HTTPS `fetch` from HuggingFace resolve URLs, pinned to
   the source's commit `revision`. If a HuggingFace CLI/library is proposed
   instead, it is a **new runtime dependency requiring approval** (repo “ask
   first” boundary).
2. **Digest source:** the catalog-declared `sha256` (GGUF) / per-file digests
   (MLX), cross-checked against the HF LFS pointer when available. A real digest
   is required for self-managed downloads; the size-floor plausibility fallback
   is a last resort only when no digest exists anywhere, and always surfaces
   `digestVerified:false` (review finding L1).
3. **Location:** `~/.local-llmup/cache/<backend>/<repo>@<revision>/<file>`
   (`0700` dirs, `0600` files), verify-before-activate via atomic rename.
4. **Resume/partial:** partial downloads land in the temp file and are discarded
   on digest failure; no partial file is ever promoted or served.

---

## 3. CLI surface changes

All additions are backward compatible; existing invocations behave identically
(default backend resolves to Ollama unless configured otherwise).

### 3.1 `recommend` / `can-run`

- New flag `--backend <name>` — scope ranking/throughput to one runtime.
- New flag `--available-backends` — restrict advice to models servable by an
  **installed** backend (still never drops models silently in default mode; this
  is an explicit opt-in filter).
- Text output: add a `Backends` annotation per model (e.g. `ollama, llamacpp`).
- `--json`: each model gains `backends: string[]` and `throughputBackend:
  string | null`; `throughputBackend` is a **deterministic platform default**
  (never `isInstalled()`-derived; review finding C1), and throughput stays
  `known:false`→omitted number when unsourced.
- Exit-code contract unchanged (`can-run` non-zero **only** for `no`).

### 3.2 `up`

- New flag `--backend <name>` (see selection precedence §2.2).
- Reads the model's per-backend source coordinate for the chosen backend
  (`source.gguf` / `source.mlx` / `source.ollama`) instead of hardcoding
  `source.ollama`.
- Persists `backend` in `state.json` (schema v2).
- If the chosen backend can't serve the model, error lists servable backends.

### 3.3 `down` / `switch` / `chat` / `ls`

- Resolve the adapter from `active.backend` (attach-intent precedence, §2.2 B).
- **`switch` is same-backend only** (review finding C2): it repoints the active
  model on the running daemon, inheriting endpoint/pid/port — valid only within
  one backend. A `--backend` that differs from `active.backend` is rejected with
  a `ValidationError` pointing the user to `down` + `up` (changing runtime means
  a different server on a different port, which the single-active-server model
  — §1 non-goal — does not run concurrently).
- `ls` shows the active backend alongside model/endpoint.
- `chat`/`migrate` embeddings are **best-effort** (review finding I2): if the
  serving backend lacks `canEmbed`, capture proceeds with **no vectors** rather
  than fabricating them or hard-failing; the memory store's `meta.json` records
  that vectors are absent. (No second embedding process runs in v1 — §10 Q3,
  decided.)

### 3.4 `doctor`

- New section: installed backends, versions (best-effort), and the
  auto-selected default for this machine; missing backends show `installHint()`.
- Stays fully offline (probing local binaries only; no network).

---

## 4. Project structure (new/changed files)

```
src/backend/
  adapter.ts          → + BackendCapabilities on the interface
  registry.ts         → NEW: createDefaultRegistry / BackendRegistry
  select.ts           → NEW: selection precedence (flag/env/config/state/auto)
  ollama.ts           → declare capabilities; unchanged behavior
  llamacpp.ts         → NEW: llama-server adapter (GGUF)
  mlx.ts              → NEW: mlx_lm.server adapter (Apple Silicon)
  lmstudio.ts         → NEW: LM Studio (`lms`) adapter
  vllm.ts             → NEW (deferred, §10 Q4): vLLM adapter (Linux+CUDA)
src/config.ts         → + loadUserConfig() for ~/.local-llmup/config.json
src/catalog/schema.ts → + gguf/mlx in ModelSourceSchema
src/types.ts          → + ModelSource.gguf/mlx, ModelFormat, BackendCapabilities
src/state/state.ts    → schema v2 (+backend), v1→v2 normalization
src/advisor/perf-data.ts, throughput.ts → per-runtime efficiency (honesty-gated)
data/perf.json        → + optional `efficiencyByBackend` map per class (absolute, cited)
src/commands/*.ts     → resolve adapter via registry+select (no `new OllamaAdapter()`)
```

Tests mirror every new file under `tests/` as `*.test.ts`.

---

## 5. Code conventions

- Files `kebab-case.ts`; types `PascalCase`; functions `camelCase`; constants
  `SCREAMING_SNAKE_CASE`; **named exports only**; explicit return types on
  exported functions; **no `any`**.
- All new external input (config file, extended catalog `source`, backend server
  responses) validated with **Zod** at the boundary.
- Backend logic lives **only** behind `BackendAdapter`; command code never
  branches on backend name except through the registry/`select()`.
- Typed errors from `src/errors.ts` (`BackendError`, `ValidationError`,
  `StateError`); never return error codes.

---

## 6. Testing strategy

- **Mock every boundary** with `vi.fn()`: no real Ollama/llama.cpp/MLX/LM Studio
  process, no network, no filesystem side effects outside a temp dir.
- **Registry/select unit tests:** create-intent precedence (flag > env > config >
  auto) and attach-intent precedence (`active.backend` dominates); a
  `--backend`/env value **conflicting** with `active.backend` for
  `down`/`chat`/`switch` throws `ValidationError`; platform-aware auto-detect;
  and the “no installed backend can serve” `BackendError` path.
- **Determinism regression:** `recommend`/`can-run` output is byte-identical
  whether or not any backend binary is installed (assert `isInstalled` is never
  called on the advice path); default Ollama throughput is unchanged after
  adding `efficiencyByBackend` (both `ollama` and `llamacpp` resolve to each
  class's existing `efficiency` scalar).
- **State migration tests:** a v1 file (`schemaVersion:1`, no `backend`) loads as
  v2 with `active.backend:"ollama"`, preserves `pid` on the owned variant, and
  rewrites `schemaVersion:2`; attached (`ownedByUs:false`) round-trips too.
- **Schema tests:** `gguf`/`mlx` sources parse; `.strict()` rejects unknown
  keys; `revision` must be a 40-hex SHA (reject `main`); `gguf.file` rejects
  globs and `..`; the “≥1 source” refine still holds; HF-repo-id validator
  accepts `mlx-community/Qwen3-14B` and rejects `../x`, absolute, leading `-`.
- **Adapter contract tests (shared suite per adapter):** loopback bind via
  explicit `--host 127.0.0.1`; endpoint host asserted loopback → non-loopback
  refused (state not written, owned server stopped); arg-array + `--` spawns;
  fail-closed on **digest mismatch**, **revision mismatch**, **exact-file
  zero/multi-match**, and **size-floor** paths; readiness-probe timeout;
  **port-ownership preflight** — when a foreign server already answers on the
  target (e.g. shared **8080**) port, `up` refuses to spawn/claim ownership and
  either attaches (`ownedByUs:false`) or raises `BackendError`, never recording
  `ownedByUs:true` for a process it did not start (review finding I5).
- **Acquisition tests:** download URL passes `assertSafeFetchUrl` (reject
  non-HTTPS, non-allowlisted host, private host); temp-file → verify → atomic
  rename; digest failure discards the partial and never promotes it; cache
  symlink rejected.
- **Advisor honesty tests:** a `(class, backend)` absent from
  `efficiencyByBackend` (e.g. `mlx`, `vllm`) ⇒ `known:false` (never a fabricated
  number); `ollama` and `llamacpp` resolve to the **same** class scalar (byte-
  identical to each other and to today's Ollama output); the advice-path default
  backend is pinned to `ollama` (not the OS/arch auto-selection) so Apple-Silicon
  `recommend` output does not regress to `unknown`; `--backend` scopes correctly.
- **Command routing tests:** `down`/`switch`/`chat` resolve the adapter from
  `active.backend`; `switch` cross-backend → `ValidationError`; embedding
  capture proceeds **vector-less** when `canEmbed:false` (no throw, `meta.json`
  records absence).
- **Config tests:** valid config selects the backend; invalid/corrupt/
  unknown-key/oversized/symlink/world-writable config → `ValidationError`
  (fail closed); absent config → auto-detect.
- **`doctor` tests:** installed backends listed offline (mocked probes); version
  strings pass through `stripControl` (hostile escape sequence neutralized).
- Run `npm test`, `npm run typecheck`, `npm run lint`, `npm run build` after each
  slice.

---

## 7. Domain principles (must hold)

- **Honesty gate:** unknown per-runtime efficiency ⇒ `unknown`; models servable
  only by one backend are annotated, never dropped.
- **Determinism / offline:** advice reads only `data/`; the user config only
  influences serving/selection, never fabricates advice numbers, and advice runs
  make no network calls.
- **Integrity, fail-closed:** every backend verifies pulled weights (digest, else
  size-floor) and refuses to serve unverified weights.
- **Loopback-only:** every backend binds `127.0.0.1` by default; `--host` is an
  explicit opt-in.

---

## 8. Phased delivery plan

Each phase is independently shippable, leaves the tree green, and is guarded by
acceptance criteria that are runnable commands/tests.

### Phase 0 — Foundation refactor (no new runtime, no behavior change)

Introduce the registry, `select()`, capability flags, and route all commands
through them; Ollama remains the only adapter and the default.

- **Deliver:** `registry.ts`, `select.ts`, `BackendCapabilities` on the
  interface + Ollama's descriptor, commands take a `BackendRegistry` dep.
- **Acceptance:**
  - All existing tests pass unchanged; `grep -R "new OllamaAdapter()" src/commands`
    returns nothing (commands go through the registry).
  - `up`/`down`/`switch`/`chat` behavior byte-identical to today for Ollama.

### Phase 1 — State v2 + `source` extension + `doctor`/`recommend` backends

Record the backend in state, extend the catalog source schema, surface backends
in `doctor` and `recommend`.

- **Deliver:** state schema v2 + v1→v2 normalization; `gguf`/`mlx` in schema and
  types; `backendsForModel`; `doctor` backends section; `recommend`
  `backends`/`--backend` (still Ollama-only servable).
- **Acceptance:**
  - v1 state file test loads and rewrites as v2 with `backend:"ollama"`.
  - `recommend --json` includes `backends` per model.
  - `doctor` lists installed backends offline (mocked probes in tests).

### Phase 2 — llama.cpp adapter (`llama-server`, GGUF)

First real second runtime; GGUF pull from HF with fail-closed verification,
loopback `llama-server`, OpenAI-compatible readiness.

- **Deliver:** `llamacpp.ts` + capabilities (`canPull`, `canEmbed` per
  `llama-server` support, `formats:["gguf"]`); catalog `gguf` sources for a few
  models; cited `(class, llamacpp)` efficiency rows in `data/perf.json`.
- **Acceptance (mocked):**
  - `up --backend llamacpp <model>` pulls→verifies→serves→ready→writes
    `backend:"llamacpp"`; digest/size mismatch **fails closed**.
  - `recommend --backend llamacpp` scopes throughput; unsourced class ⇒
    `unknown`.

### Phase 3 — MLX adapter (Apple Silicon)

- **Deliver:** `mlx.ts` (mlx-community repos, `mlx_lm.server` OpenAI-compatible,
  revision-pinned pull); auto-detect ranks MLX first on Apple Silicon; cited
  `(class, mlx)` efficiency rows.
- **Acceptance (mocked):** auto-selection prefers MLX on an Apple-Silicon
  hardware profile; fail-closed pull; honesty-gated throughput.

### Phase 4 — LM Studio adapter

- **Deliver:** `lmstudio.ts` driving the `lms` CLI / local server;
  `capabilities.canPull` reflects LM Studio's own model manager (may be `false`
  → user installs via LM Studio, `up` attaches + verifies presence).
- **Acceptance (mocked):** attach-and-serve path; graceful message when a model
  isn't present in LM Studio.

### Phase 5 — vLLM (deferred to a follow-up spec, Linux+CUDA)

**Not a v1 deliverable (§10 Q4).** Documented here for continuity; picked up only
if a concurrency/serving use-case justifies it.

- **Deliver (if pursued):** `vllm.ts`; available via explicit `--backend vllm`
  and detection-gated, **not** ranked first in auto-detect (single-user decode
  shows no citable per-request speedup, §12.2d); cited efficiency rows only if a
  reproducible single-stream benchmark exists, else `unknown`.
- **Acceptance (mocked):** offered only on CUDA profiles; honesty-gated;
  never surfaced on unsupported hardware.

---

## 9. Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| Fabricated cross-runtime speed numbers | Honesty gate: no cited `(class,backend)` efficiency ⇒ `unknown`. Every figure carries provenance in `data/perf.json`. |
| Stale / content-farm benchmark data leaking into `data/perf.json` | Trust-tiered ingest (§12): only `session-verified` or `spec-grade` figures encoded, each with a source URL and trust tier; `low-confidence` claims ship as `unknown`. All efficiencies derived on one declared weight-bytes/token basis (§2.7); `ollama`/`llamacpp` share a scalar (no invented delta). |
| State-format break for existing users | Additive v2 with in-memory v1→v2 normalization; covered by migration tests. |
| Backend-specific coupling leaking into commands | All backend logic behind `BackendAdapter`; commands branch only via registry/`select()`. A lint/grep check forbids `new *Adapter()` in `src/commands`. |
| Integrity gaps in new pull paths | Shared adapter contract test asserts fail-closed on digest/size mismatch for every adapter. |
| Non-loopback exposure regressions | Contract test asserts loopback bind and arg-array spawns for every adapter. |
| Scope creep (weight conversion, multi-serve) | Explicit non-goals (§1); phases are independently shippable. |

---

## 10. Open questions — resolved defaults

All items below are **decided** at the recommended default (2026-08-06). They can
be reopened, but Phase 2 proceeds on these:

1. **Runtime auto-detect priority — DECIDED.** Apple Silicon: `mlx` → `ollama` →
   `llamacpp`; everything else (incl. Linux+CUDA in v1): `ollama` → `llamacpp`.
   Auto-detect only ever ranks **installed** backends, so this is a *preference*
   order, not a requirement. `mlx`-first is a UX/native-path default, **not** a
   throughput claim — its tok/s stays `unknown` (§2.7). vLLM is **not** in the v1
   auto-detect order (see Q4). Rationale (§12): on Linux+CUDA, llama.cpp and
   Ollama sit on the same single-user decode roofline, and Ollama is the
   lowest-friction default; users pick `llamacpp` explicitly via `--backend`.
2. **GGUF source of truth — DECIDED: direct HTTPS `fetch`, no new dependency.**
   Weights are fetched from HuggingFace resolve URLs pinned to the source commit
   (§2.9), verified via `assertSafeFetchUrl` + digest, using only native `fetch`.
   No `huggingface-cli`/library is added (honors the "ask first" dependency
   boundary). If a future need for range-resume or auth pushes toward a library,
   that reopens as a scoped dependency request.
3. **Embedding fallback — DECIDED: vector-less capture is the default.** When the
   active backend lacks `canEmbed`, memory capture proceeds with **no vectors**
   (§3.3); `meta.json` records their absence. No second embedding process is
   spawned in v1 — that would violate the single-active-server non-goal (§1) and
   add lifecycle/port surface. Re-enabling vector capture under a
   `canEmbed:false` backend is a separate future spec.
4. **vLLM — DECIDED: deferred to a follow-up spec (not in v1).** Its advantage is
   aggregate throughput under concurrency, which the single-active-server model
   does not exercise (§12.2d); in v1 it adds CUDA-format coverage but no
   per-request speedup we can cite. Phase 5 stays documented as a **stretch/
   follow-up**, gated behind detection, not a v1 deliverable.
5. **`--available-backends` — DECIDED: opt-in** (unchanged). Making it default
   would violate “never silently drop a model” (review finding S3).
6. **Emerging runtimes (SGLang, TensorRT-LLM, ExLlamaV2/V3, ktransformers,
   llamafile, Jan/Nexa) — DECIDED: out of v1 scope, tracked** (§12.1). They fit
   the adapter model and can be added later without schema changes; ktransformers
   (DeepSeek-class MoE on modest GPU + RAM) is the most compelling follow-up.

---

## 11. Acceptance criteria (rollup — all verifiable)

- [ ] No `new OllamaAdapter()` remains in `src/commands/` (registry-routed).
- [ ] `state.json` records `backend`; a v1 file migrates to v2 with
      `backend:"ollama"`, `schemaVersion:2`, and `pid` preserved (test).
- [ ] `ModelSourceSchema` accepts `gguf`/`mlx` with pinned 40-hex `revision` and
      exact `gguf.file`, rejects globs/unknown keys/floating tags, keeps the
      “≥1 source” refine (tests).
- [ ] `recommend`/`can-run` output is identical with or without any backend
      installed; `--json` exposes `backends` and a deterministic
      `throughputBackend` **pinned to `ollama`** (not the serving-path
      auto-selection); `ollama` and `llamacpp` share each class scalar; a
      `(class,backend)` absent from `efficiencyByBackend` yields `unknown` (tests).
- [ ] `up --backend <name>` for each shipped adapter pulls→verifies→serves→
      ready and fails **closed** on digest / revision / exact-file mismatch
      (mocked tests).
- [ ] Every adapter binds loopback via explicit `--host 127.0.0.1` and refuses a
      non-loopback resolved endpoint; spawns use arg arrays + `--` (contract
      test).
- [ ] Port-ownership preflight: a foreign server on the target (shared 8080)
      port makes `up` attach or `BackendError`, never record `ownedByUs:true`
      for a process it did not start (contract test).
- [ ] `down`/`switch`/`chat` route via `active.backend`; cross-backend `switch`
      → `ValidationError`; `canEmbed:false` capture is vector-less, not a throw
      (tests).
- [ ] Self-managed downloads pass `assertSafeFetchUrl`, verify-before-activate
      via atomic rename, and never promote a partial (tests).
- [ ] Invalid/symlink/world-writable/unknown-key config fails closed (test).
- [ ] `doctor` lists installed backends + default offline, `stripControl`-clean
      versions (mocked).
- [ ] `npm test`, `npm run typecheck`, `npm run lint`, `npm run build` all pass.

---

## 12. Market & performance research (cited)

Deep-research snapshot (Aug 2026) grounding the runtime choices, the seed
efficiency values, and the honesty-gate decisions above. **Trust tiers** are
labelled explicitly so the data-ingest step (`data/perf.json` provenance) can
enforce the citation rule: `session-verified` (fetched live), `spec-grade`
(manufacturer/official docs, verify at ingest), `low-confidence` (no
reproducible primary source — must ship as `unknown`).

### 12.1 Runtime landscape (2025–2026)

| Runtime | HW targets | Formats | OpenAI server / port | Self-pull | Strength |
| --- | --- | --- | --- | --- | --- |
| **Ollama** | Metal, CUDA, ROCm, CPU | GGUF (registry blobs; imports GGUF/safetensors) | Yes — **11434** | Yes | Easiest single-user UX; wraps llama.cpp |
| **llama.cpp** (`llama-server`) | Metal, CUDA, ROCm, Vulkan, SYCL, CPU | **GGUF** | Yes — **8080** | Partial (`-hf`) | Broadest HW portability; batch-1 latency |
| **MLX** (`mlx-lm`) | **Apple Silicon only** | MLX (safetensors-based) + on-the-fly convert | Yes (`mlx_lm.server`) — **8080** | Yes | Fastest decode on Apple Silicon (small/mid) |
| **LM Studio** | Metal, CUDA, ROCm, CPU (bundles llama.cpp + MLX) | GGUF + MLX | Yes — **1234** | Yes (`lms`) | GUI + local server; strong desktop DX |
| **vLLM** | **CUDA** (ROCm, exp. CPU) | safetensors, **AWQ, GPTQ, FP8**, GGUF (exp.) | Yes — **8000** | HF at load | Batched-throughput king (PagedAttention) |
| SGLang | CUDA (+ROCm) | safetensors, AWQ/GPTQ/FP8 | Yes — **30000** | HF at load | High-throughput; RadixAttention |
| TensorRT-LLM | NVIDIA only | Compiled engines | Triton / `trtllm-serve` | No | Max NVIDIA perf; heavy build |
| ExLlamaV2/V3 | CUDA (+ROCm) | EXL2/EXL3, GPTQ | via TabbyAPI | No | Best quality-per-bit single-user GPU |
| ktransformers | CUDA + **CPU/RAM offload** | GGUF/safetensors + expert offload | Yes | No | **DeepSeek-class MoE on 1 GPU + big RAM** |
| llamafile | CPU/GPU cross-OS | GGUF (single binary) | Yes — **8080** | No | Zero-install portability |
| Jan / Nexa | Metal/CUDA/CPU | GGUF (+MLX in Nexa) | Yes — Jan **1337** | Yes | Desktop app / multi-backend SDK |

Primary sources: Ollama <https://github.com/ollama/ollama>
(<https://github.com/ollama/ollama/blob/main/docs/openai.md>); llama.cpp server
<https://github.com/ggml-org/llama.cpp/tree/master/tools/server>; mlx-lm
<https://github.com/ml-explore/mlx-lm>, MLX <https://github.com/ml-explore/mlx>;
LM Studio <https://lmstudio.ai/docs>, `lms` <https://lmstudio.ai/docs/cli>; vLLM
<https://docs.vllm.ai/en/latest/>
(<https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html>); SGLang
<https://github.com/sgl-project/sglang>; TensorRT-LLM
<https://github.com/NVIDIA/TensorRT-LLM>; ExLlamaV2
<https://github.com/turboderp-org/exllamav2>, TabbyAPI
<https://github.com/theroyallab/tabbyAPI>; ktransformers
<https://github.com/kvcache-ai/ktransformers>; llamafile
<https://github.com/Mozilla-Ocho/llamafile>; Jan
<https://github.com/menloresearch/jan>; Nexa
<https://github.com/NexaAI/nexa-sdk>.

**Design takeaway:** every target runtime exposes an OpenAI-compatible
`/v1/chat/completions`, so the existing Ollama net client generalizes — the
per-backend differences are **lifecycle** (spawn/health/port) and **model
identity/pull**, not the inference API. This validates the adapter split in §2.

### 12.2 Empirical throughput (decode tok/s unless noted)

**(a) llama.cpp on Apple Silicon — `session-verified`** — LLaMA-7B Q4_0, Metal
(llama.cpp Discussion #4167, <https://github.com/ggml-org/llama.cpp/discussions/4167>):
M1 68 GB/s → 14.2 t/s · M1 Pro 200 → ~36 · M1 Max 400 → ~55–61 · M1 Ultra 800 →
~75–84 · M2 100 → ~22 · M2 Max 400 → ~61–66 · M2 Ultra 800 → ~89–94 · M3 Max
300/400 → 57/66 · M4 120 → 24 · M4 Pro 273 → ~50 · M4 Max 410/546 → 70/83.
Back-solving the roofline on this data's **3.8 GB/token Q4_0** basis gives raw
efficiencies from **≈ 0.36 (Ultra)** to **≈ 0.84 (base parts)** — efficiency
falls systematically as the memory tier scales up (memory-controller scaling
loss), which is why it must be keyed to the **fine-grained** perf classes
(`apple-silicon-base/pro/max/ultra`), not one coarse "apple" band.
**Basis reconciliation (review C1/C2):** the existing `data/perf.json` apple
rows (0.70-class) were back-computed on a **4.4 GB/token Q4_K_M** basis.
Renormalizing this #4167 data to that same 4.4 GB basis raises the values by
`4.4/3.8 ≈ 1.16×`, landing the Pro/Max tiers right on the existing ~0.70 — i.e.
the two primary sources **agree** once the denominator is unified. All encoded
efficiencies therefore use the single **4.4 GB Q4_K_M** basis (§2.7), recorded
in provenance; `ollama` and `llamacpp` **share** these values (no invented delta).

**(b) llama.cpp on NVIDIA + Apple — `session-verified`** — LLaMA-3, avg over
1024-token gen (`XiongjieDai/GPU-Benchmarks-on-LLM-Inference`,
<https://github.com/XiongjieDai/GPU-Benchmarks-on-LLM-Inference>). 8B Q4_K_M
decode: RTX 3090 111.7 · RTX 4090 127.7 · A100 80GB 138.3 · H100 PCIe 144.5 ·
M1 Max 34.5 · M2 Ultra 76.3 · M3 Max 50.7. 70B Q4_K_M: A100 22.1 · H100 25.0 ·
M2 Ultra 12.1. **Prefill** (8B Q4_K_M) exposes the split: RTX 4090 ≈ 6,899 t/s ·
H100 ≈ 7,760 vs M2 Ultra ≈ 1,024 · M3 Max ≈ 678 — GPUs ~7–20× faster at prefill
but only ~2–4× at decode (decode is bandwidth-bound; Apple competes). The ~2×
gap between (a) and (b) for the same chip (7B Q4_0 vs 8B Q4_K_M, different
harness) is why the reported tok/s is a **range** (the estimator's ±30%
`DEFAULT_BAND_FRACTION` around a single cited scalar), not a false-precision
point — and why the encoded scalar carries a source + trust tier.
**NVIDIA reconciliation (review I4):** the existing `nvidia-24gb` row (eff 0.68)
was back-computed from an assumed 147 t/s; this source measures RTX 4090 ≈ 127.7
t/s (→ ≈ 0.59 on the same weights). Correcting the NVIDIA rows to this
session-verified anchor is an **intentional, separately-cited data update** at
ingest — it is *not* covered by the "byte-identical" guarantee, which applies
only to the mechanical Phase-0/1 re-keying (`ollama` reusing each class's
current scalar). Any numeric correction lands as its own reviewed dataset change
with provenance, never silently.

**(c) MLX vs llama.cpp on Apple Silicon — `low-confidence` → `unknown`.**
Direction is well-established (MLX generally faster decode + much faster prefill
for small/mid models, via Apple-optimized Metal kernels; substrate
<https://github.com/ml-explore/mlx-lm>), but every **magnitude** claim found
came from AI-content-farm pages with no reproducible methodology. Per the
honesty gate, no MLX multiplier is encoded; `(apple, mlx)` ships `unknown` until
a first-party `llama-bench` vs `mlx_lm` measurement exists.

**(d) vLLM/SGLang vs llama.cpp on CUDA — `partially unknown`.** At **batch=1**
all are near the same bandwidth roofline (llama.cpp can even win on overhead); at
**concurrency**, vLLM/SGLang are multiples faster in aggregate (continuous
batching + PagedAttention/RadixAttention). The single-active-server model does
not exercise concurrency, so no single-stream speedup is credited; absent a
cited head-to-head figure, `(cuda, vllm)` stays `unknown` (§2.7, review I1).
vLLM blog <https://blog.vllm.ai/2023/06/20/vllm.html>;
PagedAttention <https://arxiv.org/abs/2309.06180>. No session-verified
head-to-head single-stream table found → cross-backend CUDA deltas stay `unknown`.

**(e) Ollama vs raw llama.cpp — `low-confidence`.** Ollama wraps llama.cpp; decode
overhead is small (same GGUF kernels), differences come from default context /
flash-attention settings. Modeled as `≈ equal`; the baseline re-attribution in
§2.7 keeps existing Ollama output byte-identical.

### 12.3 Memory-bandwidth anchors (roofline denominators)

- **Apple (`session-verified`, #4167):** M1 68 · M1 Pro 200 · M1 Max 400 ·
  M1 Ultra 800 · M2 100 · M2 Pro 200 · M2 Max 400 · M2 Ultra 800 · M3 100 ·
  M3 Pro 150 · M3 Max 300/400 · M3 Ultra 800 · M4 120 · M4 Pro 273 · M4 Max
  410/546 GB/s.
- **NVIDIA (`spec-grade`, verify at ingest):** RTX 3060 ~360 · RTX 3090/3090 Ti
  936/1008 · RTX 4090 ~1008 · RTX 5090 ~1792 · A100 40/80GB 1555/1935–2039 ·
  H100 PCIe/SXM ~2000/~3350 · H200 ~4800 GB/s.
- **CPU DDR (`spec-grade`, dual-channel):** DDR4-3200 ≈ 51 · DDR5-4800 ≈ 77 ·
  DDR5-5600 ≈ 90 · DDR5-6400 ≈ 102 GB/s — bounds CPU-only / expert-offload paths.

These anchors are **advisory** relative to the existing `data/perf.json`
bracket `memBandwidthGBps` values: at ingest, a class scalar is updated only via
a reviewed, provenance-tracked change (mirroring §12.2b), not silently — so the
two datasets never disagree without a recorded decision. Any hardware class whose
bandwidth cannot be sourced must be marked `unknown`, never guessed.

### 12.4 Recent research relevant to modeling (2024–2026)

- **MoE expert offload to CPU/RAM** — ktransformers serves DeepSeek-V3/R1
  (671B, ~37B active) on one 24GB GPU + large RAM
  (<https://github.com/kvcache-ai/ktransformers>); llama.cpp `--override-tensor`/
  `-ot` pins/offloads specific tensors. Effective bandwidth becomes a blend
  capped by the slowest tier (PCIe/DDR). **v1: out of scope → `unknown`.**
- **Speculative decoding / EAGLE / Medusa** — draft-then-verify raises decode
  ~1.5–3× on accepted tokens without changing the output distribution (EAGLE
  <https://github.com/SafeAILab/EAGLE>, Medusa
  <https://github.com/FasterDecoding/Medusa>). Breaks the pure roofline → **not
  modeled in v1**; presence not assumed (estimates stay conservative).
- **KV-cache quantization (Q8/Q4 KV)** — cuts KV memory ~2–4× and per-step KV
  bandwidth, extending long-context decode (KIVI <https://arxiv.org/abs/2402.02750>;
  llama.cpp `--cache-type-k/-v`). Interacts with `context-window-sizing.md`.
- **Quantization formats** — GGUF **Q4_K_M** (~4.8 bpw, llama.cpp/Ollama,
  <https://github.com/ggml-org/llama.cpp/pull/1684>); **AWQ**
  (<https://arxiv.org/abs/2306.00978>) / **GPTQ** (<https://arxiv.org/abs/2210.17323>)
  GPU-oriented 4-bit; **MLX 4-bit** Apple-native group quant; **EXL2** variable
  bpw, best quality-per-bit. Roofline weight-bytes/token = params × bpw/8 using
  the format's **effective** bpw; quality deltas stay qualitative (no fabricated
  perplexity numbers).
- **FlashAttention / PagedAttention** — FlashAttention-2/3
  (<https://github.com/Dao-AILab/flash-attention>,
  <https://arxiv.org/abs/2205.14135>) cut attention memory traffic (helps
  prefill/long-context); PagedAttention is about KV fragmentation + batching, not
  batch-1 decode. **Mostly affects prefill/concurrency, not the v1 decode figure.**

### 12.5 Adapter-design facts (`spec-grade`, verify at ingest)

| Runtime | Port | Launch (loopback-forced) | Install |
| --- | --- | --- | --- |
| Ollama | 11434 | `ollama serve` + `ollama run <m>` | brew / installer |
| llama.cpp | 8080 | `llama-server -m m.gguf --host 127.0.0.1 --port 8080` | brew / build / release |
| mlx-lm | 8080 | `mlx_lm.server --model <repo> --host 127.0.0.1 --port 8080` | `pip install mlx-lm` (Apple Silicon) |
| LM Studio | 1234 | `lms server start` + `lms load <m>` | app + `lms` CLI |
| vLLM | 8000 | `vllm serve <m> --host 127.0.0.1 --port 8000` | `pip install vllm` (CUDA) |

Two facts drive adapter code: (1) **port 8080 collision** across llama.cpp,
mlx-lm, and llamafile → `up` must probe before claiming ownership (§2.3); (2)
several runtimes bind `0.0.0.0` by default → the adapter must **force
`--host 127.0.0.1`** and assert a loopback endpoint (§2.8 H5). Only Ollama and
LM Studio have first-class digested pulls; llama.cpp/mlx-lm/vLLM pull from
HuggingFace at load, so `local-llmup` must verify HF revision/sha256 itself
(§2.8–2.9).

### 12.6 Honesty-gate ledger (what §2.7 seeds vs. marks `unknown`)

- **Seed (session-verified), on the unified 4.4 GB Q4_K_M basis:** Apple
  bandwidth + llama.cpp Metal decode (#4167, renormalized per §12.2a); llama.cpp
  NVIDIA/Apple decode+prefill (XiongjieDai). These populate the class
  `efficiency` used by **both** `ollama` and `llamacpp` (shared — no independent
  Ollama value, so no invented overhead delta).
- **Seed (spec-grade, verify at ingest):** NVIDIA/DDR bandwidth, ports, launch
  strings, format bpw.
- **`unknown` (no reproducible primary source):** `(apple, mlx)` and
  `(cuda, vllm)` efficiencies (MLX-vs-llama.cpp and vLLM single-stream numbers);
  speculative-decoding and MoE-offload multipliers. These are **absent** from
  `efficiencyByBackend`, so scoping throughput to them yields `{ known: false }`.
  All remain rankable by weights — never substituted with a content-farm number.
