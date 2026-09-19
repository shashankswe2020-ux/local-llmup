# TypeScript Retirement

The final migration target is Rust CLI/backend plus Tauri, with no Node/npm build,
launcher, runtime, or distribution requirement. Static browser JavaScript remains.
R22 is verified; the PR is not ready to claim complete migration while R23-R26 remain open.

## Deleted After Replacement

- `src/catalog/freshness.ts`, `scripts/catalog-freshness.ts`, and
  `tests/catalog/freshness.test.ts`: replaced by the native freshness core and
  `cargo catalog-freshness`. All eleven former test contracts are covered by
  four core tests, with four executable safety/output tests. Three full reports
  matched the retained oracle byte for byte before deletion. The weekly workflow
  invokes Cargo directly; the transitional npm alias delegates to the same command.
- `src/catalog/registry-snapshot.ts`: 66 unchanged records moved to the shared
  JSON snapshot under `crates/llmup-core/fixtures/`. Native `catalog --refresh`
  embeds and validates it; retained maintenance callers use a validated loader.
  Ninety full enrichment oracle cases and four CLI output goldens pass in Rust.
  The TypeScript enrichment/collector code remains until maintenance tooling moves.
- `src/tui/cancellation.ts` and `tests/tui/cancellation.test.ts`: no production
  imports existed. State/effect classification, recovery messages, timeout constants,
  signal exits, and exact display contracts moved to `crates/llmup-cli/src/cancellation.rs`
  and `crates/llmup-cli/tests/cancellation.rs`. Replacement tests passed before
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

The archive contains native `llmup` and `llmup-gui` executables, a strict per-file
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
- R22 actual Linux/Windows folder-selection tests now pass (run `35355772910`).
  Signing/notarization, desktop dependency review, and remaining runtime smoke
  gates are not passed.

Deletion policy: prove a replacement's behavior, migrate its callers/tests, remove
the old implementation, then run checks. Do not delete a failing test or an active
entry point to manufacture a passing migration. No production cutover, release,
or merge has occurred. Verified migration slices are committed and pushed only
to the authorized feature branch for native platform verification.