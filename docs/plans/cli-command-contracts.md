# CLI Command Contracts (C02)

Date: 2026-09-19. Source-inspected contract, not executed acceptance evidence.
Owner: C02 documentation only; implementation remains pending C03-C08 under
[the approved plan](cli-migration-completion.md). Future npm CLI publishing is
retired; historical releases stay untouched. No maintained legacy channel.

## Reading The Matrix

Sources: TS registration (retired), [native command allowlists](../../crates/llmup-cli/src/native_args.rs),
[native dispatch](../../crates/llmup-cli/src/native.rs), [GUI launcher](../../crates/llmup-cli/src/gui_launcher.rs).
The table records CURRENT native acceptance, with TS differences explicitly named.
All switches are boolean, default false, unless stated otherwise. Unspecified
optional values are absent. Extra positionals, unknown commands/flags and flags
outside a command's allowlist must fail before work, stdout empty, exit 1.

- `U`: `--tui`, `--no-tui`, `--accessible`, `--no-color` (accepted but hidden in help).
- `D`: `--catalog-path <path>`, `--perf-path <path>`; default embedded datasets.
- `H`: hidden `--hardware-json <JSON string>`; default hardware detection; 64 KiB cap.
- Context: finite integral numeric value 1..10000000; advice defaults to model
  context length, activation passes no override, migration resolves target length.
- Backend: `ollama|llamacpp|mlx|lmstudio`; advice defaults Ollama; activation uses
  explicit/configured/available runtime selection; catalog switch uses active backend.
- Port: native nonzero `u16`, 1..65535; default 11434 except GUI 4000.
- References: nonblank, no control characters, at most 8192 UTF-8 bytes.
- `P/J/V/A`: plain / JSON / visual / accessible. Mode support does not prove wiring.
- `J+`: native JSON addition absent from TS registration; retain as an explicit
  native target and add contract tests in C07/C08, not claim TS parity.

## Eleven Commands

| Command / positional | Allowed flags, defaults and dependencies (plus help/version) | P / J / V / A; effects and exit |
| --- | --- | --- |
| default / `recommend` (none) | U, D, H; `--task <chat\|code\|vision\|reasoning\|tools\|embedding>`; `--context`, `--max-context`, native `--context-percent <25\|50\|75\|100>` mutually exclusive; `--backend`, `--available-backends`, `--installed`, `--port`, `--fits-only`, `--json`. Port/fits-only require installed; installed rejects task/max/percent/available-backends and non-Ollama backend. | yes / yes / yes / yes. Catalog advice offline; available-backends probes installed binaries; installed inventory reads loopback Ollama. Report exit 0. |
| `can-run [model]` | U, D, H; `--context`, `--backend`, `--installed`, `--port`, `--json`. Model required outside picker, always for installed; installed exact Ollama tag; port requires installed; non-Ollama installed backend rejected. | yes / yes / yes / yes. Offline catalog verdict or loopback installed inspection. `no` exit 1; yes/slow/unknown-fit otherwise 0; picker cancel 130. |
| `catalog` (none) | U, D, H; `--all`, `--refresh`. `--json` currently accepted by parser/help but rejected late in dispatch: C03 must reject before work and remove misleading help. | yes / reject / yes / yes. Default fitting subset; all includes nonfits. Refresh is embedded-snapshot incremental dry-run; no network/catalog writes. |
| `doctor` (none) | U, D, H; `--json`. No port/backend override. | yes / yes / yes / yes. Hardware, executable, disk/port/state/readiness diagnostics, including local runtime probes; `ok=false` exit 1. No lifecycle mutation intended. |
| `ls` (none) | U; `--json` (native addition). No D/H. | yes / J+ / yes / yes. Read active state, not installed inventory; no server probe required; empty is exit 0. |
| `up [model]` | U, D, H; `--port`, `--backend`, `--bypass`, `--installed`, `--context`, `--json` (native addition). Model required outside picker; installed requires bypass and Ollama. | yes / J+ / yes / yes. May acquire weights, spawn/attach loopback runtime and commit state under locks; integrity remains mandatory under bypass. Confirmation/picker cancel 130. |
| `switch [model]` | U, D, H; `--bypass`, `--installed`, `--context`; native additions `--port`, `--backend`, `--json`. Same installed/model constraints as up. | yes / J+ / yes / yes. Activate without memory migration; may acquire weights/start runtime/change active state. Inherit active runtime settings where owner permits. |
| `down [model]` | U, D; `--yes`, native `--json`. Optional model is a shutdown guard, not an install request; yes skips interactive confirmation only. No port/backend/H. | yes / J+ / yes / yes. Match target under lock; stop only owned identity-verified servers, detach attached daemon without killing it. Empty shutdown must create no state. |
| `chat` (none) | U (native addition); `-m, --model <ref>`; `--harness <local\|claude\|openai\|openai-compatible\|opencode>` default local; native `--message <text>`, `--agent <name>`, repeatable `--skill <name>`, `--no-memory`, `--json`. Remote harness requires model; local defaults active. Message nonblank, <=1 MiB. | yes / J+ / interactive only / cooked only. V rejects message/JSON/A; A rejects message/JSON/no-tui. JSON needs message or piped stdin. Runtime/provider calls, optional library reads and memory capture (on by default); EOF with no turns does no runtime/state work. |
| `migrate` (none) | U parsed; `--from <ref>`, `--to <ref>` required; `--move`, `--dry-run`, `--yes`; native `--context`, `--catalog-path`, `--json`. Yes requires move; native move requires yes unless dry-run. Context defaults resolved target length; unknown target needs explicit context. | currently JSON even without flag / J+ / reject / reject. Copy memory by default; move deletes source only after success; dry-run must not write. TS plain output and move-confirmation differences require C07/C08 reconciliation. |
| `gui` (none) | `--port`, `--harness` (same names, trimmed), `--no-open`, `--json`. No U/D/H; unspecified harness delegated to companion configuration. JSON suppresses browser opening. | yes / yes / reject / reject. Start sibling native GUI, loopback only, optionally open browser; supervise until exit/signal, reap child. No build, Node fallback or PATH companion lookup. |

