# CLI Migration Completion Plan

Date: 2026-09-19
Status: Approved for implementation on 2026-09-19. C01-C08 complete locally;
C05-C06 executable evidence is macOS only, and C07 retirement checks remain local.
Scope: Complete the Rust CLI and retire its TypeScript execution path. GUI and
desktop retirement remain separate milestones of the wider migration.

This document controls the next work sequence. Earlier progress notes describe
implementation history, not acceptance of the current combined changes.

## Goal And Completion Criteria

The CLI milestone is complete only when:

- Both `llmup` and `rigspark` execute native Rust without Node, npm, tsx, or
  source-tree files at runtime.
- All eleven commands work: default/recommend, can-run, catalog, doctor, ls, up,
  switch, down, chat, migrate, and gui. Plain, JSON where supported, visual, and
  accessible modes have an explicit supported contract.
- Flags, validation, stdout/stderr, exit codes, cancellation, state safety, and
  intentional compatibility changes are accounted for in a command matrix.
- `gui` locates the matching native companion; neither missing binaries nor
  invalid configuration cause a fallback to TypeScript or an implicit build.
- CLI-only TypeScript sources, their migrated tests, generated artifacts, and
  executable callers are removed. Shared GUI dependencies are retained explicitly.
- Installation, archives, development commands, Docker, and the chosen npm-channel
  policy agree about which implementation users run.
- Combined review, regression, platform checks, and CLI/TUI performance gates pass.
  An implementation-only checkpoint is not a completed migration.

This does not mean the whole repository is Node-free. That requires the later
GUI, Electron, browser-tooling, and shared-module retirement milestones below.

## Current Baseline

Existing work must be preserved, not rewritten or reverted:

| Area | Current Evidence | Acceptance Still Needed |
| --- | --- | --- |
| Native domain/runtime | Advice, acquisition, integrity, lifecycle, memory and harness implementations exist | Combined command and failure-path coverage |
| CLI commands | Public aliases, command validation, targeted shutdown, and GUI launcher implemented locally | Integrated contracts, installation and distribution |
| TUI/accessibility | Model details, comparison, chat, lifecycle events/diagnostics, cooked views implemented | Updated cancellation assertions, review evidence and platform journeys |
| Frozen parity | 2,849 sizing cases; 78 advice reports, 5,148 verdicts, 9,126 resolver cases; 24 GUI contracts | Preserve provenance and rerun against assembled candidate |
| Retirement | Several catalog tools, parity drivers, release validator, and unused chat screen removed | Entry points and remaining CLI-only dependency closure |
| Quality | Focused checks passed per increment | No full verification claim for the current worktree |
| Distribution | Native aliases and unsigned archive support implemented | npm decision, callers, clean installation and artifact checks |

The last recorded retirement count was 309, before the latest CLI changes. It is
not a current measurement or an acceptance target. Recompute at task C13.
The npm package still points at TypeScript CLI artifacts. PR #246 remains draft;
no push, merge, publication, or signing-policy waiver is authorized by this plan.

## Decisions Before Cutover

| Decision | Recommendation | Approval/Consequence |
| --- | --- | --- |
| CLI installation channel | Native source install and native archives become the documented CLI route | Approved at C01 on 2026-09-19; unreleased archives remain unsigned |
| Existing npm consumers | Retire npm CLI publishing for future versions | User selected this policy on 2026-09-19. Already-published releases remain untouched; current documentation must distinguish them from the native candidate |
| Native npm distribution | Out of scope | No npm/npx native distributor or separate maintained legacy channel will be added |
| Compatibility changes | Product-only native version string; reviewed native help formatting | Record approved differences; never pretend a Node suffix exists or regenerate goldens simply to silence failures |
| Shared TypeScript modules | Keep modules used by GUI/Electron until those consumers move | CLI completion must name the remaining shared code, not claim repository-wide retirement |
| Verification cadence | Focused checks with each edit; deep review/full regression after implementation is assembled | No repeated remote matrix per increment; schedule one agreed platform batch |

