# Changelog

## 0.11.2 - 2026-09-01

**Broader model coverage with an auditable catalog pipeline.**

### Model Catalog

- Added the official `gemma4:e4b-it-qat` Ollama artifact with its verified model
  digest, exact weight size, 128K context cap, and QAT Q4 metadata. Context
  memory remains explicitly unknown until Gemma 4 hybrid-attention KV geometry
  is curated.
- Added curated Ollama entries for Gemma 3n E2B/E4B, Qwen3
  0.6B/1.7B/4B, and Phi-4 Mini 3.8B, including verified model-layer sizes and
  digests. Unsupported KV-cache geometry remains explicitly unknown.
- Added a weekly upstream repository coverage audit that reconciles one GitHub
  issue with missing discovery candidates. It never auto-admits models, and it
  cannot detect missing variants inside an already-covered repository because
  Ollama does not expose a public tag-enumeration endpoint.
- Added catalog overview and enrichment-process documentation to the README and
  project site.

## 0.11.1 - 2026-08-30

**Readable, secure Markdown responses in the local AI workspace.**

### New Features

- Assistant responses now render sanitized GitHub-Flavored Markdown with
  headings, nested and task lists, blockquotes, tables, links, code fences,
  language labels, and persistent Copy/HTML Preview actions.
- Streaming output is frame-batched, converges to the same final DOM regardless
  of token fragmentation, and follows only while the reader remains near the
  bottom.
- Replaced the connector demo with two real, explicitly approved WHOOP tool
  calls and an actual-value health briefing.

### Security and Accessibility

- Added GUI-specific multiline sanitization without weakening terminal output
  sanitization, plus strict Marked/DOMPurify tag, attribute, link, and image
  policies.
- Added a deny-by-default CSP, no-store handling for token-bearing HTML,
  MIME/referrer/frame/permissions hardening, and scriptless artifact previews.
- Upgraded the desktop packaging toolchain to `electron-builder@26.15.3`,
  removing the critical/high archive and credential-redirect advisories in the
  previous builder dependency graph.
- Added semantic browser coverage, stable accessible names, keyboard focus,
  concise streaming announcements, hostile-input tests, and responsive checks
  down to 320 px.

## 0.11.0 - 2026-08-30

**Model performance intelligence and a complete local AI workspace.**

### New Features

- **Dedicated model performance view.** Selecting a catalog model now opens a
  complete performance dossier with the composite recommendation score and all
  five score dimensions, estimated throughput and provenance, memory and
  context/KV-cache evidence, model metadata, capabilities, supported runtimes,
  quantization sizing and integrity state, and catalog sources. Unknown values
  remain explicitly unknown.
- **Durable chat workspace.** Browser and desktop chat now support bounded,
  owner-only multi-session history with create, search, rename, archive, delete,
  export, and restart recovery.
- **Reliable run lifecycle.** Server-owned run IDs, stop/cancellation
  propagation, terminal-state guards, durable failures, retry, and fragmented
  SSE handling prevent duplicate or late completions.
- **Explicit workspace context.** Users can select a bounded workspace, attach
  files or line ranges, paste terminal output or diagnostics, and include
  read-only Git status/diffs. The context ledger records hashes, sizes,
  truncation, and inclusion decisions.
- **Safe tools and edits.** MCP calls expose locally classified risk, redacted
  arguments/results, and approval decisions. Model edits remain inert proposals
  until diff review and hash-guarded apply; stale or conflicting files fail
  closed.
- **Native folder selection.** The hardened Electron shell exposes one narrow,
  sandbox-safe directory chooser bridge without granting renderer filesystem
  access.
- **Docker distribution.** A digest-pinned, non-root, multi-platform CLI image
  is published to GitHub Container Registry for `linux/amd64` and
  `linux/arm64`, with immutable release tags and `latest`.

### Security and Privacy

- Workspace roots require explicit user selection and remain containment- and
  symlink-checked; reads are bounded and mutations are revision/hash guarded.
- Sending workspace context to a cloud harness requires a visible disclosure
  decision before any content leaves the machine.
- The GUI and desktop Runtime Host remain loopback-only with strict Host,
  Origin, content-type, and capability checks.

### Documentation and Validation

- README and site now lead with the model performance view and provide npm,
  native desktop, and Docker installation choices.
- Added deterministic browser and Electron journeys for chat, sessions,
  cancellation, context, tools, edits, accessibility, and responsive model
  details.
- Added client reducer and arbitrary-fragment SSE tests plus expanded GUI,
  workspace-policy, session-store, and release-packaging coverage.

## 0.10.0 - 2026-08-27

**Intel Arc/Xe GPU detection.**

### New Features

