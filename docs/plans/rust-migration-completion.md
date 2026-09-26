# Complete Rust Migration Plan

Date: 2026-09-21
Status: Approved for implementation on 2026-09-21. M01 is in progress; no
completion, merge, or release claim is authorized.
Scope: Finish the existing Rust migration across CLI, TUI, browser services,
desktop, verification, maintenance, distribution, and contributor tooling.

## Purpose And Authority

Complete the approved [migration specification](../specs/rust-backend-migration.md),
not restart the port. Rust services and Tauri already exist. The remaining work
is coverage reconciliation, verified consumer cutover, retirement, and integrated
certification. A native build alone is not completion.

This is the repository-wide successor roadmap for the unfinished R23-R26 work in
the [original plan](task-plan-rust-backend.md). The approved
[CLI completion plan](cli-migration-completion.md) continues to own C01-C22 and
its compatibility decisions. This document adds the missing whole-product tasks;
it does not reset completed tasks or supersede their evidence.

Creating this plan does not authorize implementation, dependency additions,
schema changes, model downloads, remote CI dispatch, commits, pushes, merges,
signing-policy exceptions, or publication. Existing dirty changes must be preserved.

## Target And Non-Goals

User clarification on 2026-09-21: nothing may remain in the root `src/`
directory at completion. This includes browser assets, not only TypeScript.
The browser assets now live under `crates/llmup-gui/static`; the native scanner
rejects any root `src/` file while allowing Rust crates' own source directories.

The final supported product has:

- Rust-owned domain logic, runtime adapters, state, memory, library, MCP,
  harnesses, workspace services, HTTP/SSE, CLI, and terminal UI.
- Native `llmup` and `local-llmup` aliases and the matching `llmup-gui` companion.
- A Tauri desktop application using the same native services and existing web UI.
- No Node, npm, TypeScript, Electron, or thin npm launcher required to build,
  test, maintain, package, install, or run the current product.
- Reviewed static browser JavaScript, CSS, HTML, and vendored browser libraries.
  A Rust frontend rewrite or WebAssembly conversion is not required.
- Existing external runtime integrations: Ollama, llama.cpp, MLX/Python,
  LM Studio, and supported harness processes. Rust does not replace their engines.

Do not redesign the UI, add backends, change catalog/performance formats, change
memory-store layout, or silently reduce supported workflows during this work.
Future npm CLI publishing is already approved for retirement; historical releases
remain intact. Do not add a replacement npm distributor.

## Inspected Baseline

These observations describe the local worktree, not a fresh test certification.

| Surface | Existing Evidence | Remaining Gate |
| --- | --- | --- |
| Domain and runtime | Native crates implement advice, four adapters, lifecycle, storage, memory, harnesses, MCP, libraries, and workspace services | Reconcile every retained behavior assertion; certify assembled candidate |
| CLI/TUI | Public aliases, parser, launcher, accessible views, visual views, and PTY tests exist | Finish C07-C22 coverage, retirement, packaging, and acceptance |
| CLI progress | CLI execution log records C01-C06 complete locally and C07 complete locally; its headline/next-action text lags that log | Reconcile C07 evidence and surviving TS checks before advancing; do not infer C08 completion |
| Browser host | Native HTTP/SSE, embedded assets, recommendation parity, and host/chat/tools/route tests exist | Full legacy browser journey coverage and Node-free browser runner |
| Desktop | Tauri implementation and historical macOS/Linux/Windows WebView/dialog evidence exist | Current-candidate journeys, audits, installers, signing, and Electron removal |
| State/workflow parity | Two remaining TS parity drivers and native bridge fixtures exist | Preserve cross-version storage and lock assertions before driver deletion |
| Tooling | Catalog maintenance, release identity, retirement, and initial performance tools are native | Browser automation, policy tests, demos, budgets, and executable CI still use Node |
| Distribution | Native archive tooling exists; root npm metadata still targets TS output | Native-only entry points, Docker, installers, release automation, install/rollback proof |
| Retirement | Strict native scanner exists with an explicit browser-JS allowlist | Fresh inventory and zero blockers; historical counts are not current measurements |

Root [Cargo.toml](../../Cargo.toml) excludes
[the desktop crate](../../apps/desktop/src-tauri/Cargo.toml). Root workspace tests,
Clippy, and builds therefore do not certify desktop. Run its gates separately.

Current [package scripts](../../package.json),
[desktop scripts](../../apps/desktop/package.json), and
[retirement policy](../../crates/llmup-cli/src/retirement.rs) are concrete starting
points. Historical results are in the
[follow-up record](rust-migration-follow-up.md),
[desktop verification record](../reviews/rust-checkpoint-5-verification.md), and
[readiness record](../reviews/rust-merge-readiness.md).

## Completion Contract

All of the following must be true before calling the migration complete:

1. Every public CLI command, browser route/event, desktop workflow, and supported
   runtime/harness capability has an owner, contract, and passing replacement test.
2. Both native aliases and the GUI companion run from installed artifacts without
   Node, npm, a compiler, or source-tree assets. Tauri installs and runs independently.
3. Existing config, sessions, library, MCP settings, workspace approvals, active
   state, and memory remain compatible or have separately approved migration rules.
4. Every retired test assertion has a replacement, a preserved immutable oracle,
   or an explicitly reviewed implementation-only disposition. Test counts alone
   are not coverage evidence.
5. TypeScript backend/Electron sources, executable Node scripts, package manifests,
   toolchain configs, stale generated outputs, and obsolete dependencies are gone.
6. `cargo native-retirement` passes without broadening allowlists to hide tooling.
   Clean builds, tests, maintenance, and packaging also pass with Node unavailable.
7. Current-candidate platform, security, runtime, installer, performance, and
   rollback gates pass. Missing evidence is blocked, not accepted by default.
8. Signed/notarized distribution and user cutover pass the approved release policy.
   Implementation completion and release authorization remain separate decisions.

## Invariants And Execution Rules

- Advice is deterministic and offline. Unknown bandwidth/geometry stays unknown;
  models with incomplete geometry remain ranked. Preserve numeric/JSON semantics.
- Keep loopback-only binding, digest/size-floor checks, bounded I/O, redirect/DNS
  restrictions, cancellation, owned-process checks, confirmation drift protection,
  atomic writes, locks, recovery journals, and private file permissions.
- Keep same-origin/session authorization, CSP, artifact sandboxing, minimal Tauri
  IPC, path containment, no-follow traversal, approval invalidation, and redaction.
- Use isolated homes and injected services in ordinary tests. Real inference,
  downloads, external credentials, and user-state mutation are never implicit.
- Transfer tests first, verify native behavior, migrate active callers, then delete
  the old implementation and stale outputs. Never remove failing tests to pass.
- Each task has one named owner before implementation. S means 1-2 files; M means
  3-5 files. Rows marked "per slice" are task families: enumerate children with
  exact file lists and separate evidence before starting; no bulk deletion task.
- Run focused checks after each change. At phase checkpoints, run the full relevant
  gates. Serialize heavyweight builds and shared-shell commands. Keep remote matrix
  execution in the agreed verification batch, not after every small change.
