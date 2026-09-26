# Rust Migration Follow-Up

Execution update (2026-09-19): the user approved implementation and retirement of
the npm CLI for future versions. Use [CLI Migration Completion Plan](cli-migration-completion.md) for the approved
task breakdown, approval decisions, dependencies, retirement order and acceptance
gates. The sections below are historical progress, not combined certification.

Base: PR #245, merged as `c726793` on 2026-09-19 at the user's request.
Branch: `feature/rust-migration-follow-up`. This follow-up is not authorized to
merge automatically or publish a release.

The foundation was intentionally merged before full retirement. The end goal
remains Rust CLI/backend and Tauri with no Node build/runtime/tooling requirement,
while retaining reviewed browser JavaScript. R23-R26 are still incomplete.

## Started

- [x] Port the deterministic bootstrap benchmark proxy to Rust: exact parameter
  ladder, pinned family offsets, rounding, and malformed-input rejection.
- [x] Verify all existing curated catalog proxies and parameter ladder boundaries
  using native tests. No changes to catalog data or production bootstrap routing.

## Next Work

- [x] Port bootstrap attention geometry and pinned GGUF/MLX source metadata with
  frozen-oracle parity, then replace the write command and retire its TS callers.
- [x] Replace incremental catalog write mode with `cargo catalog-refresh`;
  unchanged input is preserved byte-for-byte and changed catalogs use atomic writes.
- [x] Replace catalog coverage collection/reporting with `cargo catalog-coverage`;
  offline inventories support repeatable verification and the live source remains
  fixed HTTPS with redirects refused, 15-second deadline, and a streamed 1 MiB bound.
- [x] Add native cooked model selection and default-cancel review to accessible
  lifecycle commands, with shared input, 256-byte answers, and cancellation tests.
- [x] Port accessible active-server and diagnostic views with numbered evidence,
  cooked help/quit, unchanged plain-output/exit contracts, Unicode escaping/NFC
  parity, and real-PTY tests.
- [x] Implement native accessible recommendation, catalog, and can-run views,
  including search/details where applicable and explicit unknown-context evidence.
- [x] Implement accessible installed-inventory recommendation and can-run views
  from native runtime metadata, retaining unknowns and original exit codes.
- [x] Implement detailed visual model browsing with search, evidence, help, and
  bounded comparison for catalog/recommendation and installed inventories; route
  can-run through a target detail view while preserving verdict exits.
- [x] Connect full-screen lifecycle execution to actual runtime stage events and
  a scoped diagnostic sink, preserving safety warnings and cancellation cleanup.
- [x] Replace release-identity validation with a native command and frozen parity
  cases; retain existing workflow permissions and release policy.
- [x] Retire TypeScript sizing, advice, and GUI recommendation parity drivers in
  favor of native frozen-oracle tests with the original case counts and contracts.
- [x] Delete the unused TypeScript chat screen and its generated build artifacts
  after checking callers and native chat coverage.
- [x] Replace the maintenance dry-run script with `cargo catalog-refresh --dry-run`,
  preserving exact diagnostics, source bytes, and modification times.
- [x] Replace inline Node PR/issue body formatting and report decisions with
  `cargo catalog-notice`, retaining the workflow's permissions and GitHub actions.
- [x] Migrate live artifact enrichment and its remaining registry collector without
  changing curated dataset formats.
- [ ] Finish terminal UX, capability routing, lifecycle confirmations, and PTY
  parity before retiring active CLI paths.
- [ ] Replace Node browser verification and remaining tooling; rerun the strict
  `cargo native-retirement` inventory after each verified deletion.
- [ ] Resolve desktop dependency/license findings and remaining runtime/embedding
  certification; obtain signing identities through secure configuration.
- [ ] Expand native performance evidence to Windows, Tauri/GUI, long-lived memory,
  and distribution budgets; preserve current Linux/macOS release budgets.
- [ ] Complete signed distribution and reviewed production cutover only when the
  corresponding gates pass. Intermediate merges do not waive release gates.

Verification must remain honest: the retirement job currently fails on retained
Node files, and the passing native tests are not proof of complete migration.

## Current Verification

Native bootstrap has seven core tests (including all 66 frozen oracle models,
independent per-model builds, and 18 independently calculated attention geometries)
and three executable tests. Native refresh writes have four executable tests.
Tests exercise empty PATH, preview without writes, idempotence, invalid input,
symlink rejection, and preserved permissions. Full native format/Clippy/test/build
and retained lint/typecheck/build plus 2,008 tests and coverage thresholds pass.
No curated dataset was changed. The native writer uses deterministic Serde JSON;
floating-point fields may serialize as `8192.0` instead of `8192`. Schema and numeric
meaning are unchanged. No-op refresh preserves original bytes, including formatting.

The user approved Ratatui and Crossterm on 2026-09-19 for full-screen native TUI
work. A frozen 360-case mode-selection oracle passes in Rust. Native report
browsing, model picking, default-cancel lifecycle confirmation, and visual chat
are implemented with buffer/controller tests and local real-PTY acceptance.
Core RustSec and native license checks pass. Full legacy TUI parity remains open;
see `docs/reviews/rust-terminal-progress.md` for the precise remaining gates.
The requested deep CLI/TUI/GUI/desktop performance report is a separate completion
gate after migration; startup-only measurements do not fulfill it.

