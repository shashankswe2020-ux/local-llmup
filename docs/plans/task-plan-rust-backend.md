# Rust Backend Migration Plan

Status: Approved on 2026-09-17; Checkpoints 1-4 and R20-R21 implemented
experimentally. Checkpoint 5 platform certification (R22) remains open.
Scope: full Rust backend and Tauri desktop replacement.
Spec: [Rust migration](../specs/rust-backend-migration.md).

## Checkpoint 1: Executable Parity Foundation

- [x] R1: Install/verify Rust stable, pin the toolchain, and create the core
      workspace with typed fit inputs and bounded JSON input handling.
      Acceptance: invalid numbers/unknown enum values fail; no existing entry points
      or user data change. Verify Cargo tests, fmt, Clippy, build.
- [x] R2: Port memory sizing, quantization precision, context ceilings, and fit
      selection. Acceptance: unknown geometry stays unknown, MoE uses total weights,
      context caps/headroom/tie breaks match TypeScript. Verify Rust unit tests and
      differential cases across the real catalog, GPU/unified/CPU fixtures, and
      multiple contexts. Depends on R1.
- [x] R3: Add an experimental native fit runner and an npm parity command.
      Acceptance: genuine Rust execution, bounded input, clean stdout JSON, typed
      errors, and nonzero exit on invalid input. Not a replacement CLI yet.
      Verify native process tests and whole-catalog differential comparison.

Review checkpoint: demonstrate exact parity and document what is still TypeScript.

### Checkpoint 1 Results

- Rust 1.98.1 installed through rustup and pinned; Cargo.lock checked into the
  working tree for reproducibility. Application crates forbid unsafe code.
- Implemented `llmup-core` sizing/fit and `llmup-cli`'s experimental
  `llmup-fit-parity` runner. No production entry points changed.
- 16 Rust tests pass, including numeric validation, unknown geometry, MoE,
  quantization ties, context inverses, bounded input, and I/O error handling.
- `npm run rust:parity`: 2,849 exact comparisons pass across all 66 catalog models,
  three synthetic models, seven hardware profiles, and multiple context lengths.
  Native invalid-input and unsupported-argument exits are checked as well.
- Cargo locked build, rustfmt, and Clippy with warnings denied pass.
- Existing TypeScript lint, typecheck, build, and all 2,047 tests pass, including
  unchanged coverage thresholds.
- Verified on macOS arm64 only. Cross-platform compilation/runtime CI, RustSec
  release audit, Tauri native tests, and live inference checks remain later gates.
- The user explicitly approved stopping here for parity review. Next work is R4:
  full catalog/performance schema and resolver parity, not a production cutover.

## Checkpoint 2: Offline Advice

- [x] R4: Port full catalog/performance schemas and model resolution; reuse
      existing JSON datasets without fabricated fields. Verify invalid catalog and
      ambiguous/explicit-quant resolution fixtures. Depends on R2.
- [x] R5: Port hardware score and throughput evidence using shared fixtures.
      Acceptance: unknown profiles remain unknown and published numeric outputs match.
- [x] R6: Port ranking/recommendation and maximum-context reporting. Verify
      ordering, stable ties, context percentages, frozen-date recency, and JSON goldens.
- [x] R7: Implement platform hardware discovery behind injected probes.
      Acceptance: macOS unified memory, Windows/Linux GPUs, disk and fallback handling
      match observed platform contracts. No guessed VRAM/bandwidth. Verify fake OS
      outputs; perform authorized real-hardware checks separately.
- [x] R8: Deliver native recommend/can-run/catalog/doctor commands with existing
      plain/JSON contracts. Dependencies: R4-R7. Verify golden CLI output and no network
      requests for offline advice.

### Checkpoint 2 Results and Limits

- Added strict catalog/performance schemas, source manifest validation, sanitized
  display fields, duplicate/overlap checks, resolver tiers, and typed failures.
- Ported hardware scores, backend-scoped throughput, verdicts, fixed-date ranking,
  context percentages, max-context reporting, and plain advice tables.