D/H and context-percent are native additions, not TS registered flags. D reads
bounded 16 MiB files. Native chat agent/skill names are strings validated by their
library owner; parser acceptance alone does not establish pre-I/O validation.
Migration can call the active local target for summarization, including preview;
dry-run prohibits writes, not necessarily inference. Do not label it offline.

## Global Output And Mode Contract

Normal results go to stdout; warnings, errors, interactive presentation and progress
go to stderr. Errors are control-sanitized and command-prefixed once, exit 1.
Success exits 0 except negative can-run verdict and failed doctor report (1).
Picker/confirmation cancellation is 130, not successful completion. Read-only
report quit is normal completion; interruption must skip final plain stdout.
Lifecycle interruption uses 130 (SIGINT) / 143 (SIGTERM); do not infer that all
chat/migration/installed-inventory signal paths already preserve those codes.

Help/version must succeed without datasets, hardware, config, state or network.
Native version is `local-llmup <product-version>`, with no platform/Node suffix.
Native help formatting/banner may differ from CAC; preserve command/flag meaning,
hidden UI switches and useful errors, not TS byte snapshots. Both public aliases
must use this contract; hidden `--parity` is an internal fixture path, not public API.

Mode selection owner: [tui_mode](../../crates/llmup-cli/src/tui_mode.rs). Auto visual
requires all three streams TTY, valid non-dumb TERM, no recognized CI, >=60x16.
Explicit accessible read-only/lifecycle needs >=40x10 and the same eligibility;
chat accessible is a separate cooked path and permits piped input/EOF. Ineligible
auto mode falls back to plain; explicit mode fails before work. JSON conflicts
with TUI/A; no-tui conflicts with TUI/A. TUI+A selects accessible for read-only
commands, but chat rejects it. NO_COLOR presence or no-color disables color only.
TS installed advice bypasses mode resolution, as do up/switch with bypass,
installed or context. Native interactive routing differs here: pending C03/C08.

## Help And JSON Targets