- Record `pending`, `in progress`, `implemented`, `verified`, `accepted`, or
  `blocked`, with revision/tree identity, command, platform, logs, and remaining gaps.
  Only verified evidence plus required review can produce `accepted`.

## Decisions Before Cutover

| Decision | Proposed Treatment | Gate |
| --- | --- | --- |
| Existing CLI work | Continue C01-C22; preserve accepted npm retirement policy | Reconcile the execution log at M01 |
| Browser automation | Fantoccini 0.22.1 approved as a Rust test dependency; HTTP-only WebDriver runner | Local macOS journeys pass; full assertion transfer and other platforms remain M03/M14 |
| Hidden Node dependencies | Reject runners that merely conceal Node, including Python Playwright's bundled driver | Process-tree and installed-artifact inspection at M03/M27 |
| CI runner actions | User explicitly required removal of all Node-based actions on 2026-09-21, including pinned infrastructure actions | M04/M26 must replace JavaScript actions as well as repository commands; no infrastructure exception |
| Browser assets | Keep existing static assets and reviewed vendors; do not move paths merely for appearance | Embedding and license checks at M11/M29 |
| Supported platforms | Enumerate exact OS/architecture/minimum-version/runtime combinations from current contracts | M01 matrix, never inferred from one CI runner per OS |
| Desktop release dependencies | Resolve current RustSec findings and license/source obligations; refresh stale findings | M05/M33; no implicit waiver |
| Distribution trust | Native archives plus Tauri installers; checksums are not publisher authentication | Signing credentials supplied through secure configuration; M34 remains blocked until available |

## Dependency Order

```text
M01 baseline -> M02 coverage ledger
M02 -> M03 browser feasibility, M04 CI policy, M05 dependency audit
M02 -> M06 CLI completion -> M07 state contracts -> M08 workflow contracts
M03 + M06 + M08 -> M09-M14 browser services and coverage
M05 + M09-M14 -> M15-M19 desktop acceptance and Electron retirement
M08 + M14 + M19 -> M20-M23 shared-source retirement
M04 + M06 + M14 -> M24-M28 tooling/CI replacement
M23 + M28 -> M29 manifests/dependencies -> M30 strict retirement proof
M30 -> M31 regression -> M32 platform/runtime -> M33 security
M31-M33 -> M34 signed artifacts -> M35 installation/rollback
M32 + M35 -> M36 performance -> M37 documentation -> M38 acceptance
```

The task tables below give exact dependencies. Work may overlap only where those
dependencies and file ownership permit it. Shared manifests, lockfiles, fixtures,
workflow files, and public entry points require a single integrator.

## Phase A: Baseline And High-Risk Decisions

| ID | Task And Likely Files | Dependencies | Acceptance Criteria | Verification | Size |
| --- | --- | --- | --- | --- | --- |
| M01 | Reconcile current status and supported target matrix; this plan and CLI completion log | None | Record base revision plus dirty-tree identity, actual remaining CLI tasks, target OS/arch/minimum versions, runtime capabilities, and a fresh retirement inventory; preserve existing edits | Compare execution logs with actual files/tests; run `cargo native-retirement` and retain expected failures | S |
| M02 | Create whole-product assertion/consumer ledger alongside [CLI ledger](cli-retirement-ledger.md) | M01 | Every TS module/test family, browser suite, script, workflow, and package caller maps to native owner, disposition, dependencies, and evidence; enumerate child slices before edits | Review exports/imports, script calls, fixtures, and generated/package contents; identify missing behavior tests | M |
| M03 | Prove Node-free real-browser automation using [browser fixture](../../crates/llmup-gui/examples/browser_fixture.rs) and one chat journey | M02 | Approved maintained client runs page load, SSE reply, cancellation, persistence, keyboard focus, and screenshot capture with Node absent; driver/browser versions pinned; failure diagnostics and cleanup work | One real browser run on each required platform; inspect spawned process trees and runner distribution; reject hidden Node | M |
| M04 | Decide CI execution boundary; audit [workflows](../../.github/workflows) | M02 | Resolve embedded-Node actions explicitly; replacement strategy preserves pinned inputs, least privileges, artifacts, and required checks; no branch-protection bypass | Trace every action and shell command to its runtime; document decision before workflow retirement | S |
| M05 | Refresh desktop dependency/security/license blockers; separate desktop lockfile and [license policy](../../deny-native.toml) | M02 | Findings have package/version/advisory or obligation, owner, fix, and verification; required upgrades do not weaken capability boundaries | Separate workspace/desktop dependency audits and license/source inventory; review proposed upgrades | M |

Checkpoint A: approve the scope, ledger, browser-runner feasibility, and CI boundary.
Do not retire Node browser tests or Electron while their replacement gates are open.

## Phase B: CLI And Durable Compatibility

| ID | Task And Likely Files | Dependencies | Acceptance Criteria | Verification | Size |
| --- | --- | --- | --- | --- | --- |
| M06 | Complete outstanding C07-C22 in the [CLI plan](cli-migration-completion.md) | M02 | Eleven commands, all modes/flags/exits/cancellation, GUI discovery, aliases, source retirement, Docker, native distribution, and CLI performance accepted; reuse evidence rather than reimplement | Existing CLI command matrix, native public/PTY tests, CLI install smoke, C18-C22 report; retain shared GUI modules | M per existing C-task slice |
| M07 | Transfer state parity into [native regression tests](../../crates/llmup-cli/tests/state_parity.rs) and frozen legacy-format fixtures | M06 | Preserve TS-to-Rust and Rust-to-legacy-format evidence, cross-process lock contention, atomic writes, crash recovery, owner identity, and no-op semantics; document older-client concurrency restrictions | Run original bidirectional driver before retirement; hash/provenance fixtures; native two-process contention and recovery tests without Node | M per state contract |
| M08 | Transfer workflow parity driver (retired) and memory/library/harness contracts | M07 | Preserve all existing workflow fixture assertions, copy/move/dry-run semantics, revision conflicts, cancellation, embeddings capability handling, recovery data, and legacy read compatibility | Run original oracle once while available; frozen exact native assertions plus adversarial tests with injected providers; no candidate-generated expectations | M per workflow |

Checkpoint B: CLI accepted; durable compatibility evidence survives without a live
TS oracle. Frozen fixtures supplement, not replace, real lock/recovery/process tests.

## Phase C: Browser Service Cutover

Each row is accepted only when its corresponding legacy browser/API assertions
are represented in the ledger, not merely because a Rust route exists.

