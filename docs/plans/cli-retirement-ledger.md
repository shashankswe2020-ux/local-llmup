# CLI Retirement Ledger

Date: 2026-09-19; execution records updated 2026-09-22
Status: C07-C09 locally verified; C10-C11 partially retired with evidence below.
Owner: migration integrator; whole-product and release acceptance remain pending.

## Scope And Evidence Rules

Companion to [the approved plan](cli-migration-completion.md). The working tree
contains substantial uncommitted native implementation and tests. References below
describe that working tree, not a released product. Original inspection-only rows
are followed by dated execution records. A dated passing retirement record takes
precedence over an older pending note for the same row; it does not close adjacent
untested work or waive publication gates.

- **Covered** means the named native test's assertions were inspected and cover
  the stated behavior. It does not mean the current combined candidate passed.
- **Partial** means only the stated subset is covered; the remaining assertions
  must transfer before retiring the legacy test.
- **Pending** names a specific replacement assertion, not permission to discard it.
- **Changed** requires an explicit approved compatibility disposition and a test
  for the replacement contract. Test counts do not establish equivalence.
- Required focused checks must run before retirement, and all plan acceptance
  gates remain binding. Inspection-only rows do not establish execution evidence.

## Native Evidence Index

| Key | Inspected Native Test File | Scope Limit |
| --- | --- | --- |
| CC | [cli_contract.rs](../../crates/llmup-cli/tests/cli_contract.rs) | Internal native executable, isolated home, empty PATH; parser/help/default/empty-down assertions. No runtime dispatch spy. |
| PC | [public_cli.rs](../../crates/llmup-cli/tests/public_cli.rs) | Despite its name, invokes `llmup-native`; public aliases need PA as well. |
| PA | [public_aliases.rs](../../crates/llmup-cli/tests/public_aliases.rs) | Both public names: help, exact version, default/named offline JSON recommendation, empty PATH and no state creation. Not every command. |
| AP | [advice_parity.rs](../../crates/llmup-cli/tests/advice_parity.rs) | Frozen `--parity` report/resolver/text comparisons with provenance and numeric tolerance. Does not exercise ordinary argv dispatch or lifecycle/installed/GUI behavior. |

## C07: Entry-Point Assertion Transfer

### Registry, Parsing, And Options

Retired source: `tests/cli.test.ts`. Its descriptions say "ten"
commands, but `EXPECTED_COMMANDS` actually contains eleven. Transfer assertions,
not that stale count or CAC internals.

| ID | Legacy Descriptions / Actual Assertions | Native Evidence And Required Disposition |
| --- | --- | --- |
| R01 | `registers exactly the ten spec commands`; unique names; nonempty descriptions; exposes all commands to CAC; help lists every command. Exact ordered registry equality plus membership. | **Covered with reviewed disposition:** PC `help_has_unique_described_commands_and_command_scoped_options` asserts the exact eleven-command public set, uniqueness, descriptions and scoped help. CAC registration and legacy ordering are retired implementation details; native public help is the contract. |
| R02 | `documents down detach+forget semantics...`; `documents ls active-only semantics...`. | **Covered:** PC exact help test asserts `detach and forget` plus `without stopping it`; CC asserts active-state versus installed-inventory semantics. RL `guarded_down_match_stops_owned_and_only_detaches_foreign_daemons` proves behavior. |
| R03 | Reject up ports `0`, `65536`: handler never called, exit 1, exact integer-range diagnostic. | **Covered:** PC `invalid_up_ports_preserve_exact_diagnostics_before_state_access` checks both bounds, exact prefixed diagnostics, exit 1, empty stdout and no state creation; CC preserves parser-error precedence over help/version. |
| R04 | Accept ports `1`, `65535`: exactly two up calls with numeric ports. | **Covered with semantic request disposition:** native `lifecycle_request_preserves_model_bypass_context_and_boundary_ports` constructs validated lifecycle requests containing numeric ports 1 and 65535 for up/switch; PC boundary test proves public parsing. Legacy mock call counts are not retained. |
| R05 | `accepts command-scoped down --yes without changing plain execution`: once with `{}`. | **Covered with semantic request disposition:** native `down_yes_does_not_change_shutdown_request` proves identical validated requests; LC `public_empty_down_is_unchanged_by_yes_and_creates_no_state` proves both aliases produce identical output and no state. |
| R06 | `rejects migrate --yes unless --move is explicitly present`: exit 1 and dependency message even without from/to. | **Covered:** CC `migrate_yes_dependency_precedes_missing_references` checks bare and source-only invocations, exact dependency diagnostic, exit 1, empty stdout and no state creation. |
| R07 | `does not append a raw handled up error after the exact lifecycle notice`: no `internal renderer detail`, exit 1. | **Covered:** native `result_display_failure_is_safe_and_has_no_success_stdout` and `operation_display_failure_retains_runtime_evidence_not_renderer_details` assert safe single diagnostics, no private renderer detail, no success stdout and failure exit. |
| R08 | Recommend forwards context `8192`, max-context, and backend `llamacpp` with available-backends; successful exit unchanged. | **Covered:** PC `recommendation_reports_requested_context_8192` observes context evidence; parity cases cover max-context; native `backend_and_available_backends_reach_catalog_advice_together` validates combined request/probe filtering and report behavior. |
| R09 | Invalid backend `bogus`; context `0`, `abc`, `1.5`; context+max-context: no recommend call, exit 1, prefix and mutual-exclusion message. | **Covered:** PC `invalid_advice_fails_exactly_before_loading_any_inputs` checks exact cases, command prefix, exit 1, empty stdout and poisoned input paths proving no command I/O. |
| R10 | Installed can-run forwards model, context `65536`, port `11435`, never catalog can-run; installed recommend forwards context+fits-only, never catalog recommend. | **Covered with semantic request disposition:** native `installed_requests_select_inventory_with_exact_options` constructs the installed request variant with exact model/context/port/fits-only values, excluding catalog advice by type. Legacy mock call counts are retired. |
| R11 | Up forwards bypass and context `65536`. | **Covered:** native `lifecycle_request_preserves_model_bypass_context_and_boundary_ports` asserts model, bypass and context on the validated lifecycle request; runtime integrity checks remain independently covered. |
| R12 | Can-run forwards context `65536`, JSON, backend `llamacpp`; no verdict exits 1, yes/slow exit 0. | **Covered for observable reports/exits:** PC `public_advice_options_match_frozen_typescript_reports` compares context/backend can-run reports; `can_run_yes_slow_and_no_verdicts_control_exit_not_json_mode` checks all three verdicts in plain and JSON, exact exit codes and empty stderr. PC `classic_can_run_and_empty_ls_match_retained_typescript_goldens` compares plain bytes and JSON fields. Retire mock-shape assertions only after these execute successfully and alias wiring is accepted. |

