# Implementation Plan: Pluggable KV Cache (native knobs + LMCache)

> Status: **Draft — blocking decisions C1–C7 need sign-off**
> Extends: [task-plan-context-window.md](./task-plan-context-window.md) (closes deferral D10 "fp16-only, `--kv-cache` deferred")
> Related spec: [context-window-sizing.md](../specs/context-window-sizing.md), [pluggable-inference-backends.md](../specs/pluggable-inference-backends.md)
> Last updated: 2026-09-27

## Overview

Let users pick a KV-cache strategy by name — plug-and-play. The advisor then
sizes it honestly, and the lifecycle applies it to the backend fail-closed:

| Provider | What it controls | Backends | Phase |
| --- | --- | --- | --- |
| `native` (default) | KV precision (`f16`/`q8_0`/`q4_0`), flash attention, prompt/prefix reuse | llama.cpp, Ollama (owned daemon), MLX (after verification) | 1 |
| `lmcache` | KV offload/sharing across requests (CPU RAM / local disk) | vLLM only (new backend) | 2, gated |

Today the gap looks like this:
- `ServeRequest` only carries `context` ([adapters.rs](../../crates/llmup-runtime/src/adapters.rs#L44-L49)).
- llama.cpp spawns with `-m/--host/--port/--alias/--ctx-size` only ([adapters.rs](../../crates/llmup-runtime/src/adapters.rs#L324-L336)).
- Ollama gets `OLLAMA_HOST`/`OLLAMA_MODELS` only ([command.rs](../../crates/llmup-runtime/src/command.rs#L20-L25)).
- Sizing assumes fp16 KV everywhere ([sizing.rs](../../crates/llmup-core/src/sizing.rs#L202)).

The no-flag path must stay byte-identical (same four-channel guard as AC-CW9).

## Blocking decisions

| # | Decision | Blocks | Proposed default | Status |
| --- | --- | --- | --- | --- |
| C1 | "Plug and play" = **compile-time provider registry selected by name**. No dylib/plugin loading (`unsafe_code = forbid`) and no user-supplied raw backend args (argument-injection risk). | K3 | Built-in providers only; unknown name → typed error | ⏳ |
| C2 | Bytes per KV element, from the ggml block layouts: `f16` = 2.0; `q8_0` = 34 B/32 = 1.0625; `q4_0` = 18 B/32 = 0.5625. K and V are sized separately. Cite the ggml source in `data/`. | K1 | Accept; any other type → `unknown` (honesty gate) | ⏳ |
| C3 | Ollama KV type and flash attention are **daemon-wide env vars** (`OLLAMA_KV_CACHE_TYPE`, `OLLAMA_FLASH_ATTENTION`). They can only be applied to an **owned** daemon. | K4 | On an attached daemon, refuse with an explanation (fail-closed); never silently ignore | ⏳ |
| C4 | Quantized V cache needs flash attention on llama.cpp. | K3 | `q8_0`/`q4_0` imply `--flash-attn on`; an explicit `--flash-attn off` with a quantized V → validation error | ⏳ |
| C5 | Record the applied profile in `ServerState`. `ServerState` is `deny_unknown_fields`, so this is a **state schema bump v2 → v3** with a read-migration. | K4 | Accept; old state still readable, new state not readable by old binaries (documented) | ⏳ |
| C6 | Persistent defaults: `config.json` is `schemaVersion: 1`, `deny_unknown_fields`, 4 KiB cap ([state.rs](../../crates/llmup-runtime/src/state.rs#L70-L91)). | K5 | `schemaVersion: 2` adds an optional `cache` object; v1 files still accepted | ⏳ |
| C7 | LMCache needs **vLLM**, i.e. a new backend: Linux + NVIDIA only, Python runtime, HF safetensors. This is an *ask-first* boundary. | K8 | Spike + ADR first (K7); build only after approval | ⏳ |

## Architecture decisions

- **Pure core, typed profile.**
  - `llmup-core` gains `KvCacheType`, which is all the advisor needs.
  - `CacheProfile { kv_k, kv_v, flash_attention, prompt_reuse }` lives with the providers in `llmup-runtime`, because flash attention and prompt reuse only matter at launch.
  - Validation and sizing are pure functions.
  - The runtime never re-derives sizing.
- **Provider trait in runtime** (`crates/llmup-runtime/src/cache.rs`):
  ```rust
  pub trait CacheProvider: Send + Sync {
      fn name(&self) -> &'static str;
      fn support(&self, backend: BackendKind, owned: bool) -> Support; // Supported | Unsupported(reason) | Unknown
      fn apply(&self, profile: &CacheProfile, backend: BackendKind) -> Result<SpawnDelta, CacheError>;
  }
  pub struct SpawnDelta { pub args: Vec<String>, pub env: BTreeMap<String, String> }
  ```
  - Adapters merge the `SpawnDelta` into `SpawnSpec`.
  - Providers never spawn processes or touch the network.
- **Fail-closed application.**
  - If a requested knob cannot be applied, `up`/`switch` refuse before spawning.
  - After ready, the adapter records the profile it actually applied. There is no "requested vs. applied" drift.
- **Honesty gate.**
  - Unknown element size or an unverified backend flag → sizing shows `unknown` and `up` refuses.
  - Throughput impact of KV quantization is **not** estimated: `perf.json` has no sourced numbers for it, so the tok/s range is unchanged and labelled "KV quant effect: unknown".
- **Loopback + integrity unchanged.** All new flags are additive. A vLLM/LMCache backend, if approved, binds `--host 127.0.0.1` and goes through the same digest gate.

## Dependency graph

```
C2 ► K1 core KvCacheType + typed KV sizing
        K1 ► K2 advisor flags (recommend/can-run/plan --kv-cache)
{C1,C4} ► K3 CacheProvider trait + NativeCacheProvider (pure translation)
{K3,C3,C5} ► K4 ServeRequest.cache + adapter merge + ServerState v3
        {K2,K4,C6} ► K5 CLI up/switch flags + config.json v2 + ls/doctor
                K5 ► K6 GUI cache selector
── Checkpoint A: native cache knobs shippable ──
C7 ► K7 spike: vLLM + LMCache ADR (no code merged)
        K7 + approval ► K8 vLLM adapter + LmCacheProvider
{K6,K8?} ► K9 docs + site + spec status
```

K1 and K3 can run in parallel. K7 can start at any time.

## Cross-cutting conventions

- Inject Transport, ProcessControl and CommandRunner. Never spawn real Ollama/llama-server/vLLM in tests; assert on the produced `SpawnSpec`.
- Backward-compat guard: golden text, deep-equal JSON, identical key set, plus a spy proving that the no-flag path never calls the typed-KV functions.
- Every new CLI flag: `native_args.rs` help plus `help-plain.encoded.json` golden, and a `public_cli` goldens row.
- Every gate: `cargo fmt --all -- --check`, strict Clippy, workspace tests, `cargo native-retirement`.

## Task list

### K1 — Typed KV sizing (llmup-core) ✅ Done
- **Do:** `KvCacheType { F16, Q8_0, Q4_0 }` with `bytes_per_element()`, and `kv_cache_bytes_typed(per_token_f16, tokens, k, v)`. Per-token f16 bytes are split evenly between K and V.
- **Acceptance:**
  1. `f16/f16` equals today's `kv_cache_bytes` for every catalog model; this is a property test over the catalog.
  2. `q8_0/q8_0` = f16 × 1.0625/2 and `q4_0` = f16 × 0.5625/2, with exact integer rounding documented (round up).
  3. Unknown geometry stays `unknown`, with no fabricated number.
  4. Overflow → typed error.
- **Files:** `crates/llmup-core/src/sizing.rs`, `crates/llmup-core/tests/sizing*.rs`.
- **Verify:** `cargo test -p llmup-core`.

### K2 — Advisor flags ✅ Done
- **Do:** `--kv-cache <f16|q8_0|q4_0>` (and `--kv-cache-k/--kv-cache-v` for asymmetric caches) on `recommend`, `can-run` and `plan`. The KV column, fit verdict and `--max-context` all use the typed size. JSON gains `kvCacheType`.
- **Acceptance:**
  1. The no-flag output is byte-identical (four-channel guard).
  2. `--kv-cache q8_0` raises `--max-context` for a known model, by a golden-checked amount.
  3. Invalid value → exit 2 with a usage error.
  4. Deterministic and offline.
- **Files:** `crates/llmup-cli/src/native_args.rs`, `native.rs`, `crates/llmup-core/src/{plan.rs,ranking.rs,reports.rs}`, fixtures under `tests/fixtures/noninteractive/`.
- **Verify:** `cargo test -p llmup-core -p llmup-cli --test public_cli --test advice_cli`.

### K3 — CacheProvider trait + NativeCacheProvider ✅ Done (verified on llama.cpp b10090, Ollama 0.32.5)
- **Do:** pure translation per backend:
  - **llama.cpp:** `--cache-type-k`, `--cache-type-v`, `--flash-attn on|off`, and `--cache-reuse <n>` for prompt reuse.
  - **Ollama:** `OLLAMA_KV_CACHE_TYPE`, `OLLAMA_FLASH_ATTENTION=1`.
  - **MLX:** `Unknown` until the flag names are verified against the pinned `mlx-lm` version. Record the version and source in the ADR; `up` refuses until then.
- **Acceptance:**
  1. Table test: every (provider, backend, profile) combination produces the exact args/env or a typed refusal.
  2. The C4 rule is enforced.
  3. No arbitrary strings reach args: values come only from enums.
- **Files:** `crates/llmup-runtime/src/cache.rs` (new), `lib.rs`, `crates/llmup-runtime/tests/cache.rs` (new).
- **Verify:** `cargo test -p llmup-runtime --test cache`.

### K4 — Lifecycle wiring + state v3 ✅ Done
- **Do:** `ServeRequest.cache: Option<CacheProfile>`. Adapters merge the `SpawnDelta` into `SpawnSpec`. `ServerState.cache` is persisted. v2 → v3 read-migration.
- **Acceptance:**
  1. `up` against an attached Ollama with a cache profile → refusal before any mutation; state unchanged, lock released.
  2. Owned llama.cpp spawn spec contains the flags.
  3. v2 state files still load; a v3 round-trip is stable.
  4. `switch` preserves the profile unless overridden. *(Moved to K5: the preservation rule lives where CLI flags meet the stored state.)*
- **As built:** schema 3 is written exactly when an owned runtime carries a non-default profile, so a cacheless session still writes v2 and older binaries keep reading it. The replace path checks the profile before it locks, stops or spawns anything.
- **Files:** `adapters.rs`, `special_adapters.rs`, `lifecycle.rs`, `state.rs`, `crates/llmup-runtime/tests/{lifecycle,state}.rs`.
- **Verify:** `cargo test -p llmup-runtime --test lifecycle --test state`.

### K5 — CLI + config defaults ✅ Done
- **Do:**
  - `up`/`switch` accept `--kv-cache`, `--flash-attn`, `--prompt-cache off|reuse` and `--cache-provider native`.
  - `config.json` v2 gets an optional `cache` object.
  - `ls` shows the applied profile.
  - `doctor` reports per-backend cache support (`supported` / `unsupported: reason` / `unknown`).
- **Acceptance:**
  1. Flag beats config beats default.
  2. v1 config still accepted.
  3. Goldens updated; the help ordering of existing flags is unchanged.
- **Files:** `native_args.rs`, `native.rs`, `state.rs`, `application.rs`, `crates/llmup-cli/tests/{lifecycle_cli,public_cli}.rs`.
- **Verify:** `cargo test -p llmup-cli`.
- **As built:**
  - Precedence lives in the pure function `cache::requested`. For `up` it is flag > `config.json` v2 `cache` > backend default. For `switch` it is flag > the running profile, so a switch keeps what is running (K4 criterion 4). `--kv-cache f16` clears the profile.
  - An unchanged profile keeps the Ollama pointer-switch and "already active" shortcuts. A changed profile takes the full replace path, which restarts the runtime local-llmup owns.
  - The profile is checked against the chosen backend **before** any download. `--installed`, `down` and `doctor` refuse cache flags outright.
  - Launch fit now sizes the KV cache at the requested type. An asymmetric K/V profile keeps the conservative f16 estimate.
  - `up` and `ls` print `Cache: KV q8_0, flash attention auto, prompt reuse off`, and their JSON gains a `cache` object. Both appear only when a profile is applied, so the no-flag output is unchanged.
  - **Deferred:** `--cache-provider` (only `native` exists until K8) and the per-backend `doctor` row. Both are listed under K9.

### K6 — GUI cache selector ✅ Done
- **Do:** the Models view gets a cache selector. It shows the typed KV estimate and `unknown` where applicable. `/api/models/up` accepts a validated profile. Refusal reasons are shown the same way as the existing lifecycle errors (control characters stripped, 400 chars max).
- **Acceptance:**
  1. An invalid profile → 400 with a reason.
  2. The estimate updates without network calls.
  3. The WebDriver journey covers selecting `q8_0`.
- **Files:** `crates/llmup-gui/src/models.rs`, `static/index.html`, `static/chat.js` (or the models script), `crates/llmup-gui/tests/api_contracts.rs`.
- **Verify:** `cargo test -p llmup-gui`; `scripts/native-browser-journeys.sh`.
- **As built:**
  - A "KV cache" selector (`f16 · 100%`, `q8_0 · 53%`, `q4_0 · 28%`, the ggml block ratios) sits next to Context window. It is hidden for Installed Ollama, because attached daemons are refused.
  - `GET /api/models/recommended?kvCache=` re-sizes offline. Cards show `KV q8_0` only for models with known geometry; unknown geometry still reads "context fit unknown". The detail panel labels the KV cost with its type.
  - `POST /api/models/up` accepts `kvCache`, `flashAttention` and `promptCache`, and the start confirmation says the cache applies only to a runtime local-llmup starts. `/api/models/active` and the banner report the applied profile.
  - Checked by hand in the integrated browser. **Open:** criterion 3. The WebDriver journey needs Chrome + chromedriver and is listed under K9.

### K7 — Spike: vLLM + LMCache (ADR only)
- **Answer with sources:**
  1. vLLM's CLI surface for loopback binding and model path.
  2. LMCache's connector config (`--kv-transfer-config` with the LMCache connector, `LMCACHE_*` env for CPU/disk size).
  3. Supported GPUs and OSes.
  4. How to verify HF safetensors weights against a catalog digest.
  5. Process identity and trust rules.
  6. The minimum pinned versions.
- **Output:** an ADR section appended to this plan, plus the decision to proceed or stop. **No production code.**

### K8 — vLLM adapter + LmCacheProvider (only after C7 approval)
- **Do:**
  - `BackendKind::Vllm` behind the adapter traits.
  - `LmCacheProvider::support()` returns `Supported` only for owned vLLM on Linux with NVIDIA.
  - Sizing labels offloaded KV as "off-GPU", so the GPU fit reflects only resident KV. The offload size comes from the user's configured budget and is never estimated.
- **Acceptance:** follows the pluggable-backends checklist (integrity, loopback, identity trust, goldens, runtime smoke skill).

### K9 — Docs
- README section "Choosing a KV cache", site FAQ row, `context-window-sizing.md` D10 marked resolved, CHANGELOG.