| Case | Required contract / current gap | Owner |
| --- | --- | --- |
| Root `--help`, `-h`; each of eleven `<command> --help`; default/named recommend | stdout help, stderr empty, exit 0, no work; unique commands and scoped options. Native tests cover long help, not the complete short-help matrix. | C03/C07 |
| `--version`, `-v`, `-V`, including command-scoped use | Product-only stdout line, no Node/platform suffix; exit 0. Root cases tested; command-scoped cases need assertions. | C03/C06 |
| `chat --help --tui` and other accepted hidden UI flags | Help succeeds without entering terminal mode; hidden flags stay absent from rendered help. Existing test covers all four flags. | C03 |
| `up --help --catalog-path /missing`; help with semantic-invalid context/dependency | Current help exits before execute-time checks or file reads; preserve informational short-circuit for syntactically valid allowed options. Add missing-file/invalid-home assertions. | C03 |
| `--help` with unknown command/flag, wrong-command option, missing value or parser-invalid number | Native parsing/allowlist checks precede help/version: exit 1, no work. Pin precedence explicitly; semantic `--context 0` differs from nonnumeric context. | C03 |
| JSON flag manifest | TS registers exactly recommend, can-run, doctor, gui. Native target adds ls/up/switch/down/chat/migrate, rejects catalog before work; help must list JSON only for those ten supported commands. No silent ignored JSON flags. | C03/C07/C08 |
| GUI JSON stream | Current TS and native emit startup JSON, then `Stopped.` on shutdown: startup record, not a single whole-process JSON document. Native run_gui retains this on 0/130/143 after presentation; assert framing and exit separately. | C05 |
| Migration plain/JSON | Current native always emits JSON; target restore TS human summary without flag and define/test native JSON with flag. A forced `--move --yes` requirement is not an approved cosmetic compatibility change. | C07/C08 |

Invalid input must cause no hardware detection, dataset/config/state reads, locks,
process/browser launch, memory writes, downloads or endpoint calls before rejection
(help bypasses semantic execution checks as above). Existing empty-home assertions
prove absence of created state only, NOT absence of reads or network calls. Add
injected call counters/controlled fixtures for stronger claims. `catalog --json`
currently violates this ordering by rejecting after catalog/perf reads and detection.

## Coverage Transfer Ledger

Each row is one behavioral group, not a blanket command completion claim. Test
names below are source evidence only; none were run for C02. `CLI` means an actual
subprocess invocation, mostly of internal llmup-native; `unit/service` does not
prove argv forwarding. Public aliases have only the separately listed coverage.

Test-file keys (all paths relative to repository root):

- CC = [crates/llmup-cli/tests/cli_contract.rs](../../crates/llmup-cli/tests/cli_contract.rs); PC = [crates/llmup-cli/tests/public_cli.rs](../../crates/llmup-cli/tests/public_cli.rs).
- TC = [crates/llmup-cli/tests/terminal_cli.rs](../../crates/llmup-cli/tests/terminal_cli.rs); PTY = [crates/llmup-cli/tests/tui_pty.rs](../../crates/llmup-cli/tests/tui_pty.rs).
- LC = [crates/llmup-cli/tests/lifecycle_cli.rs](../../crates/llmup-cli/tests/lifecycle_cli.rs); AC = [crates/llmup-cli/tests/advice_cli.rs](../../crates/llmup-cli/tests/advice_cli.rs).
- GL = [crates/llmup-cli/tests/gui_launcher.rs](../../crates/llmup-cli/tests/gui_launcher.rs); PA = [crates/llmup-cli/tests/public_aliases.rs](../../crates/llmup-cli/tests/public_aliases.rs).
- RA = [crates/llmup-runtime/tests/application.rs](../../crates/llmup-runtime/tests/application.rs); RL = [crates/llmup-runtime/tests/lifecycle.rs](../../crates/llmup-runtime/tests/lifecycle.rs).
- Retired TS registry/dispatch suites are replaced by [native public CLI tests](../../crates/llmup-cli/tests/public_cli.rs) and [parser contracts](../../crates/llmup-cli/tests/cli_contract.rs); C07 records the assertion dispositions.
- Retired TS mode and manifest suites are replaced by [native public contracts](../../crates/llmup-cli/tests/public_cli.rs) and [PTY routing](../../crates/llmup-cli/tests/tui_pty.rs); see C08 in the retirement ledger for assertion dispositions.