### Noninteractive Dispatch And Failures

Retired source: `tests/cli-noninteractive-contract.test.ts`.
Its `CASES` are default recommend, explicit recommend, can-run, up, chat, down,
switch, migrate, ls, catalog, doctor. GUI is not in this table. Each success case
requires exactly one handler call, no wrapper stdout/stderr, and no changed exit
code; it does not require a real successful command to emit no report.

| ID | Legacy Assertions | Native Evidence And Required Disposition |
| --- | --- | --- |
| N01 | `dispatches $name once without changing exit code`, every CASES member. | **Covered with reviewed semantic disposition:** real native command journeys cover every public command across PC/CC/LC/TC/GC; request tests cover lifecycle, installed advice and migration construction; output helpers assert one report. Legacy handler mock counts are implementation details and no test-only dispatcher was added. |
| N02 | `routes $name failures only to stderr and exits 1`: stdout empty, exact `<command>: contract failure\n`; default uses recommend prefix. | **Covered:** PC command-failure and chat/ls tests cover all non-GUI commands; GC covers GUI. Native `ordinary_lifecycle_errors_are_one_prefixed_line_without_stdout` and prefix tests cover post-dispatch lifecycle failures without duplicate/raw output. |
| N03 | can-run no and doctor `{ok:false}` both exit 1. | **Covered:** PC verdict test pins can-run exits; LC `doctor_reports_corrupt_state_without_rewriting_it` now checks exact exit 1, empty stderr, failed plain/JSON stdout and unchanged state. |

## C08: Compatibility And Mode Transfer

Retirement update (2026-09-21): the native `public_cli`, `public_aliases`,
`cli_contract`, `terminal_cli`, `tui_mode`, `tui_models`, and `tui_pty` suites
passed together (97 tests) before deleting `tests/noninteractive-compat.test.ts`
and `tests/cli-tui.test.ts`. Shared noninteractive fixtures remain for surviving
command tests. The detailed pending notes below predate this execution update.

- M03/T03/T08: `eligible_plain_and_json_overrides_never_enter_ui_and_emit_one_report`
  verifies eligible-PTY bypass, unchanged terminal attributes on Unix, no control
  bytes/prompts, exact plain output and one parsed JSON document.
- T01: `visual_report_accepts_search_and_restores_terminal_on_exit` checks the
  final recommendation occurs exactly once after restoration. Legacy lazy-import
  and mocked collector invocation counts are implementation details; native
  rendering uses collected report values and does not recreate the TS dispatcher.
- T04: all five accessible command journeys execute in the passing PTY suite;
  mocked entry invocation counts are superseded by observable output/side effects.
- T06: the reviewed native missing-model wording is pinned by public CLI tests;
  selection still requires an interactive terminal.
- T07: visual and accessible picker/confirmation cancellation now consistently
  assert exit 130, no final success report and no state creation. Earlier zero-exit
  assertions referenced below no longer exist in the current tests.
- M01/M02/M04/M05/T02/T05/T09: native manifest, exact help/version, hidden flags,
  visual no-color and diagnostic exits passed in the same combined run.

Additional inspected native evidence:
[tui_mode.rs](../../crates/llmup-cli/tests/tui_mode.rs),
[terminal_cli.rs](../../crates/llmup-cli/tests/terminal_cli.rs),
[tui_pty.rs](../../crates/llmup-cli/tests/tui_pty.rs), and
[tui_models.rs](../../crates/llmup-cli/tests/tui_models.rs).

### Manifest, Help, And Version

Retired source: `tests/noninteractive-compat.test.ts`; see the execution update above.

| ID | Legacy Description / Assertions | Native Evidence And Required Disposition |
| --- | --- | --- |
| M01 | `requires one plain golden for every implemented command`: exact manifest key equality with registry plus every file exists. | **Covered locally:** PC `native_fixture_manifest_matches_public_commands_and_json_support` derives the exact command set from public help, compares it to the native plain manifest, rejects extra/missing keys by equality, and requires each fixture to be nonempty. Focused test passed on 2026-09-21. Output parity remains owned by command-specific rows. |
| M02 | `pins JSON goldens for every command that currently registers --json`: discover flags from registration, exact key equality and file existence. | **Covered locally for the approved native contract:** PC `native_fixture_manifest_matches_public_commands_and_json_support` discovers `--json` from each command's public help, compares the exact ten-command set to the native JSON manifest, verifies catalog is excluded, requires every fixture, and parses each fixture as JSON. Focused test passed on 2026-09-21. Command-specific execution/output assertions remain separate rows. |
| M03 | `keeps the plain CLI static import graph free of renderer-bearing TUI modules`: recursively traverses static imports/exports; only snapshots allowed. | **Changed implementation, partial replacement:** PA proves help/version/default advice under empty PATH; PC plain paths assert no escape bytes; `tui_mode` frozen selections prove routing decisions only. Rust links its terminal implementation rather than lazy-loading JS. Add plain/JSON terminal-entry instrumentation or a no-terminal-control public test under eligible PTY conditions; preserve native startup/memory budgets. Do not claim empty PATH establishes lazy initialization or performance. |
| M04 | `preserves the global help output byte-for-byte`: encoded legacy help fixture. | **Covered locally under the approved native-format difference:** PC `global_help_matches_reviewed_native_golden` asserts exact decoded native help bytes; command/help scope assertions remain in PC/CC. Focused test passed on 2026-09-21. The legacy fixture remains historical baseline evidence and was not regenerated. |
| M05 | `preserves the version output byte-for-byte`: normalized platform/arch and Node suffix. | **Changed (approved product-only version):** CC `help_and_version_are_offline_and_public`, PC `executable_consumes_argv_and_prints_public_version_once`, PA `public_aliases_and_internal_binary_report_public_version_without_node` assert exact `local-llmup <Cargo version>\n`. PC checks all three version flags and empty stderr. Suitable to replace the old Node/platform fixture assertion after execution; preserve historical fixture provenance. |