## Execution Rules

- Every task has one owner and an explicit file boundary. Aim for at most five
  files per implementation batch; split larger deletion groups into sub-batches.
- Start from the current worktree. Read files again before editing shared surfaces.
- Run a focused executable check after each implementation change. This is not
  the deferred deep review or full test phase.
- Freeze or port meaningful behavior assertions before removing legacy tests.
  Do not delete tests merely because the new implementation fails them.
- Delete a source only after all active imports/callers migrate. Remove its stale
  generated outputs too; `tsc` does not clean deleted-source artifacts.
- Preserve offline determinism, honest unknowns, loopback binding, digest checks,
  ownership/identity guards, lock semantics, and memory-store layout.
- No new dependencies, data formats, live runtime installs, or state-layout changes
  without the existing required approval. No user data in tests or benchmarks.

## Tasks

Tasks not marked complete in the execution log remain pending acceptance, even where implementation already exists.
Sizes are relative work estimates, not elapsed-time promises: S is one small
surface; M is a bounded multi-file task that may require several increments.

### Phase A: Contract And Integration

| ID | Task / Files | Dependencies | Acceptance Criteria | Verification | Size |
| --- | --- | --- | --- | --- | --- |
| C01 | Approve scope, distribution choice and compatibility ledger in this plan | None | User chooses npm policy; every intentional difference is documented; no implicit release authorization | Review decisions with user | S |
| C02 | Build command/mode/flag acceptance matrix from `src/cli.ts`, `native_args.rs`, current fixtures and tests | C01 | Eleven commands mapped; defaults, valid/invalid options, modes, side effects and exits each have a native test owner or named gap | Trace each row to a test or pending task; include legacy assertions not covered by frozen advice | M |
| C03 | Reconcile parser and terminal cancellation contracts in `native.rs`, `native_args.rs`, `cli_contract.rs`, `terminal_cli.rs`, `tui_pty.rs` | C02 | Invalid input fails before work; help/version do not access state; confirmed legacy cancellation returns 130; final stdout occurs only on appropriate completion | Targeted command and PTY tests; update assertions only against the agreed contract | M |
| C04 | Accept shutdown/runtime CLI wiring in `application.rs`, `lifecycle.rs` and their tests | C02 | Target matched under lock; mismatch has no effects; attached daemons are not killed; empty shutdown creates no state; failure/cancel preserves ownership guarantees | Focused application/lifecycle tests, including lock-race case and CLI empty-state regression | M |
| C05 | Complete public GUI-command integration in `gui_launcher.rs`, `native.rs`, GUI options/startup and focused tests | C02 | Port/no-open/harness/JSON behavior matches contract; bounded readiness; correct companion discovery; shutdown reaps child; no Node fallback | Mock companion tests and one isolated local CLI-to-GUI start/stop journey; no external inference | M |
| C06 | Accept public binary aliases and artifact contract in Cargo targets, `dist.rs`, `distribution.rs`, alias tests | C03, C05 | Both names use one implementation; archive includes both plus GUI companion; version checks agree; missing companion gives actionable failure | Alias tests with empty PATH; archive manifest/permissions/hash checks | M |

Checkpoint A: Command matrix has no unexplained implementation gaps. Existing
public alias builds alone do not authorize deleting the old CLI.

### Phase B: Coverage Transfer And Retirement