| Behavioral group / legacy assertion | Native owner and exact test evidence | Disposition / remaining acceptance |
| --- | --- | --- |
| Eleven unique described commands, down detach, ls active-only (TS titles still say ten) | native_args; PC `help_has_unique_described_commands_and_command_scoped_options`; CC `lifecycle_help_distinguishes_state_inventory_and_process_ownership` (CLI) | C07: retain semantic registry assertions; not the obsolete test-title count. |
| Default/named recommend dispatch once and no extra output | native execute; PC `default_dispatch_and_plain_overrides_preserve_output_without_node`; CC `default_recommend_and_native_context_modes_remain_supported` (CLI) | C07: output equivalence covered; all-command success dispatch-count assertions not replaced. |
| Invalid flags, positionals, task/backend/context, dependencies fail before work | native_args + execute; CC `command_flag_matrix_rejects_irrelevant_options`, `invalid_values_and_dependencies_fail_before_io`, `chat_library_selection_fails_before_state_access`, `supplied_hardware_is_validated_before_datasets`, `parse_error_prefix_respects_positionals_and_sanitizes_command_text` (CLI) | C03 accepted: poisoned inputs and blocked homes cover parser/dependency ordering before command I/O. Controlled dispatch-count assertions remain C07 where required. |
| Valid recommend context/max/backend/task and can-run context/backend/JSON forwarding | core advice via execute; PC `public_advice_options_match_frozen_typescript_reports` (CLI, first 13 oracle cases) | C07: bounded forwarding proof; available-backends filtering needs controlled installed-backend fixture. Full frozen domain parity alone is insufficient. |
| Valid up port boundaries, bypass/context forwarding; switch selection | application; PC `boundary_ports_are_accepted_before_catalog_loading`; RA `lifecycle_options_reject_invalid_or_unsupported_combinations` | C04/C07: boundary test proves parsing only. Add successful controlled CLI forwarding for port/backend/context/bypass/installed and switch inheritance; resolve ignored switch backend. |
| Installed can-run exact tag/context/custom port and recommend alternatives/fits-only | application::installed_inventory; [ollama_installed tests](../../crates/llmup-runtime/tests/ollama_installed.rs) `exact_local_inventory_and_honest_context_geometry`, `context_activation_verifies_variant_and_detects_source_drift` (unit/service) | C07: no equivalent CLI success-forwarding proof inspected; add controlled inventory transport and assert catalog advice was not used. |
| can-run yes/slow=0, no=1, independent of JSON | native execute; PC `can_run_yes_slow_and_no_verdicts_control_exit_not_json_mode`; PTY `visual_can_run_preserves_verdict_exit_and_interrupt_contracts` | C07/C08: preserve report exits after rendering; installed-fit exit still needs CLI case. |
| Doctor failed diagnostics=1 and no corrupt-state rewrite | diagnostics/application; LC `doctor_reports_corrupt_state_without_rewriting_it`; PTY `accessible_doctor_preserves_failed_diagnostics_and_cooked_navigation` | C07/C08: add deterministic healthy report plus plain/JSON fixture assertions; failed report is stdout, not an exception-only path. |
| Per-command errors only stderr, prefix once, exit 1 | native main; PC `command_failures_are_one_prefixed_stderr_line_and_exit_one`, `local_chat_and_ls_errors_stay_on_stderr_without_mutating_home`; GC `missing_companion_is_actionable_once_prefixed_and_redacted`, `invalid_public_options_and_private_protocol_fail_before_launch` (CLI) | C07: most cases use parsing or missing inputs, not injected runtime failures. GUI prefix, redaction and stream behavior are covered. |
| Handled lifecycle UI failure does not append raw/internal error | tui_lifecycle + native execute; TS exact handled-up-error assertion has no direct replacement in inspected CLI tests | C03/C07: controlled presentation/runtime failure must assert one safe diagnostic, no success stdout or leaked renderer detail. |
| Catalog all/refresh offline dry-run preserves input | core enrich + execute; AC `catalog_refresh_matches_frozen_legacy_text_and_never_writes_input` (CLI) | C07: retained frozen refresh text is real comparison; keep network prohibition and early-invalid tests distinct. |
| ls empty/active owned/attached state-only output | native execute; LC `native_ls_is_read_only_and_reports_empty_state_without_runtime_tools`; PC `classic_can_run_and_empty_ls_match_retained_typescript_goldens` (CLI) | C07: empty covered; active runtimeModelId/context/ownership and native JSON shape need CLI fixtures. |
| down --yes leaves plain execution unchanged, empty no-state | native execute/application; CC `down_yes_and_empty_state_remain_offline`; LC `empty_down_needs_no_hardware_or_runtime_and_creates_no_state`, `public_empty_down_is_unchanged_by_yes_and_creates_no_state` (CLI) | C04 accepted: both aliases preserve plain output with/without `--yes` and create no state. |
| Targeted down canonicalization, mismatch and lock race | application::run_native_with_config / lifecycle::down_with_target; RA `down_resolves_canonical_ids_and_preserves_state_on_mismatch_or_resolution_error`; RL `guarded_down_uses_state_after_waiting_for_the_shutdown_lock`; LC `public_down_target_mismatch_preserves_owned_and_attached_state` | C04 accepted: resolver runs under lock; public aliases forward canonical targets and mismatch before probes/stops/writes while preserving exact state. |
| Owned stop versus attached detach, identity/drift/failure/cancel safety | lifecycle; RL `guarded_down_match_stops_owned_and_only_detaches_foreign_daemons`, `guarded_down_rejects_state_drift_unknown_identity_and_reused_pid`, `guarded_down_resolution_failure_and_cancellation_preserve_state`, `failed_shutdown_restores_exact_owned_state_and_releases_lock` | C04: service evidence only; preserve exact state on failure, no kill of attached daemon, no lock residue. |
| Plain/JSON bypass renderer, hidden flags, accessible five read-only commands | tui_mode/execute; PC `explicit_interactive_modes_reject_non_tty_without_partial_output`; [mode tests](../../crates/llmup-cli/tests/tui_mode.rs) `matches_all_frozen_typescript_selections_and_error_reasons`; PTY read-only journeys | C08: selector oracle is unit evidence, not complete CLI routing; test color flags and installed/lifecycle fast-path differences explicitly. |
| Omitted model picker and confirmation default/cancel=130 | native execute; TC `accessible_model_picker_cancellation_matches_legacy_exit`, `accessible_confirmation_cancellation_preserves_enter_default` | C03/C08: reconcile exact stale PTY cases below, including no final stdout/state side effects. |
| Report completion versus signal interruption and terminal restoration | native presenters; PTY `raw_control_c_restores_terminal_and_returns_130`, `accessible_can_run_interrupt_skips_final_plain_output`, `accessible_model_lists_interrupt_without_final_plain_result`, `visual_shutdown_result_interrupt_suppresses_final_success_output` | C03 accepted: signal exits, restoration and command-specific final-output suppression pass. Broader mode/fixture transfer remains C08. |
| Chat model/harness dispatch, piped/plain/A/JSON and memory warnings | TerminalEngine/native_chat; TC `eof_chat_accepts_native_and_legacy_options_without_io`, `eof_chat_is_native_and_does_not_create_state_or_need_a_runtime`; [terminal tests](../../crates/llmup-cli/tests/terminal_chat.rs) `plain_and_accessible_output_keep_separate_transcript_contracts` (unit) | C07/C08: EOF is no-turn evidence, not successful provider forwarding. Add controlled reply/memory/error/signal and JSON stdin cases; preserve chat stdout/stderr fixtures. |
| Migrate from/to/move/dry-run/yes, plain summary and cancellation | execute/migration_service; CC dependency cases; [service test](../../crates/llmup-runtime/tests/migration_service.rs) `summarization_demotes_stored_system_turns_and_uses_target_model` | C07/C08: no CLI success transfer established. Restore plain summary; reconcile new move gate and TS interactive-unavailable notice versus native explicit reject; assert snapshot/drift/no-write preview. |
| GUI port/harness/no-open/JSON, readiness and cleanup | gui_launcher; GL `json_mode_forwards_custom_port_and_harness_without_browser`, `readiness_controls_open_and_shutdown_reaps_child`, `startup_without_readiness_is_bounded`; GC `public_aliases_start_native_gui_and_reap_it_without_runtime_or_browser`, `native_startup_failures_are_bounded_once_prefixed_and_redacted`, `missing_companion_is_actionable_once_prefixed_and_redacted`, `invalid_public_options_and_private_protocol_fail_before_launch` | C05 accepted on macOS: mock and isolated native-companion journeys cover public argv forwarding, readiness, bounded failure, redaction, once-prefixed streams and cleanup without inference or browser launch. C06 owns artifact/version agreement and additional platforms. |
| Public aliases / no Node / native companion | PA `both_public_targets_include_the_same_native_implementation` and empty-PATH help/version/advice tests; [distribution tests](../../crates/llmup-cli/tests/distribution.rs) layout/hash/size/execute-mode checks; [native_dist](../../crates/llmup-cli/tests/native_dist.rs) `real_artifact_directory_round_trip_runs_without_node_or_source_tree`; [dist version-gate tests](../../crates/llmup-cli/src/dist.rs); [GUI startup tests](../../crates/llmup-gui/tests/startup.rs) | C06 accepted locally on macOS ARM64: built trio copied through artifact directory to isolated prefix; all versions agree, aliases run embedded advice without Node/source-tree runtime, missing companion is actionable. Windows names are fixtures only; cross-platform execution remains C20. |
| Plain/JSON fixture manifest and surviving consumers | PC `retained_goldens_cover_every_public_command` (existence/JSON parse only); `classic_can_run_and_empty_ls_match_retained_typescript_goldens` (actual comparison) | C08: preserve eleven plain + four TS JSON fixtures; add native JSON manifest excluding catalog, and actual runtime output comparisons. |
| Help/version goldens, banner and renderer import isolation | PC `executable_consumes_argv_and_prints_public_version_once`; CC `help_and_version_are_offline_and_public`; PA empty-PATH tests | C06/C08: product-only version/native banner/help formatting intentional. Replace TS import-graph assertion with native no-Node/plain-no-renderer behavior; do not rewrite goldens merely to pass. |

