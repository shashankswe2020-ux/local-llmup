# TypeScript Retirement

The final migration target is Rust CLI/backend plus Tauri, with no Node/npm build,
launcher, runtime, or distribution requirement. Static browser JavaScript remains.
R22 is verified; the PR is not ready to claim complete migration while R23-R26 remain open.

## Deleted After Replacement

- `scripts/rust-fit-parity.ts`: replaced by
  `cargo test --locked -p rigspark-cli --test fit_parity`. A frozen independent
  TypeScript oracle preserves all 2,849 sizing cases, exact numeric comparisons,
  original batch boundaries, and validation/argument exits. Three native tests pass.
- `scripts/rust-advice-parity.ts`: replaced by
  `cargo test --locked -p rigspark-cli --test advice_parity`. The frozen oracle retains
  78 reports, 5,148 verdicts, and 9,126 resolver/can-run cases, including 918
  resolution and 162 validation errors. Two native tests preserve text/JSON,
  ordering, sanitization, and the original numeric tolerance.
- `scripts/rust-gui-parity.ts`: replaced by
  `cargo test --locked -p rigspark-gui --test recommendation_parity`. Three native
  tests cover all 24 GUI recommendation contracts through the native GUI owner,
  with structural/order checks and the original numeric tolerance. Frozen oracle
  fixtures record independent TypeScript provenance and source hashes. These
  three gates no longer compare against live TypeScript on each run; intentional
  contract/data changes require explicit baseline review and recapture.
- `src/tui/screens/chat.tsx`: unused screen with no source/test imports; native
  `tui_chat` provides the active experimental visual chat path. Four native chat
  tests pass. Its stale generated JS, source map, and declaration were removed
  from `dist` as well. Remaining chat-entry/limits modules are not deleted because
  their boundary contracts still need reconciliation.
- `scripts/verify-release-identity.ts` and
  `tests/shipping/release-identity.test.ts`: replaced by
  `cargo verify-release-identity` with ten native tests and 100 frozen result/error
  cases. Package/workflow callers use the native replacement; release policy and
  permissions are unchanged.
- `src/catalog/registry-collector.ts`, `scripts/catalog-enrich.ts`, and
  `tests/catalog/registry-collector.test.ts`: replaced by native manifest parsing,
  HTTPS transport, quant-only updates, and `cargo catalog-enrich`. Seventeen native
  tests include eight full-catalog oracle comparisons. Failure/outage and no-op
  runs preserve the catalog; cancellation never writes partial updates. The
  native collector adds streamed byte limits and rejects unsafe registry path
  coordinates before requesting them. Live/platform verification remains pending.
- `scripts/catalog-refresh-dry-run.ts`: replaced by `cargo catalog-refresh --dry-run`.
  Tests verify exact legacy stderr counts, empty stdout, no temporary/state files,
  unchanged bytes and modification times for both no-op and nonempty diffs.
- Five inline Node blocks in the catalog workflow: replaced by the native
  `catalog-notice` formatter for PR/freshness/coverage bodies and attention/count
  decisions. Exact body and native report pipeline tests pass. Report validation
  precedes PR branch mutations; shell/YAML lint now passes. GitHub publishing
  remains in the unchanged workflow steps and was not executed during testing.
- `src/catalog/coverage.ts`, `scripts/catalog-coverage.ts`, and
  `tests/catalog/coverage.test.ts`: replaced by native coverage parsing, monitoring,
  fixed-source bounded HTTPS collection, and JSON/text/summary reporting. Five
  offline differential reports matched before deletion; ten native tests cover
  parser/comparison, body limits/status/cancellation, output contracts, and safe
  report writes. Use `cargo catalog-coverage --inventory-path <file>` for offline
  verification. Missing repositories are alerts only, never auto-admitted.
- `src/catalog/bootstrap.ts`, `scripts/bootstrap-catalog.ts`, and
  `tests/catalog/bootstrap.test.ts`: replaced by native bootstrap, frozen full
  oracle comparisons, independent geometry tests, and atomic CLI write tests.
  Invoke `cargo catalog-bootstrap`; use `--dry-run` to preview without writes.
- `scripts/catalog-refresh.ts`: replaced by `cargo catalog-refresh` with no-op
  byte preservation and validated atomic updates. The weekly workflow invokes
  Cargo directly; transitional npm commands delegate to Cargo.