- **Intel GPU detection.** Hardware detection now recognizes Intel Arc (discrete)
  and Xe (integrated) GPUs. A discrete Arc's dedicated VRAM counts toward fit and
  the yes/slow/no verdict; integrated Xe stays conservative (shared memory isn't
  credited). With no sourced Intel performance profile, throughput stays
  `unknown` rather than guessing (honesty gate). (#223)

### Fixes

- macOS desktop app is ad-hoc signed so Apple Silicon no longer reports it as
  “damaged”.
- Desktop installers (macOS / Windows / Linux) now attach to the published
  GitHub Release on every release.
- Site: OS-aware installer bar with a platform dropdown and per-OS icons.

## 0.9.1 - 2026-08-27

**Desktop app icon, one-click installers, and a green release pipeline.**

### New Features

- **Desktop app icon.** The Electron app and site now use the brand silver
  diamond mark (matching the GUI rail), wired into the window, the macOS Dock,
  and electron-builder for all platforms.
- **Direct desktop downloads.** The site's Desktop section links straight to the
  packaged installers (macOS `.dmg`, Windows `.exe`, Linux `.AppImage`).
- **Release CI builds installers.** The release workflow now builds and publishes
  the desktop installers for macOS, Windows, and Linux on every tagged release.

### Fixes

- Make the release workflow pass reliably: build before test so dist-dependent
  tests have `dist/bin.js`, poll for a stable rendered frame in TUI tests to end
  first-paint races on slower CI runners, and refresh the noninteractive goldens.

## 0.9.0 - 2026-08-27

**Agentic browser workspace: connectors, agents & skills, tools, and inline graphs.**

### New Features

- **MCP connectors.** Attach Model Context Protocol servers to the workspace —
  local `stdio` commands or loopback HTTP/SSE only. Add, enable, disable, and
  remove connectors; each connector's tools become available to the chat, which
  the model calls in an agentic tool loop.
- **Agents & skills library.** Author reusable **agents** (persona / system
  prompts) and **skills** (instruction blocks), stored locally as markdown with
  YAML frontmatter (the Claude Code / Codex convention). Full create / edit /
  enable / disable / delete. An agent can bundle the skills it always loads, and
  any skill can be toggled per message; the selection is composed into a single
  system prompt server-side.
- **Inline images & graphs in chat.** The chat panel now renders generated
  images and graphs inline, served from a validated, loopback-only artifacts
  endpoint (`GET /api/images/:name`) — basename-only, image-extension allowlist,
  no traversal.
- **Backend picker in the workspace.** Recommendation cards expose a per-model
  runtime selector so every backend (Ollama, llama.cpp, MLX, LM Studio) is
  reachable directly from the browser, not just the auto-selected default.

### Fixes

- **MLX executable check** now recognizes macOS framework Python
  (`.../Python.framework/.../Python`), so MLX chat works on Homebrew Python
  instead of being rejected as an unapproved backend executable.
- **Local chat harness** captures the live listener process identity, so
  fail-closed inference works for attached backends (e.g. LM Studio) instead of
  refusing to run without process/model-path identity.
- The Runtime pill in the chat header reflects the active backend instead of the
  dropdown default.

### Catalog

- Added small, fast validation models to the catalog and bootstrap sources
  (`qwen2.5:0.5b` across Ollama/HF/GGUF and `qwen2.5:0.5b-mlx`).

### Documentation

- Recorded new workspace demos (agents + skills + tools solving and plotting a
  quadratic with an inline graph, and the MCP connector lifecycle) and refreshed
  the site and README with the current UI.

## 0.8.1 - 2026-08-26

**Browser GUI bug fixes.**

### Fixes

- Made the Session sidebar functional: the "Current session" button now reloads
  chat history and switches to the chat view (was dead, non-functional UI).
- Removed misleading static "Previous run"/"Memory" placeholders that had no
  backing store.
- The turn count now refreshes after a successful chat instead of going stale
  until a manual refresh.
- The status strip reflects the real active-model endpoint instead of a
  hardcoded `127.0.0.1:11434`; `/api/models/active` now owns the active-model
  card, fixing a race that could overwrite it with the session placeholder.

## 0.8.0 - 2026-08-26

**In-browser model management + neobrutalist site redesign.**

### New Features

- The browser GUI can now manage models end to end: pick a recommended model for
  your hardware or start one directly, then chat — all driven by the same
  `recommend`, `up`, and `ls` engine as the CLI.
- Added a `GuiModelManager` bridge with `GET /api/models/recommended`,
  `GET /api/models/active`, and `POST /api/models/up` routes. Requests are
  Zod-validated and models are brought online through the verified `up`
  lifecycle (integrity checks and active-server state included).
- The Models view surfaces the same yes/slow/no verdicts and est. tok/s as the
  CLI, with a Start button that serves a chosen model on `127.0.0.1`.

### Documentation

- Recorded a real browser GUI demo GIF and Models-view screenshot; added a
  Browser GUI section to the README.
- Redesigned the marketing site with a neobrutalist theme (thick borders, hard
  offset shadows, cream paper, colored icon tiles) documenting every feature,
  the full 11-command surface, and the new Browser GUI.

### Validation

- Added GUI model-management unit coverage and server route tests.
- Verified with the project’s full typecheck, lint, build, and test gates.

## 0.7.0 - 2026-08-26

**Browser GUI + pluggable chat harness adapters.**

### New Features

- Added a loopback-only browser GUI for interactive chat sessions.
- Added a pluggable chat harness registry for `local`, `claude`, `openai`, and `openai-compatible` providers.
- `llmup gui` now starts a browser-backed local/cloud chat server with safe host validation and JSON output mode.
- `llmup chat --harness <name>` routes non-local prompts through the selected provider without disturbing the default local backend path.
- Cloud harness availability checks fail closed when required credentials or runtime configuration are missing.

### Validation

- Added harness unit coverage, GUI server coverage, and chat regression tests for the non-local harness path.
- Verified the feature with the project’s full test, typecheck, build, and lint gates.
- Refreshed the release demo assets to match the current command surface.

## 0.6.1 - 2026-08-10

**Documentation patch.**

- Add real TUI screenshots and end-to-end demo GIF recorded with vhs
- Replace HTML `<pre>` mockups with actual terminal captures
- Include VHS tape files for reproducible re-recording (`assets/*.tape`)

## 0.6.0 - 2026-08-10

**Terminal User Interface (TUI) — Release Candidate.**

This release adds a full interactive terminal UI that activates automatically in
capable terminals (TTY ≥60×16) and degrades gracefully to plain text elsewhere.

### New Features

- **Interactive TUI** with Ink 5 + React 18 rendering to stderr:
  - **Recommend screen** — searchable, scrollable model list with selection,
    marking, comparison, and detail overlays.
  - **Doctor dashboard** — box-drawn diagnostics, backend version table, AI
    Hardware Score axes.
  - **Catalog browser** — search, filter, refresh diff, and model details.
  - **Lifecycle progress** — real-time staged pull/verify/serve with Ctrl+C
    cancellation and partial-state compensation.
  - **Chat screen** — multi-line input (Ctrl+J), streaming responses, draft
    validation (32 KiB / 8192 graphemes / 256 lines), session summary on exit.
  - **Model picker** — keyboard-navigable model selection for switch/migrate.
  - **`ls` card** — active server status with auto-exit for implicit TUI.
- **Accessible mode** (`--accessible`) — cooked line-oriented fallback for
  screen readers. Never enters raw mode or writes cursor-control sequences.
- **Mode auto-selection** — visual / accessible / plain chosen by terminal
  capabilities, environment, and user flags.
- **Cancellation model** — signals trigger a 30-second cleanup timeout with
  compensation (partial state cleared, cursor restored, raw mode exited).
  Second signal forces immediate exit with documented exit codes.
- **Session ownership** — terminal resources (raw mode, cursor, resize listener,
  stdin pause/resume) are tracked and restored on any exit path.
- **Performance budgets** — cold-start regression ≤20 ms p90, TUI module load
  ≤150 ms p90, tarball increase ≤250 KiB, install increase ≤15 MiB.
- **Terminal hygiene guarantees** — no stuck raw mode, no hidden cursor, no
  orphan processes (proven by automated smoke tests).

### Infrastructure

- 23 new TUI test files (337 assertions) covering screens, session, keys,
  cancellation, chat limits, lifecycle, model picker, and budget gates.
- TUI-specific CI workflow (`tui-compatibility.yml`) with runtime-proof,
  package-budget, and dependency-policy jobs across macOS/Linux/Windows ×
  Node 18/20/22/24.
- `tui:package-budget`, `tui:runtime-budget`, and `tui:dependency-policy`
  scripts enforce performance gates in CI and locally.
- Total test count: **1459 tests** across **87 files**, all passing.

### Dependencies Added

- `ink` ^5.2.1, `react` ^18.3.1 (lazy-imported; zero cost on non-TUI paths)

## 0.5.0 - 2026-08-08

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
- Added the attach-only LM Studio backend for GGUF and Apple-Silicon MLX models.
  It discovers downloaded models through bounded, schema-validated `lms` JSON,
  verifies locatable GGUFs against catalog SHA-256, names any unavoidable
  delegated-integrity boundary, and never auto-selects or owns the LM Studio
  process. Attach/readiness/chat/embedding are bound to the exact trusted
  executable, PID, process start, model identifier, and delegated model path.
  Real LM Studio 0.4.20+1 smoke passed exact marker chat and 768-dimensional
  embeddings on a custom loopback port.

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
