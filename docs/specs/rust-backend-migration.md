# Rust Backend and Tauri Migration

Status: Approved on 2026-09-17. Checkpoints 1-4 and checkpoint 5 implementation
(R20-R22) are verified experimentally; checkpoint 6 and production cutover are pending.

## Objective

Replace all TypeScript backend functionality with Rust and replace Electron
with Tauri 2, retaining the existing web frontend and user-facing workflows.
This is a staged replacement, not a wrapper that permanently delegates backend
logic to Node.js. A Cargo workspace alone is not migration completion.

## Scope and Compatibility

- Rust owns catalog validation/resolution, hardware discovery, memory sizing,
  advisor/ranking, all four inference adapters, downloads/integrity, lifecycle,
  configuration/state, conversation memory, library, MCP, external harnesses,
  workspace operations, GUI HTTP/SSE, CLI, and terminal interactions.
- Tauri replaces Electron with the same frontend and Rust application services.
  Browser GUI remains supported through a loopback-only Rust HTTP host.
- Keep current CLI commands, flags, JSON fields, exit codes, SSE event shapes,
  data locations, and catalog/performance datasets unless an intentional
  incompatibility is separately reviewed. Existing golden fixtures are contracts.
- Updated user requirement (2026-09-18): no Node.js or npm in the final build,
  runtime, or distribution path, including no thin npm launcher. Ship native CLI
  archives and Tauri applications; end users need no compiler. Browser JavaScript
  remains supported as static frontend assets, not a Node backend. Retained
  TypeScript currently serves as a compatibility oracle until its gates migrate.
- Runtime integrations still launch external Ollama, llama.cpp, MLX/Python,
  LM Studio, and external harness processes when those integrations need them.
  Rust migration does not mean reimplementing their inference engines.
- Rust installation and necessary reviewed crates are approved by the user.
  Existing catalog and memory-store formats must not change during the port.

## Architecture

- Root Cargo workspace with `crates/llmup-core` for pure domain code,
  `crates/llmup-runtime` for OS/network/storage services,
  `crates/llmup-cli` for the native CLI, and `crates/llmup-gui` for HTTP/SSE.
  Create each crate only when it contains working behavior.
- `apps/desktop/src-tauri` consumes the Rust services directly. It must not spawn a Node
  backend. Electron remains the production default until Tauri workflow parity.
- Prefer serde/serde_json and typed validators for wire formats, thiserror for
  typed errors, Tokio for asynchronous services, reqwest with rustls and explicit
  redirects, Axum for HTTP/SSE, and clap for CLI parsing. Introduce dependencies
  only as needed and commit Cargo.lock for reproducible binaries.
- Use Rust 2024, snake_case functions/modules, checked arithmetic, explicit
  Result errors at boundaries, no unsafe application code, and no panic-based
  handling of untrusted data. Preserve JavaScript's safe-integer range in JSON
  contracts. Decimal/floating-point parity must be verified, not assumed.
- During coexistence, Rust exposes explicitly experimental native commands;
  it never silently takes over production commands. Explicit native lifecycle
  commands write their configured home; parity checks only use isolated storage.
  Differential tests run pure Rust logic against the current TypeScript engine.

## Security and Data

- Advice stays deterministic and offline. Unknown geometry/performance remains
  unknown, including hybrid attention. MoE weights include all experts.
- Preserve digest verification, local manifest verification, size floors,
  bounded I/O, redirect/DNS restrictions, process identity checks, cancellation,
  confirmation drift checks, and ownership rules. Bypass only overrides fit.
- Port state locks and atomic writes before enabling any Rust lifecycle mutation.
  Test crash recovery and old/new data interoperability in isolated temp homes.
- Preserve workspace path containment, symlink protections, permissions, reviewed
  edits, secret redaction, and default-deny tool execution. No raw shell or broad
  filesystem capability is exposed to the webview.
- Tauri capabilities are explicit and minimal; remote pages and artifact previews
  receive no privileged IPC. Preserve CSP, same-origin and session authorization.
- No real runtime/model downloads in automated unit or parity tests. Live smoke
  tests require explicit authorization and isolated state.

## Verification and Completion

