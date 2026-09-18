# Rust Checkpoint 5 Verification

Date: 2026-09-18. Host: macOS arm64. Status: R20-R21 implemented; R22 open.
No production routing switch, commit, release, or Electron removal is included.

## Native Entry Points

```sh
npm run rust:gui -- --port 59103
npm run rust:desktop
npm run rust:gui:test
npm run rust:desktop:test
npm run rust:gui:e2e
npm run rust:gui-parity
```

Set `LOCAL_LLMUP_HOME` to an isolated directory before experimental mutations.
Builds require the pinned Rust toolchain and npm dependencies because the marked
and DOMPurify vendor files are embedded at compile time. Built native executables
do not require Node. `rust:gui:e2e` uses a separate Rust example with an injected
model and fresh temporary home; it does not start a real inference process.
Use `RUST_GUI_TEST_PORT` to choose a free browser-test port (default 4322).

## Verification Results

- Workspace fmt, strict Clippy, locked tests and build: passed.
- Tauri fmt, strict Clippy, locked tests and build: passed.
- Tauri command-dispatch tests: approved root picker invocation succeeds;
  artifact path, foreign origin/port, and non-main window are denied.
- Real macOS WebView smoke: frontend, composer, and injected bridge load;
  process exits successfully without starting inference.
- Three Chromium journeys against native HTTP/SSE: passed. Replies persist and
  restore; completion is announced; cancellation saves no partial exchange;
  Escape returns context-picker focus; mobile has no horizontal overflow;
  desktop shows seven metric canvases. Screenshots were inspected.
- Host tests cover asset embedding, artifact sandboxing/traversal, body limits,
  origin/token/listener checks, shutdown admission, session isolation, duplicate
  runs, SSE disconnect cancellation, and tool approval/disconnect.
- GUI recommendation parity: 24 complete model-list contracts. Prior sizing,
  advice, state, and workflow parity gates pass unchanged.
- TypeScript: lint/typecheck/build and all 2,066 tests pass; coverage thresholds
  pass (85.31% statements, 79.34% branches, 81.39% functions, 86.76% lines).

## Review Findings Addressed

- Caller-supplied listeners previously could bind outside the expected loopback
  address. `serve` now validates the exact address and port before accepting work.
- Approval events could reach the browser before the reply slot existed. Slots
  now precede publication and accept one response only.
- Connector disconnect could wait behind an agent awaiting approval. Mutations
  now cancel before waiting on the manager and clear session grants.
- Requests could enter after shutdown. The boundary now returns 503, and cleanup
  runs after server errors as well as ordinary shutdown.
- A Tauri capability containing `http://127.0.0.1:port/` is not path-restricted:
  Tauri normalizes `/` to `*`. The literal-root `/{}` pattern is tested through
  the actual dispatcher. Navigation and command-level window checks remain.

Sources: [Tauri capabilities](https://v2.tauri.app/security/capabilities/),
[Tauri 2.11.5 test API](https://docs.rs/tauri/2.11.5/tauri/test/index.html), and
the pinned tauri-utils 2.9.3 `RemoteUrlPattern::from_str` implementation.
Tauri documents Linux iframe-origin limitations. Artifact responses prohibit
scripts via sandbox CSP; the launch document prohibits framing. No artifact
document is granted the picker capability.

## Remaining R22 Gate

| Check | macOS arm64 | Linux | Windows |
| --- | --- | --- | --- |
| Native build, tests, Clippy | Passed | Passed | Passed |
| Actual WebView launch/bridge | Passed | Passed (WebKitGTK/Xvfb) | Passed (WebView2) |
| Picker IPC with injected selection | Passed | Passed | Passed |
| Physical folder dialog select/cancel | Passed | Selection automation failed | Exact-selection assertion failed |
| Browser streaming/cancel/keyboard | Passed (Chromium) | Passed (Chromium) | Passed (Chromium) |

Run the same locked Cargo desktop tests and build on native Linux with WebKitGTK
and Windows with WebView2. Run the built desktop executable with `--smoke-test`,
then manually select and cancel a workspace folder, check root revocation, close
the window during a pending reply, and verify no owned process remains. Test
artifact isolation in the actual platform WebView, not only the mock runtime.

On 2026-09-18, the user authorized feature-branch commits, pushes, and verification
CI. Commit `f60c3a4` started the three-platform `Rust Desktop Verification` workflow:
https://github.com/shashankswe2020-ux/local-llmup/actions/runs/35316992201
The complete native build/lint/test/WebView/browser matrix passed for all three
platforms at commit `59dffd0`:
https://github.com/shashankswe2020-ux/local-llmup/actions/runs/35325069584
Platform jobs: macOS `105536111599`, Windows `105536111731`, Linux `105536111831`.

Native execution found and fixed Linux `O_PATH` directory descriptors being used
for fsync/chmod, Windows-only unused mutability, a missing Windows icon resource,
and Unix-only absolute paths in adapter/inference fixtures. Private permissions,
descriptor-relative operations, and identity checks were retained; no test gate
was weakened. Test startup waits now have deadlines and CI collects all failures.

The additional actual-folder-dialog gate failed at commit `c4f36b3`:
https://github.com/shashankswe2020-ux/local-llmup/actions/runs/35340732466
It uses the real picker twice (Cancel, then selection), checks the selected path
against a disposable directory, registers and revokes that root, and requires a
successful exit. Linux uses GTK portal/Xvfb; Windows uses UI Automation. Mock
picker tests are not substituted for this gate.

Both platforms opened two real picker dialogs, but Linux never completed the
second selection before the smoke deadline. Windows returned a directory other
than the required disposable target, which the smoke guard rejected before root
registration. These are unresolved automation/interaction failures, not passing
dialog evidence. The driver checks the success marker as well as the process
exit code, so an exit code of zero alone cannot falsely pass the test.

R22 remains unchecked. Next action: inspect the live native controls/screenshots
on interactive Linux and Windows sessions, or repair the hosted dialog drivers
with that evidence. Do not weaken the exact-path assertion, skip the dialog step,
or substitute injected picker results to close this gate.

The actual macOS folder dialog was exercised through Accessibility automation:
Browse opened the native sheet; Cancel dismissed it; reopening and selecting a
disposable directory registered a workspace root. Authenticated root revocation
cleared the capability. Closing the native window terminated its process normally.
No inference runtime was started during this check.

Do not mark R22 or the full checkpoint complete from these macOS results alone.
Signed installers, distribution,
native runtime smoke with real weights, dependency-release audits, and production
cutover remain checkpoint 6. Tauri bundle generation is disabled until those gates.