# Rust Migration Follow-Up

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
- [ ] Migrate remaining catalog refresh writes, live collectors, coverage reports,
  and maintenance issue rendering without changing curated dataset formats.
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