Each slice requires failing tests, implementation, focused verification, and a
recorded parity result before routing consumers to it. Required Rust gates:
`cargo test --workspace --locked`, `cargo fmt --all -- --check`,
`cargo clippy --workspace --all-targets --locked -- -D warnings`, and
`cargo build --workspace --locked`. Run RustSec/dependency/license review before
release. During coexistence retain npm lint, typecheck, tests/coverage, and build.

The migration is complete only after every CLI/API/runtime workflow is Rust-owned,
the Tauri application passes native integration tests, desktop/browser regressions
pass, existing data upgrades and rollback are tested, platform artifacts are
verified, and retired TypeScript backend/Electron dependencies are removed.
Do not replace an unsupported workflow with an empty-success stub.

## Checkpoint 1 Usage

Rust 1.98.1 is pinned by `rust-toolchain.toml`. Install rustup using the official
installation instructions. On this development machine, Homebrew installed
rustup as a keg-only package; use the following in a new terminal session:

```bash
export PATH="$(brew --prefix rustup)/bin:$PATH"
npm run rust:test
npm run rust:check
npm run rust:build
npm run rust:parity
```

No shell startup files were modified. Standard rustup installations normally use
`$HOME/.cargo/bin` instead. The toolchain includes rustfmt and Clippy.

`target/debug/llmup-fit-parity` is an experimental executable, not a replacement
for `llmup`. It reads a JSON array of projected sizing requests from stdin, with
an 8 MiB input limit and at most 4,096 requests. Each request contains `model`,
`hardware`, and optional `context`; Rust types in `crates/llmup-core/src/sizing.rs`
define the accepted fields. Unknown fields and invalid numbers are rejected.
Successful output is one JSON array on stdout. Invalid input returns exit 1 and
a JSON error on stderr; unsupported arguments return exit 2. `--help` and
`--version` identify the experimental executable explicitly.

The parity script builds and executes this native binary in batches against the
TypeScript oracle. This opt-in test command intentionally spawns the Rust runner;
it does not spawn inference runtimes, contact model endpoints, or mutate user
state. Its use of the existing catalog is limited to projecting sizing fields:
the separate Checkpoint 2 native executable now owns catalog parsing and browsing.

## Checkpoint 2 Usage

```bash
npm run rust:build
npm run rust:advice-parity
cargo run --locked -p llmup-cli --bin llmup-native -- recommend --context 65536 --json
cargo run --locked -p llmup-cli --bin llmup-native -- can-run gemma4:e4b-it-qat --context 65536
cargo run --locked -p llmup-cli --bin llmup-native -- catalog --all
cargo run --locked -p llmup-cli --bin llmup-native -- doctor --json
```

After building, `target/debug/llmup-native` runs directly without Node.js. Its
default command is recommend. Supported recommendation controls include task,
context, context percentage, max-context, backend throughput scope, and explicit
available-backend filtering. `--catalog-path` and `--perf-path` read validated
offline files with a 16 MiB size limit; normal operation embeds the shipped data.
The hidden `--hardware-json` option injects a validated test profile without OS
probing. The hidden `--parity` protocol is bounded and only for differential tests.

Checkpoint 2 originally kept doctor offline by user agreement. Checkpoint 3 now
validates active state and verifies listener identity and backend readiness.
Backend installation/version probes remain bounded local command invocations.
Catalog refresh was initially deferred; checkpoint 6 now implements its offline
dry-run in Rust with exact enrichment/text goldens. Interactive TUI and maintenance
automation remain migration work; installed-model
inventory and lifecycle operations are now available in the experimental binary.

Hardware fixtures cover macOS, Linux, Windows, unknown GPUs, Intel shared memory,
Linux dedicated DRM memory, root disk selection, and snapshot fallback. Native
hardware readings have not been live-validated across platforms. Windows WMI
fallback limitations and missing GPU data are surfaced on stderr. No inference
runtime is launched or contacted by the deterministic parity tests.

The existing TypeScript application remains the production implementation.
This checkpoint does not ship Tauri or authorize deleting any existing backend.

## Checkpoint 3 Usage

The experimental native binary now owns state/config, acquisition, process control,
all four lifecycle/inference adapters, installed-model discovery/context activation,
up/switch/down/ls, and active doctor checks. It does not invoke a Node backend.
These commands are opt-in and do not replace the production npm entry points.

