# Catalog Production Activation and v2.1.0

## Approved Scope

On 2026-09-30 the maintainer approved production key generation without exposing
private material, a main-only `catalog-signing` environment with
`shashankswe2020-ux` as required reviewer (self-approval allowed), expansion to
multi-layer weight accounting for Qwen 3.6, and preparation of v2.1.0. Ask before
publishing crates. Do not merge the activation PR without review or bypass the
protected catalog-publication environment.

## Design

- Embed only the generated Ed25519 public key. The private seed is held outside
  the repository and in the protected GitHub environment secret.
- Add optional per-quantization `projectors` with exact byte counts and SHA-256
  digests. `diskBytes` includes the model and projector weight bytes. Existing
  entries without projector pins retain their prior integrity behavior.
- Enrichment sums projector bytes, retains the model digest separately, and
  sizes resident model weights plus projector weights and the existing 15%
  allowance. Bootstrap must preserve projector pins.
- Pull and context activation enforce pinned projector identities/sizes before
  inference. The local verifier continues hashing every manifest blob.
- Admit `qwen3.6:35b` with sourced weights, native context, capabilities and
  license. Hybrid KV geometry and unsourced benchmark proxy remain unknown.
- The optional extension retains catalog schema version 2; older strict readers
  reject the new field rather than silently ignoring integrity requirements.
  Production trust first ships with v2.1.0, which understands the extension.
- Preserve historical migration oracles and add independent tests for the new
  model instead of rewriting historical expected recommendations.

## Tasks and Acceptance

- [x] Provision private key outside source and protected environment secret;
  verify main-only branch policy and required reviewer.
- [x] Embed public key and complete local real-key sign/verify rehearsal without
  publication or reading private material into chat.
- [x] Add projector metadata, enrichment accounting, validation and focused tests.
- [x] Wire projector pins through pull and context activation; test missing,
  substituted, malformed, and corrupt projector paths with local fixtures.
- [x] Admit Qwen 3.6 and preserve unknown geometry/benchmark metadata.
- [x] Complete workspace, lint, format, build, browser and packaging checks.
- [ ] Prepare v2.1.0 versions, changelog, provenance and activation PR for review.
- [ ] After reviewed merge, dispatch signed catalog publication and obtain human
  environment approval; verify downloaded artifact and offline cached advice.
- [ ] Prepare application release; request approval before crates.io publishing.

## Verification

Use `cargo test -p rigspark-core`, runtime pull/installed-model tests, signed
catalog tests and CLI bootstrap tests after each affected slice. Final gates:

```sh
cargo test --workspace --locked --no-fail-fast -- --test-threads=2
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo fmt --all -- --check
cargo build --workspace --locked
cargo native-retirement
```

Tests use local metadata and tiny fixture blobs, never real Ollama processes or
weight downloads. Publication and live catalog download are separately authorized
operational steps, not test-suite dependencies. No unsourced speed or full-context
fit may be inferred for the hybrid architecture.

## Local Verification Record

On 2026-09-30, the complete workspace test suite passed after preserving the
historical advice catalog as an exact v2.0.0 fixture and updating live-catalog
count/date/order assertions. Workspace build, Clippy with warnings denied,
formatting, native-retirement, and `cargo package --workspace --locked
--allow-dirty` all passed. The separate desktop project compiled offline with
its refreshed lockfile. Native browser journeys passed at desktop, mobile and
tablet sizes (ChromeDriver 153 emitted its existing Chrome 154 warning).

Production-key signing and client-verification were rehearsed locally without
publication. GitHub API checks confirmed the main-only branch policy and
required reviewer. The editor may retain stale environment/secret diagnostics.
No model weights were downloaded, no live inference process was started, no
catalog was published, and no crates were published during these checks.