| ID | Task And Likely Files | Dependencies | Acceptance Criteria | Verification | Size |
| --- | --- | --- | --- | --- | --- |
| M09 | Models, recommendation, installed activation, lifecycle, telemetry; [GUI services](../../crates/llmup-gui/src), [legacy model journeys](../../tests/e2e/models.spec.ts) | M03, M06, M08 | Match API validation, output/unknowns, runtime ownership, context confirmation, and visible state updates; no TS service fallback | Native route tests plus real browser model/installed/telemetry journeys against injected fixtures | M per journey |
| M10 | Sessions, streaming, run coordination, agents/tools; [native chat tests](../../crates/llmup-gui/tests/chat.rs), [tool tests](../../crates/llmup-gui/tests/tools.rs) | M09 | Persist only completed exchanges; cancel stale/disconnected runs; enforce provider disclosure, approval deadlines, session isolation, connector grant invalidation, and bounded streams | Native SSE race/failure tests plus real browser chat/tool journeys, reload, cancel, and reconnect | M per journey |
| M11 | Workspace, artifacts, formatting, accessibility; [legacy workspace tests](../../tests/e2e/workspace.spec.ts), [static assets](../../crates/llmup-gui/static) | M10 | Preserve edit review/apply/revert/recovery, containment, artifact isolation, Markdown sanitization, keyboard/focus, announcements, and responsive layouts; embeds load without npm | Native path/security tests and real browser workspace/formatting/a11y journeys with console, network, screenshots, and canvas checks | M per journey |
| M12 | Transfer remaining pure frontend behavior assertions from [GUI tests](../../tests/gui) | M11 | Reducer, SSE parser, sanitization, and rendering assertions run in the real browser via the approved non-Node harness; retain positive and adversarial cases | Original assertion-to-new-test ledger; deterministic browser fixtures, malformed/chunked events, XSS cases, and leak checks | M per test family |
| M13 | Accept public Rust browser-host routing; [GUI launcher](../../crates/llmup-cli/src/gui_launcher.rs), [host tests](../../crates/llmup-gui/tests/host.rs), [startup tests](../../crates/llmup-gui/tests/startup.rs) | M09-M12 | Public GUI command and packaged companion serve embedded assets; readiness, port conflicts, browser opening/no-open, auth, shutdown, and child reaping match contract; no build/Node fallback | Installed public CLI-to-GUI journey plus host-origin/token/body-limit/startup failure tests with isolated state | M |
| M14 | Retire Playwright TS configurations, native/legacy E2E drivers, and migrated fixtures | M03, M12, M13 | Every browser assertion has accepted replacement evidence; no test points at the old host; browser tests are Node-free on required platforms | Compare M02 ledger; run complete new browser suite; check callers and generated fixtures after each deletion batch | M per deletion batch |

Checkpoint C: Rust browser services own all supported workflows; real browser
coverage remains intact without Node. Browser availability is an explicit test
prerequisite, never a reason to silently skip required journeys.

## Phase D: Tauri And Electron Retirement

| ID | Task And Likely Files | Dependencies | Acceptance Criteria | Verification | Size |
| --- | --- | --- | --- | --- | --- |
| M15 | Reconcile desktop behavior contract against [Electron main](../../apps/desktop/src/main.ts), [preload](../../apps/desktop/src/preload.cjs), and [Electron tests](../../tests/e2e/electron.spec.ts) | M05, M13 | Account for launch/relaunch, navigation, external links, folder selection/revocation, close/shutdown, failure reporting, configuration and any update behavior; declare actual gaps | Compare each Electron behavior with Tauri implementation and a named test; no unsupported empty-success stubs | M |
| M16 | Close Tauri workflow gaps; [desktop main](../../apps/desktop/src-tauri/src/main.rs) and native tests | M15 | All M15 workflows pass with native services; attached processes survive close; owned children and runs terminate; state persists across reopen | Separate desktop test/build gates; real WebView and physical dialog Cancel/select/revoke/exit journeys per platform | M per workflow |
| M17 | Revalidate desktop trust boundaries after dependency fixes | M05, M16 | Minimal capability set; exact origin/port/path/window IPC restrictions; artifact and remote pages denied; sandbox/CSP preserved | Actual dispatcher denial tests plus real WebView navigation/artifact abuse cases; regression tests for each audit fix | M per boundary |
| M18 | Build and inspect local Tauri installer candidates; [Tauri configuration](../../apps/desktop/src-tauri/tauri.conf.json), packaging resources | M16, M17 | Pinned Cargo-based bundling uses no npm; required icons/licenses/assets present; release identity consistent; clean install/start/close/uninstall leaves user data intact | Package inspection and unsigned local installer smoke on each target; label unsigned artifacts unreleased, never equivalent to M34 | M per platform |
| M19 | Retire Electron entry points, preload, package/config, legacy launcher consumers and generated outputs | M14, M18 | Accepted desktop contract replaces each consumer; native launch route available; remove only mapped Electron files, not Tauri/static resources | Native desktop smoke plus retained checks/import scans after each <=5-file deletion batch; inspect packaged resources | M per batch |

Checkpoint D: desktop functionality and local package path accepted. Signed
distribution remains a separate blocked gate until credentials and review exist.

## Phase E: Shared TypeScript Retirement

Delete by actual dependency graph, not by directory size. Keep the browser assets
under their current paths unless a separately tested relocation is necessary.

| ID | Task And Likely Files | Dependencies | Acceptance Criteria | Verification | Size |
| --- | --- | --- | --- | --- | --- |
| M20 | Retire TS GUI services and shared command/TUI callers; [GUI sources](../../src/gui), [commands](../../src/commands), [terminal sources](../../src/tui) | M08, M14, M19 | Zero active consumers of deleted services; retained `recommend`/installed/up/ls/gui/snapshots dependencies now native; static browser assets preserved | Replacement host/runtime tests, caller graph, retained TS typecheck/build; remove stale generated files per batch | M per dependency slice |
| M21 | Retire shared memory, state, library, MCP, harness, and workspace implementations with migrated tests | M20 | Each exported behavior maps to Rust and M07/M08 evidence; permissions, recovery, approved edits, connector auth, and default-deny tools remain covered | Focused native owner tests and ledger review before deletion; retained caller/type checks afterward | M per module slice |
| M22 | Retire shared backend, hardware, advisor, ranking, catalog, config, and resolver implementations | M21 | Offline advice, acquisition, integrity, installed metadata, hardware unknowns, and numerical parity retained; no orphan imports | Frozen advice/sizing/recommendation suites plus runtime boundary tests; compare datasets byte-for-byte, caller scans | M per module slice |
| M23 | Finish remaining TS test/support closure and generated-output cleanup | M20-M22 | No assertion disappears without ledger disposition; legacy setup/fixtures kept only while consumed; all obsolete compiled JS/maps/declarations excluded from distribution | Native replacements pass; inventory both tracked sources and ignored build/package outputs; verify filesystem deletion | M per batch |

Checkpoint E: no TS application implementation remains. Remaining Node dependencies
must be explicitly named tooling blockers, not hidden behind a passing application build.

## Phase F: Tooling, CI, And Final Dependency Removal