### CLI TUI Routing

Retired source: `tests/cli-tui.test.ts`. These tests stubbed the
mode resolver and entry functions; the native equivalents should assert observable
routing or use injected native operations, not recreate CAC mocks.

| ID | Legacy Description / Assertions | Native Evidence And Required Disposition |
| --- | --- | --- |
| T01 | `routes eligible explicit recommend through the lazy interactive entry`: tui option forwarded; interactive called with empty command options and explicit selection; plain handler not called. | **Partial:** PTY `visual_report_accepts_search_and_restores_terminal_on_exit` asserts visual entry, Recommend, restoration, exit 0. Add assertion that recommendation is collected once and no plain report is emitted before UI completion; lazy JS import itself is superseded by M03. |
| T02 | `normalizes CAC --no-color into the mode selector contract`: tui and noColor both true. | **Covered locally:** `tui_mode` preserves the frozen selection contract, model buffer tests preserve monochrome styling, and PTY `recommend_tui_no_color_preserves_visual_session_without_colored_sgr` proves both `--tui` invocations enter/restore the visual session while only the ordinary invocation emits color SGR. The PTY assertion intentionally avoids exact cursor-diff bytes; Ratatui buffer tests own detailed section layout. Focused PTY test passed on 2026-09-21. |
| T03 | `preserves plain routing for ineligible and --no-tui invocations`: no resolver/interactive call, plain `{}`. | **Covered for non-TTY output:** PC `default_dispatch_and_plain_overrides_preserve_output_without_node`, [advice_cli.rs](../../crates/llmup-cli/tests/advice_cli.rs) `plain_override_and_no_color_preserve_noninteractive_output` compare bytes and no escape output. PTY `small_terminal_falls_back_but_explicit_request_fails_before_rendering` covers auto fallback and explicit failure. **Pending:** eligible full-size TTY plus `--no-tui` must not enter raw/alternate mode; absence of a JS resolver call is implementation-specific. |
| T04 | `routes all five read-only commands through accessible mode`: each interactive entry called once. | **Covered for accessible journeys:** PTY `accessible_recommendation_search_details_and_print_never_execute`, `accessible_can_run_preserves_evidence_plain_result_and_verdict_exit`, `accessible_doctor_preserves_failed_diagnostics_and_cooked_navigation`, `accessible_catalog_search_details_and_refresh_are_read_only`, `accessible_active_server_uses_cooked_help_then_prints_plain_result` assert corresponding screen/content/exits and no visual entry. **Pending:** once-only collector/operation assertion; PTY output is not a dispatch spy. |
| T05 | `preserves can-run and doctor exit contracts after interactive rendering`: no verdict and unhealthy diagnostics exit 1 in visual mode. | **Covered locally:** PTY `visual_can_run_preserves_verdict_exit_and_interrupt_contracts` covers visual can-run verdict and interruption exits. PTY `visual_doctor_unhealthy_diagnostics_restore_terminal_and_exit_one` proves unhealthy visual doctor exits 1, restores the terminal, and emits one final diagnostic report. Focused doctor test passed on 2026-09-21. |
| T06 | `allows omitted can-run model only in interactive mode`: accessible empty options reach picker; plain no model does not run and emits required-model diagnostic, exit 1. | **Covered for selection/plain rejection:** PTY `accessible_can_run_picker_and_report_share_input_and_allow_cancel` selects a model then renders its report; PC `explicit_interactive_modes_reject_non_tty_without_partial_output` pins plain missing-model stderr/exit/no stdout. **Changed wording:** native `can-run: model is required\n` omits legacy `outside interactive mode`; parent must record this wording disposition. Cancellation half of PTY test is blocked by T07. |
| T07 | `maps interactive picker cancellation to exit 130`: null picker result must not mean success. | **BLOCKED, contradictory tests:** terminal `accessible_model_picker_cancellation_matches_legacy_exit` pins 130; PTY `model_picker_and_lifecycle_confirmation_cancel_before_side_effects` still pins 0 for can-run escape, and `accessible_can_run_picker_and_report_share_input_and_allow_cancel` pins 0 for q. Resolve to approved 130 contract before retirement. Also reconcile PTY `accessible_lifecycle_defaults_to_cancel_without_raw_mode_or_state` and `accessible_model_choice_and_review_share_one_cooked_input_reader` (0) with terminal `accessible_confirmation_cancellation_preserves_enter_default` (130). Retain no-state, restoration, and no-final-report assertions. |
| T08 | `forces JSON through the existing noninteractive command`: plain `{json:true}`, no interactive entry. | **Partial:** PC default/named JSON plus PA prove machine-readable output in non-TTY; frozen mode oracle covers JSON selection. Add eligible PTY `recommend --json` asserting exactly one JSON document, no prompts/alternate screen/raw session, and no UI dispatch. |
| T09 | `keeps actual parsed help free of hidden TUI compatibility flags`: global and can-run help omit all four UI flags. | **Covered:** CC `public_help_lists_commands_and_scopes_flags` and `help_and_version_are_offline_and_public` check global and all command help. `hidden_ui_flags_are_still_recognized` separately checks hidden flags parse with chat help. Candidate to retire after native execution/alias acceptance. |

### Fixture Ownership

Keep [tests/fixtures/noninteractive-golden.ts](../../tests/fixtures/noninteractive-golden.ts)
and [tests/fixtures/noninteractive](../../tests/fixtures/noninteractive). The helper
already derives `CommandName` from the plain manifest and no longer imports the
CLI registry. PC consumes can-run plain/JSON and ls plain directly; its manifest
test only verifies existence/parsing of other fixtures. AP uses a separate frozen
oracle and cannot substitute for every retained command fixture. Surviving command
tests must retain fixture access after the entrypoint tests move; shared GUI
tests remain independent retention requirements.

The synthetic TypeScript TUI fixture was retired on 2026-09-23 after its last
controller/schema consumer moved. Independent native JSON oracles remain intact;
the retained noninteractive golden helper and command fixtures below are separate.