## Exact Blockers And Handoff

1. C03 complete: cancellation assertions, fixture scoping, early catalog JSON,
  installed/chat/hardware validation, help precedence and interrupted final-output
  suppression are covered by the focused command/terminal/PTY targets.
2. C04/C07: Add controlled lifecycle/inventory CLI forwarding evidence; reconcile
  accepted switch overrides with active-backend selection. Preserve under-lock
  target resolution, no-active no-write path and ownership/drift rollback tests.
3. C05-C06 complete locally on macOS. C06 covers companion artifact/version
  agreement; cross-platform execution remains C20.
  Current bounds: readiness 128 bytes / 10 s; presentation 5 s; shutdown interrupt
  helper 1 s, graceful wait 3 s, then forced kill and wait 3 s. Sibling name alone
  does not verify companion product version at launch time. C06 enforces version
  agreement during packaging without introducing a new launcher protocol.
4. C07/C08: Reconcile migration plain output/move gate, chat and inventory signal
  codes, native JSON additions, and mode-routing differences. These are pending
  behavior decisions/tests, not approved version/help cosmetic changes.

Fixture retention owner: [tests/fixtures/noninteractive-golden.ts](../../tests/fixtures/noninteractive-golden.ts).
Current command-test consumers include recommend, can-run, up, chat, down, switch,
migrate, ls, catalog and doctor under tests/commands; GUI fixtures are also in the
manifest. Preserve shared consumers until their owning retirement batch migrates
them. An existing fixture file is not a runtime assertion and does not authorize deletion.

