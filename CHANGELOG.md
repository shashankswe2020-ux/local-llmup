# Changelog

## Unreleased

Phase 2 llama.cpp production hardening after real-process smoke testing.

- Replaced invalid GGUF catalog coordinates with verified Hugging Face commit,
  filename, size, and LFS SHA-256 metadata; self-managed weights now require a
  digest and are never served after an unverified pull.
- Bounded and serialized direct downloads with cancellation, byte ceilings,
  progress, redirect/SSRF validation, stale-part cleanup, owner-only cache
  permissions, symlink refusal, and atomic verified promotion.
- Chat and migration now use the active loopback endpoint and canonical runtime
  model alias instead of hard-coded ports/Ollama ids.
- llama.cpp attach/spawn/stop now bind HTTP identity to the expected model path,
  alias, listening address, PID, canonical executable, and process start time.
- Fixed repeated/cross-backend `up`, single-model `switch`, backend preference
  precedence, persistent log-pipe deadlocks, and stale-state cleanup.
- Real Ollama smoke testing fixed macOS listener identity for `ollama serve` and
  implemented the advertised embedding capability with trusted-endpoint checks,
  bounded requests/responses, timeout/cancellation, and strict vector validation.
- Added the Apple-Silicon MLX backend (audited `mlx-lm==0.31.3`) with platform gating,
  loopback-only lifecycle, process-bound inference, bounded OpenAI-compatible
  chat, per-session bearer authentication, browser-origin/content-type/body-size
  guards, custom-code refusal, vector-less embedding fallback, and fail-closed multi-file repository
  acquisition from a pinned per-file SHA-256/size manifest. Direct-adapter real
  smoke passed pull/cache→serve→inference→stop with SmolLM2 360M on a custom
  port; catalog/CLI MLX smoke remains gated on curated MLX source data.
- Completed Phase 3 backend selection: MLX is auto-preferred only on Apple
  Silicon, is omitted from non-Apple `recommend`/`can-run` servability output,
  and remains honesty-gated to unknown throughput because no cited MLX
  efficiency scalar is shipped.

## 0.4.1 - 2026-08-07

Bug fix: `--version` now reports the actual installed version.

- `local-llmup --version` was printing a hard-coded `0.3.2` string that had
  drifted from the real package version. The CLI now reads the version from the
  bundled `package.json` at runtime, so it always matches the installed release
  and can never drift again.

## 0.4.0 - 2026-08-07

Pluggable backends (foundation) — the advisor now understands that a model can be
served by more than one runtime, and surfaces which backends apply. Ollama
remains the sole servable backend in this release; the new flags are informational.

- `doctor` gains a **Backends** section: each known backend (`ollama`,
  `llamacpp`, `mlx`, `lmstudio`) with its installed/version status and the
  default. Detection is offline and best-effort — an absent backend reports
  cleanly rather than erroring.
- `recommend` and `can-run` now surface a **`backends`** list per model and a
  **`throughputBackend`** field in `--json`, pinned to `ollama` by default so
  advice stays deterministic and byte-identical regardless of what is installed.
- `recommend`/`can-run` gain **`--backend <name>`** to scope the throughput
  estimate to a specific runtime; `recommend` gains opt-in
  **`--available-backends`** to filter to models servable by an installed
  backend. The default advice path never probes installation and never drops
  models — unsourced `(class, backend)` pairs report `unknown` (honesty gate).
- The model catalog now accepts **`gguf`** and **`mlx`** sources alongside
  `ollama`, and memory capture is vector-less when the active backend cannot
  embed (no fabricated vectors). Internal: backend registry, capability
  descriptors, intent-split selection, fail-closed user config, and a state
  schema v2 (with v1→v2 migration) now underpin all commands.

## 0.3.2 - 2026-08-06

Docs: the README now includes visual aids so command output is easier to grasp.

- Added Mermaid diagrams — a command lifecycle flowchart and a `yes / slow / no`
  verdict decision tree — plus `xychart-beta` performance graphs for estimated
  throughput (tok/s) and the AI Hardware Score breakdown. No code changes.

## 0.3.1 - 2026-08-06

Bug fix: `up` no longer fails for models without a recorded catalog digest.

- The size-only integrity fallback previously required the downloaded weights to
  match the catalog's approximate `diskBytes` **exactly**. Because that figure is
  a rough estimate — real Ollama pulls routinely differ, and are often larger —
  `up` (and `switch`) failed with a spurious `size mismatch` for any model that
  lacks a recorded SHA-256. The fallback is now a plausibility floor: it rejects
  only grossly-truncated/empty downloads (below half the estimate) while
  tolerating benign differences. The strict digest path — and Ollama's own
  manifest verification during `pull` — are unchanged, so integrity is preserved.

## 0.3.0 - 2026-08-06

Context-window sizing — `recommend` now understands how much context each model
can actually hold on your machine, and how a target window changes the ranking.

- `recommend` gains **`--context <tokens>`**: re-ranks the catalog with the KV
  cache sized at your chosen window (fp16), so models that no longer fit at that
  context drop out or fall to `slow` with a `context-bound` reason.
- `recommend` gains **`--max-context`**: reports the largest context each model
  can hold on your hardware, bounded by either the model geometry or your memory
  (`boundBy: model | hardware`).
- `--context` and `--max-context` are mutually exclusive; both surface in
  `--json` alongside a `kvPrecision: "fp16"` field. Unknown geometry reports
  `unknown` rather than a fabricated number (honesty gate).
- Site adds a full command reference; README revamped with real per-command
  terminal output.

## 0.2.0 - 2026-08-06

Local AI Hardware Advisor (v1.0) — the tool now tells you not just what fits, but
how well it will run, with no pricing data or maintenance liability.

- `doctor` now reports an **AI Hardware Score** (0–100) and your **primary
  bottleneck** (VRAM / RAM / compute / storage); `--json` includes both.
- New **`can-run <model>`** command: a single `yes | slow | no` verdict with the
  binding reason and an estimated tok/s range. Exits non-zero only for `no`, so
  it is scriptable (`local-llmup can-run <model> && local-llmup up <model>`).
- `recommend` gains a **Verdict** (✓ yes / ⚠️ slow / ❌ no) and **Est. tok/s**
  column; `--json` gains `verdict` and `estTokPerSec` per row.
- Added a memory-bandwidth **throughput estimator** (roofline model) backed by a
  curated, cited hardware performance dataset (`data/perf.json`). Throughput is
  always a range; hardware with no profile reports `unknown` rather than a
  fabricated number (honesty gate).
- Ranking order and existing command behavior are unchanged.

## 0.1.0 - 2026-08-05

- Initial public release of local-llmup.
- Added hardware-aware model recommendation and local install/serve flows.
- Added chat, migrate, ls, catalog, and doctor commands.
- Added a curated model catalog with weekly refresh automation hooks.