| ID | Task And Likely Files | Dependencies | Acceptance Criteria | Verification | Size |
| --- | --- | --- | --- | --- | --- |
| M24 | Replace dependency, package, runtime-budget and workflow-policy test callers; [scripts](../../scripts), [workflow tests](../../tests/workflows), [shipping tests](../../tests/shipping) | M04, M06 | Native replacements preserve relevant security, artifact, identity, resource and workflow assertions; obsolete Node-version checks receive explicit dispositions, not fake native equivalents | Frozen valid/invalid policy fixtures; native CLI invocation without Node; compare threshold meaning | M per tool |
| M25 | Replace demo/recording and support script Node consumers | M03, M14 | Existing demonstrations invoke native aliases or the approved browser runner; disposable state/cleanup and reproducible visual output retained | One bounded offline run per retained script; audit shell and Python transitive executables | M per script |
| M26 | Migrate CI, desktop verification, catalog automation, Pages, and backlog callers | M04, M14, M24 | No prohibited Node command/action; native quality and browser checks replace retained gates; permissions, token scope, schedule, artifact retention and branch requirements preserved | Workflow policy tests, actionlint, shell/PowerShell checks; inspect dependent/composite actions; remote verification only in authorized batch | M per workflow |
| M27 | Replace release automation and disable future npm publishing; Docker and native artifact callers | M06, M18, M24, M26 | Native CLI trio and Tauri packages have matching target/version manifests, hashes, notices and provenance; no Electron/npm publishing; non-root native Docker path works | Non-publishing artifact tests and container/install smoke; inspect workflow triggers and no-Node process trees; preserve historical release URLs | M per artifact/workflow |
| M28 | Replace remaining contributor/test/format/lint/maintenance entry points | M25-M27 | All scripts from former manifests have a native/non-Node replacement or reviewed retirement; static JS has syntax/security/browser validation; docs identify required tools | Execute complete command inventory with Node absent; catalog checks use offline fixtures and never rewrite curated data during verification | M per command family |
| M29 | Remove root npm manifests/lockfiles, TS/ESLint/Vitest/Playwright config and unused dependencies | M23, M28 | No active consumer remains; vendored Marked/DOMPurify assets and licenses survive; both Rust lockfiles and embedded-resource paths remain valid | Clean checkout build/test/package without `node_modules` or legacy `dist`; inspect bundle contents and vendored licenses | M per batch |
| M30 | Close strict retirement and clean-environment proof | M29 | Zero scanner findings; no broad allowlist bypass; no stale generated/backend JS; no transitive Node process in build/test/maintenance/package/runtime | `cargo native-retirement`, scanner tests, clean environment with Node unavailable, process/executable inspection, package-content audit | M |

Checkpoint F: Node-free source, development, verification, and packaging are proven.
The scanner is necessary but not sufficient: it cannot prove semantic absence of
hidden runtime execution or ignored generated artifacts by itself.

## Phase G: Integrated Certification And Cutover

| ID | Task And Likely Files | Dependencies | Acceptance Criteria | Verification | Size |
| --- | --- | --- | --- | --- | --- |
| M31 | Full current-candidate correctness regression and review | M30 | Both Cargo projects pass all gates; ledger has no unexplained gaps; correctness/readability/architecture/security/performance review findings resolved | Commands below, new browser runner, PTY tests, separate desktop tests; record exact candidate identity | M per review surface |
| M32 | Execute platform and real-runtime acceptance matrix | M31 | Every supported target/capability tested or explicitly blocked; approved installed runtimes cover acquisition/integrity/serve/ready/chat/embedding where supported/stop, ports, cancellation and ownership | Authorized isolated real-runtime smoke, public aliases, browser and desktop journeys; unsupported embedding marked unsupported, not successful | M per platform/runtime |
| M33 | Final security, dependencies, licenses, supply-chain audit | M31, M32 | No unresolved release-blocking vulnerability; both dependency trees/SBOMs/notices/source obligations reviewed; frontend vendors, archives and installers included | Workspace and desktop RustSec/license checks plus targeted boundary regressions; approved explicit policy for non-blocking findings | M per audit surface |
| M34 | Generate signed/notarized release candidates without publishing | M27, M33 | Exact release hashes/versions verified; macOS signing/notarization, Windows signing and approved native archive authenticity policy enforced; secrets remain outside logs | Verify signatures/notarization and provenance on each platform; missing identities block, never silently produce release artifacts | M per platform |
| M35 | Prove clean install, legacy upgrade, uninstall and rollback | M34 | No developer tools needed at runtime; isolated legacy data remains readable; stale launcher/PATH collisions documented; downgrade preserves data/recovery bytes; uninstall never removes models/memory | Clean target machines; signed installers/native archives; reversible fixture-based failure injection, owned/attached process checks | M per target |
| M36 | Complete [performance certification](rust-performance-certification.md) | M32, M35 | CLI/TUI/browser/desktop/shared-service journeys measured against pinned baseline; raw samples and artifact hashes retained; regressions fixed or block acceptance | Existing protocol, Windows measurement support, long-lived memory, input/stream latency and package-size gates; rerun impacted safety tests after optimization | M per journey |
| M37 | Update current installation, contributor, migration and support documentation | M35, M36 | README/site/help match native artifacts and commands; explain external runtime requirements, npm legacy status, state/concurrency limits and rollback; stale project instructions corrected | Verify every active example against installed candidate; preserve historical docs as history, not executable instructions | M per document family |
| M38 | Produce final acceptance report and request release/cutover approval | M31-M37 | All tasks accepted with linked evidence; no required gate blocked; final candidate unchanged since certification; explicit owner sign-off and rollout/rollback thresholds | Checklist below, final retirement report, reviewed target matrix; separately authorize merge, publication and rollout | S |

Checkpoint G: migration accepted only after the final report. Publishing or changing
production routing still requires explicit authorization; a plan is not that approval.

## Verification Commands

These are implementation acceptance commands, not tests claimed as run while
writing this plan. During coexistence, preserve existing npm gates until their
assertions and callers migrate; do not delete them ahead of replacement coverage.

```sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
cargo build --workspace --locked

cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets --locked -- -D warnings
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked
cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml --locked

cargo test --locked -p llmup-cli --test retirement
cargo native-retirement
cargo audit
cargo audit --file apps/desktop/src-tauri/Cargo.lock
cargo deny --config deny-native.toml check licenses

npm run lint
npm run typecheck
npm run build
npm run test:cov -- --maxWorkers=2 --reporter=dot
```

M05 must define a separately reviewed desktop license policy/check; the root
license command does not cover the excluded desktop project. M03/M24/M28 must
record exact executable commands for new browser, frontend, budget, and tooling
checks before their old callers are removed. Do not invent success for commands
that have not yet been implemented. After M29 the npm block must be obsolete,
with all applicable assertions owned by these recorded replacement commands.

## Evidence And Coverage Ledger

Each task's record must contain:

| Field | Required Content |
| --- | --- |
| Identity | Task/child ID, named owner, status, source revision and dirty-tree/artifact identity |
| Contract | Legacy behavior/test/assertion and native owner; approved differences linked |
| Scope | Exact edited/deleted files, caller list, generated artifacts, retained dependencies |
| Execution | Command, tool/browser/runtime versions, OS/architecture, fixture/model digest |
| Result | Exit status, assertions, raw logs, screenshots/traces when relevant; mock/live label |
| Approval | Reviewer, unresolved risks, approval needed, and blocking dependency |

Keep original oracle provenance and hashes. A fixture exported from the candidate
and immediately asserted against that candidate is not independent parity evidence.
Preserve historical baseline artifacts outside the final executable product tree
for performance/compatibility comparisons; this is not a retained Node fallback.

## Risks And Rollback