The helper's current consumers are the recommend, can-run, up, chat, down, switch,
migrate, ls, catalog and doctor command suites, plus noninteractive compatibility.
Confirm every actual import before fixture deletion; recommend/up/ls command tests
survive this CLI-only cut. The GUI command suite is retained separately and does
not currently import this helper; GUI fixture existence is not GUI output parity.
The former typed TUI fixture served the retired read-only and controller suites.
Native projections retain their independently frozen data rather than importing it.

## Registry-Importing Shipping Test

Source: [tests/shipping/readme-packaging.test.ts](../../tests/shipping/readme-packaging.test.ts).
This file is a direct `COMMANDS` importer and blocks entrypoint deletion even
though it is outside the four CLI test files. Do not delete the entire suite.

| ID | Legacy Description / Actual Assertions | Replacement Or Retention Required |
| --- | --- | --- |
| S01 | `documents the primary one-liner workflows and keeps them aligned with the CLI registry`: README includes recommend/up/chat/catalog and registry contains them. | **Partial:** CC/PC help checks cover native command existence, not README. Transfer registry membership to the native command manifest or inspected public help; retain a README workflow test for these four names and actual native invocation examples. No Rust test inspected here checks the README relationship. |
| S02 | `declares publish metadata and npm ignore rules for a clean tarball`: repository, llm/ollama/cli keywords, homepage, bugs, main/types at dist/cli, ignore tests/.env/tokens. | **Changed by approved npm retirement:** replace CLI main/types requirements with private shared-package policy: `private:true`, no CLI bin/main/types/exports pointers, valid local Electron GUI subpath, retained metadata and secret exclusions. Native archive tests do not prove private npm metadata. Keep applicable metadata/exclusion assertions. |
| S03 | `packs only publish-safe files`: executes npm pack dry-run; requires dist/cli and model data; excludes tests/.env/tokens.json. | **Changed, partial native evidence:** [distribution.rs](../../crates/llmup-cli/tests/distribution.rs) `public_binaries_and_gui_round_trip_unsigned_on_unix_and_windows` checks exact fixture-binary names, unsigned status and tamper rejection; `public_alias_allowlist_rejects_duplicates_launchers_and_traversal` rejects JS/cmd/internal-name/traversal entries. These are package-directory tests with fixture bytes, not a built archive or Electron package audit. Add actual native artifact and private shared-package content checks: needed data/static assets retained, no deleted CLI outputs, no tests/secrets. Retire the dist/cli positive assertion, not the confidentiality contract. |
| S04 | `ships a non-root Docker image through GHCR and documents how to pull it`: USER llmup, Node entrypoint, GHCR naming/buildx/permission, changelog extraction, README/site pull commands. | **Pending C15/C16/C17:** replace Node-entrypoint assertion with native binary entrypoint, retain non-root/default offline/loopback contracts, GHCR architecture recipe and accurate historical-vs-candidate documentation. Keep changelog extraction and least-required workflow permissions assertions. No inspected native test establishes Docker policy or image behavior. |
| S05 | `uses an explicit filesystem-safe desktop executable name`: executableName local-llmup, safe-name regex, Linux artifactName. | **KEEP unchanged:** Electron is not retired at this milestone. Native alias tests are not a replacement for desktop packaging metadata. Remove only the registry import dependency from this suite after S01 transfers. |

## Active Import Closure

This is an inspected active-source inventory, not a claim that every string
mention must disappear. Dynamic imports and type-only imports count as blockers.
Frozen oracle provenance and historical documentation are not executable callers.

| Retirement Source | Current Incoming Edges / Blockers |
| --- | --- |
| src/bin.ts (retired) | Package bin aliases and built-file callers below. It imports `run` from cli and invokes it once. Prior bin test deletion is already in the worktree; do not recreate/delete it again. PA/PC version/default checks are evidence, not fresh acceptance. |
| src/cli.ts (retired) | bin; all four named CLI test files; shipping registry test; package main/types and dev. Static imports include all seven retiring commands plus recommend/up/ls and shared harness/types/sanitize. Lazy imports include commands/gui, installed-models and TUI capabilities/read-only-entry/lifecycle-entry. |
| Can-run, catalog and doctor retired | Native command, projection and fault-isolation tests replace their suites; shared GUI/domain services and independent golden data remain. |
| Retired down/switch command sources | Removed after lifecycle-entry retirement and native transaction/identity/integrity assertion transfer. Shared up and snapshots remain for GUI consumers. |
| Retired chat/migrate command sources | Removed after the CLI entry retirement and native assertion transfer below. The separate terminal chat entry and limit helper were retired on 2026-09-22. |
| [src/tui](../../src/tui), except snapshots | cli lazily imports capabilities/read-only-entry/lifecycle-entry. Internal entry modules lead to renderers/screens/pickers/types/sanitize/cooked reader; tests import other modules directly. Renderer-proof is executed by proof/budget tooling. Detailed source batches below enumerate all remaining files. |

### Shared Keepers

| Keep | Active Non-Retiring Consumers / Reason |
| --- | --- |
| recommend, ls, up, installed-up, installed-models, gui (**retired 2026-09-25**) | Their last consumer, the TS GUI, was retired. Evidence: recommend by the frozen advice matrix (78 cases: 13 option sets x 6 hardware profiles, plus sanitization), `llmup-core/tests/{ranking,reports}.rs` (available-backend filtering; empty vs nothing-fits text) and CLI context validation; ls by the six frozen [state parity](../../crates/llmup-cli/tests/state_parity.rs) contracts (owned, attached, runtime model, context); up by `llmup-runtime/tests/activation_plan.rs` (backend precedence flag > `LOCAL_LLMUP_BACKEND` > user config, Apple-Silicon-only MLX auto order, platform/source gates, fit/bypass/explicit-quant/context rules, disk preflight) plus adapter, pull, acquisition and lifecycle suites (owned runtime stopped when persisting state fails); installed-models by `ollama_installed.rs`; gui by `gui_cli.rs`. **Fixed bug:** a disk-bound auto selection told users to retry with `--bypass`, which still failed; it now reports `insufficient disk space`. Intentional: native messages omit legacy GiB detail. IMPL-SPECIFIC: `up-import` import-time side effects, frozen result objects, DI call ordering |
| src/tui/snapshots.ts (**retired 2026-09-25**) | Process-identity binding, PID reuse and confirmation validation are owned by `llmup-runtime/tests/identity.rs`; revalidate-under-lock by guarded down and memory migration drift tests. **Fixed bug:** native MLX rejected the macOS framework Python host (`Python.framework/.../Resources/Python.app/Contents/MacOS/Python`), so owned MLX servers on Homebrew or python.org Python could never be verified; it now accepts exactly that host for the resolved interpreter (`tests/adapters.rs`). IMPL-SPECIFIC: RFC 8785 canonical-JSON hashing and frozen snapshot objects (native compares typed structures) |