- Added `llmup-runtime` with sysinfo RAM/disk measurements and bounded GPU command
  probes: macOS system_profiler, NVIDIA nvidia-smi, Linux DRM sysfs, and Windows
  WMI plus NVIDIA override. Dedicated Intel memory requires explicit evidence.
- Added experimental `llmup-native` recommend/can-run/catalog/doctor commands.
  Production npm entry points and Electron remain unchanged. Embedded datasets
  allow the native binary to run without Node or source-tree data files.
- `npm run rust:advice-parity` passes 78 hardware/mode report comparisons, 5,148
  model verdicts, and 9,126 resolver/can-run cases. Plain text is compared exactly;
  JSON numeric calculations use a 1e-12 relative tolerance for platform math.
- Checkpoint 1's 2,849 sizing cases still pass. Rust tests cover strict inputs,
  manifest rejection, hardware mapping/fallback, ranking ties, offline diagnostics,
  and native CLI success/failure exits. Existing 2,047 TypeScript tests and coverage,
  lint, typecheck, and build pass.
- User-approved scope adjustment: native doctor is offline in Checkpoint 2.
  Existing state yields a warning that readiness was not checked; state parsing
  and process/readiness verification move to Checkpoint 3. It does not claim
  parity with the legacy doctor's active-server diagnostics yet.
- Catalog browsing (`catalog` and `catalog --all`) is ported. Registry enrichment
  (`catalog --refresh`), installed-model checks, and lifecycle flags are explicitly
  rejected rather than silently forwarded or treated as successful.
- Live OS probes were not run on this machine or Windows/Linux as part of this
  checkpoint. Fixture coverage is not proof of live hardware equivalence. WMI can
  truncate large memory readings; NVIDIA uses nvidia-smi when available, otherwise
  a warning identifies that limitation. Missing GPU readings are conservative.
- RAM/disk probe failures without usable measured RAM return an error; no RAM is
  fabricated. Snapshot fallback preserves measured RAM and discloses the legacy
  disk sentinel. Full failure/cancellation platform proof remains a release gate.
- No commits, release, production cutover, dataset changes, or Tauri changes.

Remaining parity work before production: catalog
refresh/enrichment, exact parser diagnostic wording/JSON whitespace, and native
platform smoke tests. These limitations must not be hidden by a production switch.

## Checkpoint 3: State and Runtime Safety

- [x] R9: Port config/state schemas, permissions, locks, atomic writes, process
      identity, and confirmation snapshots. Test interop with existing files and
      concurrent TypeScript/Rust access in isolated homes.
- [x] R10: Port streaming acquisition, pinned repository manifests, digest and
      size validation, cancellation/timeouts, cache containment, and cleanup.
- [x] R11: Port Ollama inventory, installed-model integrity, context variants,
      chat/stream/embed, and serve/attach/stop using injected OS/HTTP abstractions.
- [x] R12: Port llama.cpp adapter; verify exact artifacts and server ownership.
- [x] R13: Port MLX adapter; preserve interpreter/platform and token identity rules.
- [x] R14: Port LM Studio adapter; preserve delegated integrity and attachment rules.
- [x] R15: Port up/switch/down/ls with all bypass/context and ownership semantics.
      Dependencies: R9-R14. Verify adversarial lifecycle and failure preservation tests.

### Checkpoint 3 Results

R9-R15 are implemented in the experimental native path. Production npm entry
points and Electron remain unchanged; this is not the R26 production cutover.

- State/config: strict bounded reads, v1/PID-0 normalization, backend-specific
  identities, private atomic writes, guarded PID locks, descriptor ownership,
  and compare-before-publication. The TypeScript state lock uses the same guard
  protocol. Unknown owners and abandoned guards fail closed rather than being
  reclaimed based only on age.
- Identity: injected OS observations, bounded Unix lsof/ps and Windows PowerShell
  probes, unique loopback listeners, executable/start checks, and confirmations
  binding complete state including runtime model/context. Legacy owned state is
  enriched from verified live identity before stopping. Readiness and shutdown
  have cancellation/deadlines and owned-child cleanup.