| Risk | Mitigation / Blocking Gate |
| --- | --- |
| Large dirty worktree masks partial completion | M01 snapshot and evidence reconciliation; no resets, mass formatting or silent deletion |
| Native browser library cannot replace required journeys on a target | M03 early feasibility gate; retain old tests until approved non-Node replacement works |
| Hidden Node inside runner/action/tool | M04 policy plus M30 process/artifact inspection; no allowlist workaround |
| Coverage loss during mass retirement | M02 assertion ledger and <=5-file consumer-ordered batches |
| Legacy clients race native state or recovery | M07 two-process tests; forbid unsupported mixed-version mutation; document recovery before downgrade |
| Tauri/WebView differs from Chromium tests | Separate actual WebView/dialog/IPC evidence per platform at M16/M17/M32 |
| Signing credentials or desktop audit fixes unavailable | Keep M33/M34 and completion blocked; unsigned local packages are not release acceptance |
| Performance gains conceal lost behavior | Equivalent successful workloads, raw measurements, retained safety assertions; no startup-to-inference claims |
| Catalog/network-dependent verification drifts | Frozen offline fixtures for CI; isolated explicitly authorized live certification |

Before each retirement batch, record the source baseline, deletion manifest,
accepted native artifact, and fixture hashes. Do not create commits or branches
without authorization. Rollback uses an explicitly chosen known-good artifact or
reviewed source restoration, not a destructive reset of the shared worktree.

Test upgrades and rollback in disposable homes copied from fixtures. Never delete
user models, memory, sessions, workspace changes, or recovery journals. Older
clients may not understand pending native transactions or lock guards: recover
and quiesce with the native implementation first, or block downgrade explicitly.
Do not claim arbitrary old versions are safe concurrent writers.

For approved publication, stage candidate artifacts, verify them on clean targets,
then roll out the agreed release channel. Integrity failure, data loss, unauthorized
IPC/tool access, leaked owned processes, or inability to start on a supported
target blocks rollout. Pause further distribution and revert the documented
recommended artifact on regression; do not mutate users' data as rollback.

## Final Acceptance Checklist

- [ ] M01-M38 and all required child slices accepted with evidence.
- [ ] CLI C01-C22 accepted; eleven commands and both aliases covered.
- [ ] Browser/Tauri workflows and external runtime capability matrix complete.
- [ ] Durable compatibility, recovery, update and rollback verified.
- [ ] No TS backend, Electron, npm manifests or executable Node tooling remains.
- [ ] Reviewed browser assets and vendor licenses remain intact.
- [ ] Strict retirement and clean Node-free build/test/package/runtime proof pass.
- [ ] Root and separate desktop quality/security/license gates pass.
- [ ] Signed artifacts, installers and all supported targets verified.
- [ ] Full performance report accepted; no unsupported improvement claims.
- [ ] Installation/contributor/support documentation matches the candidate.
- [ ] Final candidate identity recorded; merge/release authorization obtained separately.

## First Implementation Action

On approval, execute M01-M02 against the current worktree, reconcile the C07 log,
and resume the earliest unaccepted CLI coverage task. In parallel work only when
authorized, M03 browser-runner feasibility and M05 desktop audit triage are useful
independent high-risk tasks. Do not begin by rewriting native services or deleting
shared TypeScript directories.

## Execution Log

| Task | Status | Evidence / Remaining Work |
| --- | --- | --- |
| M01 | In progress | Baseline captured on macOS arm64 at `3529fd9a28d3668ca0cfa36b2d3a1cd3bbc54635` on branch `feature/rust-migration-follow-up`: 83 dirty status entries, index tree `b02a4ca6486a877ea13b865fed405ce34c8a6dea`, status SHA-256 `5d3d424459147c0f385274b2601ca2b7a31330e47c9c61e1167d30fc4f967509`, Rust/Cargo 1.98.1. `cargo native-retirement` failed as expected with 305 blockers: 289 Node/TS or unreviewed-JS sources, seven package/toolchain files, eight executable Node references, and one browser asset importing Node. By top-level path: 153 tests, 120 source, 11 scripts, seven root, seven apps, six workflows, and one vendor file. Supported-target/runtime matrix and exact blocker-family ledger remain before acceptance. |
| M02 | In progress | Initial [whole-product ledger](rust-migration-ledger.md) maps 17 product families, ten tooling/distribution families, test transfer owners, generated-output hazards, and the five native archive targets. Assertion-level child rows remain mandatory before each retirement slice; M03-M05 decisions and exact minimum supported OS versions remain open. CLI-only coverage remains owned by the existing CLI ledger. |
| M03 | Verified locally; incomplete | Approved Fantoccini dependency and new native browser runner pass three local real-Chrome journeys with Node absent from PATH. See [browser evidence](../reviews/rust-browser-retirement.md). Remaining assertion transfer, driver/process orchestration and Linux/Windows evidence block whole-suite retirement. |
| M04 | Decision accepted; implementation pending | User requires removal of all Node-based GitHub Actions, including pinned infrastructure actions. |
| M06 | In progress | C08 completed locally: 97 native tests passed, two TS compatibility suites deleted, and all 1,919 surviving tests passed. C09 development/demo callers use Rust with a new regression test; packaging/Docker/budget/workflow callers remain before CLI entry-source deletion. |
| M07 | Driver replacement verified locally; full milestone pending | Original bidirectional TS/Rust state driver passed twice before retirement. Six independently exported TS state/ls contracts with source hashes now pass through native atomic round-trips and both public aliases. Native child-process tests verify lock exclusion in both directions and reacquisition. Removed the TS driver; `cargo state-parity` and its transitional npm alias run Rust. Full M06 and assembled compatibility/platform acceptance remain open. |

Latest local verification: 588 workspace tests passed with two test threads before
adding the three state-parity tests; those three pass separately. Strict workspace
all-target Clippy, native build, retained lint/typecheck/build and all 1,919 retained
tests pass. Initial default-concurrency regression hit one launcher deadline;
that test passed alone and the full suite passed under controlled concurrency,
without increasing its timeout. The GUI parity example's obsolete call signature
was corrected to the frozen eight-result contract. Browser examples pass unit
checks and real macOS Chrome journeys; no remote/platform/release claim is made.

Current strict inventory: 304 findings, including 280 TypeScript/TSX files.
Three TS files were deleted in this execution batch. The stronger inventory also
exposes Node-backed checkout/Pages/backlog actions previously missed by command
scanning, so raw blocker counts are not directly comparable without that policy
change. The complete migration is not finished.

### Root Source Retirement Batch

- M08: replaced the final TS workflow parity driver with `cargo workflow-parity`.
  The original driver passed before removal. Its 34 independent expected outputs,
  storage seed files, timestamps, modes and source hashes are frozen in
  [workflow-parity.json](../../crates/llmup-cli/fixtures/workflow-parity.json).
  Three native tests cover all cases, post-capture compatibility, input bounds,
  and public CLI dry-run/copy/move. The legacy Windows device-name exception is
  explicit; Windows execution is still unverified.
- M11/M29: moved all nine browser assets unchanged from root `src/` into
  [native GUI assets](../../crates/llmup-gui/static), updated Rust embedding,
  Tauri configuration, compatibility callers and lint scope. Five native host
  tests, 272 retained GUI tests, and two separate Tauri tests pass locally.
- M06/C09: deleted `src/bin.ts` and `src/cli.ts` and their six stale generated
  JS/declaration/map outputs. Root package is private with no main/types/bin
  launcher metadata; lockfile synchronized offline. Public native tests own the
  registry/help/version contract. Transitional benchmarks keep the old revision
  as baseline but execute the current candidate as a native release binary.