```bash
npm run rust:state-parity
cargo test --locked -p llmup-runtime
target/debug/llmup-native ls --json
target/debug/llmup-native doctor --json
target/debug/llmup-native recommend --installed --context 65536 --json
target/debug/llmup-native can-run gemma4:e4b-it-qat --installed --context 65536
```

Native up/switch/down are real mutations. Use a separate `LOCAL_LLMUP_HOME` for
experimental runs; inspect it with native ls/doctor and do not mix concurrent
released clients. Runtime binaries and, for Unix ownership probes, lsof/ps must
be installed. Acquisition needs network access; ordinary advice remains offline.

```bash
target/debug/llmup-native up gemma4:e4b-it-qat --backend ollama --port 11435
target/debug/llmup-native up gemma4:e4b-it-qat --installed --bypass --context 65536
target/debug/llmup-native switch llama3.1:8b
target/debug/llmup-native down
```

Explicit CLI context remains Ollama-only, matching the existing command contract.
Installed activation requires bypass and an existing verified Ollama daemon; it
never pulls or spawns. Ordinary switch only changes the model pointer on Ollama;
use up to replace single-model llama.cpp/MLX or attach a delegated LM Studio model.
Bypass never disables disk, digest, local-manifest, process, or loopback checks.
Progress and fit/integrity warnings go to stderr; command results go to stdout.

The state parity command uses isolated temporary storage and a Rust example
process, not inference binaries. It verifies state round-trips and mutual lock
exclusion with the patched TypeScript implementation. The shared `lock.guard`
directory serializes lock creation/reclamation/release; lock files retain their
PID format. Unknown owners and abandoned guards fail closed. Earlier released
TypeScript clients do not honor this guard protocol, so do not run them concurrently
with experimental Rust mutations. No automated guard deletion is safe merely
because its timeout expired; recovery requires establishing that no mutator remains.

Rust confirmations bind all validated state fields, including context and runtime
model IDs, and are not byte-compatible with TypeScript confirmation tokens.
All-backend state and ls text/JSON parity is checked. Runtime tests use injected
OS/HTTP boundaries, not real inference. Live Windows/Linux and runtime smoke
certification, packaging/security release gates, and production cutover remain
later checkpoints. The plan records conservative recovery and legacy timestamp
limitations; experimental APIs are not yet production-stable.

## Checkpoint 4 Usage

The experimental backend implements memory capture/migration and embedding
integration, agent/skill libraries, all five chat harnesses, MCP connections and
approval policy, workspace/context/edit services, sessions, and image artifacts.
These native services do not call the TypeScript backend. Existing production
entry points are unchanged; GUI route/SSE transport wiring and Tauri are checkpoint 5.
The agent execution loop and session run coordinator themselves are native services
implemented in checkpoint 4, not deferred TypeScript dependencies.

```bash
npm run rust:workflow-parity
target/debug/llmup-native chat --message "Hello" --no-memory
target/debug/llmup-native chat --harness openai --message "Hello" --json
target/debug/llmup-native migrate --from source:model --to target:model --context 8192 --dry-run
target/debug/llmup-native migrate --from source:model --to target:model --context 8192
target/debug/llmup-native migrate --from source:model --to target:model --context 8192 --move --yes
```

Use an isolated `LOCAL_LLMUP_HOME`. Local chat requires a verified active runtime;
cloud harnesses require their existing environment configuration (`OPENAI_API_KEY`,
`ANTHROPIC_API_KEY`, or `OPENAI_COMPAT_BASE_URL` and optional
`OPENAI_COMPAT_API_KEY`). OpenCode must be installed; tools are denied unless
`LOCAL_LLMUP_OPENCODE_UNRESTRICTED` is explicitly enabled. Neither tests nor parity
scripts invoke these real services. Native CLI chat is deliberately noninteractive
until checkpoint 6, and accepts `--model`, `--agent`, repeated `--skill`, and bounded
stdin. Only local CLI chat captures memory; capture failures are reported without
discarding the reply. The memory APIs support injected re-embedding/summarization.
CLI migration summarizes overflow using the verified target when that target is
active; otherwise it deterministically truncates. Backends without embedding
support migrate vector-less. Without a target embedder, supported vector spaces
are reused. A dry run writes nothing but may query the active target for a summary.
The prepared migration is computed once and committed against captured source,
target, and runtime state; concurrent changes fail closed.