Do not delete shared [advisor](../../src/advisor), [backend](../../src/backend),
[catalog](../../src/catalog), [hardware](../../src/hardware),
[memory](../../src/memory), [state](../../src/state), [harness](../../src/harness),
[library](../../src/library), or [MCP](../../src/mcp) trees as collateral
cleanup. Retiring a file under commands does not retire its domain implementation.

## Direct Callers And Package Policy

| Surface | Current Coupling | Required Owner Action Before Deletion |
| --- | --- | --- |
| [package.json](../../package.json) | main/types -> dist/cli; two bin names -> dist/bin; dev -> tsx src/cli; test:tui-proof and three TUI budget/policy scripts. Build runs tsc plus GUI static copy. | **C14 package owner:** keep a private build-only package for Electron/shared GUI, no future npm CLI publishing, no stale entrypoint fields. Preserve a working local file dependency and GUI subpath. Make dev select the native public binary; preserve an explicitly named shared build route. Do not delete the package wholesale or add a new npm native distributor. |
| [apps/desktop/package.json](../../apps/desktop/package.json), [main.ts](../../apps/desktop/src/main.ts) | `local-llmup: file:../..`; build:cli rebuilds root and reinstalls local dependency; main imports GUI dist subpath. | **C14 + desktop owner:** preserve build/install resolution and emitted declarations/assets; rename misleading build:cli only with callers updated. Recheck desktop local lock metadata and packaged node_modules; keep Electron build and naming checks. This is not a maintained legacy CLI channel. |
| [tsconfig.json](../../tsconfig.json), [vitest.config.ts](../../vitest.config.ts), [eslint.config.js](../../eslint.config.js) | Includes all src, emits declarations/maps into dist, React JSX; coverage explicitly excludes src/cli; lint ignores dist/target/vendor/apps. | **C09/C12 retained-TS owner:** remove obsolete exclusions only after source removal; remove JSX/type dependencies only after last retained use. tsc does not clean stale files. Preserve retained TS quality/coverage gates. |
| [Dockerfile](../../Dockerfile) | Node build/runtime npm installs, dist/data copy, USER llmup, Node dist/bin entrypoint. | **C15:** native CLI image/build recipe and non-root smoke; preserve offline default and required embedded data. Resolve supported amd64/arm64 builds; do not run container commands during this task. |
| [scripts/opencode-support-demo.sh](../../scripts/opencode-support-demo.sh) | Executes npx tsx src/cli.ts chat with harness/model; package demo script calls it. | **C16 demo owner:** use chosen native executable and preserve supplied model/harness, output/error behavior; never auto-build/download or call live provider as a documentation check. |
| [assets/demo.tape](../../assets/demo.tape), [recommend.tape](../../assets/recommend.tape), [can-run.tape](../../assets/can-run.tape), [doctor.tape](../../assets/doctor.tape) | Main tape installs historical npm 0.8.1; tapes invoke public command names resolved via PATH. | **C16/C17:** retain historical recording label or update future recording recipe to isolated native install. Do not advertise historical GIF/npm installation as evidence of the candidate. Scope PATH to intended native binary. |
| Retired Git-baseline runtime-budget script | Rebuilt a Git checkout and timed Ink imports, incompatible with the approved published-package baseline. | **C12/C16/C21 remain pending:** compare the pinned published npm artifact only after migration. Native PTY tests replace the renderer dependency proof, not performance certification. No benchmark was run. |
| [scripts/tui-package-budget.ts](../../scripts/tui-package-budget.ts) | Builds isolated npm baseline/candidate, packs artifacts, measures installed dependencies; copies src/data/config files. | **C12/C16:** replace CLI gate with native archive/install budget and keep separate retained Electron/shared dependency accounting. Do not run the old script after removing its candidate build inputs or call npm-publish retirement a budget waiver. |
| [scripts/tui-dependency-policy.ts](../../scripts/tui-dependency-policy.ts), [tui-budget-baseline.ts](../../scripts/tui-budget-baseline.ts) | Policy pins Ink/React/string-width/types, lock integrity/licenses/lifecycle scripts/Yoga artifact; packed delta 250 KiB, install delta 24 MiB. Baseline helper is imported by both budget scripts. | **C12/C16:** transfer native dependency/license/security gates, retain relevant npm audit/SBOM gates for shared code. Delete baseline helper last, after both callers migrate. Remove policy tests only with equivalent enforcement, not because dependencies were removed. |
| [tests/tui/perf/budget-gates.test.ts](../../tests/tui/perf/budget-gates.test.ts) | Requires npm pack and <=500 KiB, budget scripts, dist/bin existence, Node version/help timing, production audit. | **C12/C16:** split native CLI artifact/startup assertions from retained shared npm security/package assertions. Its title about no TUI import only checks version text; do not cite it as an import-graph proof. |
| [tui-compatibility.yml](../../.github/workflows/tui-compatibility.yml) | Three OS/four Node runtime matrix, proof build, Node dist/bin, runtime/package budgets, SBOM/audit. | **C16 workflow owner:** equivalent native platform/terminal gates plus retained shared Node validation; do not simply remove the workflow. |
| [release.yml](../../.github/workflows/release.yml) | npm pack/dry-run and release asset/install text, policy/budget/SBOM; Docker buildx publishing; Electron root rebuild and publish. | **C14/C16:** remove future CLI npm artifact/publish assumptions, wire reviewed native unsigned artifacts and preserve retained desktop/security checks. Keep changelog/version consistency and permissions scoped. No tag push, release dispatch, signing waiver or publishing is authorized. |
| npm-publish.yml (retired) | On published release, downloads .tgz and SBOM, verifies, then real npm publish. | **C14/C16:** retire the future publication trigger/path under the approved policy; move still-required checks to retained/native CI. Setting private metadata alone is insufficient workflow migration. Already-published npm releases are untouched. |
| [workflow-policy.test.ts](../../tests/workflows/workflow-policy.test.ts) | Pins current npm artifact/publish steps as well as unrelated CI safety. | **C16 test owner:** replace obsolete publish assertions with no-future-npm-CLI publication checks and native artifact verification. Preserve other policy requirements; this file is already modified by other work. |
| [ci.yml](../../.github/workflows/ci.yml), [catalog-refresh.yml](../../.github/workflows/catalog-refresh.yml) | Still call root npm build; not direct CLI entrypoint execution in the inspected references. | **Retained tooling owners:** preserve a valid shared build route; do not delete these jobs merely because Node remains. State/workflow parity scripts and browser/Electron tooling remain later milestones. |

