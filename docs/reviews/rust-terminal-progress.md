# Native Terminal Progress

Date: 2026-09-19. Status: native visual paths implemented; full R23 retirement
and the requested all-surface performance certification are not complete.

## Implemented

- Native mode policy matches 360 frozen TypeScript selections/errors, including
  TTY combinations, explicit conflicts, terminal-name validation, CI, sizes,
  monochrome settings, and forced-plain behavior.
- Read-only commands (`recommend`, `can-run`, `catalog`, `doctor`, `ls`) show a
  bounded native view when eligible. Explicit `--tui` rejects unsuitable
  terminals before domain work. `--no-tui`, JSON, pipes, and CI stay noninteractive.
- Report navigation supports arrows, page/home/end, horizontal scrolling,
  `/` search, next-match `n`, and quit via `q`, Escape, or Enter. The report is
  printed to stdout after the alternate-screen presentation exits normally.
- Catalog and recommendation now use model-focused list/detail views, including
  installed inventories. Can-run starts in the target's detail view. Search,
  evidence scrolling, overview, modal help, and marking/comparison of up to four
  models reuse the existing bounded evidence without recomputing advice. Safe
  recommendation finish-print never executes a command. Normal exit prints the
  original final report; cancellation suppresses that report.
- Missing catalog-model arguments can be selected interactively for `can-run`,
  `up`, and `switch`. Installed-model activation still requires an explicit ID.
- Visual lifecycle actions have a default-cancel confirmation before hardware
  probing, runtime access, acquisition, or state mutation. Confirmation does not
  weaken digest, process ownership, loopback, or context validation.
- After confirmation, visual lifecycle execution displays observed runtime stages
  and bounded diagnostics full-screen. Known safety warnings retain occurrence
  counts; progress uses sourced byte counts with filenames redacted and omissions
  counted. Cancellation waits for the runtime to return before restoring the
  terminal. Result/recovery views never infer rollback or cleanup success.
- Accessible `up`, `switch`, and `down` now use cooked, numbered confirmation at
  the 40x10 terminal threshold. Empty input, EOF, and any answer other than `2`
  cancel. Missing catalog model arguments use a numbered picker, with one shared
  input reader across selection and confirmation. Ctrl+C exits 130 before runtime
  work. Answers are bounded to 256 UTF-8 bytes. Model numbers use decimal integer
  input; unlike JavaScript Number conversion, exponent/hex/fraction syntax is not
  accepted. Installed-model activation continues to require an explicit ID.
- Accessible `ls` and `doctor` now show numbered evidence on stderr with cooked
  `?` help and `q`/EOF exit. Normal completion prints the original plain report
  once on stdout; Ctrl+C returns 130 without a final report (SIGTERM returns 143
  on Unix). Doctor retains its diagnostic exit status. No raw mode or alternate
  screen is used. Non-TTY and conflicting invocations fail before domain work.
- Accessible recommendation and catalog support cooked search, numbered details,
  help, and quit. Catalog refresh presents the same refreshed catalog and diff as
  final stdout. Recommendation print completes the view without executing its
  suggestion; interactive and final text share one ranking calculation.
- Accessible can-run preserves verdict exits and shared picker input and shows
  unknown requested-context fit before quitting. Installed-inventory views display
  only native runtime evidence, including unknown metadata and throughput.
- These read-only views preserve visible control-character escaping, NFC prose
  normalization, model-identifier escaping, and 256-byte grapheme-safe field
  truncation. Doctor shows at most 20 checks/backends with omitted-item counts;
  unknown score evidence remains `Unknown (not sourced)`. Native screens are
  capped at 32 KiB, stricter than the retained 256 KiB frame budget.
- Visual chat reuses the native engine. Drafts are bounded to 32 KiB, 8,192
  graphemes, and 256 lines. Backspace removes a whole grapheme; Ctrl+J inserts a
  newline; Ctrl+C clears a nonempty draft or interrupts; Escape exits.
- Only successful replies enter the bounded 20-message context. Pending requests
  are cancelled on exit. Replies over 1 MiB are rejected. Provider errors and
  memory warnings remain visible; no error text becomes conversation context.
- Terminal output uses stderr and restores raw mode, alternate screen, cursor,
  and bracketed paste on normal/error exits. Read-only and chat rendering is
  event-driven. Lifecycle diagnostics refresh at 100 ms while running.
  Plain/accessibility chat behavior remains unchanged.

## Verification

Tests include buffer rendering at 20x5, 60x16, and 120x40; navigation/search;
control sanitization; draft bounds; completed and pending injected-engine turns;
and real PTY entry/exit, Ctrl+C, narrow-terminal fallback, and lifecycle/picker
cancellation before side effects. No inference runtime or network is used.
Exact read-only plain/JSON goldens and prior line-chat tests still pass.

