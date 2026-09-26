# Whole-Product Rust Migration Ledger

Date: 2026-09-21
Status: Initial M02 inventory. Consumer families are mapped; assertion-level
dispositions remain required before each retirement slice.
Owner: M02 in the [complete migration plan](rust-migration-completion.md).

## Scope

This ledger covers non-CLI TypeScript/Node/Electron consumers and the tooling
needed to remove them. CLI command and terminal assertions remain owned by the
[CLI retirement ledger](cli-retirement-ledger.md). Existing Rust implementation
is not acceptance by itself: each row must reach zero active legacy consumers
and link replacement evidence before its files are deleted.

The strict baseline at `3529fd9a28d3668ca0cfa36b2d3a1cd3bbc54635` contains
305 retirement findings. Counts describe the dirty tree on 2026-09-21 and are
not deletion targets: 153 are under `tests/`, 120 under `src/`, 11 under
`scripts/`, seven under `apps/`, six under `.github/workflows/`, seven are root
files, and one is under `vendor/`.

## Disposition Rules

- `Transfer`: preserve each meaningful assertion in native tests or immutable
  independently sourced fixtures before removing the legacy test.
- `Retire`: remove only after active imports, scripts, workflow callers, package
  references, and generated outputs reach zero.
- `Keep browser asset`: retain reviewed browser JavaScript; it must not import
  Node APIs or require Node to validate, embed, package, or execute.
- `Historical only`: may remain in documentation or external evidence, never in
  a current executable path.
- Unknown ownership or coverage is a blocking gap, not evidence of equivalence.

## Product Consumer Ledger

