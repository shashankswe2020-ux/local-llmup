# Independently Published Catalog Updates

## Status

Approved, 2026-09-30. The user approved explicit updates, the Ed25519 dependency,
signed envelope, shared cache, GitHub Releases hosting, and fail-closed behavior
until production key provisioning. Branch: `feature/catalog-updates`.

## Objective and Scope

Users can update model recommendations without installing a new application
release. Recommendations remain deterministic and offline. CLI and GUI use the
same locally verified catalog snapshot, with the bundled catalog as a fallback.
New model admission still requires evidence and maintainer review; downloading a
new catalog does not discover or approve models automatically.

The initial release provides explicit updates and visible catalog provenance.
Automatic background checks are deferred. Existing model schema v2 remains
unchanged; a separately versioned signed distribution envelope is introduced.
The performance dataset remains bundled; missing performance evidence continues
to produce unknown values rather than fabricated estimates.

## Proposed Contract

- Add `rigspark catalog --update` for networked updates and
  `rigspark catalog --status` for offline provenance. Preserve existing
  `catalog --refresh` behavior and explicitly document its different purpose.
- GUI provides an explicit catalog-update action and status, through protected
  same-origin API routes. Updating never downloads model weights or starts a
  runtime. Normal recommendation requests never contact the update service.
- Publish immutable, signed catalog artifacts independently of application
  releases. A fixed official HTTPS channel identifies the latest artifact.
  Publication is gated on reviewed catalog changes, validation, and tests.
- Authenticate exact payload bytes with Ed25519 using an embedded public key.
  Proposed implementation dependency: `ed25519-dalek`. Never download a public
  key from the same untrusted update channel and treat it as a trust anchor.
- The signed payload binds the distribution-format version, monotonic catalog
  revision, publication time, model schema version, and catalog contents.
  Reject incompatible schemas, malformed metadata, excessive sizes, invalid
  signatures, revision reuse with changed contents, and rollback attempts.
- Apply bounded HTTPS downloads with timeouts and a constrained redirect policy.
  Errors preserve the current snapshot. Never log signatures' private keys or
  expose arbitrary remote URLs through the GUI update endpoint.
- Store catalog state under a dedicated directory in the existing application
  home, separate from conversation memory. Use existing no-follow filesystem
  utilities, atomic replacement, and serialized updates. Keep the previous
  verified snapshot for recovery; reverify cached data on load.
- Offline resolution order: valid active snapshot, valid previous snapshot,
  bundled catalog. Corruption is reported visibly, not silently hidden.
  Explicit test/catalog overrides retain their existing precedence.
- Status reports source, revision/digest, generation/publication date, model
  count, and fallback warnings. Catalog age is not a claim of complete upstream
  coverage. A running GUI sees an activated update on its next catalog request.

## Trust Bootstrap and Operations

The maintainer owns the production signing key. It must be generated and stored
outside source control and outside model-visible inputs. Only its public key is
embedded in the application. The publication workflow uses a protected signing
secret/environment; signing and public release must not run on untrusted PRs.

Tests use explicitly test-only keys and injected transports. Do not ship a test
key as the production trust anchor. Production setup needs the public key and
an approved artifact hosting location. Key rotation initially requires an app
release; recovery/rotation procedures must be documented before activation.

## Implementation Tasks

### 1. Verified Snapshot Format

- Acceptance: signed fixtures validate; tampering, unknown keys, incompatible
  versions, oversized input, and invalid catalogs fail with typed errors.
- Verification: focused runtime tests, then runtime crate tests.
- Files: runtime manifest/module/tests and core catalog validation if needed.
- Dependency: approved dependency and signed-envelope contract.

### 2. Offline Store and Activation

- Acceptance: shared loader resolves active/previous/bundled snapshots offline;
  invalid updates preserve working data; replay/rollback and concurrent writes
  are guarded; symlinks cannot redirect cache writes.
- Verification: temporary-home tests with injected time and deterministic
  signed fixtures, including interrupted activation and corrupt-cache recovery.