- `scripts/rust-dialog-smoke.mjs`: replaced by the Cargo `dialog-smoke` example.
  Native sequence tests and actual Windows/Linux Cancel/select/root/revoke/exit
  tests pass in run `35442346134`; macOS native verification also passes. The
  existing PowerShell/AT-SPI drivers remain, with no Node coordinator.
- `src/catalog/freshness.ts`, `scripts/catalog-freshness.ts`, and
  `tests/catalog/freshness.test.ts`: replaced by the native freshness core and
  `cargo catalog-freshness`. All eleven former test contracts are covered by
  four core tests, with four executable safety/output tests. Three full reports
  matched the retained oracle byte for byte before deletion. The weekly workflow
  invokes Cargo directly; the transitional npm alias delegates to the same command.
- `src/catalog/registry-snapshot.ts`: 66 unchanged records moved to the shared
  JSON snapshot under `crates/rigspark-core/fixtures/`. Native `catalog --refresh`
  embeds and validates it; retained maintenance callers use a validated loader.
  Ninety full enrichment oracle cases and four CLI output goldens pass in Rust.
  The TypeScript enrichment/collector code remains until maintenance tooling moves.
- `src/tui/cancellation.ts` and `tests/tui/cancellation.test.ts`: no production
  imports existed. State/effect classification, recovery messages, timeout constants,
  signal exits, and exact display contracts moved to `crates/rigspark-cli/src/cancellation.rs`
  and `crates/rigspark-cli/tests/cancellation.rs`. Replacement tests passed before
  deletion; remaining TypeScript typecheck and all 2,034 tests passed afterward.
- The unpublished `src/distribution/native-package.ts`,
  `scripts/package-native-preview.ts`, and `tests/shipping/native-package.test.ts`
  from the preceding work were removed. The new Rust distribution assembler and
  tests replace them, without generated `.cjs`, package.json, or npm artifacts.

## Native-Only Build

```sh
cargo native-dist package
cargo native-dist verify target/native-dist/<package-directory>
cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml --locked
```

The archive contains native `llmup` and `rigspark-gui` executables, a strict per-file
SHA-256 manifest, and project/browser-library licenses. An adjacent checksum
verifies the tarball. Artifacts are explicitly unsigned: checksum consistency
does not authenticate the publisher. `tar`, a Rust toolchain, and platform-native
build tools are prerequisites; Node and npm are not.

Marked 15.0.12 and DOMPurify 3.4.13 are vendored byte-for-byte with their licenses
and recorded hashes. The Rust host embeds them directly. A separate source
snapshot under `/tmp/llmup-no-node.PPp1qx` containing no npm manifests or
node_modules built and packaged native CLI/GUI executables with a PATH excluding
Node/npm. The initial check exposed a dotted-version archive-name bug, which now
has a passing regression test.

The same npm-free snapshot also compiled the Tauri desktop successfully with
`cargo build --locked --manifest-path apps/desktop/src-tauri/Cargo.toml` and the
same Node-free PATH. Workspace strict Clippy, tests, and build pass; retained
TypeScript lint/typecheck/build pass. This proves native builds no longer need
npm installation, not that every remaining repository workflow has been retired.

## Retained Until Verified Retirement

- Electron main/build/release files still have active desktop packaging consumers;
  delete them together with their production wiring after the Tauri release gates.
- TypeScript CLI, GUI, backend, and data modules remain interconnected and are
  used by parity tests. Full TUI and catalog-maintenance automation are incomplete;
  the user-facing offline catalog-refresh command itself is now native.
- Node-based browser drivers, parity scripts, and workflows still need native
  replacements before removing all npm manifests and the TypeScript toolchain.
  Sizing, advice, and GUI recommendation parity are now native frozen-oracle tests;
  state interoperability and workflow parity still retain their TypeScript drivers.
- R22 actual Linux/Windows folder-selection tests now pass (run `35355772910`).
  Signing/notarization, desktop dependency review, and remaining runtime smoke
  gates are not passed.

Deletion policy: prove a replacement's behavior, migrate its callers/tests, remove
the old implementation, then run checks. Do not delete a failing test or an active
entry point to manufacture a passing migration. No production cutover, release,
or merge has occurred. Verified migration slices are committed and pushed only
to the authorized feature branch for native platform verification.

Latest local deletion batch: retirement inventory reports 309 remaining blockers,
down from 315 before the release-identity and three parity-script/screen removals.
The inventory is intentionally still failing. Native replacement checks, retained
TypeScript typecheck, and the retained build pass. Deep review, full regression,
cross-platform checks, and all-surface performance remain deferred at the user's
request. No push, merge, production cutover, or release was performed in this batch.