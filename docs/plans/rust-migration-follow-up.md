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

- [ ] Port bootstrap attention geometry and pinned GGUF/MLX source metadata with
  frozen-oracle parity, then replace the write command and retire its TS callers.
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