| ID | Legacy family and active consumers | Existing native owner/evidence | Disposition and dependency | Required evidence / current gap |
| --- | --- | --- | --- | --- |
| L01 | CLI entries, command modules, TUI, command/TUI tests: `src/bin.ts`, `src/cli.ts`, `src/commands/**`, `src/tui/**`, corresponding tests and npm scripts | `llmup-cli`; public/contract/accessibility/PTY/lifecycle/distribution tests | Follow C08-C22 under M06; shared GUI dependencies stay until L02-L11 move | Use the CLI command matrix and ledger; C07 is complete locally, C08 is next. No bulk deletion. **2026-09-25:** `src/commands/**` and `tests/commands/**` fully retired (see CLI ledger shared keepers) |
| L02 | Advice, ranking, resolver and catalog readers: `src/advisor/**`, `src/ranking/**`, `src/resolver.ts`, `src/catalog/**`; consumed by commands and GUI recommendation/model routes | `llmup-core` plus native fit/advice/recommendation frozen suites and catalog tools | Transfer remaining consumer assertions, then retire in M22 | Exact GUI/API assertion mapping and current-candidate dataset byte checks remain. **2026-09-25:** `src/catalog/**` and `src/resolver.ts` retired; `backendsForModel`/formats are compared across ~4,000 exact `backends` arrays in the frozen advice oracle, schema/load/seed by `llmup-core/tests/catalog.rs`, bootstrap and enrichment oracles, enrichment fetch guards by `llmup-runtime/tests/registry_collector.rs`. **Retired 2026-09-25:** `src/advisor/**` and `src/ranking/**`; verdicts, tok/s ranges, scores and fit are owned by the frozen fit oracle (2,849 TS cases), the advice oracle (78 cases × 13 option sets) and `llmup-core` unit tests; perf-dataset rejection vectors (negative/missing bandwidth, efficiency 0 or >1, missing citations, inverted ranges, provenance mismatch, unknown backend/keys, non-URL provenance, schema version) added to `llmup-core/tests/catalog.rs`. IMPL-SPECIFIC: TS weight-sum invariant and recency helper (observable only through the ranking oracles) |
| L03 | Hardware detection and memory math: `src/hardware/**`; consumed by doctor, advice, lifecycle and GUI hardware routes | `llmup-runtime` probes and `llmup-core` sizing; platform fixtures exist | Transfer and retire in M22 after L09 browser routes | Live target matrix is incomplete; unknown GPU/unified-memory behavior must remain honest. **Retired 2026-09-25:** detection by `llmup-runtime/tests/hardware.rs`, memory math by `llmup-core/tests/sizing.rs` and the frozen fit oracle. **Fixed bug:** on macOS, `sysinfo` disk enumeration asks for `AvailableCapacityForImportantUsage`, which computes purgeable space. That took 30-36 s in a cold process, blew the 3 s probe budget, and made `detect()` fail, breaking advice and the GUI model routes. On Unix, root free space now comes from `statvfs("/")` (available blocks times fragment size, the same figure `df` reports and legacy used). Windows keeps `sysinfo` drive enumeration. Regression test: `detection_stays_within_its_probe_budget_on_a_cold_process` |
| L04 | Backend acquisition/inference/network/installed inventory: `src/backend/**`; consumed by lifecycle commands, GUI runtime and local harness | `llmup-runtime` adapters, pull/lifecycle/application/inference tests | Transfer and retire in M22 after M32 runtime acceptance | Assertion-level mapping for all four adapters, custom ports, integrity, cancellation and attached/owned processes remains. **Retired 2026-09-25** with `src/harness/usage.ts`: 22 suites (381 cases) mapped to adapter/pull/acquire/lifecycle/identity/inference/installed/process-control suites. **Fixed bugs:** (1) auto-selection and doctor's default could pick attach-only LM Studio, violating spec Q1 (`mlx→ollama→llamacpp` on Apple Silicon, `ollama→llamacpp` elsewhere); (2) MLX directories allowed a `model_file` custom-loader key (legacy rejected it; mlx-lm can load code it names); (3) Windows LM Studio trust compared canonical `\\?\C:\...` paths and mixed separators exactly and case-sensitively, so LM Studio could never be trusted on Windows; (4) attach-intent `switch`/`down` silently ignored a `LOCAL_LLMUP_BACKEND` that conflicted with the active backend (spec §2.2 requires an error). Added vectors: public/non-public address boundaries, daemon environment allowlist, pull size floor. Intentional: version banners are reported trimmed and sanitized rather than reduced to a semver token; external provider URLs may use non-default HTTPS ports; enrichment never follows redirects (stricter than legacy's validated redirects); pull progress uses lifecycle events. IMPL-SPECIFIC: Node spawn option shapes, JS descriptor objects, registry registration, non-positive PIDs (native PIDs are unsigned and validated) |
| L05 | Durable state/config and shared contracts: `src/state/**`, `src/config.ts`, `src/context.ts`, `src/types.ts`, `src/immutable.ts`, `src/errors.ts`, `src/output.ts`, `src/sanitize.ts`; broadly consumed | `llmup-core` and `llmup-runtime`; native state/config/error/output behavior exists across unit and CLI tests | State compatibility first at M07; retire residual shared files in M20-M23 | Bidirectional format/lock/recovery assertions still depend on `scripts/rust-state-parity.ts`; map top-level utility tests individually. **2026-09-25:** `src/state/**` retired (native `tests/state.rs` plus six frozen TS state/ls contracts). **Root utilities retired 2026-09-25; `src/` no longer exists.** Config home resolution extracted as `state::resolve_home` and tested (trimmed override, blank fallback, relative-to-absolute, derived paths), plus 0644 acceptance, invalid JSON and a directory at the config path. IMPL-SPECIFIC: error class hierarchy, frozen snapshots, TS enum arrays and table renderer internals (CLI output is pinned by native goldens) |
| L06 | Memory capture/store/migration: `src/memory/**`; consumed by chat, migrate, GUI sessions and agents | `llmup-runtime` memory/migration services and tests; workflow parity fixtures exist | Transfer at M08, retire in M21 | Preserve vector-less stores, staging/recovery bytes, revisions, copy/move/dry-run and legacy reads without candidate-generated fixtures. **Retired 2026-09-25:** five suites transferred to `tests/memory.rs` and `tests/memory_contracts.rs` (rule-ordered fact extraction, sanitized appends and fact dedup, embedding space recording/mismatch rejection/no fabricated vectors, reuse vs re-embed on any model or dimension difference, bounded summaries and deterministic truncation, overlapping-store refusal and atomic replacement of an existing target with owner-only modes, bounded unique slugs, fail-closed metadata and escaping symlinks). **Fixed bug:** a store directory with group/other permissions was accepted; it now fails closed like legacy. IMPL-SPECIFIC: umask manipulation, JS single-use commit objects (native `PreparedMigration` is consumed by value) |
| L07 | Harnesses: `src/harness/**`; consumed by CLI chat, GUI agents and test fixtures | `llmup-runtime` harness implementations and injected tests | Transfer at M08, retire in M21 after GUI chat acceptance | Map local/OpenAI-compatible/OpenAI/Anthropic/OpenCode errors, disclosure, cancellation, usage and embedding capabilities. **Retired 2026-09-25** except `src/harness/usage.ts` (still imported by `src/backend/**`): six suites transferred to `tests/harness.rs` and `tests/harness_contracts.rs` (bearer token only when configured, Claude headers/system-turn handling, malformed payloads and error statuses, local unavailable/attached live identity/runtime-model default/untrusted refusal, OpenCode unrestricted config, explicit providers, inline reasoning/tool markdown, and real fixture-script runs: missing binary, nonzero exit, malformed output, output cap, cancellation kills the child). **Fixed bug:** provider text after `data: [DONE]` was still emitted; the stream now ends at the terminator. IMPL-SPECIFIC: dynamic registration and duplicate-name rejection (native registry is a fixed built-in set) |
| L08 | Agent/skill library and MCP: `src/library/**`, `src/mcp/**`; consumed by GUI routes, agent loop and connector UI | `llmup-runtime` library/MCP/session/tool services and native workflow tests | Transfer at M08/M10, retire in M21 | Map frontmatter/store precedence, connector transports/reconnect, grant invalidation, redaction and subprocess cleanup. **Retired 2026-09-25:** seven suites transferred to `tests/library_contracts.rs` (fail-soft frontmatter, quoting round trip, sorted listing that skips foreign/unsafe files, slug disambiguation, removal, enabled-only composition with agent skills once) and `tests/mcp_contracts.rs` (loopback-only strict unique documents, owner-only atomic store refusing symlinks and writable files, connect/error/disconnect/shutdown status, replace keeps unchanged and closes changed connections, invalid replacement leaves state and file untouched, connected-only tools with first-connector collision wins and routed calls) plus connector id slugging in `llmup-gui/tests/agent_http.rs` |
| L09 | GUI host, models, lifecycle and telemetry: `src/gui/server.ts`, `contracts.ts`, `hardware.ts`, `runtime.ts`, `management.ts`, `telemetry.ts`, `update.ts`; consumed by Electron and browser REST/SSE | `llmup-gui` host/routes/models/telemetry plus host/routes/startup/recommendation tests; `tests/api_contracts.rs` (2026-09-24) | Accept through M09/M13; retire in M20 | **2026-09-24:** server/contracts suites transferred: shell regions, system prompt and temperature forwarding, canonical turn rebuild, cancel/idle cancel, oversized chat, runtimes list, active=null, recommendation runtime/context validation and scoping, installed/up request validation before any runtime access. Intentional: backend failures stream the generic `Chat failed; no completed exchange was saved.` instead of the provider message. IMPL-SPECIFIC: Zod event schemas, TS run-state machine, DI shapes, static-root resolution. Model start/installed discovery with real runtimes stay owned by runtime lifecycle tests. **Retired 2026-09-24:** management (active summary ownership/variant/context; up validation of empty model, port, context, backend, installed-without-bypass and unknown fields before any state or runtime access; presets/limit/unknown context fit via the recommendation oracle), runtime (pure `view()` controls, per-model refusal, `/api/runtimes/*` refusals, `/api/hardware`), telemetry (native `usage()`), update (all version cases). `src/gui/**`, `src/commands/gui.ts` and `tests/commands/gui.test.ts` deleted; `gui` command behavior is owned by `crates/llmup-cli/tests/gui_cli.rs`. IMPL-SPECIFIC: DI of model manager/sensors; real Ollama start/stop is never driven from tests |
| L10 | GUI chat, sessions, tools, artifacts: `src/gui/agent.ts`, `run.ts`, `session*.ts`, `tool-policy.ts`, `artifacts.ts`; consumed by browser chat/tool/session/artifact flows | `llmup-gui` and `llmup-runtime` chat/session/tool/artifact services; native chat/tools/host tests; session/attachment tests added 2026-09-24 | Accept through M10/M11; retire in M20 | **2026-09-24:** session repository, sessions API, chat-runs and chat-attachments transferred. **Fixed bug:** native `gui_text` deleted bare CR, gluing lines (`"```ts\rconst"`); CRLF/CR now become LF (shared by GUI, CLI chat and context sources). Titles collapse whitespace like legacy. **Retired 2026-09-24:** agent (`tests/agent.rs`, `tests/agent_contracts.rs`: incremental deltas, tool results/errors/denials fed back with tool name, budget, cancellation before first step and before tools run), tool-approval/connectors/disclosure (`llmup-gui/tests/agent_http.rs`), tool-policy, usage, run, library, artifacts (missing image now 404; was 400), text-sanitize (`GuiTextStream`; fixed OSC payload leak and bare-CR gluing). Sources and suites deleted with L09 |
| L11 | GUI workspace/edit transactions: `src/gui/workspace/**`; consumed by workspace REST routes and browser editor | `llmup-runtime` workspace/edit capabilities (`tests/workspace_contracts.rs`) and `llmup-gui` routes (`tests/workspace_api.rs`) | **Transferred 2026-09-24**; delete with `src/gui` in M20 | All workspace-service/policy/edit-proposal/patch-transaction/workspace-api/edit-review/edit-apply/context-sources assertions ported (18 native tests). Intentional: missing git and non-repository both report `git-failed`; review errors use native messages (`overlapping or invalid hunk`, `unsafe or duplicate edit path`, `create target exists`); apply requires a prior identical review; workspace access is always enabled (legacy disabled-mode 404s are IMPL-SPECIFIC) |
| L12 | Browser assets: `src/gui/static/**`; embedded/served by Rust host and loaded by Tauri | Reviewed static HTML/CSS/JS plus native asset/host and browser journey evidence | Keep browser assets through M11/M29; remove only actual Node dependencies and obsolete build copies | **2026-09-26:** vendored Marked/DOMPurify moved to `crates/llmup-gui/vendor/` so they ship in the published crate. DOMPurify's `node:` text is an object key (`{node:e,shadow:null}`), not an import; the retirement rule now flags only `from`/`require(`/`import(` module loads of `node:` specifiers. Frontend unit assertions are ported (L13) |
| L13 | GUI unit/integration tests: `tests/gui/**` (34 files) and GUI fixtures | Native `llmup-gui`/`llmup-runtime` tests cover substantial behavior | **28 server-side suites retired 2026-09-24** with L09-L11 | **Client suites retired 2026-09-26:** run reducer, SSE framing, Markdown policy and render scheduler, calculator template and live telemetry assertions run in real Chrome through WebDriver (`crates/llmup-gui/examples/support/client_units.rs`, first step of `browser_smoke`), mutation-checked locally. Markdown dependency policy moved to vendor SHA-256/licence pins in `llmup-cli/tests/shipping_policy.rs`. The New chat journey race (click ignored while `activeRun` trails the settled status) is fixed by retrying until the POST is issued |
| L14 | Legacy browser E2E host and journeys: `tests/e2e/**`, `playwright.config.ts`; drives TS GUI and Electron | Native browser fixture exists; `tests/e2e-native/chat.spec.ts` still uses Playwright/Node | M03 proves replacement; transfer M09-M12; retire at M14 | Preserve model/installed/chat/formatting/tools/workspace/a11y/Electron flows, diagnostics, screenshots, keyboard and responsive checks |
| L15 | State/workflow parity drivers: `scripts/rust-state-parity.ts`, `scripts/rust-workflow-parity.ts` | Native bridge examples, Rust services and frozen fixtures | Transfer at M07-M08, then retire | Run original oracle once while available; retain provenance and real cross-process contention/recovery tests |
| L16 | Electron shell: `apps/desktop/src/main.ts`, `preload.cjs`, desktop package/config/build output; consumes legacy GUI launcher/server | Tauri app under `apps/desktop/src-tauri`; historical three-OS WebView/dialog evidence | **Retired 2026-09-24 (user-approved, Tauri only).** Sources, npm manifest/lockfile/.npmrc/tsconfig, after-pack hook and Electron spec deleted; icons/demos kept | Tauri tests cover root-only navigation/IPC, window-scoped picker, cancel returning no directory, filesystem-safe product name. Intentional differences: 1280x840 (min 760x540) window; external links/new windows denied rather than opened in the OS browser; host stops when the window closes. Launch/relaunch, owned children, installers, signing and update disposition remain M16-M18 gates |
| L17 | Desktop/browser automation: `tests/e2e/**`, `tests/e2e-native/**`, both Playwright configs, dialog/demo runners | Native WebDriver runner, fixture and `scripts/native-browser-journeys.sh` | **Browser suites retired 2026-09-24**: every legacy spec ported and deleted with its TS server, fixtures and configs (see [browser record](../reviews/rust-browser-retirement.md)) | macOS local evidence only; Linux/Windows CI run pending. Dialog runners and demo recorders remain |

## Tooling And Distribution Ledger

| ID | Executable consumer | Current role | Disposition and dependency | Required evidence / current gap |
| --- | --- | --- | --- | --- |
| T01 | Root `package.json`, lockfile, TypeScript/ESLint/Vitest/Playwright configs | Builds/tests TS, launches dev CLI, defines npm CLI artifacts and Node dependencies | **Retired 2026-09-26 (1.0.0)** | `package.json`, `package-lock.json`, `tsconfig.json`, `eslint.config.js`, `vitest.config.ts`, `.prettierrc` and `.npmignore` deleted. `dev` is the `cargo llmup` alias; `cargo native-retirement` reports 0 blockers and runs in CI. Owners: `crates/llmup-cli/tests/retirement.rs`, `tests/shipping_policy.rs` |
| T02 | `Dockerfile` | Builds and runs native binaries as non-root | **Native** | Builds `llmup`, `local-llmup`, `llmup-gui`; ships vendor notices from `crates/llmup-gui/vendor/`. No native image published yet |
| T03 | `scripts/tui-*.ts` | Dependency/package/runtime budgets and baselines | **Retired 2026-09-26** | Budgets covered Ink/React/Yoga npm packages that no longer exist. Native budgets: `native-performance` (latency, peak RSS, executable size) in Rust Merge Readiness; input-safety boundary by `tests/crossterm_boundary.rs` |
| T04 | Catalog/release helpers and workflow policy tests | Native catalog producers; npm release identity | **Retired 2026-09-26** | `workflow-policy`, `readme-packaging` and `markdown-dependency-policy` suites replaced by `tests/shipping_policy.rs` (permissions, pinned actions, native CI steps, no push to main, crate metadata/includes, vendor SHA-256/licence pins, README install). npm `release_identity` checker deleted: it validated `package.json`/lockfile/`npm pack`, which no longer exist |
| T05 | `scripts/record-gui-demo.*`, `record-whoop-connector-demo.mjs`, `opencode-support-demo.sh` | Browser/CLI demos | **Retired 2026-09-26** (GUI recorders); `opencode-support-demo.sh` is native | Recorded GIFs remain as assets. Re-recording would use the WebDriver harness in `crates/llmup-gui/examples/browser_smoke.rs` |
| T06 | `scripts/mcp-python-runner.mjs` | Node wrapper for a Python MCP demo connector | **Retired 2026-09-26** | No test, workflow or code consumer; MCP stdio framing and cleanup are owned by `llmup-runtime/tests/mcp_contracts.rs` |
| T07 | `.github/workflows/ci.yml`, `tui-compatibility.yml`, `rust-desktop-verification.yml`, `rust-merge-readiness.yml` | Quality gates | **Native 2026-09-26** | `ci.yml` runs retirement, fmt, Clippy, tests, `cargo package` and build; `tui-compatibility.yml` (Node 18-24 matrix) deleted; checkout actions replaced by an exact-revision `git fetch` |
| T08 | `.github/workflows/catalog-refresh.yml`, Pages/backlog automation | Catalog refresh, site, backlog | **Native 2026-09-26** | Catalog validation is `cargo test -p llmup-core --test catalog`; Pages publishes the `gh-pages` branch (repository Pages source must be `gh-pages`); backlog uses `gh project item-add` with event data passed through `env` |
| T09 | `.github/workflows/npm-publish.yml`, `.github/workflows/release.yml` | Publication | npm publishing retired; `release.yml` remains verification-only | 1.0.0 publishes crates to crates.io manually in dependency order: `llmup-crossterm`, `llmup-core`, `llmup-runtime`, `llmup-gui`, `llmup-cli`. Signed archives/Tauri installers remain M27/M34 |
| T10 | Root and desktop package manifests/build outputs | npm/Electron closure | **Retired** | No `package.json` in the tree; `dist/` and `apps/desktop/dist/` absent |

## Test Family Transfer Ledger

| Family | Legacy location | Native owner | Retirement gate |
| --- | --- | --- | --- |
| CLI/TUI | CLI ledger plus `tests/commands/**`, `tests/tui/**`, top-level CLI compatibility tests | `crates/llmup-cli/tests/**` and core/runtime owner tests | C08-C13/M06 assertion disposition |
| Core advice/catalog/hardware | `tests/advisor/**`, `catalog/**`, `hardware/**`, `ranking/**`, resolver/config/type tests | `crates/llmup-core/tests/**`, CLI parity suites, runtime hardware tests | L02/L03/L05 mapping and M22 |
| Runtime/backends/state | `tests/backend/**`, `state/**`, lifecycle command tests | `crates/llmup-runtime/tests/**`, CLI lifecycle/public tests | L04/L05 and M07/M32 |
| Memory/harness/library/MCP | `tests/memory/**`, `harness/**`, `library/**`, `mcp/**` | `crates/llmup-runtime/tests/**`, GUI chat/tool tests | L06-L08 and M08/M10/M21 |
| GUI server/frontend | `tests/gui/**` | `crates/llmup-gui/tests/**`, runtime tests, future non-Node browser tests | L09-L13 and M09-M12 |
| Browser/Desktop E2E | `tests/e2e/**`, `tests/e2e-native/**` | M03 browser harness plus Tauri smoke/dispatcher/dialog tests | L14/L16/L17 and M14-M18 |
| Shipping/workflows | `tests/shipping/**`, `tests/workflows/**`, TUI budget tests | Native distribution/retirement/performance/policy replacements | T01-T10 and M24-M29 |

Before deleting a test file, add child rows or evidence references that identify
its assertions and outcome. Files with mixed implementation-detail and public
behavior assertions may use separate dispositions. Do not classify a mock call
count as public compatibility unless ordering or side effects make it observable.

## Supported Target And Capability Baseline

| Surface | Declared target/capability | Current evidence | Remaining gate |
| --- | --- | --- | --- |
| Native archives | `aarch64-apple-darwin`, `x86_64-apple-darwin`, `aarch64-unknown-linux-gnu`, `x86_64-unknown-linux-gnu`, `x86_64-pc-windows-msvc` | Packaging code validates these five targets; local executable evidence is macOS arm64 | Execute each target or explicitly revise support; minimum OS/glibc versions are not yet declared |
| Desktop/WebView | macOS, Ubuntu and Windows runners | Historical macOS 14, Ubuntu 24.04 and Windows Server 2022 CI evidence exists | Re-run current candidate; runner versions do not establish product minimum OS versions |
| Runtime adapters | Ollama, llama.cpp, MLX/Python and LM Studio | Native implementations and injected tests exist | M32 authorized live target matrix; preserve backend-specific unsupported capabilities |
| Harnesses | local, OpenAI-compatible, OpenAI, Anthropic and OpenCode | Native implementations and injected workflow tests exist | M32 real-provider/runtime evidence only when separately authorized and credentials are securely available |
| Embeddings | Backend capability-dependent | Native services model supported/unsupported/vector-less behavior | Test supported implementations and report unsupported cases without substituting success |

## Generated And Ignored Artifact Hazards

The strict scanner inventories tracked and nonignored untracked files. It does
not prove ignored outputs are absent. Check these after their owning source batch:

- `dist/**/*.js`, `dist/**/*.d.ts`, `dist/**/*.map`, copied `dist/gui/static/**`.
- `apps/desktop/dist/**`, `apps/desktop/release/**`, Electron builder outputs.
- `target/native-build/**`, `target/native-dist/**`, root and desktop Cargo targets.
- `coverage/**`, `test-results/**`, Playwright browser caches and traces.
- Packed npm tarballs, SBOM JSON, release manifests, Docker images and extracted
  installation prefixes outside the repository.
- Tauri generated schemas, permissions, bundles and platform installer staging.

Artifact cleanup must be scoped and verified. Never use a broad clean command on
the shared dirty worktree or treat ignored user data as generated output.

## Current Gaps And Next Child Slices

1. C08 is complete locally and its two TS suites are deleted; C09 callers remain.
2. M03 has a passing local Rust WebDriver runner; full assertion transfer and
  Linux/Windows evidence are still required before L14/L17 retirement.
3. M04 decision: all Node-based GitHub Actions must go, including infrastructure
  actions. The strict scanner now flags the known action references.
4. M05 must refresh separate desktop security/license evidence.
5. Before any M20-M23 deletion, expand the affected L02-L13 row into exact
   source/test assertions and verify the named native owner on the current tree.

The TS state-parity driver in L15 has been retired after two passing original
interoperability runs and three native replacement tests. Its independently
exported contracts and source hashes are retained in
[state-parity.json](../../crates/llmup-cli/fixtures/state-parity.json). The workflow
driver remains until dynamic storage, library, session and workspace assertions
are transferred. No shared application source is authorized for deletion merely
because the driver is gone.

## Progress Recording

For every child slice append: owner, exact files, source/tree identity, legacy
assertions, native tests, commands/results, platform/runtime, deleted/generated
artifacts, retained consumers, review findings, and blockers. Status values are
`pending`, `in progress`, `implemented`, `verified`, `accepted`, or `blocked`.