- Acquisition: pinned HF HTTPS requests with manual redirect checks and a custom
  resolver that rejects mixed/private/special-address results; streamed SHA-256,
  required commit evidence, exact repository sizes versus GGUF ceiling sizing,
  whole-operation deadlines, cancellation cleanup, progress, private staging,
  component-wise containment, portable path collision checks, guarded PID locks,
  and recognized dead-owner partial recovery. Single-file Rust writes also hold
  the repository lock. Failure never promotes partial or corrupt content.
- Ollama: discrete pull argv and local manifest/blob verification, catalog
  digest/size-floor enforcement, inventory/metadata/context comparison, unique
  context variants with readback and source-drift checks, attach-only installed
  activation, trusted serve/attach/readiness/stop, chat/tool calls, lenient NDJSON
  streaming, and bounded embeddings. Unknown geometry/throughput stays unknown.
- llama.cpp: pinned GGUF acquisition, exact model path/alias checks, authoritative
  health plus OpenAI readiness, custom loopback ports, owned cleanup, chat, and
  explicit unsupported embeddings. No fabricated embedding capability.
- MLX: Apple-Silicon/audited-version gates, complete non-executable snapshots,
  isolated interpreter argv, authenticated guarded server wrapper, exact loaded
  path plus identity completion, five-minute startup budget, owned-only lifecycle,
  bounded chat, and unsupported embeddings. Never attaches to an existing port.
- LM Studio: downloaded-model/group parsing, exact delegated source selection
  and local integrity checks, trusted executable allowlist, greeting/CLI port
  checks, exact loaded identifier/path, attach-only ownership, chat, indexed
  embeddings, and no foreign-process termination.
- Native application: up/switch/down/ls, backend selection precedence, fit/disk
  preflight, explicit quantizations, bypass, installed fallback, context variants,
  installed recommend/can-run, and active doctor checks. Ordinary switch remains
  Ollama-only; single-model/delegated replacement uses up. Failed acquisition
  preserves prior state; stopped owned PIDs are cleared before replacement;
  shutdown failure restores state; final publication rejects intervening drift.
- Verification: 103 Rust tests; strict Clippy, rustfmt, locked build; all 2,055
  TypeScript tests and coverage thresholds, lint, typecheck, and build. The state
  parity runner round-trips all backend identities and legacy state, compares
  native ls text/JSON to TypeScript, and proves lock exclusion both ways. Existing
  2,849 fit cases and the complete offline advice parity suite still pass.

### Release Constraints

- Tests use injected runtime/HTTP boundaries and isolated temporary storage. No
  live inference binaries or model downloads were used. Execution was macOS arm64;
  native Windows/Linux compilation and live-runtime certification remain R25 gates.
- Unix lock recovery uses positive signal-zero death evidence. Other platforms
  retain unknown locks for explicit recovery. Never remove an abandoned guard
  until all cooperating mutators have been stopped.
- Do not run released unpatched clients concurrently with experimental mutations.
  They do not honor the new state guard protocol, and legacy acquisition clients
  do not share all Rust snapshot-lock guarantees. Use isolated homes for testing.
- Linux historical elapsed-time-derived process timestamps may differ by rounding
  from authoritative ps start time; mismatches refuse ownership operations. Restore
  state through a fresh verified attachment rather than weakening identity checks.
- Native confirmation objects are internal, not byte-compatible TypeScript tokens.
  Rust adds explicit response/resource limits and conservative path rejection;
  platform/wire diagnostics are not claimed universally byte-identical.
- No release, commit, push, dataset change, memory-layout change, or Tauri switch.

## Checkpoint 4: Memory, Harnesses, and Tools

- [x] R16: Port memory capture/store/migrate, embeddings, and library composition.
      Acceptance: existing layouts stay readable/writable; rollback loses no records.
- [x] R17: Port local/OpenAI/Claude/OpenAI-compatible/OpenCode harnesses with
      cancellation, streaming, endpoint validation, output caps, and secret redaction.