## Verification Cadence

The user requested batching remote CI after implementation work. Continue focused
local validation after each edit; do not launch or wait for the full matrix on
each increment. Keep changes local until the next agreed verification batch.
No merge or release is authorized. The coverage migration matched five offline
TypeScript reports before deletion and has four core, three response-boundary,
and three executable tests. Its actual live request and platform certification
remain unrun in this batch. No model dataset or memory-store layout changed.

The next local increment adds two compiled dry-run tests, four exact notice-core
tests, and four notice executable tests. The native producer-to-notice pipeline
runs offline with an empty PATH. Reports are bounded to 1 MiB and reject malformed
timestamps, inconsistent counts/flags, unexpected sources, duplicate names, and
unsafe repository names before any output. The catalog workflow's inline Node
formatting is removed and `actionlint` passes, resolving its former nested-shell
quoting failure. Its write-enabled workflow was not dispatched; pushes and the
full platform matrix remain deferred.

Native `cargo catalog-enrich` now replaces the TypeScript registry collector and
maintenance script. Four core tests, nine runtime tests, and four executable
tests cover target-quant updates, digest-only memory preservation, total-parameter
MoE floors, fixed HTTPS origin, streamed 4 MiB limits, per-request deadlines,
isolated failures, cancellation, atomic writes, and no-op byte preservation.
Eight frozen full-catalog cases match the former TypeScript output exactly after
typed JSON normalization. `--manifest-fixture` is strictly offline and never falls
back to live requests; `--dry-run` reports without writing. Live registry requests
and cross-platform certification were not run in this local batch. The workflow
still retains Node-based compatibility quality gates; it has not been dispatched.

## Implementation-First Batch

The user requested implementation before deep review and full testing. Concurrent
agents selected with `GPT-6 Astra (copilot)` implemented independent components;
only focused checks accompany subsequent changes. No remote CI, push, merge, or
release is authorized by this change in cadence.

Accessible catalog and recommendation have 20 and 12 frozen legacy cases;
can-run has 58. The can-run screen intentionally adds the missing-geometry warning
before exit, while preserving the frozen legacy output otherwise. Recommendations
now calculate evidence once for interactive and final output and suppress unsafe
or truncated executable suggestions. Installed views use native runtime evidence
instead of substituting curated metadata and have ten focused component tests.
Temporary Node fixture exporters are removed.

Lifecycle execution now has cancellation-aware running/result/recovery presentation
and waits for the runtime operation after cancellation. It does not claim rollback
success or fabricate detailed stages. Structured runtime events now report actual
acquisition, verification, startup/attachment, activation, readiness, and stop
operations through a bounded nonblocking 64-event channel without string payloads.
The CLI consumes and drains those events. Visual execution now uses a bounded
diagnostic sink and full-screen progress; plain/accessibility stderr behavior is
preserved. Safety warnings retain counts, download filenames are redacted, and
omitted progress is counted. Existing raw subprocess logging policy is unchanged. Twelve
focused runtime event tests, fourteen lifecycle controller tests, and two native
workflow tests pass; full orchestration/platform coverage is still pending.
The release-identity replacement
has ten native tests, including 100 frozen result/error cases; the former script
and mirrored TypeScript test are removed. Full regression, independent deep review,
cross-platform certification, and all-surface performance measurements remain
pending for this batch. R23-R26 are not complete.

The next terminal increment adds 22 focused visual-model tests, 11 installed-view
tests, 19 lifecycle controller tests, and 22 local PTY journeys. Model views reuse
existing evidence and support help, filtering, details, and four-model comparison;
no command suggestions execute. Visual can-run preserves success/no-fit exits and
returns 130 without final stdout on interruption. Confirmed shutdown with isolated
empty state exercises all three terminal screens without touching a runtime.
Installed visual routing is implemented but has no live-runtime PTY certification
in this batch. These focused checks do not replace the deferred full verification.

## Verified Deletions

The user explicitly requested removal of migrated TypeScript files. Three parity
drivers are now deleted and their transitional npm aliases invoke Cargo tests;
the native commands also run directly without npm. Coverage is retained as 2,849
sizing cases, 78 advice reports/5,148 verdicts/9,126 resolver checks, and 24 GUI
recommendation contracts. Expectations were frozen from the independent retained
TypeScript implementations before deletion, with provenance and source hashes.
The unreferenced `src/tui/screens/chat.tsx` and its generated artifacts are removed.

Replacement checks, native chat tests, retained typecheck, and retained build pass.
The current retirement inventory reports 309 blockers (315 before this and the
release-identity deletions). Active TypeScript enrichment, CLI/GUI/runtime callers,
state/workflow interoperability drivers, and browser verification remain until
their consumers and coverage are migrated. No full test/review pass or remote CI
was started; release and production-cutover gates remain unchanged.