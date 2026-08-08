# Spec: Interactive Terminal User Interface

> Status: **Draft (v0.2) — llmfit audit and architecture, security, and test-strategy feedback incorporated; pending dependency and human approval.**
> Last updated: 2026-08-08
> Related: [local-llmup.md](./local-llmup.md),
> [hardware-advisor.md](./hardware-advisor.md),
> [runtime-performance-benchmarking.md](./runtime-performance-benchmarking.md), and
> [telemetry.md](./telemetry.md).
> Reference implementation candidate: [Ink](https://github.com/vadimdemedes/ink),
> a React renderer for interactive command-line interfaces.

---

## 0. Assumptions and proposed decisions

These assumptions become decisions only when this specification is approved:

1. “Each command has a TUI” means every functional command has a purpose-built
   interactive presentation when run in a compatible terminal. It does **not**
   mean scripts, pipes, JSON, help, or version output become interactive.
2. Existing plain-text, JSON, exit-code, stdout/stderr, safety, determinism, and
   side-effect contracts remain supported. Noninteractive invocations preserve
   current behavior byte-for-byte unless a separately versioned output change is
   approved.
3. TUI is automatic only when stdin, stdout, and stderr are all TTYs, terminal
   capabilities are sufficient, and neither `--no-tui` nor a machine-readable
   mode is active. There is no prompt in CI, pipes, redirects, or `TERM=dumb`.
4. Add global `--tui`, `--no-tui`, `--accessible`, and `--no-color` flags.
   `--tui` never overrides JSON/piped-input incompatibility or an unsafe terminal.
5. Commands requiring a model may omit it only in TUI mode and select from a
   validated offline list. Missing required values remain errors outside TUI.
6. Advice commands remain deterministic and offline. Their TUIs may filter,
   sort, inspect, and print a next command, but may not pull, serve, switch, or
   contact telemetry/backends as a consequence of a keypress.
7. The proposed renderer is Ink with React, loaded lazily only after TUI
   eligibility is established. This adds runtime dependencies and therefore
   requires explicit approval. Node.js 18 support may not be silently dropped.
8. The TUI is inline and leaves a final static summary in scrollback. It does not
   use the alternate screen, mouse-only controls, desktop notifications, or
   terminal hyperlinks by default.
9. Terminal content is untrusted. Catalog, runtime, model, endpoint, error, and
   progress strings pass context-aware escaping and bounds before entering any
   frame.
10. Benchmark and telemetry TUIs are specified for their approved command
    contracts but implemented only when those commands themselves exist.

---

## 1. Objective

Provide a consistent, polished interactive experience across local-llmup without
sacrificing its scriptable CLI contract.

The TUI should let users:

- understand current hardware, model fit, runtime, and progress at a glance;
- search and inspect large recommendation/catalog lists without terminal spam;
- choose models and options safely when arguments are omitted;
- see long-running pull, readiness, migration, benchmark, and chat states;
- confirm destructive actions before they begin;
- recover cleanly from cancellation, resize, unsupported terminals, and errors;
- obtain the same final facts, honesty-gated unknowns, and exit semantics as plain
  text and JSON.

### Target users

- First-time users who do not know model ids, quantizations, or backend flags.
- Interactive terminal users managing local models and conversation memory.
- Maintainers diagnosing lifecycle failures from clear staged progress.
- Power users who want keyboard-first navigation without losing scriptability.

### Non-goals

- Replacing stable plain text or JSON output.
- A web UI, daemon dashboard, remote control plane, or browser dependency.
- Mouse-required interaction, image protocols, sixel, audio, or notifications.
- Running a runtime/network operation from `recommend`, `can-run`, or catalog
  browsing unless that operation already belongs to the invoked command.
- Inventing missing performance, context, memory, or integrity values.
- Persisting UI history, keystrokes, filters, chat drafts, or terminal dimensions.
- Adding telemetry events for focus, keypresses, screen views, or TUI usage.
- Reimplementing backend, ranking, state, memory, or catalog business logic in UI
  components.

### 1.1 LLMFit reference audit and ten-dimensional quality advantage target

Reference reviewed on 2026-08-08 at upstream tree
[`15ed15d`](https://github.com/AlexsJones/llmfit/tree/15ed15dcf3ef793ff685c24ed949fd08f28f18dc),
especially its [TUI guide](https://github.com/AlexsJones/llmfit/blob/15ed15dcf3ef793ff685c24ed949fd08f28f18dc/docs/tui.md),
`llmfit-tui/src/tui_app.rs`, `tui_ui.rs`, and `tui_events.rs`.

Strengths to retain:

- keyboard and Vim-style list navigation;
- search, fit/availability/provider/use-case/license/runtime filters;
- detail, multi-model comparison, hardware planning/simulation;
- download and benchmark progress, installed-model awareness;
- visible system hardware and model fit/performance evidence;
- contextual help and responsive scrollable tables.

Problems local-llmup must avoid:

- one overloaded application with a large hidden mode/key matrix;
- single-letter actions whose meaning changes across many modes;
- UI state and domain/network/process orchestration coupled in giant modules;
- estimates modified through opaque “advanced efficiency” tuning;
- automatic background network services or a dashboard bound to `0.0.0.0`;
- downloaded/community/live data silently mixed with deterministic offline advice;
- theme breadth prioritized over accessibility, task clarity, and failure safety;
- destructive/runtime actions discoverable only by memorized shortcuts.

The product shorthand “10x better” is not presented as a measured multiplier.
The normative claim is a **ten-dimensional quality advantage target**: pass all
ten independently verifiable dimensions below; failure in one cannot be averaged
away:

| Dimension       | Required local-llmup advantage                                                                            |
| --------------- | --------------------------------------------------------------------------------------------------------- |
| Task focus      | One purpose-built screen flow per command, not one global mode maze                                       |
| Discoverability | 100% of current actions visible in footer, contextual action bar, or `?`; no undocumented key-only action |
| Time to value   | Top recommendation detail <=1 key; compare <=3 keys; exact next command <=2 keys after results load       |
| Explainability  | Every verdict/rank shows sourced fit, score, throughput, context, backend, and unknown-reason evidence    |
| Safety          | Confirmation snapshot + locked revalidation for every destructive target; no one-key irreversible action  |
| Scriptability   | Plain/JSON/piped golden output and exit behavior preserved                                                |
| Accessibility   | Complete cooked-input accessible mode, no color/motion dependency, tested screen-reader transcript        |
| Resilience      | Idempotent restoration and no duplicate domain execution across render/signal/resize failure              |
| Performance     | Meets §9 cold-start, input, frame, memory, and package budgets                                            |
| Privacy/network | No automatic web server, remote dashboard, community fetch, UI telemetry, or non-loopback exposure        |

The model explorer additionally exceeds the reference with a persistent-on-screen
contextual action bar (not persisted across runs), breadcrumbs instead of hidden
modes, up-to-four-model compare, an evidence ledger explaining every displayed
number, and safe command handoff that prints—but never auto-executes—the next
runtime command.

Before GA, a reproducible comparative audit checks out the pinned upstream commit
in an isolated temporary workspace and runs equivalent PTY task scripts with
fixture-safe hardware/model data where supported:

1. find the top runnable model and explain why it ranks first;
2. filter by fit + backend + capability and inspect one result;
3. compare three models and identify the best known value without treating unknown
   as zero;
4. discover how to print/start the selected model's next command;
5. cancel a destructive/runtime action and recover from terminal interruption.

The audit records visible actions before help, successful task completion,
keypress count after data load, hidden-mode transitions, evidence fields,
confirmation/revalidation behavior, accessibility path, terminal restoration,
network listeners, and scriptable-output availability. local-llmup must meet its
absolute gates, use no more keypresses for tasks 1–4, expose every tested action
without external docs, provide strictly stronger safety/evidence/accessibility for
tasks 1/3/5, and open no listener. Performance/package measurements are reported
side-by-side but are not called cross-language superiority. The report cites
upstream commit/paths and records facts only; no upstream source/assets are copied.

The upstream build/run is untrusted and executes only in an unprivileged,
disposable Linux sandbox: empty synthetic HOME/XDG/cache, no inherited environment
credentials, no host/runtime/Docker sockets, no devices beyond required PTY/null,
read-only verified source and Cargo cache, dedicated writable output/tmp, no-new-
privileges/seccomp, bounded CPU/memory/PIDs/disk/time, and a network namespace
with seccomp-denied socket/connect/bind/listen calls. A separate fetch-only job may
download the pinned commit/archive and Cargo dependencies through an allowlist;
it records SHA-256, verifies exact git commit `15ed15d…`, retains the upstream
`Cargo.lock`, and the sandbox builds with `cargo --locked --offline`. Audit
artifacts record source/archive/binary hashes and sandbox policy. If these
controls cannot be enforced, the comparative audit is `not_run` and cannot count
as release evidence.

---

## 2. UX principles

### 2.1 Progressive enhancement

The domain command executes through the same use case in every mode:

```text
validated CLI intent → domain result/progress events → presenter
                                                 ├─ JSON
                                                 ├─ plain text
                                                 └─ interactive TUI
```

TUI is a presenter, not a second command implementation. A failure to initialize
the TUI before domain work falls back to plain mode with one sanitized stderr
notice. A failure after mutation starts restores the terminal and reports the
real product outcome; it never reruns the command.

Auto-mode renderer initialization failure writes exactly
`local-llmup: interactive UI unavailable (renderer_init); continuing in plain mode\n`.
Ordinary ineligibility and `--no-tui` write no notice and never import the
renderer. Explicit `--tui` initialization failure is a pre-domain validation
error, not fallback. Runtime render failure writes exactly
`local-llmup: interactive UI failed (renderer_runtime); terminal restored; final result follows\n`
after restoration; raw renderer errors are never shown unless a future explicit
debug mode is approved.

Failure-state matrix:

| Point                                      | Behavior                                                                                                                                            |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| lazy import/mount before picker            | auto mode uses `renderer_init` fallback; explicit `--tui` fails pre-domain                                                                          |
| picker/review before acceptance            | restore, execute nothing, write `local-llmup: interactive UI failed (renderer_pre_execution); no action was performed\n`, exit 1                    |
| accepted but before controller `execute()` | same pre-execution failure; do not infer consent in plain mode                                                                                      |
| domain execution in flight, pre-commit     | restore, emit `renderer_runtime`, switch to bounded plain stderr progress, continue/cancel only from the domain signal—not because rendering failed |
| post-commit/final render                   | restore, emit `renderer_runtime`, write existing final/plain summary once, preserve product result                                                  |

Automatic fallback never re-prompts, reconstructs omitted intent, or executes a
previously displayed choice after its renderer/session failed.

### 2.2 Content hierarchy

Every screen has four stable regions:

1. **Header** — command, current model/backend, and compact machine context.
2. **Primary content** — list, result card, conversation, or staged progress.
3. **Context/detail** — evidence, unknown reasons, selected-item details.
4. **Footer** — visible keys, current filter/page, warnings, and cancellation.

Avoid decorative gradients, excessive borders, giant logos, fake gauges, and
animation without information. One semantic accent color and restrained status
colors are sufficient.

### 2.3 Honest status

- `unknown` remains visible with its sourced reason.
- Estimated throughput and sampled metrics are labeled estimates.
- Integrity state distinguishes digest verification from weaker evidence.
- Attached versus owned processes are always explicit.
- A spinner means active work only; waiting, retrying, cancelled, failed, and
  complete are distinct states.
- Progress without a sourced total is indeterminate; never fabricate a percent.

### 2.4 Safe action design

- Read-only commands never gain mutating shortcuts.
- Destructive actions show exact target, ownership, and consequence.
- Confirmation occurs before state/runtime locks and before mutation.
- Default confirmation choice is cancel.
- `--yes` bypasses confirmation only for the command explicitly invoked; no
  persistent “always confirm” setting is changed.
- These prompts are interactive-TUI behavior. Existing noninteractive explicit
  arguments remain the authorization contract and never trigger a prompt; locked
  target/state revalidation still applies.
- Escape backs out of a picker/dialog but does not silently cancel already-started
  product work. During work, Ctrl+C requests cancellation through the command's
  existing abort/cleanup boundary.

### 2.5 Visual language and reference wireframes

Semantic tokens are `surface`, `text`, `muted`, `accent`, `success`, `warning`,
`danger`, and `focus`; status text remains complete without color. Borders are
single-line and sparse. The selected row uses a left focus marker plus emphasis,
not background color alone. Breadcrumbs show location; there are no hidden Vim
modes.

Wide recommendation explorer:

```text
 local-llmup / Recommend        Apple arm64 · 32.0 GiB unified · ollama estimate
 Search: qwen_   Fit: runnable   Task: any   Backend: all   Marked: 2/4
 ───────────────────────────────────────────────────────────────────────────────
   #  Model                 Quant   Mem      Verdict    tok/s       Score
 > 1  qwen3:14b            Q4_K_M  9.3 GiB  ✓ yes      18.2–33.7   0.82
   2  qwen2.5-coder:14b     Q4_K_M  9.1 GiB  ✓ yes      18.5–34.1   0.80
   3  deepseek-r1:14b       Q4_K_M  9.4 GiB  ⚠ slow     unknown     0.76
 ───────────────────────────── Evidence ────────────────────────────────────────
 Fit  weights 8.7 GiB + headroom; context geometry sourced; RAM bound at 65k
 Speed estimate · ollama · Apple unified-memory profile · not a live benchmark
 Why #1  quality .84 · fit .90 · speed .71 · recency .88 · capability neutral
 ───────────────────────────────────────────────────────────────────────────────
 ↑↓ Navigate  / Search  Space Mark  c Compare  Enter Details  ? Help  q Quit
```

Lifecycle progress:

```text
 local-llmup / Up / qwen3:14b                  Ctrl+C cancels with safe cleanup
 ✓ Resolve & fit       Q4_K_M · 9.3 GiB
 ✓ Backend             ollama (explicit)
 ● Acquire & verify    3.2 / 8.7 GiB  [███████░░░░░░]  36%
 ○ Prior cleanup
 ○ Serve on 127.0.0.1:11434
 ○ Readiness
 ○ Commit state
 Integrity: pending · Ownership: not established · Elapsed: 00:41
```

Chat:

```text
 local-llmup / Chat          qwen3:14b · ollama · memory capture on
 ─ You ─────────────────────────────────────────────────────────────────────────
 Explain why KV cache grows with context.
 ─ Assistant ───────────────────────────────────────────────────────────────────
 KV cache stores attention keys and values for prior tokens…
 ───────────────────────────────────────────────────────────────────────────────
 > _
 Enter Send · Ctrl+J New line · ↑ Draft history (session only) · ? Help
 3 turns · context window sends latest 20 messages · memory ✓
```

At 60–99 columns the evidence pane becomes an `Enter` detail overlay; no field is
silently discarded. Accessible mode renders the same information as numbered
sections and prompts rather than this cursor-addressed layout.

---

## 3. Mode selection and CLI contract

### 3.1 Global flags

| Flag           | Contract                                                                                       |
| -------------- | ---------------------------------------------------------------------------------------------- |
| `--tui`        | Request TUI; fail before domain work if incompatible rather than silently changing output mode |
| `--no-tui`     | Force existing plain output and noninteractive argument requirements                           |
| `--accessible` | Linear, low-motion, no live-region rewrite; verbose labels and ASCII-safe status text          |
| `--no-color`   | Disable color while retaining layout; `NO_COLOR` has the same effect                           |

`--yes` is a shared **command option**, not global: only `down` and
`migrate --move` register it. Every other command—including `migrate` without
`--move`—rejects it at parse/validation time.

Precedence:

1. `--json` or another machine-readable mode forces JSON/plain and conflicts with
   `--tui` as a validation error.
2. `--no-tui` forces plain.
3. Noninteractive/unsupported environment forces plain unless `--tui`, which
   fails before command side effects with a useful reason.
4. Otherwise, TUI is the default.

`--accessible` implies no spinner frames, no cursor-dependent selection, no
color, and a line-oriented interaction strategy. It does not
change domain results.

Normative mode table:

| Inputs                                                                          | Outcome                                          |
| ------------------------------------------------------------------------------- | ------------------------------------------------ |
| `--json` alone                                                                  | JSON                                             |
| `--json` + `--tui` or `--accessible`                                            | validation failure before domain work            |
| `--no-tui` alone                                                                | plain                                            |
| `--no-tui` + `--tui` or `--accessible`                                          | validation failure                               |
| `--accessible` (optionally with `--tui`) + full TTY + >=40x10 + non-CI/non-dumb | accessible interactive                           |
| `--accessible` with pipe/redirect/CI/dumb/undersize                             | validation failure; use plain `--no-tui` instead |
| `--tui` + full eligibility                                                      | TUI                                              |
| `--tui` + any incompatibility                                                   | validation failure with stable reason code       |
| no mode flag + full eligibility                                                 | TUI                                              |
| no mode flag + any incompatibility                                              | plain, no fallback notice                        |

`--no-color`/`NO_COLOR` modify TUI or accessible styling but not mode. Accessible
interactive mode never enables raw mode, hides the cursor, or incrementally
rewrites frames. It uses canonical/cooked stdin, numbered options, ordinary
submitted lines, and line-oriented progress. EOF cancels before work or requests
normal command cancellation during work.

### 3.2 Eligibility predicate

Visual auto-TUI requires all of:

- `process.stdin.isTTY === true`;
- `process.stdout.isTTY === true`;
- `process.stderr.isTTY === true`;
- `TERM` exists and is not `dumb`;
- terminal width >= 60 columns and height >= 16 rows;
- no JSON flag, piped command input, or CI marker;
- TUI renderer loaded successfully.

Any absent/false value means plain mode. CI uses the same fixed marker allowlist
as the telemetry spec but does not read or emit telemetry state. `FORCE_COLOR`
does not force TUI. `NO_COLOR` changes color only.

Accessible interactive mode uses a separate explicit predicate: all three
streams are TTYs, terminal is non-CI/non-dumb, and dimensions are >=40x10. It is
exempt from visual TUI's 60x16 layout threshold and never uses visual raw-mode
components.

### 3.3 Positional and option behavior

Interactive-only omission is additive:

```text
local-llmup can-run [model]
local-llmup up [model]
local-llmup switch [model]
local-llmup migrate [--from <model>] [--to <model>]
```

- In TUI mode, omitted values open bounded offline pickers.
- In plain/JSON/noninteractive mode, existing required-value errors remain.
- Explicit arguments are shown for review but not reselected unless the user
  chooses Back before work begins.
- Ambiguous explicit model strings still use the existing resolver/error contract;
  the TUI does not guess.
- `--yes` is accepted only by `down`, `migrate --move`, and any future explicitly
  documented destructive action.

### 3.4 Output and exit compatibility

- JSON stdout is unchanged and contains no ANSI.
- Piped chat input and redirected output use the existing line-oriented mode.
- TUI dynamic frames write to stderr; final command result writes once to stdout
  in the existing plain shape after unmount, unless the command already defines
  an interactive chat transcript on stdout.
- Diagnostics remain stderr.
- Exit codes remain command-defined: e.g. `can-run no` and failed `doctor` remain
  nonzero even if the TUI rendered successfully.
- Cancel before domain work exits 130 with no mutation. Ctrl+C after work begins
  follows command-specific cancellation/cleanup and exits 130 only after cleanup.
- Terminal-renderer failure never converts product success to failure after a
  committed operation; it restores the terminal, emits the final plain summary,
  and records a sanitized UI warning on stderr.

---

## 4. Shared interaction model

### 4.1 Keyboard map

| Key                   | Meaning                                       |
| --------------------- | --------------------------------------------- |
| `↑` / `k`, `↓` / `j`  | Move selection                                |
| `PageUp` / `PageDown` | Move one viewport                             |
| `Home` / `End`        | First/last item                               |
| `/`                   | Focus search/filter                           |
| `Enter`               | Inspect/accept current non-destructive choice |
| `Space`               | Toggle a checkbox where documented            |
| `Tab` / `Shift+Tab`   | Move between explicit controls/panes          |
| `Esc`                 | Back/close/cancel before work                 |
| `?`                   | Toggle full key help                          |
| `q`                   | Quit a read-only completed screen             |
| `Ctrl+C`              | Request cancellation and terminal restoration |

No single-letter shortcut performs an irreversible operation. Key handling is
ignored while focus is in a text editor except documented editor commands.

### 4.2 Lists and search

- Search is case-insensitive over sanitized canonical ids/families only.
- Filtering is local, deterministic, and never triggers hardware/network probes.
- Lists virtualize to visible rows plus a small overscan; catalog size cannot
  create unbounded frames.
- Selection is keyed by stable model id, not row index, so resize/filter does not
  silently switch target.
- `Space` marks up to four models; the footer shows `Compare (n/4)`. `c` opens a
  dedicated comparison screen with models as columns and sourced evidence rows.
  Marking is available only on model-list screens, never overloaded elsewhere.
- Empty results show the active filter and a clear reset key.
- Sorting uses existing domain ordering unless a visible user-selected sort is
  applied; the chosen sort is not persisted.

### 4.3 Progress

Progress events use a strict discriminated union:

```ts
export type UiProgressEvent =
  | { readonly type: "phase_started"; readonly phase: UiPhase; readonly label: string }
  | {
      readonly type: "progress";
      readonly phase: UiPhase;
      readonly completed: number;
      readonly total: number | null;
      readonly unit: "bytes" | "items";
    }
  | {
      readonly type: "message";
      readonly phase: UiPhase;
      readonly level: "info" | "warn";
      readonly text: string;
    }
  | { readonly type: "phase_completed"; readonly phase: UiPhase; readonly detail?: string }
  | {
      readonly type: "phase_failed";
      readonly phase: UiPhase;
      readonly code: UiErrorCode;
      readonly detail: string;
    };
```

All fields are bounded and sanitized at construction. Events are advisory
presentation data; domain state is authoritative. The presenter coalesces frequent
progress to <=30 frames/second and retains at most 200 messages/50 KiB. Final
phase transitions are never dropped.

Progress counts are finite nonnegative safe integers. A known total is positive,
`completed <= total`, and cannot change within one phase; an unknown total is
null and may become one fixed known total once. Phase transitions form a strict
started → zero-or-more progress/message → completed-or-failed state machine with
no duplicate terminal event. Labels/details use the context-specific text bounds
in §7.4. Invalid or out-of-order events are rejected at the controller boundary,
not rendered.

### 4.4 Confirmation

A confirmation includes:

- action verb;
- canonical target model/store;
- owned/attached server effect where relevant;
- whether source memory is deleted;
- default-focused Cancel and explicit Confirm;
- `--yes` bypass disclosure in the footer when active.

Typed target-name confirmation is not required because commands operate only on
local model state, but exact target identity must remain visible.

---

## 5. Command-specific experiences

### 5.1 `recommend` (default command)

**Screen:** ranked model explorer.

- Header: platform/architecture, usable RAM or VRAM, task/context/backend scope.
- Main list: rank, model, params, quant, estimated memory, verdict, tok/s,
  backends, score.
- Detail pane: capabilities, license, context evidence, fit explanation,
  throughput source, and honesty-gated unknown reasons.
- Filters: search, capability, verdict, backend availability; flags initialize
  filters and remain authoritative.
- Compare up to four models across verdict, selected quant, weights/KV/total
  memory, throughput range/source, max context/bound-by, capabilities, license,
  compatible backends, and score-component explanation. Unknown is never ranked
  as zero or highlighted as best.
- `Enter` opens details. It does **not** run `up` or probe a runtime.
- `p` exits and prints the exact sanitized `local-llmup up <id>` next command;
  it does not access the clipboard.
- Won't-fit models are a separate view and never disappear silently.
- Underlying ranking/order/data are exactly `RecommendationResult`.

### 5.2 `can-run`

**Screen:** model picker when omitted, then verdict/evidence card.

- Shows yes/slow/no in text and symbol, not color alone.
- Shows quant, binding reason, backend compatibility, and throughput source/range.
- A `no` verdict still exits nonzero.
- No shortcut starts a model; footer prints the next command only for yes/slow.

### 5.3 `doctor`

**Screen:** diagnostics dashboard.

- Checks render as OK/WARN/FAIL rows with detail and remediation command.
- Backend table, version, install state, and default runtime are separate.
- Hardware score and primary bottleneck appear only when sourced.
- Probes run once exactly as today; expanding a row does not rerun it.
- Exit is nonzero iff the report contains FAIL.
- No “fix” action executes commands; suggested commands are text.

### 5.4 `catalog`

**Screen:** searchable catalog browser.

- Default fit filter and `--all` semantics remain unchanged.
- Search/filter by id, family, capability, architecture, fit, release year.
- Detail includes quantizations, memory needs, sources, license, context, and
  supported backends from offline data.
- `--refresh` first shows a staged dry-run phase, then a diff view and catalog;
  it never writes the catalog.
- No action pulls or serves a model.

### 5.5 `up`

**Screen:** optional model picker/review followed by lifecycle progress.

Stages are fixed and map to existing orchestration:

```text
resolve → hardware/disk preflight → backend selection → acquire/verify
→ prior-owned cleanup → serve/attach → readiness → state commit
```

- Review screen shows model, quant, backend precedence result, disk requirement,
  selected port, and loopback host.
- Explicit requested-quant fit warnings require Continue/Cancel unless `--yes` is
  later approved for this non-destructive warning; v1 does not use `--yes` here.
- Pull shows sourced bytes/total when available; otherwise indeterminate status.
- Integrity result remains visible before serve starts.
- Ctrl+C propagates cancellation only where backend contracts support it and then
  runs ownership-safe cleanup. It never signals by name/port alone.
- Final stdout remains `<model> ready at <endpoint>`.

### 5.6 `chat`

**Screen:** bounded conversation viewport + input editor + status footer.

- TUI requires interactive stdin. Piped input preserves existing mode.
- Header shows canonical model/backend and loopback endpoint without PID/path.
- Multiline editor: Enter sends; Ctrl+J inserts newline; Alt+Enter is an optional
  alias only where the terminal distinguishes it. Empty messages do nothing;
  Ctrl+C on empty draft exits, otherwise first requests clear/cancel explicitly.
- Draft/submission hard limits are 32 KiB UTF-8, 8,192 grapheme clusters, and 256
  lines. Paste/input is counted incrementally; crossing any limit blocks submit
  with a visible error before backend or memory calls. Domain chat validates the
  same limits independently of UI.
- While awaiting a non-streaming adapter response, show request-in-progress; do
  not fake token streaming. Future real streaming requires an adapter contract.
- Adapter response ingestion is capped at the backend's existing decoded-body
  limit and additionally rejects content above 1 MiB UTF-8 before memory capture;
  display truncation is never the only protection. Display visibly escapes unsafe
  code points through `sanitizeTerminalText()` without prior destructive
  sanitization and bounds visible message bytes/lines. Only a
  bounded recent viewport is held by UI; memory capture remains authoritative.
- Memory-capture failure is a visible warning but does not terminate healthy chat,
  matching current behavior.
- Automatic TUI intentionally emits no assistant transcript to stdout while the
  session runs; dynamic conversation is on the TUI stream and exit writes one
  compact `Chat session ended: <turns> turn(s), <warnings> memory warning(s).`
  summary. `chat --no-tui` and piped/redirected chat preserve the existing
  assistant-reply stdout transcript byte-for-byte. This interactive-only stdout
  change is versioned/documented and does not affect scripting paths.

### 5.7 `ls`

**Screen:** compact active-server status card.

- Shows model, backend, endpoint, port, and owned/attached.
- Reads state only; does not add reachability/process probes.
- Empty state provides exact next command.
- Auto-exits after rendering the static summary unless `--tui` was explicit; an
  explicit TUI remains until `q`/Esc so details can be inspected.

### 5.8 `switch`

**Screen:** target picker/review + preparation progress.

- Picker excludes or disables current model and explains single-model backend
  restrictions before work.
- Shows current → target, backend, endpoint, and whether pull preparation is
  required.
- Preparation and state-race semantics remain exactly as existing command logic.
- Final output remains `Switched to <model> (<endpoint>).`
- No destructive confirmation is required; Esc is available before pull starts.

### 5.9 `down`

**Screen:** ownership-aware confirmation + stop/detach progress.

- Shows exact active model/endpoint and `owned` or `attached` behavior.
- Owned: “stop verified local-llmup process and clear state.”
- Attached: “leave runtime running and forget local state.”
- Default is Cancel. `--yes` bypasses confirmation.
- If no active server, show existing no-op summary and exit 0 without prompt.
- State rollback and ownership-safe stop semantics are unchanged.

### 5.10 `migrate`

**Screen:** source picker → target picker → plan → confirmation/progress → summary.

- Source picker includes only stores with readable local memory.
- Target picker uses canonical catalog ids and excludes source/same-store aliases.
- `buildMigrationPreview()` is pure/read-only: it shows source counts, predicted
  carry/summarize counts, proposed embedding/context strategy, runtime-request
  disclosure, move/dry-run intent, source snapshot, target present/absent snapshot,
  and whether existing target memory will be replaced. It contains no
  generated summary/vector payload and makes no backend request.
- Existing target memory requires explicit confirmation in TUI mode even without
  `--move`. In noninteractive plain mode, the explicitly supplied `--to` retains
  today's overwrite authorization contract and does not prompt; source/target
  snapshot revalidation still prevents concurrent unseen drift.
- After acceptance, revalidate both source and target snapshots, then
  `materializeMigrationPlan()` performs any approved target-model summarization/
  embedding and returns the existing concrete `MigrationPlan`.
- Before target commit under the product lock, revalidate source and target
  identities again; either drift discards staged/materialized output and returns
  to a fresh preview rather than overwriting changed data.
- `--dry-run` may materialize after the review (preserving the existing disclosed
  target-model request behavior), prints the concrete summary, and never enters
  commit confirmation/write.
- `--move` shows source deletion prominently and requires confirmation unless
  `--yes`; non-move migration requires a normal Continue action when arguments
  were selected interactively.
- No lock is held while choosing/reviewing. Existing atomic write and source
  preservation rules remain authoritative.

### 5.11 `benchmark` (after benchmark command approval/implementation)

**Screen:** immutable configuration review → lifecycle timeline → live metric
samples → aggregate evidence.

- No animation/progress enters measured intervals unless the approved benchmark
  protocol explicitly accounts for it; renderer updates are paused or isolated
  while timing-sensitive samples execute.
- U4 requires a benchmark-owned `enterMeasurementQuietWindow()` barrier invoked
  and awaited before the benchmark starts its monotonic request timer, plus
  `leaveMeasurementQuietWindow()` only after the terminal measurement timestamp.
  Entering flushes pending UI frames, pauses scheduler/progress rendering, and
  acknowledges quiescence; raw samples/events are buffered under existing caps.
  Generic `UiProgressEvent` phase changes are insufficient and cannot open/close
  this gate. Timing tests prove no renderer callback executes inside the measured
  interval.
- Shows TTFT, prefill, decode, sampled process memory, integrity, containment, and
  unknown reasons exactly from `BenchmarkResultV1`.
- Active-mode request-binding limitations and baseline incomparability remain
  visible.
- JSON, baseline exit 2, cleanup, and real-runtime evidence contracts remain
  unchanged.

### 5.12 `telemetry` (after telemetry command approval/implementation)

**Screen:** local status/control only.

- Shows configured/effective state, suppression reason, install-id presence (never
  the id), outbox count, policy URL, and retention summary.
- `on` displays the approved disclosure before confirmation.
- `off` displays local deletion and server-retention limits, defaults Cancel, then
  uses the approved delivery lease/deletion contract.
- Never emits a telemetry event or network request.

### 5.13 Help and version

`--help`, `<command> --help`, and `--version` remain immediate plain output. They
are not TUIs and never initialize raw mode.

---

## 6. Presentation architecture

### 6.1 Domain/presenter separation

Ink components never invoke command dependencies. A command-specific application
controller owns the interaction/use-case sequence:

```text
parse options
  → build bounded offline choices
  → resolve omitted intent through UiDriver
  → prepare immutable evidence/snapshot
  → render review and obtain typed decision
  → execute domain use case with signal/progress
  → locked authoritative snapshot revalidation where required
  → render typed outcome and existing final formatter
```

Normative contracts:

```ts
export type UiMode = "plain" | "json" | "tui" | "accessible";

export type UiDecision<T> =
  { readonly type: "accepted"; readonly value: T } | { readonly type: "cancelled" };

export type UiReviewDecision =
  { readonly type: "accepted" } | { readonly type: "back" } | { readonly type: "cancelled" };

export interface UiChoiceRequest<T extends { readonly id: string }> {
  readonly title: string;
  readonly items: readonly T[];
  readonly initialId: string | null;
}

export interface UiReviewRequest {
  readonly screen: "up" | "switch" | "down" | "migrate" | "telemetry";
  readonly viewModel: ReviewViewModel;
}

export interface CommandViewModelMap {
  readonly recommend: RecommendViewModel;
  readonly canRun: CanRunViewModel;
  readonly doctor: DoctorViewModel;
  readonly catalog: CatalogViewModel;
  readonly up: UpViewModel;
  readonly chat: ChatViewModel;
  readonly ls: LsViewModel;
  readonly switch: SwitchViewModel;
  readonly down: DownViewModel;
  readonly migrate: MigrateViewModel;
  readonly benchmark: BenchmarkViewModel;
  readonly telemetry: TelemetryViewModel;
}

export interface UiDriver {
  readonly mode: UiMode;
  choose<T extends { readonly id: string }>(
    request: UiChoiceRequest<T>,
  ): Promise<UiDecision<{ readonly id: string }>>;
  review(request: UiReviewRequest): Promise<UiReviewDecision>;
  readonly emit: (event: UiProgressEvent) => void;
  complete<K extends keyof CommandViewModelMap>(
    screen: K,
    viewModel: CommandViewModelMap[K],
  ): Promise<void>;
  fail(error: Error): Promise<void>;
}

export interface ExecutionContext {
  readonly signal: AbortSignal;
  readonly emit: (event: UiProgressEvent) => void;
}

export interface InteractiveCommandController<Options, Intent, Prepared, Result> {
  resolveIntent(options: Options, ui: UiDriver): Promise<UiDecision<Intent>>;
  prepare(intent: Intent, context: ExecutionContext): Promise<Prepared>;
  review(prepared: Prepared, ui: UiDriver): Promise<UiReviewDecision>;
  execute(prepared: Prepared, context: ExecutionContext): Promise<Result>;
}

export interface TerminalCapabilities {
  readonly stdinTty: boolean;
  readonly stdoutTty: boolean;
  readonly stderrTty: boolean;
  readonly columns: number;
  readonly rows: number;
  readonly colorDepth: 1 | 4 | 8 | 24;
  readonly unicode: boolean;
  readonly ci: boolean;
  readonly term: string | null;
}
```

`UiDriver` returns only stable validated ids and accept/back/cancel decisions; it
never returns a prepared object and cannot access
backend, state, filesystem, or command dependency objects. Controllers call
domain modules. Plain mode supplies a noninteractive driver that resolves only
already-present arguments and never prompts. Read-only commands may use a
simplified build-result controller but still return typed results.

`Prepared` objects are immutable and include all displayed evidence plus a
confirmation snapshot where state can race. Execution must not trust mutable
display text and receives the original controller-held `Prepared`. Back loops to
intent resolution and rebuilds preparation; future editable review fields require
a dedicated validated amendment DTO followed by full re-prepare. Existing pure
formatters remain the plain/JSON contract.

### 6.2 Confirmation snapshots and locked revalidation

```ts
export interface ConfirmationSnapshot {
  readonly operation: "down" | "detach" | "migrate" | "migrate_move" | "replace_server";
  readonly canonicalTargetIds: readonly string[];
  readonly backend: BackendName | null;
  readonly endpoint: string | null;
  readonly ownedByUs: boolean | null;
  readonly processIdentityHash: string | null;
  readonly stateRevisionHash: string;
  readonly sourceStoreIdentityHash: string | null;
  readonly targetStoreIdentityHash: string | null;
}
```

The UI displays a view derived from this snapshot. After confirmation and after
acquiring the product lock, the controller re-reads authoritative state/store
metadata and requires exact snapshot equality before any mutation/signal. Drift
releases the lock and returns to a fresh review; `--yes` fails closed instead of
automatically approving a changed target. Tests race `up`, `down`, `switch`, and
`migrate --move` at every confirmation/lock boundary.

All identity hashes use SHA-256 lowercase hex over UTF-8 RFC 8785 canonical JSON;
each object is strict/Zod-validated before hashing and the hash field itself is
excluded:

- `stateRevisionHash`: complete `RuntimeState` including schema version and every
  active backend/model/endpoint/port/ownership/PID/executable/start field, with
  absent optional values represented as null in the canonical hash object.
- `processIdentityHash`: canonical backend, parsed loopback host/port, PID,
  owned/attached status, canonical executable identity, and process-start
  identity. Before a signal, the command must additionally rerun live listener/
  process/backend identity verification; equal stored fields alone are not proof.
- `sourceStoreIdentityHash`: complete strict validated source-memory logical
  object loaded through the existing descriptor-safe boundary—ordered
  conversation turns, system prompt, facts, metadata, embedding model/dimension,
  source chunks, and vector values. Paths, mtimes, inode numbers, and directory
  iteration order are excluded. Missing optional logical files become explicit
  null/empty schema values. Revalidation reopens/reloads under the same safety
  rules and recomputes the logical hash.
- `targetStoreIdentityHash`: the same logical-store hash when target memory
  exists. An absent target uses SHA-256 of canonical `{status:"absent"}`; null is
  allowed only for operations with no target store. The preview states whether
  existing target memory will be atomically replaced.

Snapshots are first captured after prepare and before review. State/process is
revalidated immediately after lock acquisition and immediately before signaling;
both migration source and target are revalidated before materialization and again
under the commit lock immediately before rename. Hashing uses bounded existing state/memory schemas; overflow or unsafe files
fail closed instead of producing a partial hash.

### 6.3 TUI modules

```text
src/tui/
  capabilities.ts    Mode eligibility and color/unicode policy
  session.ts         Lazy renderer mount/unmount, terminal restoration
  presenter.ts       Progress bridge and final-result handoff
  theme.ts           Semantic tokens only
  keys.ts            Shared keyboard map
  sanitize.ts        Bounded terminal-safe text helpers
  components/
    app-frame.tsx
    header.tsx
    footer.tsx
    list.tsx
    detail-pane.tsx
    status.tsx
    progress.tsx
    confirm.tsx
    text-input.tsx
    error-boundary.tsx
  screens/
    recommend.tsx
    can-run.tsx
    doctor.tsx
    catalog.tsx
    up.tsx
    chat.tsx
    ls.tsx
    switch.tsx
    down.tsx
    migrate.tsx
    benchmark.tsx     Added only with benchmark implementation
    telemetry.tsx     Added only with telemetry implementation
```

Command-specific screens consume typed view models, not command dependency bags.
One screen per file; shared behavior is composed from focused components.

### 6.4 Dependency decision

Proposed exact dependencies (verified against npm registry metadata on
2026-08-08):

- runtime `ink@5.2.1` (MIT, ESM, `engines.node >=18`, React peer `>=18`);
- runtime `react@18.3.1` (MIT);
- runtime `string-width@7.2.0` (MIT, ESM, `engines.node >=18`);
- development `@types/react@18.3.12`.

The lockfile pins Ink's complete dependency/peer graph; U0 explicitly reviews
the `react-devtools-core` peer and `yoga-layout` artifact before acceptance. Ink
rendering uses injected streams and disables console patching so command output
cannot be captured or reordered by the renderer.

Before approval is implemented, a dependency spike must verify:

- Node 18/20/22/24 compatibility on macOS/Linux/Windows;
- ESM + `tsc` without bundling and `jsx: react-jsx`;
- custom stdin/stdout/stderr streams, incremental rendering, raw-mode cleanup;
- license, provenance, lockfile, vulnerability, install-size, and cold-start impact;
- no postinstall scripts or native binaries in the accepted dependency graph.

If these exact versions fail review or become unsupported before implementation,
work stops for a new approval; it does not upgrade dependencies, raise the Node
minimum, or introduce a custom renderer silently. Ink is lazy-imported only in
eligible TUI mode so plain/JSON cold start and dependency evaluation remain
isolated.

### 6.5 View models

Every screen receives a strict, immutable view model built from domain results.
View-model builders:

- sanitize/bound all strings once;
- preserve raw enum/id values separately from display labels;
- use stable ids for list keys;
- never include paths, prompts beyond the current chat viewport, process handles,
  secrets, or arbitrary backend payloads;
- never convert unknown to a number;
- are pure and snapshot-testable.

### 6.6 Command result and preparation inventory

Controllers build these additive immutable application DTOs; screens never parse
plain output or recompute domain facts:

| Command   | Preparation/result contract                                                                                                                                                                                                                                                                                            |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| recommend | Existing `RecommendationResult` plus per-entry score components, fit evidence, throughput provenance/unknown code, and context provenance sourced from advisor outputs                                                                                                                                                 |
| can-run   | Existing `CanRunResult` plus fit evidence and throughput provenance/unknown code                                                                                                                                                                                                                                       |
| doctor    | Existing `DoctorReport` unchanged; remediation command is a sanitized explicit field, not parsed from detail text                                                                                                                                                                                                      |
| catalog   | New `CatalogResult` containing refresh diff, hardware summary, ordered rows, fit evidence, and empty-state reason                                                                                                                                                                                                      |
| up        | `UpPrepared` contains resolved model/quant/hardware fit/backend precedence/disk/port/prior-state snapshot; `UpResult` contains canonical model/backend/endpoint/ownership/integrity                                                                                                                                    |
| chat      | `ChatPrepared` contains active canonical model/backend/endpoint identity; `ChatSessionResult` contains turn count and memory-warning count only                                                                                                                                                                        |
| ls        | New `LsResult` discriminated as empty or active with existing state fields; no probe fields                                                                                                                                                                                                                            |
| switch    | `SwitchPrepared` contains current/target/server snapshot and backend restriction; `SwitchResult` contains target/endpoint/no-op                                                                                                                                                                                        |
| down      | `DownPrepared` contains confirmation snapshot and stop-vs-detach consequence; `DownResult` contains no-op/stopped/detached                                                                                                                                                                                             |
| migrate   | Pure `MigrationPreview` contains canonical stores, predicted counts/strategies, runtime-request disclosure, move/dry-run, source snapshot, target absent/present snapshot, and replacement disclosure; post-acceptance `MigrationPlan` contains actual summary/vector material; typed completion summary is the result |

If required provenance is absent today, the producing advisor/domain function is
extended additively to return it. The UI may not reverse-engineer provenance from
formatted labels, duplicate formulas, or invent a reason. Each result has one
plain formatter and one view-model builder fed by the same object.

After `execute()`, the controller calls a pure command-specific
`build<Command>ViewModel(result)` and passes only the mapped value to
`UiDriver.complete(screen, viewModel)`. The driver cannot accept arbitrary domain
results. Review view models are separately built from `Prepared`; they contain
display values plus opaque snapshot hash labels, never mutable command resources.

---

## 7. Terminal safety and lifecycle

### 7.1 Terminal ownership

A `TuiSession` owns only terminal presentation resources:

- raw-mode enable/disable;
- cursor hide/show;
- renderer listeners and resize subscription;
- transient frame region;
- one AbortController for UI cancellation.

It does not own runtime/server processes. Product cleanup remains in command and
backend layers.

### 7.2 Command cancellation contract

Every asynchronous controller receives one caller `AbortSignal` and forwards it
to hardware/runtime/network/filesystem operations that support cancellation,
including backend pull, serve, readiness, chat, embed, and summarization calls.
Adapters remain responsible for bounded socket/process cleanup.

```ts
export type CommandEffect =
  | "unchanged"
  | "artifact_cached_state_unchanged"
  | "spawned_process_cleaned"
  | "prior_server_stopped_replacement_not_started"
  | "state_rollback_attempted"
  | "state_committed"
  | "target_committed_source_retained"
  | "fully_completed";

export type CommandTermination =
  | {
      readonly type: "success";
      readonly phase: UiPhase;
      readonly effect: "unchanged" | "state_committed" | "fully_completed";
    }
  | {
      readonly type: "cancelled";
      readonly phase: UiPhase;
      readonly effect: "unchanged" | "artifact_cached_state_unchanged" | "spawned_process_cleaned";
    }
  | {
      readonly type: "partial";
      readonly phase: UiPhase;
      readonly effect:
        | "prior_server_stopped_replacement_not_started"
        | "state_rollback_attempted"
        | "target_committed_source_retained";
      readonly remediation: string;
    }
  | {
      readonly type: "failed";
      readonly phase: UiPhase;
      readonly effect: CommandEffect;
      readonly code: UiErrorCode;
    };
```

Rules:

- First Ctrl+C/SIGINT aborts the signal, changes the footer to “Cancelling…”, and
  waits for product cleanup. Repeated Ctrl+C never bypasses ownership checks or
  calls `process.exit()`; it only repeats the bounded cleanup status.
- SIGTERM and SIGHUP use the same ownership-safe domain cancellation/cleanup path.
  Successful pre-commit cancellation exits 130 for SIGINT, 143 for SIGTERM, or
  129 for SIGHUP. No signal restores the terminal without also notifying active
  domain work.
- Cleanup failure has precedence over cancellation and exits 1 with the cleanup
  error; a cancellation message is retained as context.
- After an irreversible effect, cancellation never rewrites history. The
  controller returns the exact `CommandTermination` effect and a sanitized
  remediation for partial completion; it does not collapse partial work into
  generic success.
- Synchronous/read-only phases that cannot abort finish their current bounded
  operation, observe the signal before the next phase, and perform no later side
  effect.
- Each controller execution has a monotonically increasing local generation id;
  progress emitted after abort, unmount, or a newer generation is discarded.

Command phases are explicit:

- read-only: resolve/detect/build/render-result;
- up: resolve, preflight, select-backend, acquire, verify, prior-cleanup, serve,
  readiness, state-commit;
- switch: resolve, prepare, readiness, locked-revalidate, state-commit;
- down: review, locked-revalidate, state-clear, stop/detach, rollback;
- migrate: load, plan, review, summarize/embed, locked-revalidate, stage, commit,
  optional-source-delete;
- chat: read-draft, request, display, memory-capture.

`UiPhase` is the union of these stable kebab-case values. `UiErrorCode` reuses
typed command error categories (`validation`, `backend`, `integrity`, `timeout`,
`cancelled`, `state-race`, `filesystem`, `render`, `unknown`) and never contains
raw error text.

Side-effect/compensation matrix:

| Command boundary                                                     | Cancellation/failure effect and exit                                                                                   |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| read-only or before mutation                                         | `unchanged`; signal exit 129/130/143 after cleanup                                                                     |
| up during acquisition                                                | verified cache artifact may remain: `artifact_cached_state_unchanged`; 129/130/143                                     |
| up after new spawn but before state commit, no prior server stopped  | stop verified new process: `spawned_process_cleaned`; 129/130/143 if cleanup passes                                    |
| up after prior owned server is stopped and replacement fails/cancels | `prior_server_stopped_replacement_not_started`; exit 1 with rerun-`up` remediation                                     |
| up after replacement state commit                                    | `state_committed`; finish success summary even if signal arrived late                                                  |
| switch before state commit                                           | pulled artifact may remain, active state unchanged; 129/130/143                                                        |
| switch after state commit                                            | `state_committed`; success summary                                                                                     |
| down after state clear but stop failure                              | existing rollback is attempted and reported as `state_rollback_attempted`; exit 1, never claim unchanged process state |
| down after verified stop/detach                                      | `state_committed`; success summary                                                                                     |
| migrate before target rename                                         | staged output removed, source/target unchanged; 129/130/143                                                            |
| migrate after target rename but before `--move` source deletion      | `target_committed_source_retained`; exit 129/130/143 with “target valid; source retained” summary                      |
| migrate after source deletion                                        | `fully_completed`; success summary                                                                                     |
| chat after reply but before failed/cancelled capture                 | emit a nonterminal memory warning; session remains usable or exits 130 if the user cancels                             |

No compensation attempts to resurrect a stopped process or delete a valid target
solely to make a cancellation look atomic. Cleanup/rollback failure still takes
precedence and exits 1.

### 7.3 Restoration

Restore cursor, raw mode, stdin pause state, and listeners on:

- success, error, cancellation, and user quit;
- component/render failure;
- SIGINT, SIGTERM, SIGHUP where supported;
- rejected promise and CLI action error;
- terminal resize below minimum.

Restoration is idempotent and runs in `finally`. Signal handlers preserve expected
exit semantics (129 for SIGHUP, 130 for SIGINT, 143 for SIGTERM) after product cleanup. Never call
`process.exit()` before restoration/cleanup; set exit code or re-raise safely.

### 7.4 Untrusted content

- TUI view models use a new pure `sanitizeTerminalText(value, context)` before
  every text node. It scans original code points first and visibly escapes unsafe
  values before any normalization; it does **not** call destructive
  `stripControl()`. Existing plain/JSON formatters keep their current sanitizer
  and compatibility contract.
- Text contexts are typed as `action_identifier`, `single_line`, or `multiline`.
  Only chat bubbles and bounded detail prose accept multiline text. Every other
  context replaces CR/LF with visible `\\n` markers so content cannot forge rows,
  warnings, confirmation controls, or footer actions.
- Action identifiers must pass their existing ASCII domain allowlist (model ids,
  backend enums, loopback endpoints). A non-ASCII/invalid identifier is never
  actionable and is shown only as deterministic `\\u{HEX}` escaped code points.
  Confirmation shows the exact canonical ASCII id beside any friendly label.
- Prose is NFC-normalized for display after unsafe values are escaped. Bidi controls,
  zero-width/default-ignorable characters, and unpaired surrogates are replaced
  by visible escaped code points rather than silently removed. Identity matching
  always uses the original validated canonical value, never normalized display.
- In multiline prose, CRLF/CR normalize to LF; LF is preserved. Tab becomes two
  spaces. ESC, C0/C1 controls other than normalized LF, OSC introducers,
  bidi/default-ignorable characters, NUL, and invalid surrogates become literal
  ASCII `\\u{HEX}` text. The sanitizer output itself is asserted to contain no
  terminal-control code point.
- Bound cell 256 bytes, detail 8 KiB, chat visible message 64 KiB, frame 256 KiB,
  and retained UI messages 50 KiB.
- Normalize CR/LF and reject terminal escape, OSC, bidi override/isolate controls,
  NUL, and unsafe C0/C1 controls. Preserve ordinary Unicode where supported.
- Every byte limit is `Buffer.byteLength(value, "utf8")`. Grapheme iteration uses
  Node 18's `Intl.Segmenter("en", {granularity:"grapheme"})`; terminal-cell width
  uses direct dependency `string-width@7.2.0` with ambiguous-width treated as
  narrow. Truncate only between grapheme segments and append a width-accounted
  ellipsis. U0 verifies Node/platform consistency with Unicode fixture vectors.
- No untrusted string becomes a key binding, style token, terminal title, URL,
  format string, or command executed by the UI.

### 7.5 Resize and unsupported terminals

- Recompute layout on resize with a 50 ms debounce.
- > =100 columns: list + detail pane.
- 60–99 columns: single pane with detail overlay.
- Below 60x16 before visual work: auto mode falls back to plain and explicit
  visual `--tui` errors. Accessible mode uses its separate 40x10 minimum.
- Below minimum during work: freeze animation, restore terminal, continue domain
  work with plain progress/final output; never rerun or cancel solely due to size.
- Windows ConPTY, common POSIX terminals, and tmux are supported only after smoke
  evidence. Unknown capability uses conservative ASCII/no-color behavior.

---

## 8. Accessibility

- Keyboard-only complete; no mouse requirement.
- Status always uses text plus symbol; never color alone.
- Respect `NO_COLOR` and `--no-color`.
- `--accessible` disables live rewrites/spinners, prints one line per phase, uses
  explicit labels, keeps cursor visible, and supports line-number + typed-number
  selection instead of cursor-only navigation.
- Motion is limited to max 10 spinner frames/second (30 fps is a renderer cap,
  not required animation). Accessible mode uses no animation.
- Focus is explicit in header/footer text; dialogs announce action and default.
- Help lists every key in plain language.
- Truncation always has an inspect/full-detail route within bounded limits.
- Emoji are optional decoration; ASCII labels remain complete.
- Errors include remediation, preserve exit semantics, and never disappear on a
  timed toast.

---

## 9. Performance budgets

Measured on supported Node versions with a fake domain command:

| Budget                             | Requirement                                                    |
| ---------------------------------- | -------------------------------------------------------------- |
| Plain/JSON cold-start regression   | <=10 ms median and <=20 ms p90 versus pre-TUI baseline         |
| Eligible TUI module load           | <=150 ms p90                                                   |
| First frame after result available | <=100 ms p90                                                   |
| Key-to-frame latency               | <=50 ms p90 with 1,000 list rows                               |
| Frame rate                         | <=30 fps; no busy loop                                         |
| Retained UI memory                 | <=25 MiB above plain mode for 1,000 rows / 200 progress events |
| Final frame bytes                  | <=256 KiB                                                      |
| npm tarball increase               | hard gate <=250 KiB                                            |
| production install increase        | hard gate <=15 MiB                                             |

Performance tests use injected clocks/streams and fixed fixtures. A release smoke
records real cold start and interaction traces. TUI rendering is paused during
benchmark measurement intervals and excluded from offline advice calculations.
Tarball delta compares `npm pack --json --dry-run` packed bytes from clean pre-TUI
and candidate commits using their committed lockfiles. Install delta compares
fresh same-platform `npm ci --omit=dev --ignore-scripts` trees with empty npm
caches and filesystem byte counts; CI records each OS separately and all must
pass. No variance above the hard limits is accepted without a spec revision.

---

## 10. Data, backend, and domain boundaries

- No changes to `data/models.json` or `data/perf.json` formats.
- TUI filters do not modify ranking weights or advice.
- Advice remains offline; `--available-backends` remains the only explicit
  recommendation installation probe.
- Backend logic stays behind `BackendAdapter`; UI receives progress/results only.
- Integrity checks, process identity, loopback binding, state locks, and ownership
  cleanup cannot be skipped by UI mode.
- Chat/migration memory layout is unchanged and UI state is never persisted there.
- Telemetry gets no TUI events/keys/filter values and is not initialized by UI.
- Benchmark protocol/fingerprints remain unchanged; UI work cannot contaminate
  measured intervals.

---

## 11. Documentation

README and help must document:

- automatic interactive TUI and exact eligibility;
- `--tui`, `--no-tui`, `--accessible`, `--no-color`, and command-scoped `--yes`;
- unchanged JSON/piped/script behavior;
- command-specific keyboard help;
- terminal minimums and fallback behavior;
- cancellation/cleanup semantics;
- how to report terminal compatibility issues without sharing prompts or paths.

Examples show both interactive screenshots/transcripts and stable plain/JSON
output. Generated screenshots contain fixture data only and no local usernames,
hostnames, paths, or real conversation content.

---

## 12. Testing strategy

### 12.1 TDD and test boundaries

Write failing tests before implementation. Automated tests mock with `vi.fn()`:

- stdin/stdout/stderr streams and terminal capabilities;
- key input and resize events;
- monotonic clock, frame scheduler, and signal hooks;
- command domain results and progress events;
- network, filesystem, child process, backend, and state operations as required by
  existing command tests.

No Vitest test downloads models, starts Ollama/llama.cpp, or contacts telemetry.

### 12.2 Mode/compatibility cases

- Eight TTY combinations, `TERM` missing/dumb, CI, dimensions, renderer failure.
- Flag precedence for JSON/TUI/no-TUI/accessible/no-color/NO_COLOR.
- Every row of the normative mode table, including accessible cooked-input mode,
  incompatible combinations, EOF, redirects/pipes, and minimum 40x10 behavior.
- `--tui` incompatibility fails before domain calls; auto mode falls back.
- Plain/JSON/piped outputs and exit codes match golden pre-TUI fixtures.
- Omitted interactive args open pickers; omitted noninteractive args fail.
- Help/version never load the renderer or enter raw mode.
- Lazy import proves plain/JSON path does not evaluate Ink/React modules.
- Exact renderer-init/runtime notice text, no notice for ordinary ineligibility,
  and no raw renderer error leakage.
- A registry meta-test derives every command/flag from CLI registration and fails
  if the mode matrix, screen contract, plain golden, or help coverage is missing.

### 12.3 Component and interaction cases

- Snapshot each screen at 60, 80, 100, and 160 columns; 16/24/40 rows.
- Keyboard navigation, wrap/clamp rules, focus, help, filter, empty state, back.
- Stable-id selection under filter/sort/resize; no index-target drift.
- Accessible line mode has feature-equivalent selection/confirmation.
- No destructive action from a single accidental key; Cancel is default.
- Confirmation occurs before lock/mutation/backend calls.
- Controller resolve→prepare→review→execute ordering and typed decisions for each
  command; UI drivers cannot access command dependencies.
- Confirmation snapshots revalidate exact target/ownership/process/state/store
  identity under lock; concurrent up/down/switch/migrate races fail closed or
  return to a fresh review, including `--yes` drift.
- Migration tests cover absent/existing target disclosure, required replacement
  confirmation, target changes before materialization and commit, and no stale
  target overwrite after either drift point.
- Virtualized 1,000-row list and bounded progress/history memory.
- Unknown metrics/reasons remain visible and never become zero.

### 12.4 Terminal safety cases

- ANSI/OSC/title/hyperlink, C0/C1, CR overwrite, bidi, NUL, long grapheme, wide
  character, combining mark, invalid surrogate, and huge-string fixtures.
- Single-line newline spoofing, zero-width/default-ignorable controls, homoglyph
  confirmation targets, ASCII action-id rejection, NFC prose, UTF-8 byte limits,
  `Intl.Segmenter` boundaries, and `string-width` cell vectors.
- Frame/message/cell/detail/chat byte caps and grapheme-safe truncation.
- Resize before/during work and fallback without duplicate domain execution.
- Renderer throw/rejection at every lifecycle phase restores terminal exactly once.
- SIGINT/SIGTERM/SIGHUP, repeated Ctrl+C, cancellation race, late progress after
  unmount, and cleanup failure.
- Exit 129/130/143, cleanup-error precedence, committed-after-cancel success, signal
  forwarding to every supported operation, and generation-id late-event drops.
- Raw mode/cursor/listener/stdin state restored; no listener leaks across repeated
  in-process command tests.

### 12.5 Command contracts

- `recommend`/`can-run`/`doctor`/`catalog` TUI never triggers mutation/network
  beyond existing explicit flags and preserves deterministic results.
- `up` stage order, progress coalescing, integrity visibility, cancellation, and
  owned cleanup.
- `chat` piped compatibility, multiline editing, bounded viewport, pending state,
  memory-capture warning, no fake streaming, exact TUI summary versus `--no-tui`
  transcript, 32 KiB/8,192-grapheme/256-line draft bounds, huge paste, multibyte
  edges, 1 MiB response rejection, and no oversized memory capture.
- `ls` state-only behavior and empty/owned/attached views.
- `switch` restrictions, race handling, and no-op current target.
- `down` owned/attached copy, default cancel, `--yes`, rollback on stop failure.
- `migrate` picker exclusions, dry run, move confirmation, atomic summary.
- Future benchmark/telemetry screens run only after their command contracts exist.
- Benchmark quiet-window barrier flush/pause/ack ordering proves no frame callback
  occurs between measurement timestamps.
- A traceability suite demonstrates all ten §1.1 quality dimensions and the
  visible-action/time-to-value key-count targets against deterministic fixtures.
- Comparative-audit harness tests enforce exact commit/archive/lock/binary hashes,
  offline locked build, empty credentials/home, read-only mounts, resource caps,
  denied socket/connect/bind/listen syscalls, and `not_run` release failure.
- Comparative results classify every permitted divergence per task instead of
  relying on an aggregate score and retain exact local/upstream artifact hashes.
- Golden tests pin locale `en-US`, timezone UTC, TERM, color variables, dimensions,
  Unicode capability, and clock. Race tests use controlled schedulers/deferreds
  with hard completion deadlines—never real sleeps.
- Golden updates record the generating command, environment identity, fixture
  hashes, and reviewer-visible semantic frame diff. Race failures print random
  seed, logical event order, pending tasks, and terminating deadline.

### 12.6 Performance and package cases

- Fixed benchmark for cold plain path with TUI module absent from import graph.
- TUI load, first-frame, key latency, frame frequency, memory, and frame cap.
- `npm pack --dry-run` checks tarball contents/size; dependency-tree audit checks
  licenses, scripts, native binaries, vulnerability report, and install size.
- Node 18/20/22/24 and macOS/Linux/Windows CI matrix for type/build/unit tests.
- Each dependency/performance/package/key-count gate has a deliberate negative
  fixture proving the harness fails when its threshold or invariant is violated.

### 12.7 Real terminal smoke

Release smoke matrix uses fixture/fake domain operations first, then safe real
read-only commands:

- macOS Terminal/iTerm-compatible terminal;
- Linux xterm-compatible terminal and tmux;
- Windows Terminal/ConPTY;
- 60/80/120 columns, resize, NO_COLOR, accessible mode;
- recommend, can-run, doctor, catalog, ls;
- one explicitly authorized lightweight runtime lifecycle for up/chat/down using
  the production smoke skill.

Smoke verifies no orphan process, stuck raw mode, hidden cursor, corrupted
scrollback, leaked control bytes, or changed final exit/output contract.
Required matrix jobs fail when smoke reports `not_run`; optional local runs may
report an explicit prerequisite skip that never counts as release evidence.

### 12.8 Verification commands

```bash
npm test
npm run typecheck
npm run lint
npm run build
npm pack --dry-run
```

---

## 13. Phased delivery

### Phase U0 — Renderer/dependency proof

- Approve Ink/React runtime dependencies.
- Verify Node 18, ESM/tsc, terminal streams, cleanup, package/cold-start budgets.
- Establish golden plain/JSON compatibility fixtures before refactoring.

### Phase U1 — Presentation foundation + read-only commands

- Capability/mode selection, session lifecycle, theme, frame/list/detail/status.
- Typed result/presenter boundaries.
- `recommend`, `can-run`, `doctor`, `catalog`, and `ls`.
- Accessibility and terminal-safety suite.

### Phase U2 — Lifecycle commands

- Confirmation/progress framework.
- `up`, `switch`, `down`, and `migrate`.
- Cancellation and process/state cleanup regression suite.

### Phase U3 — Chat

- Bounded conversation viewport and multiline editor.
- Preserve piped mode and memory-capture behavior.
- Real lightweight runtime smoke.

### Phase U4 — Future commands

- `benchmark` TUI only after benchmark P1 approval/implementation.
- `telemetry` TUI only after telemetry T1 approval/implementation.

Each phase is independently releasable behind auto-detection plus `--no-tui`.
Rollback is a patch release forcing plain mode; no remote flag or telemetry is
required.

---

## 14. Acceptance criteria

### Compatibility and modes

- **AC1:** Every implemented functional command has a command-specific TUI in an
  eligible terminal; help/version remain immediate plain output.
- **AC2:** Plain, JSON, piped, exit-code, stdout/stderr, and side-effect golden
  contracts remain unchanged.
- **AC3:** Mode/flag precedence and the eligibility predicate are table-tested;
  explicit incompatibility fails before domain work and auto mode falls back.
- **AC4:** Missing interactive arguments open validated pickers; the same missing
  values remain errors outside TUI.

### UX and accessibility

- **AC5:** Shared keyboard behavior, visible help, focus, empty/error states, and
  safe confirmation work at all supported dimensions.
- **AC6:** Every function is keyboard-complete, status is not color-only,
  NO_COLOR works, and accessible mode provides cooked-input, cursor-visible,
  line-oriented low-motion parity without raw mode or frame rewrites.
- **AC7:** Resize preserves stable-id selection or safely falls back without
  duplicate execution.
- **AC8:** Read-only advice/catalog TUIs cannot execute mutating/runtime/network
  actions and preserve honesty-gated unknowns.

### Command behavior

- **AC9:** Recommend, can-run, doctor, catalog, and ls render the exact existing
  result evidence and preserve their probe/exit contracts.
- **AC10:** Up renders fixed lifecycle stages and cannot bypass fit, disk,
  integrity, loopback, readiness, state, or owned-cleanup checks.
- **AC11:** Chat preserves piped mode, bounded context/memory capture, and displays
  no fake streaming or unsanitized model content; TUI drafts/responses enforce
  §5.6 limits and emit the versioned session summary, while `--no-tui` preserves
  the existing transcript.
- **AC12:** Switch/down/migrate preserve race, ownership, rollback, dry-run,
  atomic-write, source-preservation, target-replacement disclosure, and locked
  source/target snapshot semantics.
- **AC13:** Down and migrate-move default to Cancel; confirmation occurs before
  locks/mutation, a locked snapshot revalidation prevents target drift, and
  `--yes` is command-scoped and fails closed on drift.

### Safety and lifecycle

- **AC14:** All untrusted content is sanitized/bounded before frames; adversarial
  terminal fixtures cannot execute controls, alter titles, forge rows, or exceed
  memory/frame limits.
- **AC15:** Success, failure, signals, repeated cancellation, render errors, and
  resize restore cursor/raw mode/listeners exactly once before exit.
- **AC16:** UI failure never reruns a domain command, signals an unverified process,
  strands a lock, or changes a committed product result.
- **AC17:** Progress is bounded/coalesced, final transitions are retained, and
  late events after unmount are ignored.
- **AC18:** Every asynchronous controller forwards one cancellation signal,
  reports exact side-effect/compensation state, assigns 129/130/143 only after
  successful cleanup, and gives cleanup failures precedence.
- **AC19:** Context-specific sanitization prevents newline/Unicode/identifier
  spoofing and all byte/width/grapheme bounds recompute from fixture evidence.

### Performance, packaging, and release

- **AC20:** Plain/JSON and interactive performance meet every budget in §9 on the
  release test matrix.
- **AC21:** Approved dependencies pass engine/license/provenance/script/native/
  vulnerability review; npm package contents and install-size budgets pass.
- **AC22:** Node 18/20/22/24 and macOS/Linux/Windows automated gates pass.
- **AC23:** Real terminal smoke passes without stuck raw mode, hidden cursor,
  scrollback corruption, control leakage, or orphan processes.
- **AC24:** `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, and
  `npm pack --dry-run` pass.
- **AC25:** Code review has no unresolved Critical/Important and security review
  has no unresolved Critical/High/Medium findings.
- **AC26:** The command controller resolves intent, prepares immutable evidence,
  obtains a typed decision, executes domain logic once, and formats one typed
  result; screens never parse text or access backend/state dependencies.
- **AC27:** All ten §1.1 quality dimensions and pinned-llmfit comparative task
  criteria pass with a reproducible, hash-pinned, network/syscall-sandboxed audit;
  no numeric multiplier or hidden key-only action is claimed.

### Future command gates

- **AC28:** Benchmark TUI cannot ship before benchmark command acceptance and
  proves an acknowledged quiet-window barrier prevents rendering inside measured
  intervals.
- **AC29:** Telemetry TUI cannot ship before telemetry command acceptance and
  performs no event/network operation itself.

---

## 15. Boundaries

### Always

- Preserve machine-readable and noninteractive contracts.
- Detect terminal capability conservatively before loading the renderer.
- Keep domain/backend/state logic outside UI components.
- Sanitize and bound every untrusted terminal string.
- Restore terminal state in every path.
- Keep advice offline/deterministic and benchmarks uncontaminated.
- Confirm destructive actions before locks/mutation.
- Test with fake streams before real terminal smoke.

### Ask first

- Adding Ink/React or any runtime dependency.
- Raising Node.js minimum or introducing a bundler/native module.
- Changing plain/JSON output or exit codes.
- Adding a mutating action to an advice/catalog screen.
- Persisting UI state/history or adding mouse/image/notification support.
- Changing backend, state, memory-store, catalog, or telemetry schemas.
- Adding benchmark/telemetry screens before those command phases are approved.

### Never

- Prompt or enter raw mode in pipes, redirects, JSON, CI, or `TERM=dumb`.
- Let UI mode bypass integrity, identity, loopback, locking, or cleanup controls.
- Fabricate progress percentages, metrics, compatibility, or runtime status.
- Pass raw model/runtime/error strings to terminal rendering.
- Track keys, focus, filters, drafts, prompts, or TUI usage in telemetry.
- Execute arbitrary commands, URLs, clipboard writes, or terminal OSC sequences.
- Spawn real runtimes or make real network calls in Vitest.

---

## 16. Draft decisions requiring human approval

1. Automatic TUI in eligible terminals, with plain fallback elsewhere.
2. Ink + matching React as new runtime dependencies after U0 proof.
3. Global `--tui`, `--no-tui`, `--accessible`, and `--no-color` flags.
4. Scoped `--yes` only for `down` and `migrate --move`.
5. Interactive omission/pickers for model arguments and migrate source/target.
6. Inline rendering that preserves scrollback instead of alternate-screen mode.
7. Confirmation defaults for down and migrate-move.
8. Accessibility, terminal-size, performance, tarball, and install-size budgets.
9. Phased rollout order and future benchmark/telemetry command gates.

Implementation must not begin until this specification and dependency decision are
approved.