- [x] R18: Port MCP transports, connector persistence, tool discovery/invocation,
      default-deny approval, resource limits, and teardown.
- [x] R19: Port workspace context, sessions, artifacts, reviewed edit transactions,
      and file-root authorization. Verify traversal, symlink, stale approval, and
      recovery fixtures. Dependencies: R9, R16-R18.

### Checkpoint 4 Implementation and Evidence

Rechecked and completed at the native service boundary on 2026-09-18. The initial
2026-09-17 implementation left integration gaps despite marking this checkpoint
done. The follow-up closes those gaps; production npm, Electron, and HTTP entry
points remain TypeScript until their planned cutover, not as native fallbacks.

- Memory preserves schema-1 metadata, JSONL conversations/chunks/vectors, raw
  facts/persona, and existing library/session/connector documents. Capture pins
  embedding spaces; migration supports reuse, re-embedding, summarization hooks,
  deterministic truncation, copy, and guarded move. Native backend embeddings
  verify active process identity. Publication journals recover interrupted
  generations and source retirement; recovery retains uncertain bytes.
  `PreparedMigration` binds one computed plan to both store snapshots. The native
  CLI now uses `MigrationService`: active-target summarization demotes stored
  system turns, respects backend embedding support, and checks runtime drift
  under the commit lock. Summaries are not regenerated during publication.
- All five harnesses are registered in production order. Remote and OpenCode
  output is bounded, cancellable, and redacted across event boundaries. Native
  chat consumes library and memory data; `ChatService` composes reviewed context,
  explicit cloud disclosure, and revision-checked atomic session exchanges.
  Local inference streams adapter deltas with sink-driven cancellation. Native
  run leases prevent concurrent provider calls for one session and reject late
  completion after cancellation. Explicit system prompts and the 20-message
  inference window preserve the existing chat contract without deleting history.
- MCP uses the official `rmcp` SDK for JSON-RPC, with bounded stdio, guarded
  Streamable HTTP, same-origin legacy SSE fallback, paginated discovery, exact
  single-use approvals, scope-bound session grants, local risk classification,
  redacted previews, and bounded cleanup. An in-memory pipe test exercises the
  real SDK handshake, discovery, invocation, and close without a live server.
  The native agent loop now composes model requests, explicit approval, MCP
  invocation, tool feedback, and final streaming through `ChatService::run_agent`.
  It preserves advertised tool names, bounds steps/calls/results, defaults to
  denial without an approver, and withholds tools for the final budgeted step.
  Connector add/remove/list status APIs are native and omit environment secrets.
- Workspace roots remain opaque capabilities. Reads/search/context reject denied
  paths and symlinks; reviewed diffs match the frontend contract. Apply/revert
  checks exact hashes; pending recovery requires a newly authorized matching
  root and never overwrites user drift. Sessions, library CRUD/composition,
  bounded Git snapshots, and decoded image artifact basenames are implemented.
  Capability-relative operations (`cap-std`/`cap-fs-ext`) bind memory generation
  publication/recovery and workspace file operations to retained directory
  handles. Session/library/artifact access also uses bounded capability-relative
  file operations; traversal rejects symlinked ancestors. Replaced-root tests
  prove that an existing memory/workspace handle cannot switch to another root.
- Experimental CLI `chat` accepts piped input or `--message`; `migrate` supports
  read-only previews and copy/move (`--move --yes`). Interactive terminal UX is
  still R23. Agent execution and run orchestration are implemented in Rust here;
  only HTTP/SSE transport wiring and the GUI/Tauri host remain R20-R22.

Verification: 166 Rust tests; cargo fmt, strict Clippy, and workspace build pass.
TypeScript lint/typecheck/build and all 2,055 tests in 142 files pass; coverage
thresholds pass (85.22% statements, 79.22% branches, 81.51% functions, 86.67% lines).
All prior sizing/advice/state parity gates pass. `npm run rust:workflow-parity`
adds 34 exact fixtures, bidirectional memory capture, and native CLI
dry-run/copy/move interoperability with TypeScript readers.