- Files: runtime snapshot store, secure filesystem integration, store tests.
- Dependency: task 1.

### 3. Explicit CLI Update and Status

- Acceptance: update downloads only on explicit request; status is offline;
  bounded transport failures do not replace the catalog; conflicting flags
  fail before networking; advice and lifecycle commands share the loader.
- Verification: injected transport tests, CLI integration tests, affected crate
  tests, and unchanged offline/parity contracts.
- Files: runtime update transport, CLI args/dispatch, focused CLI tests/fixtures.
- Dependency: task 2 and approved hosting contract.

### 4. Shared Runtime Consumers

- Acceptance: GUI, chat, advice, and model activation resolve the same selected
  snapshot; fixture overrides and standalone deterministic helpers remain
  explicit; newly added signed-fixture models are visible without rebuilding.
- Verification: cross-consumer tests against one temporary application home.
- Files: remaining runtime/GUI catalog consumers and focused tests.
- Dependency: task 3.

### 5. GUI Update and Provenance

- Acceptance: Models view displays catalog source/date and update progress;
  explicit update refreshes models; errors preserve usable results; no startup
  or recommendation request implicitly accesses the network.
- Verification: protected API tests and native browser journeys at desktop and
  mobile sizes, including successful, failed, and offline states.
- Files: GUI routes/module, Models UI assets, API/browser tests.
- Dependency: task 4.

### 6. Publication and Documentation

- Acceptance: maintainers can validate/sign/publish an immutable catalog without
  a binary release; clients verify the published format; signing permissions
  are scoped; key setup/rotation and update/fallback behavior are documented.
- Verification: fixture-based artifact round trip and workflow policy tests;
  no production signing or publishing during local implementation.
- Files: maintainer publishing command/tests, workflow, reference documentation.
- Dependency: tasks 1-5 and provisioned production trust anchor for live launch.

## Engineering and Verification

Follow Rust workspace conventions: typed serde input with explicit checks,
typed errors, no unsafe code, and no new backend-specific command logic.
Public interfaces use descriptive snake_case names and existing Config/Directory
abstractions. Tests live in `crates/<crate>/tests/`; domain decisions use pure
functions and transport/filesystem/clock boundaries are injected.

Write failing tests before implementation and validate each increment. Run the
affected crate tests after changes. Final gates:

```sh
cargo test --workspace --locked --no-fail-fast -- --test-threads=2
cargo build --workspace --locked
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo fmt --all -- --check
cargo native-retirement
```

Always keep advice offline, unknown figures honest, and invalid updates
non-destructive. Ask before new runtime dependencies, model schema changes,
memory layout changes, or production publication. Never commit secrets, use
live network/model processes in tests, or weaken signature checks to unblock
deployment. No commits or production releases are implied by this plan.

## Completion Tracking

- [x] Approve spec, tasks, dependency, and trust/publication contract.
- [x] Task 1: verified format and negative tests.
- [x] Task 2: offline cache and atomic activation.
- [x] Task 3: CLI update/status and shared advice loader.
- [x] Task 4: runtime consumer consistency.
- [x] Task 5: GUI action/status and browser verification.
- [x] Task 6: publishing support and operational documentation.
- [x] Full workspace gates and security/code review.
- [ ] Production public key/channel provisioned (external launch prerequisite).

## Verification Record

Verified locally on macOS on 2026-09-30: full workspace tests with
`--no-fail-fast -- --test-threads=2`, workspace build, Clippy with warnings
denied, formatting check, and native-retirement gate all passed. Native browser
journeys passed across desktop, 390px, 320px, and tablet viewports, including
catalog-update success, simulated offline failure, and preserved model results.
ChromeDriver 153 warned about the installed Chrome 154 version; journeys passed.

The implementation review covered signature validation, bounded downloads,
rollback checks, atomic cache replacement, GUI mutation authorization, and
signing-secret isolation. No production key, environment, or release was
provisioned. The GitHub editor reports the expected missing `catalog-signing`
environment and `CATALOG_SIGNING_SEED` secret until maintainer setup is complete.