| ID | Task / Files | Dependencies | Acceptance Criteria | Verification | Size |
| --- | --- | --- | --- | --- | --- |
| C07 | Transfer remaining entry-point assertions from `cli.test.ts` and `cli-noninteractive-contract.test.ts` into native public CLI tests | C03-C06 | Dispatch/options/error-prefix/stream/exit assertions mapped; runtime-backed success cases use injected or controlled fixtures, not real services | Native replacement tests pass before deleting either TS test; coverage ledger records every disposition | M |
| C08 | Transfer `noninteractive-compat.test.ts`, `cli-tui.test.ts` and their fixture consumers | C03, C07 | Mode routing, help/version changes, fixtures, picker exits and command JSON manifest covered; shared golden files remain usable | Native mode/PTY/public tests plus focused surviving fixture consumers | M |
| C09 | Retire `src/bin.ts` and `src/cli.ts`; update their direct scripts/test consumers in small batches | C06-C08; C01 channel decision | No active import or execution points to deleted entry files; development command uses native CLI; no stale `dist/bin*` or `dist/cli*` shipped | Typecheck retained TS, build, public alias smoke, reference scan, filesystem absence | M |
| C10 | Retire CLI-only command modules: can-run/catalog/doctor, then chat/down/switch/migrate | C07-C09 | For each module, native contract coverage replaces source tests and production import count is zero; public behavior is preserved | Separate <=5-file batches; focused owner tests before each deletion, retained caller/type checks after | M per batch |
| C11 | Retire terminal-only TypeScript modules and associated migrated tests; retain `snapshots.ts` | C08-C10 | Capabilities, read-only, lifecycle, chat and session assertions mapped; chat-limit and restoration differences resolved rather than discarded | Native controller/buffer/PTY checks per sub-batch; import graph and retained GUI tests | M per batch |
| C12 | Remove CLI-only dependency/build residue after source retirement | C09-C11 | `cac`, Ink/React and terminal dependency candidates removed only if no remaining consumers; lockfile consistent; obsolete policy/budget callers replaced, not bypassed | Lockfile-only dependency update as appropriate; retained install/build checks; native policy and budget equivalents | M per batch |
| C13 | Produce retirement manifest and audit generated/package contents | C09-C12 | Deleted files, retained consumers and reasons explicit; no deleted entry artifacts in packages; CLI execution has no Node requirement | `cargo native-retirement` inventory and scoped CLI import/artifact checks; repository-wide failures remain visible | S |

Retain these shared modules until their non-CLI consumers migrate:

- `src/commands/recommend.ts`: GUI recommendation and context parsing.
- `src/commands/ls.ts`, `up.ts`, `installed-models.ts`, `installed-up.ts`: GUI
  management and activation dependency closure.
- `src/commands/gui.ts`: Electron launcher integration.
- `src/tui/snapshots.ts`: GUI/harness process identity and activation confirmation.

The earlier 35-file CLI/TUI deletion candidate set is a starting manifest, not
permission for a bulk delete. Recheck actual imports, generated outputs and tests
at each batch. Keep shared advisor/backend/memory/state modules out of this cut.

Checkpoint B: CLI-only TypeScript is retired with preserved behavior coverage.
Shared GUI code is listed explicitly; no test deletion is justified merely by a
missing source import after retirement.

### Phase C: Distribution And User Cutover

| ID | Task / Files | Dependencies | Acceptance Criteria | Verification | Size |
| --- | --- | --- | --- | --- | --- |
| C14 | Implement approved package-channel policy in package metadata and direct callers | C01, C06, C09 | No npm/main/types/bin pointer targets deleted files; Electron consumers keep a valid build route; npm legacy status or retirement is explicit | Packaging-policy tests and exact artifact inspection; no publish | M |
| C15 | Migrate Docker CLI execution and corresponding build policy | C06, C14 | Container runs native CLI as non-root; offline default retained; no Node required by CLI image; GUI remains loopback-only | Native Docker build/smoke when available; validate supported architecture recipes, record untested targets | M |
| C16 | Migrate CLI workflow/demo/budget callers in independent batches | C12-C15 | No job or demo executes deleted TS CLI; equivalent native gates replace old gates; permissions and publish triggers not broadened | Workflow policy tests, actionlint, script checks; do not dispatch publishing workflows | M per batch |
| C17 | Update installation, development and migration documentation | C14-C16 | README/site explain actual install channel and companion binary; no claim that historical npm/GHCR artifacts already contain this migration; troubleshooting and rollback documented | Documentation examples match public help, artifact layout and install smoke | S |