Also update current operational instructions under C17, including
[copilot-instructions.md](../../.github/copilot-instructions.md) and
[ship.agent.md](../../.github/agents/ship.agent.md), which still direct users to
tsx/dist/bin/npm publishing. This agent does not edit those files. Generic skill
examples and frozen oracle source hashes are not direct execution edges.

### Approved Distribution Outcome

Future CLI installation is native source installation or approved native archives.
There is no new npm/npx native distributor, no promised maintained legacy branch,
and no continuing npm CLI publication channel. Historical npm releases remain
historical. Retaining a private package solely to build shared Electron/GUI code
does not preserve an advertised TypeScript CLI.

The package owner must prove that local Electron installation can still resolve
the GUI deep import after removing CLI main/types/bin metadata. An exports map,
if introduced later, must expose the retained GUI subpath and declarations, not
accidentally block it. Keep model/performance data, required registry snapshot and
GUI static assets. Exact pack/package contents, not `private:true` alone, establish
absence of deleted outputs and secrets. Native archive fixture tests do not waive
real artifact, clean-install, signing, or desktop-license acceptance.

## Small Deletion Batches

**Proposal only; parent schedules and executes.** Every row below contains at
most five source files. Associated test migration/deletion, callers, metadata and
generated artifacts are separate <=5-file batches, not hidden additions to a row.
If changes must be atomic, split the source row further so the total edited-file
count stays <=5. No intermediate broken import graph is acceptable.

Before each source row: replacement assertions pass at the assembled candidate,
legacy test imports have been transferred, executable callers no longer target
the source, and all remaining static/dynamic/type edges are inspected. Afterwards:
run the plan's focused retained/native checks and inspect artifact absence. These
are future requirements, not commands run by this documentation task.

| Batch | Exact Source Files | Preconditions / Dependency Order |
| --- | --- | --- |
| D01 | src/bin.ts (retired), src/cli.ts (retired) | C03-C08 accepted, five direct registry/entrypoint test consumers transferred (shipping suite retained), package/dev/Docker/workflow/demo/budget callers migrated. Remove bin and cli together. |
| D02 | Read-only entry and view-model builder retired | Native projections cover evidence, bounds, unsafe identifiers and unknown values; user approved suppressing suggested commands over 256 bytes on 2026-09-23. Synthetic fixture retired with its last controller consumer. |
| D03 | Complete locally: lifecycle entry retired on 2026-09-22 | Native lifecycle controller failure tests, confirmation/PTY tests and restored switch-picker eligibility replace routing behavior. Removes runtime imports of down/switch; their own command suites remain. |
| D04 | Can-run, catalog and doctor sources retired | Native catalog filter/order/memory and exact refresh/no-write tests pass. Doctor tests cover independent failures, backend defaults/version isolation, warning-only low scores/digests and state health. User approved nonzero identity/readiness failure exits on 2026-09-23. |
| D05 | Complete locally: chat/migrate/down/switch sources retired | Shared activation, memory and confirmation identities remain for GUI consumers; no directory-wide cleanup authorized. |
| D06 | Complete locally: legacy chat entry and limit helper deleted | Native draft/response/summary tests and the approved fail-closed oversized-response contract replace these modules; see C11 evidence below. |
| D07 | All five read-only presentation sources retired | Native recovery, frozen accessible contracts, 22 model-view tests and 29 PTY tests pass, including fragmented catalog navigation. Independent session resource tests and their implementation remain outside this retired group. |
| D08 | Complete locally: lifecycle renderer, screen, accessible presenter and type module retired | D03 complete; 20 native lifecycle-controller tests, five cooked confirmation tests and 26 PTY journeys passed before removal. |
| D09 | Three model-picker sources retired | Native bounds/cooked-input tests and PTY stable selection, fragmented Home/End, q/Escape/Ctrl-C cancellation and terminal restoration pass; no remaining production consumers. |
| D10 | Renderer proof, session owner, generic controller and schema retired; [keys.ts](../../src/tui/keys.ts) remains | User approved native typed workflows instead of unused generic Back/rebuild and callback progress exceptions. Native confirmation/cancellation, bounded observations and authoritative result checks pass. Raw key safety still needs transfer. |
| D11 | Cooked reader, capability selector, controller types and terminal sanitizer retired | Native fixed text profiles replace the unused configurable API with user approval on 2026-09-23. Unicode/control escaping and bounded chat display have native tests; shared non-terminal sanitization and snapshot imports remain intact. |

**Scheduling blocker:** the plan lists C10 before C11, but D02/D03 are C11-owned
prerequisites to C10 source removal. Parent must explicitly coordinate these
three bridge-file transfers ahead of D04/D05, or defer C10 deletion until they
are ready. This ledger does not silently change the approved task dependencies.

### Test And Artifact Sub-Batches

Retirement candidates, not authorization. Each listed group is <=5 files;
source rows above are executed separately after these transfers are accepted.