## C06 Artifact Acceptance

Executed evidence and exact commands are recorded in the
[C06 execution log](cli-migration-completion.md#c06-evidence-2026-09-20).
The complete binary set is `llmup`, `local-llmup`, `llmup-gui` on Unix targets,
and those three names with `.exe` on Windows. Existing optional license/notice
files remain allowed; opposite-target binaries, missing aliases/companion and
duplicates are rejected both when packaging and when verifying a manifest.
Unix binaries require owner-execute permission; file bytes and SHA-256 must
match the manifest. Checksums do not establish authenticity.

The GUI companion now supports standalone `--version`, producing
`llmup-gui <product-version>` without config/state/server initialization. Package
creation requires successful matching versions from both aliases and the GUI.
Directory verification stays non-executing, and the public GUI launcher retains
its existing sibling discovery/readiness protocol and reinstall diagnostic.
The real proof used built debug binaries and a directory round trip, not a signed
or compressed release archive. No Linux/Windows execution or full regression is
inferred from these focused macOS checks.

## Bounded Later Checks (Not Run Here)

Run only after the corresponding implementation batch is authorized, serially,
with locked/offline dependencies already cached. Use isolated homes and controlled
fixtures; no installed services, downloads or weight pulls. Scope filters to the
ledger row; C19 owns full regression, not C02.

```sh
cargo test --offline --locked -p llmup-cli --test cli_contract
cargo test --offline --locked -p llmup-cli --test terminal_cli
cargo test --offline --locked -p llmup-cli --test tui_pty model_picker_and_lifecycle_confirmation_cancel_before_side_effects
cargo test --offline --locked -p llmup-runtime --test lifecycle guarded_down_
cargo test --offline --locked -p llmup-runtime --test application down_
cargo test --offline --locked -p llmup-cli --test lifecycle_cli empty_down_
cargo test --offline --locked -p llmup-cli --test gui_launcher
cargo test --offline --locked -p llmup-cli --test public_aliases
cargo test --offline --locked -p llmup-cli --test public_cli
```

C02 verification is source/test tracing and documentation structure/whitespace
checks only. No source/test edits, builds, tests, dependency changes, network or
commits performed; no C03-C08 acceptance inferred from this document.