Checkpoint C: The local source/build/distribution path consistently selects Rust.
Do not announce a released CLI, push, merge or publish at this checkpoint.

### Phase D: Acceptance And Performance

| ID | Task | Dependencies | Acceptance Criteria | Verification | Size |
| --- | --- | --- | --- | --- | --- |
| C18 | Combined correctness/security/architecture review | C03-C17 | Review integrated changes, not just agent outputs; high-impact findings fixed; parser, launcher, locks, cleanup, integrity and output bounds checked | Findings with source references and focused regression checks; no blanket approval based on test counts | M |
| C19 | Full local regression and clean build | C18 | Native fmt/Clippy/tests/build pass; retained TS lint/typecheck/build/tests and coverage pass while relevant; no removed safety gates | Commands below; serialize heavy builds and Vitest; record versions and logs | M |
| C20 | Cross-platform and actual-runtime CLI acceptance | C19; approved verification batch | Linux/macOS/Windows supported targets pass public binary and PTY journeys; process ownership/custom ports/cache/cancel checked against authorized runtimes; unsupported cases explicit | Platform matrix and isolated real-runtime smoke; no newly installed runtime or weight download without authorization | M per platform |
| C21 | Deep CLI/TUI performance measurement and improvements | C19-C20 | Matching successful workloads; baseline/candidate hashes and raw samples; regressions fixed or block acceptance; no inference claims from startup data | Follow linked performance protocol for every CLI/TUI journey; profile, optimize, rerun identical workload | M per surface |
| C22 | CLI completion report and release handoff | C13-C21 | All acceptance rows linked to evidence; zero CLI-specific retirement gaps; unresolved whole-repo gates separate; rollback does not damage state | User reviews report; merge/release requires separate explicit authorization | S |

Verification commands to assemble at C19 (not run during this planning task):

```sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
cargo build --workspace --locked
cargo audit
cargo deny --config deny-native.toml check licenses
npm run lint
npm run typecheck
npm run build
npm run test:cov -- --maxWorkers=2 --reporter=dot
```

Native-only source installation smoke must install both CLI aliases and the GUI
companion into an isolated prefix, then run without Node/npm on PATH. Packaging
checksums prove consistency, not publisher authenticity. Artifacts stay unsigned
until the separately required signing gates pass.

## Parallel Work And Ownership

- After C02, C04 runtime work and C05 GUI-launch work can proceed independently.
- C03 and any C05 edits to `native.rs` must be serialized through one integrator.
- C07/C08 test transfers can run in parallel only with distinct fixture ownership.
- C10/C11 deletion batches are sequential by import dependencies, not bulk parallel
  deletes. Package metadata, lockfiles and workflow callers have one owner each.
- C15 container work and C17 documentation can be drafted in parallel after the
  package policy is fixed; final documentation waits for actual artifact evidence.
- Use requested `GPT-6 Astra (copilot)` agents with named file ownership. Agents
  return exact changes, test evidence, and remaining gaps; parent integrates.
- Serialize terminal commands that share a shell, and do not run heavy Rust builds
  concurrently with the retained coverage suite.

## Rollback And External Gates

- Before destructive retirement, record the baseline revision, contract fixtures,
  exact deletion manifest and reproducible native artifact. Preserve existing
  uncommitted changes; create no commit or branch without authorization.
- Do not keep two competing launchers under the same advertised command. A legacy
  channel, if approved, must be explicitly named and isolated.
- Rollback restores an authorized source/artifact version, never deletes user
  models, caches or memory. State interoperability tests must remain during coexistence.
- Signing identities are unavailable; signed publication is blocked, not waived.
- Desktop dependency/license findings are separate unresolved gates. They do not
  justify claiming desktop completion when CLI checks pass.
- If a required platform/runtime cannot be exercised, report its exact blocked
  acceptance row. Do not mark C20 or the final certification complete.

## Wider Migration After CLI