Deliberate boundaries: native APIs add conservative resource/path limits; native
transaction journals live in `.staging` and must be recovered by Rust before
returning an interrupted home to an older client. Moved source bytes and
quarantined generations are retained for recovery, not automatically purged.
Workspace recovery does not persist file-access authorization. No live cloud,
inference, or MCP service was used in verification. Power-loss durability and
Windows/Linux process/filesystem certification remain R25 release gates.

## Checkpoint 5: Rust GUI Host and Tauri

- [x] R20: Port GUI HTTP routes, SSE streaming, request limits, session token and
      origin checks, static/vendor assets, and graceful shutdown to Axum.
      Dependencies: R8, R15-R19. Verify existing HTTP contracts and browser journeys.
- [x] R21: Create the Tauri app using the existing frontend and the Rust host;
      match navigation, native dialogs, lifecycle, and packaging identity. No Node
      backend. Gate every privileged capability and forbid artifact IPC/navigation.
- [ ] R22: Run native Tauri tests on macOS/Linux/Windows plus browser screenshots,
      console/network checks, keyboard accessibility, streaming/cancellation, and
      desktop integration tests. Linux requires WebKitGTK; Windows requires WebView2.

### Checkpoint 5 Implementation and Evidence

R20-R21 are implemented in `crates/llmup-gui` and
`apps/desktop/src-tauri`. The production npm CLI, TypeScript GUI, and Electron
entry points are unchanged. The native host and desktop execute no Node backend.

- Axum serves embedded frontend/vendor assets and native model, hardware,
  runtime, session, library, workspace, connector, artifact, update, and chat
  routes. JSON bodies are bounded with deadlines; workspace routes require the
  launch token. Exact loopback listener/Host and same-origin mutation checks
  reject rebinding, cross-site requests, and unexpected listeners.
- Native SSE drives `ChatService` and the MCP agent loop. Disconnect, explicit
  cancellation, shutdown, session changes, and connector mutations cancel work;
  incomplete replies are not persisted. Admission rejects concurrent chats.
  Approval slots are registered before publication to avoid early-response races;
  connector mutations cancel before waiting for the agent's manager lock.
- Tauri retains product identity and the frontend, uses an ephemeral loopback
  host, exposes only the native directory picker, and denies external navigation,
  new windows, and downloads. Artifacts have sandbox CSP and no privileged
  capability. The exact-root capability uses `/{}` because Tauri 2.11.5 expands
  a bare `/` URL pattern to all paths. IPC regression tests reject artifact URLs,
  other ports/origins, and other windows through the actual Tauri dispatcher.
- Native telemetry provides measured RAM/CPU/disk plus frontend host-roundtrip
  latency. Latest-call input/output and prompt-cache counts preserve unknown
  provider fields rather than substituting zero. It is not session-total billing
  or model inference latency.

Verification on macOS arm64, 2026-09-18:

- Rust workspace and Tauri: formatting, strict Clippy, locked tests and builds pass.
- Real native WebView `--smoke-test` loads the frontend and bridge and exits cleanly.
  Two Tauri tests cover navigation rules and actual command IPC with an injected
  picker result; this does not claim physical native-dialog interaction.
- `npm run rust:gui:e2e`: three Chromium journeys against a real Rust fixture
  host pass: streaming/history restoration/announcements, cancellation without
  partial persistence, and keyboard focus/mobile/desktop rendering. Screenshots
  are generated under `test-results/`. No cloud API or inference runtime is used.
- All prior parity gates pass, plus 24 complete GUI recommendation contracts.
- TypeScript lint/typecheck/build and 2,066 tests pass. Coverage thresholds pass:
  85.31% statements, 79.34% branches, 81.39% functions, 86.76% lines.

R22 is **not complete**. Linux WebKitGTK and Windows WebView2 builds, native
tests, WebView launches, and browser journeys passed on hosted runners. Actual
Linux/Windows folder-selection automation still fails; macOS dialog checks passed.
Run the commands and platform matrix in
`docs/reviews/rust-checkpoint-5-verification.md` on native machines before checking
R22. Signed artifacts, installer certification, live inference smoke, and the
production switch remain checkpoint 6; bundle generation is deliberately disabled.