- M27: user explicitly approved retiring npm/Electron publishing before signed
  replacement readiness. Removed npm publishing and changed the release workflow
  to three-platform native verification only, with read-only permissions, exact
  Git revision validation, no Node actions and no publication. A final failing
  publication gate preserves the unresolved release prerequisites. Actionlint and
  native/retained policy tests pass; no workflow was dispatched.
- C15: Docker now builds the native binary trio from pinned official Rust and
  Debian multi-platform images, embeds browser/data assets, and runs non-root.
  Recipe-policy tests pass; actual image build/runtime is blocked because the
  local Docker daemon is stopped. This is not container acceptance.
- C11: reproduced and fixed the native draft line-limit bug where a trailing
  newline admitted a 257th empty line. Inclusive byte/grapheme/line boundaries,
  error precedence and exact diagnostics now have passing native tests. Legacy
  terminal-resource cleanup coverage still needs transfer before TUI retirement.

Last measured inventory in this batch: 299 findings, including 277 TS/TSX files
and 118 root `src/` files. Assets are moved, not deleted; their browser behavior
is retained. The root directory is not yet empty and migration is not complete.

Subsequent C10 increment: removed the now-unreferenced chat and migrate command
implementations and their two command test suites after native assertion transfer.
Added migration boundary/drift/vector tests and restored local CLI fuzzy model
resolution with selected-model memory ownership. See the detailed
[C10 transfer record](cli-retirement-ledger.md). The 1,874 retained tests and
typecheck pass after these deletions; root `src/` still contains other consumers.

Final local verification for this batch: 610 native workspace tests pass with
two test threads; strict all-target Clippy and workspace build pass. Two separate
Tauri tests passed after relocation. All nine browser assets match their original
bytes. Filesystem checks confirm the four application source deletions, workflow
driver deletion, publishing workflow retirement and exact stale CLI artifacts.
There are still 116 root `src/` files and 273 TypeScript/TSX files repository-wide.
No claim of complete migration, empty root source, cross-platform certification,
container runtime acceptance or release authorization is made.

### Continuation (2026-09-22)

- User directed performance comparison to follow completed migration, using a
  pinned published Node package as the baseline. Updated the linked performance
  protocol; no benchmark or baseline install was run in this batch.
- Removed four unused terminal sources (chat entry, chat limits, read-only entry,
  lifecycle entry) and three replaced test suites, including exact compiled outputs.
- Reproduced the cooked-chat trailing-empty-line bug and generic-error mismatch;
  native visual/cooked chat now share synchronous validation and precise errors.
- Transferred Unicode, exact 1 MiB response boundaries, invalid-draft provider
  exclusion, recovery and all session-summary cases. User explicitly approved
  fail-closed oversized replies rather than legacy successful-turn accounting.
- Fixed missing switch-picker filtering: exclude the active Ollama model and
  cancel for single-model runtimes without preparation, prompt or state mutation.
  Native unit and real PTY tests cover the filtered selection identity and exits.
- Focused native tests and all 1,820 retained compatibility tests pass after
  deletion. Remaining terminal-resource and GUI consumers still block full
  retirement; this is not an empty-root-src completion claim.

Continuation verification: all 618 native workspace tests pass with two test
threads; strict workspace all-target Clippy, native build, retained lint,
typecheck and build pass. After rebuilding, the four retired source modules and
their twelve compiled artifacts are absent. Current inventory: 112 root `src/`
files and 266 TypeScript/TSX files repository-wide. Comparative performance work
remains deferred until migration completion.

### Lifecycle Retirement Continuation

Removed two unused command modules (down/switch), four lifecycle presentation
modules and their four replaced test suites after verifying native ownership.
Added direct native regressions for state-clear failure before stop, idempotent
shutdown, pointer-switch metadata reset, readiness failure, concurrent drift,
single-model/no-active rejection, integrity request forwarding and unexpected
presentation exit with awaited cleanup. Retained typecheck and all 1,789 tests
pass after deletion. Native picker bounds were tightened and tested; picker
fragmented-input and separate terminal-resource coverage remain open. No
published-package benchmark was run; migration remains the active task.

Combined verification: all 625 native workspace tests pass with two test
threads; strict all-target Clippy, native build, retained lint, typecheck and
build pass. The six retired source modules, four suites and corresponding
compiled artifacts remain absent after rebuilding. Measured inventory: 106
root `src/` files and 256 TypeScript/TSX files repository-wide. Root `src/` is
not yet empty; browser, desktop, shared services and tooling retirement remain.

### Picker And Read-Only Presentation Continuation

Retired three picker modules plus the read-only command wrapper and accessible
formatter, and their three test suites. Native picker validation and cooked
conversation checks retain choice bounds, stable IDs, invalid-answer retries
and cancellation. A failing real PTY test exposed immediate Escape cancellation
on fragmented Home/End input; the picker now uses the legacy 50 ms grace period.
PTY coverage checks first/last/next model identity, q/Escape/Ctrl-C cancellation,
unchanged state and restored terminal attributes. Confirmation replies wait for
a complete rendered frame to avoid racing event-stream transitions.

Native read-only presentation now preserves already-computed results on display
failure, emits the fixed renderer-runtime notice, and preserves signal exit
codes. Unit checks cover the error boundary; a PTY invalid-UTF-8 input test proves
one notice and one exact authoritative final report. No domain operation is
retried. JavaScript dynamic-import failure assertions are retired as obsolete
implementation mechanics: native renderers are statically linked, not loaded
after command dispatch. Native frozen accessible report/conversation suites
retain evidence, unknown values, search, details, help, bounds and safe commands.

Retained typecheck and all 1,768 compatibility tests pass after deletion. The
native terminal slice passes 28 PTY, five accessible and three report-view tests;
59 native accessible/model-view tests also pass. Full workspace checks are
recorded separately when completed. Visual-screen fragmented input and terminal
resource cleanup remain open. The unused legacy cooked reader is retained until
its truncation-versus-native-rejection behavior has an explicit disposition.
No published-package installation or performance comparison was run.

The next local increment retired the visual renderer, screen and list-state
modules plus their two suites after 22 model-view and 29 PTY checks passed.
Shared bounded Escape lookahead now covers both picker and model views; a
catalog PTY regression failed before that integration and passes afterward.
Ratatui owns viewport clipping in place of the legacy overscan array; native
tests retain stable selection, empty filters, page/Home/End navigation, four
marks, modal details/help/comparison, evidence and small-terminal resizing.
Rust ownership replaces repeated JavaScript unmount calls; PTY sessions verify
restored termios and display modes. Independent partial-acquisition, signal and
cleanup-timeout contracts remain in the retained session suite. Typecheck and
all 1,751 retained compatibility tests pass after these additional deletions.

Final combined verification: 631 native workspace tests pass with two test
threads; strict workspace all-target Clippy, native build, retained lint,
typecheck and build pass. All eight retired sources and their compiled outputs
remain absent after rebuilding. Measured inventory: 98 root `src/` files and
243 TypeScript/TSX files repository-wide. Five replaced test suites were removed;
shared fixtures and independent terminal-resource tests remain. The oversized
cooked-input disposition was requested but no answer was recorded, so that
legacy helper and suite remain unchanged. Full migration is not complete.