`ChatService` freezes reviewed context, requires explicit disclosure approval for
non-local providers, and commits user/assistant messages together only at the
expected session revision. A cancelled or stale run cannot overwrite newer session
data. `SessionRepository::runs` owns one cancellable run per session, and the
service commits only through the active run lease. `prepare_with_prompt` accepts
the bounded explicit system prompt and supplies the most recent 20 messages to
inference while preserving all stored messages.

`ChatService::run_agent` drives the native model/tool/result loop and persists its
final exchange through the same revision/run checks. Bind a `LocalHarness` with
`bind()` for a multi-step turn so the expected runtime remains fixed throughout.
Tool events carry redacted arguments/results; step/call/output/approval-time limits
are enforced. With no trusted approver, tool calls are denied. MCP approvals are
separate from model output: a trusted host must grant each
call or an exact session-scoped tool identity. Reconnects and session/workspace
changes invalidate grants. Risk labels are advisory, never permission grants.

Memory and workspace transactions retain recovery bytes when interrupted. Opening
a native memory store recovers its pending transaction; a read-only migration
preview refuses pending recovery rather than mutating storage. Successful moves
retain the original source under `.staging/memory-moved-*`. Never delete recovery
directories simply because a timeout expired. Use native recovery before letting
older TypeScript clients access an interrupted home. Normal schema-1 data remains
readable and writable by both implementations.

Native memory generation operations and workspace reads/writes use retained
directory capabilities with no-follow traversal, rather than validating a path
and subsequently trusting ambient pathname resolution. Libraries, sessions, and
artifact reads use the same bounded capability-relative file helper. This uses
`cap-std` and `cap-fs-ext`; application unsafe code remains forbidden.

Workspace edit recovery requires explicit root registration and a matching stored
filesystem identity. It restores only files still matching the transaction output;
user-modified files are skipped and their pending journal retained. Root capabilities
are not automatically restored from disk. Delete proposals can be reviewed, but
delete application remains disabled, matching the existing safety boundary.

Verification includes 34 exact workflow oracle fixtures, bidirectional memory
capture, native CLI dry-run/copy/move, injected provider/process tests, and a real
MCP SDK handshake over in-memory pipes. Native transport/resource limits may reject
inputs accepted by the legacy implementation. Live server interoperability,
platform filesystem/process certification, and power-loss testing remain release
gates; no production readiness is implied by the experimental checkpoint.

## Sources

- https://doc.rust-lang.org/cargo/reference/workspaces.html
- https://serde.rs/derive.html
- https://docs.rs/sysinfo/0.38.4/sysinfo/struct.System.html
- https://docs.rs/tokio/latest/tokio/process/struct.Command.html
- https://docs.rs/clap/latest/clap/
- https://docs.rs/time/latest/time/
- https://rust-lang.org/tools/install/
- https://v2.tauri.app/start/prerequisites/
- https://v2.tauri.app/security/capabilities/
- https://v2.tauri.app/reference/config/
- https://docs.rs/rustix/1.1.5/rustix/process/fn.test_kill_process.html
- https://docs.rs/reqwest/0.12.28/reqwest/struct.ClientBuilder.html
- https://docs.rs/reqwest/0.12.28/reqwest/dns/trait.Resolve.html
- https://docs.rs/tempfile/3.27.0/tempfile/struct.NamedTempFile.html#method.persist
- https://docs.rs/tempfile/3.27.0/tempfile/struct.NamedTempFile.html#method.reopen
- https://docs.rs/rmcp/3.4.0/rmcp/
- https://docs.rs/rmcp/3.4.0/rmcp/transport/trait.Transport.html
- https://docs.rs/sse-stream/0.2.6/sse_stream/
- https://docs.rs/reqwest/0.13.5/reqwest/struct.ClientBuilder.html
- https://docs.rs/cap-std/4.0.3/cap_std/fs/struct.Dir.html
- https://docs.rs/cap-fs-ext/4.0.3/cap_fs_ext/trait.DirExt.html