These milestones remain under the original R23-R26 umbrella and need their own
small task plans before implementation. They are not hidden inside CLI retirement.

| Milestone | Remaining Scope | Exit Gate |
| --- | --- | --- |
| W01 GUI/shared services | Move remaining TypeScript GUI consumers to native services, then delete shared command/backend/hardware/state/memory closures | Browser/API/security parity and no active TS service consumers |
| W02 Verification tooling | Replace state/workflow drivers and Node-based browser automation without losing interop/real-browser assertions | Native/non-Node runners cover original contracts; no build/test scripts require Node |
| W03 Desktop | Retire Electron after Tauri functionality, dependency/license remediation and packaging are accepted | Supported-platform installers, permissions, close/cleanup and native dialog evidence |
| W04 Whole-repo retirement | Remove npm manifests/toolchain/dependencies only after all consumers are gone; retain reviewed static browser JS | `cargo native-retirement` passes, clean Node-free build/runtime/tooling proof |
| W05 Full performance/release | GUI/app/shared-service performance matrix, final security gates, signing/notarization and release rollback | Complete sourced report and separately authorized release |

## References

- [Original migration plan](task-plan-rust-backend.md)
- [Follow-up implementation history](rust-migration-follow-up.md)
- [Terminal implementation record](../reviews/rust-terminal-progress.md)
- [TypeScript retirement record](../reviews/rust-typescript-retirement.md)
- [Performance certification protocol](rust-performance-certification.md)
- [Migration specification](../specs/rust-backend-migration.md)

## Next Action

C01-C09 entry-source retirement is complete locally. Continue C10-C12 using the
[command matrix](cli-command-contracts.md) and
[coverage/retirement ledger](cli-retirement-ledger.md). Do not
delete shared GUI or terminal sources before their replacement assertions pass.

## Execution Log

| Task | Status | Evidence / Remaining Work |
| --- | --- | --- |
| C01 | Complete | User approved implementation and selected future npm CLI retirement on 2026-09-19; no publication or merge authorized |
| C02 | Complete | Eleven-command matrix and assertion-level retirement ledger written from current sources/tests; identified gaps remain acceptance work, not waived |
| C03 | Complete | Parser/dependency ordering, pre-I/O installed/chat/hardware validation, cancellation 130 and final-output gating pass focused CLI/terminal/PTY acceptance |
| C04 | Complete | Service lock-race, ownership, mismatch, rollback and cancellation tests pass; both public aliases preserve targeted mismatch state and empty down behavior |
| C05 | Complete | GUI launcher/unit contracts and public-alias diagnostics pass; controlled macOS companion startup, readiness, failure and reap smokes pass without browser or inference |
| C06 | Complete locally (macOS ARM64) | Shared alias implementation guarded; complete target-correct binary trio, GUI-inclusive version gate, manifest/hash/size and Unix execute permissions tested; built-binary artifact directory copied to isolated prefix and executed without Node/source-tree runtime. Cross-platform execution remains C20. |
| C07 | Complete locally | Entry-point assertions transferred to public/request/output tests; CAC ordering and handler mock counts explicitly retired as implementation details; legacy TS deletion awaits focused surviving npm checks |
| C08 | Complete locally | 97 native public/alias/parser/terminal/mode/model/PTY tests passed together; assertions and implementation-detail dispositions recorded in the CLI ledger. Deleted `tests/noninteractive-compat.test.ts` and `tests/cli-tui.test.ts`, confirmed absent; all 1,919 retained tests pass and shared fixture consumers remain intact. Cross-platform and full acceptance gates remain C18-C22. |
| C09 | Complete locally | Deleted both TS public entry files and their exact six generated artifacts; callers now use Cargo/native binaries. Root npm package is private without main/types/bin metadata and its lockfile is synchronized. Native public/retirement tests and retained typecheck pass. Shared command/TUI implementation retirement remains C10-C12. |
| C14 | Implemented locally | Private compatibility package retains GUI build support; future npm publishing workflow removed with explicit user approval. Historical published packages unchanged. |
| C15 | Implemented; executable verification blocked | Pinned Rust/Debian native-only recipe, non-root user, three binaries and notices; policy tests pass. Docker daemon stopped, so no image build/runtime or architecture acceptance claimed. |
| C16 | In progress | Release workflow is native verification only with publication blocked and no actions runtime; TUI compatibility still has retained Node tooling and needs complete migration. |
| C17 | In progress | README now documents Cargo source installation and historical npm/container status. Site and remaining contributor guidance still need final cutover. |
| C11 | In progress (2026-09-22) | Removed unused chat-entry, chat-limits, read-only-entry and lifecycle-entry modules with three migrated suites. Shared native validation fixes trailing empty lines; response/summary boundaries pass. User approved fail-closed responses over 1 MiB. Restored switch-picker filtering and tested no-effect cancellation on non-Ollama backends. All 1,820 retained tests pass; renderer/session-resource and remaining view assertions stay pending. |