### Cooked Input Rejection Approved (2026-09-23)

User approved rejecting accessible input over 256 bytes rather than truncating
it. Retired the unused legacy cooked-line reader, its four-test suite and exact
compiled outputs. The existing native producer loop was extracted privately for
testing without changing runtime behavior. Regressions cover exact UTF-8 byte
boundaries, a million-byte paste stopped after at most 259 consumed bytes, one
error followed by producer closure (no truncated command or trailing confirmation),
CRLF/EOF, ordered delivery, bounded backpressure and receiver-close shutdown while
data is available. This does not certify interrupting an idle blocking stdin read.

All 363 native CLI tests and 1,747 retained compatibility tests pass. Strict
workspace all-target Clippy, native workspace build, retained lint, typecheck
and build pass. Full workspace tests were not rerun for this CLI-only increment.
Measured inventory: 97 root `src/` files and 241 TypeScript/TSX files repository-wide.
Retired compiled outputs remain absent after rebuilding. Migration and terminal
resource coverage remain incomplete; published-package performance testing stays
deferred until migration completion.

### Capability, Proof And Can-Run Retirement (2026-09-23)

Retired the unused TypeScript capability selector, Ink renderer proof and
can-run command with their three suites. Surviving compatibility consumers keep
only the four-value mode type and can-run result shape locally; shared domain
services and fixtures remain. Native capture tests now directly cover terminal
flags/dimensions, safe missing values, bounded malformed TERM, CI provenance,
locale precedence and Windows Unicode eligibility. All 360 frozen mode decisions
still pass. Exact native can-run plain/JSON goldens, verdict exits, frozen
advice/resolver matrix and PTY context/picker cases cover the command transfer;
an added CLI test covers Apple/non-Apple MLX eligibility and unsourced throughput.
Legacy JSON uses zero numeric placeholders with `known:false`; human output
remains explicitly `unknown`. Rust value ownership replaces JS freeze assertions.

Removed the obsolete runtime-budget script and its package/workflow caller: it
rebuilt a Git baseline and timed Ink imports, incompatible with the approved
published npm baseline. The proof script now executes native PTY tests and the
retained dependency policy. Policy checks prevent the old runtime-budget call
from returning. Functional checks are not performance certification; C12/C16/C21
remain pending until the published-package comparison after migration. No
benchmark, baseline install, remote workflow or publication was run.

Doctor projection tests now pin score axes and exact escaping. A failing empty-
catalog regression exposed native doctor deriving usable memory from the first
model; it now uses hardware-only memory capacity and reports an empty catalog as
a warning, not a false hardware failure. The legacy doctor command remains until
probe-failure isolation and readiness behavior transfer. The legacy view-model
builder remains until its long-ID handoff contract has an explicit disposition.
The user-edited accessible-input test file was read and left unchanged.

Focused native tests, the replacement proof command (29 PTY and nine dependency
tests), actionlint, retained typecheck and all 1,686 compatibility tests pass.
Combined workspace verification is recorded after completion.

Follow-up: the user approved native suppression of suggested commands over 256
bytes while retaining model evidence. After 49 native projection tests passed,
retired the unused view-model builder and its ten-test suite, including the
temporary can-run result type. Frozen native projections preserve doctor score
axes/escaping, catalog evidence and limits, active/empty state, unknown throughput
and safe suggestions. Native value ownership replaces JavaScript deep-freeze
mechanics; independent schema/controller fixtures remain.

All 639 native workspace tests pass with two test threads. Strict all-target
Clippy, native workspace build, actionlint, retained lint/typecheck/build pass;
all 1,676 surviving compatibility tests pass after the final builder deletion.
Performance certification remains deferred and the overall migration is incomplete.
Final inventory: 93 root `src/` files and 232 TypeScript/TSX files repository-wide.
Four root source modules, four replaced suites and the obsolete Git-baseline
benchmark script were removed in this continuation. Their exact compiled outputs
remain absent after the final retained build. No benchmark or published-package
baseline installation was performed.

### Terminal Text Retirement (2026-09-23)

User approved native fixed display profiles and existing 20-message chat history
(up to 1 MiB per reply), replacing the unused configurable terminal sanitizer and
legacy 200-message/50 KiB display-buffer API. Retired the isolated terminal
sanitizer and its 24-test suite; shared backend/GUI sanitization remains unchanged.
The native helper retains the 19 independently frozen single-line cases and adds
8 KiB multiline details and 64 KiB visible chat profiles. Tests pin NFC, CRLF/CR
normalization, tab expansion, visible controls/default-ignorables, intact grapheme
and escape-token truncation, inclusive bounds and pre-expansion 1 MiB rejection.
Rust strings cannot contain lone UTF-16 surrogates; UTF-8 validation remains at
external input boundaries. Ratatui owns cell layout instead of configurable
sanitizer column overrides; generic frame-builder overrides are retired.

Actual chat rendering now uses the profiles instead of character-count truncation
and silent control removal. A failing rendering regression now proves controls
remain visibly escaped while stored reply content stays unchanged. Transcript
rows retain at most 192 KiB, reserving space for the bounded draft/title/status;
a direct production-helper test checks the bound and latest-row retention.
The new helpers are used by rendering, not only tests.

Native text, chat, history and safe-suggestion checks passed before deletion.
A combined PTY run had one exact-report mismatch caused by an extra carriage
return, unrelated to chat rendering; the identical focused recovery test passed
without changing its assertion. This transient PTY instability is recorded, not
treated as weakened output parity. Typecheck and all 1,565 retained compatibility
tests pass after deletion. Full native and static/build gates are recorded when
complete. The user-modified runtime event file was not edited in this increment.
No benchmark, baseline installation or real inference runtime was run.

Final review moved the transcript budget into row construction, avoiding a large
temporary row list for newline-heavy messages. Two production-helper tests verify
latest-row retention, pending-draft line normalization, bounded retained bytes and
unchanged history. Native text/chat checks and all 30 PTY tests pass on the final
renderer. Strict workspace all-target Clippy and native build pass, as do retained
lint/typecheck/build and 1,565 compatibility tests. The full native workspace run
failed in the unrelated GUI launcher malformed-readiness process test: it received
StartupTimeout instead of InvalidReadiness. The exact test passed in isolation
without deadline/assertion changes; this is not a passing full-workspace gate.
No full rerun was completed after the incremental row-budget refinement.

Measured inventory: 86 root `src/` files and 218 TypeScript/TSX files. The legacy
terminal sanitizer, its suite and compiled outputs remain absent after rebuilding.
The raw key decoder, shared GUI services, browser/desktop and remaining tooling
are still pending. Migration remains incomplete; performance comparison against
the pinned published npm package stays deferred.

### Catalog And Doctor Retirement (2026-09-23)

Retired the isolated legacy catalog and doctor commands and their suites after
native transfer. Catalog coverage includes default-fit/all filtering, release
descending/ID ascending ordering, nonfitting memory evidence, frozen refresh
output and unchanged input files/home. Shared loaders/enrichment remain for
their independent consumers.