| Group | Legacy Files / Disposition |
| --- | --- |
| E01 | Removed in the earlier C07 work: `tests/cli.test.ts` and `tests/cli-noninteractive-contract.test.ts`. Native public/request/output assertions own their contracts; retained tests pass after removal. |
| E02 | Complete locally: both TS compatibility suites removed after the 97-test native replacement batch. Shared fixtures remain; 1,919 retained tests pass. |
| E03 | [shipping/readme-packaging.test.ts](../../tests/shipping/readme-packaging.test.ts): edit/retain, do not delete; S01-S05 dispositions above. |
| E04 | Can-run, catalog and doctor command suites retired after independent native assertion transfer and approved doctor health-exit disposition. |
| E05 | Complete locally: chat/migrate/down/switch command suites retired after native transfer; see lifecycle transaction evidence below. |
| E06 | Command, accessible, visual-screen, list-state and view-model suites retired after native transfer. Synthetic typed fixture retired with the last controller/schema consumer; independent native goldens remain. |
| E07 | Lifecycle-entry, renderer, screen and model-picker suites retired after native transfer. |
| E08 | Complete locally: both legacy chat entry/limit suites deleted after native assertion transfer and user approval of oversized-response behavior. |
| E09 | Cooked-reader, capability, generic-controller and terminal-sanitizer suites retired; [keys.test.ts](../../tests/tui/keys.test.ts) remains. Fixed display profiles and native history policy have explicit approval; raw decoder safety assertions remain pending. |
| E10 | Renderer proof, terminal-smoke and session suites retired | Native tests cover resource ownership, partial mutation, repeated sessions, signals, resize debounce/recovery, independent size thresholds and bounded presentation restoration while awaiting runtime cleanup. Direct input-owner release replaces Node listener/pause bookkeeping. OS-signal execution evidence remains macOS-only. |
| E11 | [dependency-policy.test.ts](../../tests/tui/dependency-policy.test.ts), [perf/budget-gates.test.ts](../../tests/tui/perf/budget-gates.test.ts): replace/split under C12/C16; preserve relevant shared security and native performance gates. [snapshots.test.ts](../../tests/tui/snapshots.test.ts) is explicitly NOT in a deletion group. |

Generated cleanup must mirror the exact deleted-source manifest: dist/bin.js,
dist/bin.d.ts, dist/bin.js.map; the three cli outputs; equivalent command outputs;
and dist/tui outputs except snapshots. Inventory before removal, then split actual
files into <=5-file cleanup batches or use an explicitly reviewed clean shared
build staging directory. Do not wipe dist/commands or dist/tui indiscriminately.
Inspect the Electron-installed local package copy as well as root dist and native
archives. No claim about current generated-file presence is made here.

## Remaining Blockers And Handoff

| Owner | Actionable Blocker / Evidence To Return |
| --- | --- |
| C02 command-matrix owner | Reconcile R01 exact command set/order, R02/R06/T06 diagnostic/help differences, M02 all-eleven JSON acceptance and approved help/version changes. Own their matrix file only; consume row IDs from this ledger. |
| C03 parser/terminal integrator | Resolve T07 contradictory 0/130 assertions without dropping no-state/restoration/final-output checks; pin both invalid up-port diagnostics and missing-model/migrate dependency precedence. Serialize native.rs/native_args and terminal/PTY edits. |
| C07 test-transfer owner | Implement pending R03-R11/N01-N03 assertions using injected or controlled fixtures. Prove forwarding/once-only dispatch, not just parse acceptance or early file failure; preserve integrity checks on bypass. Return exact native test names and focused execution evidence. |
| C08 mode/fixture owner | Close M01-M04/T01-T08 gaps, including JSON/plain on eligible TTY, no-color argv routing, visual doctor exit and manifest completeness. Coordinate PC/PTY ownership with C07/C03 rather than concurrently editing those shared files. |
| C10/C11 retirement owner | Coordinate bridge ordering D02/D03, map remaining command/TUI suites before E04-E10 retirement, recheck all imports including types and fixtures at each batch. Do not infer command-suite coverage from this entrypoint ledger. |
| C14-C17 package/workflow/demo/desktop owners | Remove active executable callers before source deletion; retire future npm CLI publication while keeping private Electron/GUI build, security gates and artifact confidentiality. Package metadata, each workflow and lockfile each have one owner; existing changes must be reread, not overwritten. |
| Parent / C18-C22 | Accept passing assembled-candidate evidence, full regression/platform/performance gates and actual artifacts. Record baseline revision plus uncommitted candidate diff/artifact hashes before deletion; restore only authorized versions without touching user models/cache/memory. No commit/branch/push/release authorization is implied. |

Additional C11 evidence limits observed while checking closure:

- D05/D08 continuation (2026-09-22): down/switch have no remaining TS source
  callers after D03. Runtime lifecycle tests cover owned stop versus attached
  detach, exact target resolution/mismatch, identity reuse, cancellation, lock
  races, rollback and stop failure. New
  `shutdown_clear_failure_never_stops_and_successful_shutdown_is_idempotent`
  verifies failed state publication cannot stop the daemon and repeated shutdown
  never stops twice. New pointer-switch tests pin exact daemon preservation,
  clearing runtime/context/integrity metadata, readiness failure, concurrent
  replacement/disappearance and single-model rejection before readiness.
  The native application tests preserve no-active and already-active behavior,
  context/bypass forwarding and backend/port constraints. The private catalog
  request helper pins selected-quant SHA and size-floor forwarding; pull-service
  tests own failed acquisition and digest/manifest verification before activation.
  Frozen public command fixtures retain user-visible output contracts.
- Lifecycle presentation transfer: native controller tests cover ordered/bounded
  observed progress, draw/input failure, completion, cancellation and cleanup.
  `unexpected_control_exit_cancels_and_waits_for_runtime_cleanup` replaces the
  unexpected Ink-exit assertion; normal native completion and terminal RAII/PTY
  restoration replace explicit Ink unmount bookkeeping. Accessible Cancel/default
  and explicit confirmation and visual Enter/navigation/restoration are exercised
  in the passing cooked and PTY suites. These do not retire the separate legacy
  session-resource test suite. All six source files, four replaced test files and
  exact generated source outputs are removed; retained typecheck and 1,789 tests pass.
- Native picker validation now rejects >1,000 choices, duplicates, blank labels,
  controls and excessive label bytes before raw-mode acquisition or output.
  Accessible labels retain their existing stricter 256-byte limit; visual labels
  retain the legacy 8 KiB ceiling. The old picker/decoder suites remain until
  fragmented raw escape-input behavior has independent native evidence.
- D03 closed locally on 2026-09-22. All 19 native lifecycle-controller tests
  passed, including display failure before runtime polling, committed result
  preservation without retry, cancellation cleanup and diagnostic failures.
  Five accessible confirmation/picker tests and six lifecycle CLI tests passed.
  Native picker filtering now excludes the active Ollama model and all targets
  for non-Ollama switch operations. A catalog-based unit test pins filtered
  selection identity; a real PTY test checks llama.cpp, MLX and LM Studio return
  130 before any picker/review, preserve exact state bytes, and leave no lock.
  The six terminal-entry tests pass; default cancel, prompt-only --yes, one final
  result and terminal restoration remain covered in public/PTY tests. Legacy
  lazy module loading/Ink-specific mock events are replaced by native draw-failure
  and runtime-polling assertions, not a retained Node fallback. Source and test
  deleted with exact compiled outputs; all 1,820 retained tests pass afterward.