### C06 Evidence (2026-09-20)

Changes are limited to CLI distribution implementation/tests, the alias test,
GUI options/main/startup test, and these two plan documents. Existing dirty
changes were preserved; no commit, branch, network, new dependency, publication,
or broad formatting was performed.

- Both public Cargo entry files still include the same `native.rs`; a regression
  test pins this and existing empty-PATH help/version/advice tests pass.
- Package creation and directory verification require exactly the target's three
  binary names, with only the existing optional license/notice allowlist. Missing,
  duplicate, mixed-target, legacy launcher and traversal names fail closed.
- Packaging probes both aliases (`rigspark <version>`) and the GUI companion
  (`rigspark-gui <version>`). Mismatch, wrong product, failed exit, invalid UTF-8 and
  missing executable fail the gate. GUI standalone `--version` returns before
  configuration, harness or listener initialization; mixed startup flags reject.
- Manifest size/hash tampering, missing/unlisted files and stripped Unix owner
  execute permission reject. Packaging preserves source permissions.
- The opt-in real artifact test uses freshly built debug binaries, existing
  `package_directory`/`verify_directory`, and a copied directory in a temporary
  prefix with spaces. It removes the staging directory, runs all three versions
  and both aliases' help/offline embedded advice with empty PATH and isolated cwd,
  then removes the companion and checks both aliases' exact reinstall diagnostic.
  No Node, source-tree runtime files, server, browser or inference is required.

Executed with Rust 1.98.1 (`aarch64-apple-darwin`), using cached locked dependencies:

```sh
cargo build --offline --locked -p rigspark-cli --bin llmup --bin rigspark -p rigspark-gui --bin rigspark-gui
cargo test --offline --locked -p rigspark-cli --bin llmup-dist --test distribution --test native_dist --test public_aliases --test gui_launcher
cargo test --offline --locked -p rigspark-gui --test startup
cargo test --offline --locked -p rigspark-cli --test native_dist real_artifact_directory_round_trip_runs_without_node_or_source_tree -- --ignored --exact
cargo fmt --all -- --check
```

Results: build passed; 45 CLI/distribution/launcher tests plus 6 GUI startup tests
passed; the separately selected real artifact test passed (also rerun after
formatting); Cargo format check passed. Layout, permission and GUI version tests
were observed failing before implementation; version-gate tests first failed to
compile because the helper did not yet exist. Formatting edits were limited to
the two touched distribution test files.

Limits: this is the authorized directory-round-trip alternative, not a compressed
release archive extraction or `cargo install` test. Windows naming is fixture
evidence only; no Linux/Windows or Intel macOS execution is claimed. Checksums
remain unsigned consistency checks, not publisher authentication. Directory
verification intentionally does not execute untrusted artifacts; version checks
belong to packaging, not GUI launch-time negotiation. Independent code/security
sub-agent review was unavailable in this session; C18-C20 and release/signing
gates remain pending, with no full-worktree regression claim.