## Checkpoint 6: Distribution and Retirement

- [ ] R23: Port terminal UX (including accessible/plain modes and cancellation)
      with golden/parity tests. Keep no hidden fallback to the TypeScript backend.
- [ ] R24: Add signed/checksummed native CLI and Tauri artifacts for supported
  OS/architecture targets; no Node/npm launcher or build requirement (updated
  user requirement on 2026-09-18). CI changes and
      release switches require explicit review before activation.
- [ ] R25: Run authorized runtime smoke tests, performance/package budgets,
      RustSec/license checks, data interoperability/rollback, and full workflow parity.
- [ ] R26: Switch production entry points only after R1-R25 pass. Remove retired
      TypeScript backend and Electron code/dependencies; keep frontend tooling and
      appropriate regression fixtures. Document deliberate incompatibilities.

## Working Rules

### Checkpoint 6 Progress (2026-09-18)

This checkpoint is **partial**, not a completed migration. Work in this session
is local only: the user approved existing-runtime smoke tests and local packaging,
not release activation or production routing changes.

- R23: Native line-oriented chat now supports stdin/TTY turns, explicit
  `--accessible`, plain transcript output, bounded 20-message conversation context,
  32 KiB/8,192-grapheme drafts, 1 MiB replies, and Ctrl-C (exit 130). Failed turns
  do not enter history and produce failure status. Local sessions bind their
  initial runtime state. `--message` and single-request JSON remain available.
  Six injected session tests and two executable contract tests pass. Full-screen
  TUI, recommendation/lifecycle selection, capability auto-routing, and complete
  terminal golden/parity coverage remain unfinished; R23 stays unchecked.
- R24: The superseded npm preview generator has been deleted. `cargo native-dist
  package` builds native CLI/GUI executables and an unsigned checksummed archive
  with license notices; `cargo native-dist verify <directory>` checks its manifest.
  Vendored browser assets remove the GUI build's `node_modules` dependency.
  Production npm bins are unchanged pending cutover. Signed cross-platform CLI/Tauri artifacts,
  installer verification, notarization, and release review remain unfinished.
- R25: A real llama.cpp smoke on macOS verified pinned acquisition/digest,
  loopback/custom port, chat, multi-turn context, vector-less memory capture,
  cache reuse, replacement, and owned shutdown. It exposed and led to tested fixes
  for redirect commit-evidence loss and a post-signal process-exit race.
  Native Ollama now supports explicit custom-port/store acquisition, cold-start
  daemon cleanup, and verified activation; an isolated live pull/chat/repeated-up/
  down run passed without changing user state. Embeddings remain unverified. Core
  RustSec/license checks pass; desktop audit warnings and MPL obligations remain.
  Other-runtime certification and approved performance budgets remain open.
- R26: Blocked by R22-R25. No production cutover, retirement of TypeScript/Electron,
  release publication, or change to existing datasets/user memory layouts.

Detailed evidence, commands, limitations, and retained cache location:
`docs/reviews/rust-checkpoint-6-progress.md`.

Implement one numbered slice at a time. Split R4 onward into focused testable
subtasks at the owning code boundary before editing. Preserve existing behavior
and data; do not call a scaffolding checkpoint a complete migration. No release,
branch push, or commit without a separate request. Record failures and remaining
work here so another session can continue without redoing completed investigation.

## Risks

- OS process identity and filesystem semantics differ by platform; pure tests do
  not establish lifecycle safety. Use platform CI and authorized smoke tests.
- Floating-point and JSON numeric differences can change model ordering; retain
  TypeScript as a differential oracle until output contracts pass.
- WebView CSP/IPC and Electron APIs differ; Tauri is a separate migration gate,
  not a packaging-only change.
- A full replacement spans all existing backend subsystems. Checkpoint 1 is a
  deliverable starting increment, not a claim that subsequent work is complete.