- D06/E08 closed locally on 2026-09-22. Native terminal validation now shares
  byte/grapheme/line limits with visual chat. Tests cover 32768 UTF-8 bytes,
  8192 graphemes, 256 lines including trailing empty lines, combined Unicode,
  error precedence/diagnostics, no provider call for invalid drafts, and recovery
  on the next valid turn. Native response tests cover exactly 1 MiB and over-limit
  ASCII/multibyte replies; summary tests pin all five zero/singular/plural cases.
  The user explicitly approved rejecting oversized replies as failed turns with
  no transcript/history entry, superseding legacy success-plus-memory-warning.
  Existing terminal/PTY/controller tests own pending state, EOF, bounded context,
  cancellation and stream separation; native runtime owns model/identity/capture.
  One native unit test plus 20 chat/entry integration tests passed before deletion.
  All 26 native PTY journeys passed before retiring the orphaned read-only entry.
  After deletion, typecheck and all 1,831 retained tests pass. Exact compiled
  artifacts were removed; shared fixtures and session-resource tests remain.
- Session assertions transferred on 2026-09-23: native guard tests cover
  exactly-once ownership, partial mutation and independent cleanup failures;
  PTY tests cover cooked/raw/cursor and OS signals. Lifecycle tests cover debounce,
  recovered sizes, visual/accessibility thresholds, pending cleanup precedence,
  fallback errors and terminal restoration without dropping runtime work. Rust
  ownership prevents post-drop reacquisition; releasing the event stream replaces
  Node pause/resume and listener removal. macOS signal checks do not certify other
  platforms. The original inspection-only limitation is superseded for this suite.
- Key decoder retired on 2026-09-24 after the approved bounded Crossterm parser
  patch. Native key mapping lives in `tui_models`, `tui_view` and `tui_lifecycle`
  tests; OSC/DCS/SOS/PM/APC/C1 and paste suppression in `terminal_events`; bounds,
  fragmented paste and lone-Escape expiry in the vendored parser tests (69 per
  Unix backend) and the 32-test PTY suite. Fixing lone Escape required returning
  to poll after a draining read, since the TTY read otherwise blocked. The
  decoder had no remaining callers; source and test were deleted (no generated
  outputs existed). Windows console decoding is unchanged; Linux/Windows remain
  uncertified.

### Assertion-Level Retirement Candidates

After native execution and parent acceptance, the clearest candidates are R12
(can-run context/backend/JSON reports and verdict exits), T09 (hidden help flags),
M05 (approved product-only version), and the observable subsets of T03/T04/T06.
R01 command membership/description/uniqueness has native evidence but its exact-set
assertion still needs work. These are portions of suites, not a claim that any of
the five requested files is wholly redundant. S05 and shared fixtures must remain.

Handoff acceptance records should attach to each row: native test symbol, fixture
and provenance, exact candidate revision/diff identity, executed command/result,
approved compatibility difference if any, retiring TS assertions, remaining
consumers, and reviewer. No whole-suite deletion should rely on a passing count.

## Completion Rule

### C10 Chat And Migrate Transfer

The chat and migrate command sources and their two command suites were deleted
after confirming zero active source callers. Their exact generated JS/map/type
files were also removed. Shared memory, harness, state and terminal modules remain.

- Migrate successful copy/move/dry-run, facts/persona preservation and output:
  native `workflow_parity`, `public_cli`, and runtime `memory` tests. All 34
  workflow contracts retain independent TS expectations and storage seeds.
- Migration drift and failure before commit: `source_drift_and_under_lock_failure_prevent_migration_commit`
  and `prepared_migration_commits_exact_summary_once_and_rejects_later_drift`.
- Embedding reuse/re-embedding/vector-less flags: runtime `memory` tests pin
  vectors/chunks, unsupported metadata and unchanged source storage.
- Missing source, invalid UTF-8, oversized system.md and symlink escapes: native
  memory boundary tests; alias collisions and unknown context: workflow CLI test.
- Active-target summary roles/model: runtime `migration_service`; backend process
  identity/token contracts remain covered by injected backend inference tests.
- Legacy Node descriptor-support rejection is retired as implementation-specific:
  native stores retain directory capabilities rather than pretending Node has them.
- The approved native command permits uncatalogued memory IDs with explicit
  `--context`; unknown target without context fails. Frozen compatibility does not
  claim arbitrary legacy diagnostics for this supported native extension.
- Chat transcript, EOF, blank turns, bounded context, failure/memory warnings and
  cancellation: native `terminal_chat`, `terminal_cli`, `tui_chat` and public CLI tests.
- Local fuzzy model resolution and selected-model memory ownership were restored
  in `native_chat` with tests for unambiguous prefixes, ambiguity rejection,
  installed context variants and single-model backend mismatch rejection.
- Custom endpoints, legacy/current process identity, MLX credentials, LM Studio
  attachment and stream bounds remain owned by native harness/adapter/inference
  tests. The migration specification's local-only CLI memory rule supersedes the
  old command's remote-provider memory capture assertion; remote harness tests stay.

Retained typecheck and all 1,874 surviving compatibility tests passed after both
source/test pairs were removed. This is not acceptance of the remaining C10/C11
modules or a claim of complete migration.

Inspection-only coverage is not authorization to delete a whole file. Completed
retirements above include passing replacement evidence and caller checks;
remaining partial/pending rows block their containing tests. Intentional
differences require recorded approval. Preserve shared fixtures and non-CLI
consumers independently of entrypoint retirement.

Original C02 documentation-only validation: whitespace check passed; all 151 local links
resolved; D01-D11 matched the current entrypoint/seven-command/TUI-except-snapshots
source inventory with no omissions, extras, duplicates or >5-source-file batches.
These are document/manifest checks, not behavioral test results. No build, test,
package, runtime, container or plan execution was performed. Only this new ledger
was edited; the main plan and command-matrix ownership boundary were preserved.