Doctor now collects independently of advice performance data. Corrupt/missing
catalog input becomes a failed check instead of hiding hardware/backend/state
evidence. Hardware failures retain a null JSON score and explicitly unknown
plain score/bottleneck. Corrupt state is reported without writes or lock creation;
catalog-dependent readiness is explicitly unchecked if the catalog is unavailable.
Installation presence and version queries are separate, bounded probes: a failed
version query leaves an installed backend with unknown version. Injected tests
cover per-backend failures, sanitization and platform default selection. Low
scores, empty catalogs and unverified digests remain warning-only where applicable.

User approved keeping native doctor's nonzero exit when recorded-server identity
or readiness cannot be verified, rather than the legacy readiness warning. Native
health tests verify both failures preserve state and never lock or stop processes.
The prior native test expecting doctor to abort on missing catalog was updated to
assert a full diagnostic report; other commands retain their one-line error contract.

Retained typecheck and 1,647 compatibility tests pass after both deletions. The
final native workspace run and build/static gates are recorded once complete.
No model download, real runtime smoke, benchmark or baseline installation was run.

Final verification: all 645 native workspace tests pass with two test threads;
strict workspace all-target Clippy, native build, retained lint/typecheck/build
and 1,647 compatibility tests pass. Both retired commands, their suites and exact
compiled outputs remain absent after rebuilding. Measured inventory: 91 root
`src/` files and 228 TypeScript/TSX files repository-wide. Shared GUI services,
terminal controller/resource contracts, browser/desktop and tooling migration
remain open. Published-package performance comparison remains deferred.

### Terminal Signal And Resource Transfer (2026-09-23)

A failing real PTY test proved SIGHUP left native terminals in raw mode. Native
model views, reports, pickers, visual/cooked chat, accessible reports and lifecycle
controllers now use a shared SIGINT/SIGTERM/SIGHUP receiver. Visual paths register
signals before terminal acquisition. Cooked chat preserves the specific signal
exit and awaits cancellation; lifecycle cleanup retains first-signal precedence.
The Unix PTY matrix covers 27 command/mode/signal combinations with unchanged state,
exact restored termios, cursor visibility and no accessible-mode control sequences.
These OS-signal cases were run on macOS, not certified on Windows/Linux.

The terminal resource guard now arms restoration before each mutation, retains
the original raw-mode state and attempts independent paste/cursor/screen/raw
cleanup even if another restoration operation fails. Injected tests cover failure
after each acquisition step and twenty repeated sessions. Real PTY tests continue
to verify normal and interrupted restoration. A controller regression checks
hangup cancellation is delivered once, cleanup is awaited and ordinary completion
does not abort the runtime token.

Retired the seven-test legacy terminal-smoke suite after 30 native PTY tests and
the native cleanup checks passed. The legacy session source and its independent
suite remain: resize fallback and bounded cleanup-timeout contracts still need
transfer. Root source retirement is not claimed for this increment. Test-only
PTY deadlines now force-stop only their own child before cleanup; incorrect chat
and empty-ls prompt matchers were corrected after exposing a harness cleanup hang.
No real inference runtime, model download or performance comparison was used.

Verification: the full native workspace run passed 649 tests. A final two-line
correction classified exit 129 as cancellation in lifecycle evidence and suppressed
the post-cancellation result screen; afterward all 21 lifecycle controller tests,
nine output tests and 30 PTY tests passed, including the expanded 27-case signal
matrix. The full workspace suite was not rerun after that final classification
correction. Strict workspace all-target Clippy and native build pass on the final
code; retained lint/typecheck/build and all 1,640 compatibility tests pass.
Measured inventory remains 91 root `src/` files and 227 TypeScript/TSX files.
The replaced smoke suite is absent; session source deletion remains blocked by
the explicitly retained resize/timeout contracts. Migration is incomplete and
published-package performance comparison remains deferred.

### Terminal Session Retirement (2026-09-23)

Retired the unused legacy session owner and its 18-test suite after native
resource/signal coverage and lifecycle resize/deadline transfer. Visual resize
below 60x16 is debounced for 50 ms; accessible lifecycle progress observes sizes
without consuming input or enabling raw mode, with a 40x10 threshold. Recovery
above the minimum cancels pending fallback. Fallback stops presentation without
cancelling domain work; the final runtime result remains authoritative and the
CLI does not reopen the result UI after restoration.

Cancellation arms the existing 30-second presentation deadline. At expiry the
terminal guard and visual input owner are released even if cleanup is still
pending; the controller continues awaiting the runtime and does not claim that
cleanup completed. Resize during cancellation cannot bypass that wait. Tests
cover notification errors, direct visual restoration wiring, input-owner drop
without another poll, real EOF, recovered size and both threshold boundaries.
Typed Rust ownership replaces legacy post-close start and Node listener/pause
mechanics; shared controller/schema/key tests remain independently retained.

Retained typecheck and all 1,622 compatibility tests pass after deletion. Native
controller and PTY checks pass; full workspace and static gates are recorded
after completion. No performance comparison or baseline installation was run.

Final verification: 657 native workspace tests passed. One subsequent test-only
addition verifies that cancellation still works after resize restoration; it and
all 30 lifecycle controller, nine output and 30 PTY tests pass on the final code.
The full workspace was not rerun for that last test-only addition. Strict workspace
all-target Clippy and native build passed; final CLI all-target Clippy also passed.
Retained lint/typecheck/build and 1,622 compatibility tests pass. The retired
session source, suite and compiled outputs are absent. Measured inventory: 90
root `src/` files and 225 TypeScript/TSX files repository-wide. Full migration is
still incomplete; the pinned published npm comparison remains deferred.

### Generic Controller Retirement (2026-09-23)

User approved native typed workflows instead of recreating the unused JavaScript
callback-controller API, its generic Back/rebuild cycle and progress-validation
exceptions. Retired the controller, view-model schema and terminal controller
types, their 33-test suite and the orphaned synthetic TypeScript view-model
fixture. All consumers were checked before deletion; independent native JSON
oracles, noninteractive goldens and shared GUI/domain services remain intact.

Native confirmation/selection tests own explicit consent, invalid answer handling,
safe canonical model identity and cancellation before effects. Typed Rust outcomes
replace arbitrary JS object/getter/hidden-property validation; native projection
schemas still validate external evidence. Lifecycle tests own execute-once,
authoritative completion/failure, cancellation cleanup and no success output after
interruption. The approved diagnostic model uses bounded best-effort observations
instead of allowing malformed callback progress to govern command success. A new
full/closed-queue regression proves observation saturation neither blocks nor
retries operations nor replaces their successful or failed results. Existing
tests retain ordering, dropped-operation evidence and bounded/redacted diagnostics.

All 86 focused native event/controller/selection/projection/output checks pass.
All 1,589 retained compatibility tests, strict workspace all-target Clippy,
native workspace build, retained lint/typecheck/build and link/whitespace checks
pass. Full native workspace tests were not rerun for this deletion and test-only
increment. Measured inventory: 87 root `src/` files and 220 TypeScript/TSX files.
Retired compiled outputs remain absent after rebuilding. Raw key decoding and
terminal sanitizer tests remain pending rather than being waived by the controller
API decision. Full migration is incomplete; no benchmark or published-package
baseline installation was performed.