The 360-case fixture `crates/rigspark-cli/tests/tui-mode-oracle.json` was mechanically
captured from the retained `resolveUiMode` at commit `c1e4374`; expected values
were not generated by the Rust implementation. Native capability capture uses
conservative basic-color detection rather than assuming truecolor support.

The user approved Ratatui and Crossterm on 2026-09-19. Runtime versions are
Ratatui 0.30.2 and Crossterm 0.29.0; `portable-pty` 0.9.0 is dev-only. Core
RustSec and the native permissive-license policy pass with the new dependencies.

The user also approved `unicode-normalization` (resolved version 0.1.25) for
terminal NFC parity. The existing regex/grapheme libraries handle visible escape
units and Unicode default-ignorable characters. Native audit and license checks
pass. `accessible-text-oracle.json` freezes 19 legacy sanitizer inputs covering
control sequences, bidi, combining characters, emoji, and truncation.
`accessible-read-only-oracle.json` freezes 11 composed `ls`/`doctor` screens,
including owned/attached/empty state, known/unknown scores, missing backends,
long lists, and hostile text. Both were mechanically captured from retained
TypeScript at commit `71d83bb`, not generated by the native implementation.

Sources:
- https://docs.rs/ratatui/0.30.2/ratatui/
- https://docs.rs/crossterm/0.29.0/crossterm/event/index.html
- https://docs.rs/ratatui/0.30.2/ratatui/backend/struct.TestBackend.html
- https://docs.rs/portable-pty/0.9.0/portable_pty/

## Remaining Gates

This is not yet full legacy TUI parity. Lifecycle execution now consumes bounded
runtime events for acquisition, verification, startup/attachment, activation,
readiness, and stop, with guarded result/recovery presentation. Combined operations
remain labeled as combined rather than pretending finer-grained observations.
Visual execution now uses a scoped diagnostic sink; plain and accessible execution
retain line-oriented diagnostics. Existing subprocess stderr suppression is
unchanged, and raw backend logs are not newly captured. Detailed model views are
implemented. Full lifecycle review evidence and complete functional parity remain.
No progress percentages or rollback claims are fabricated when evidence is absent.
Visual chat follows the retained completed-reply presentation, not token streaming.
PTY cancellation is covered locally; complete platform and functional journeys
must pass before retiring the active TypeScript TUI.

The deep performance report requested by the user must cover complete CLI/TUI/GUI/
desktop journeys after migration. Existing version/startup budgets do not establish
TUI input latency, GUI responsiveness, Tauri-vs-Electron memory, or inference speed.
No unmeasured improvement is claimed here.

The accessible prompt increment adds five unit tests and three real PTY tests for
default cancellation, sequential prompts, and Ctrl+C without state creation or
alternate-screen use. Cross-platform CI is intentionally deferred to the next
batch at the user's request; local PTY results do not certify Windows behavior.

The accessible read-only increment adds six report/input tests and one sanitizer
oracle test, plus three real PTY cases for `ls` help/quit, `ls` interruption, and
doctor failure-preserving completion. TypeScript read-only code remains active
until the remaining screens are migrated. Cross-platform verification and the
full performance report remain deferred; no new remote CI run was launched.

The following implementation-first batch adds catalog/recommendation/can-run
controllers and installed-inventory views. Catalog and recommendation match 20/12
frozen TypeScript cases. Can-run retains 58 frozen cases with an explicit native
missing-geometry warning added before exit. Installed views have ten focused tests
against actual native sizing-report shapes. Eighteen local PTY cases cover the
combined terminal paths before the subsequent lifecycle bridge increment. The
event integration has twelve focused runtime event tests, fourteen lifecycle
controller checks, and two native workflow tests. This is not a
full regression or platform certification of the batch. The user deferred deep
review and full testing until implementation is complete.

The next implementation increment connects detailed visual catalog, recommendation,
can-run, installed-inventory, and full-screen lifecycle execution. Focused checks
pass: 22 model-view tests (including all 58 frozen can-run cases), 11 installed-view
tests, 19 lifecycle controller tests, and 22 local PTY journeys. New PTY coverage
exercises catalog search/detail/back, marking/comparison/help, confirmed empty
shutdown across confirmation/execution/result screens, and can-run verdict and
interrupt exits. No real inference runtime or network is used. Installed visual
adapters are covered with native report fixtures, not a live installed runtime.
Deep review, full regression, platform coverage, and performance remain deferred.

Try the experimental native entry points in a terminal at least 40x10:

```sh
cargo run --locked -p rigspark-cli --bin llmup-native -- ls --accessible
cargo run --locked -p rigspark-cli --bin llmup-native -- doctor --accessible
```