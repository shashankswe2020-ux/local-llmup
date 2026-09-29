# Native Browser Verification

Date: 2026-09-21
Status: M03 implemented and verified locally on macOS arm64; M14 retirement
and whole-product migration are not complete.

## Native Runner

[browser_smoke.rs](../../crates/rigspark-gui/examples/browser_smoke.rs) uses
Fantoccini 0.22.1 with an HTTP-only connector. Only explicit HTTP `127.0.0.1`
root endpoints are accepted. Credentials, other hosts, paths, queries, fragments
and TLS endpoints reject before creating a session. Browser connections, DOM
waits, complete journeys, screenshots and session closure have deadlines.
Failure screenshots are best-effort and cannot prevent browser closure.

The user approved a Rust browser-test dependency and required removal of all
Node-based CI actions, including infrastructure actions. Fantoccini is a dev
dependency only, pinned in Cargo.lock; it does not bundle a Node driver.

The existing [native fixture](../../crates/rigspark-gui/examples/browser_fixture.rs)
provides disposable storage and injected replies. Its update endpoint now returns
the same unknown response that Playwright previously intercepted, avoiding release
network requests. Production update checking is unchanged.

Build both executables, start a matching ChromeDriver and fixture on unused
loopback ports, then run:

```sh
cargo build --locked -p rigspark-gui --example browser_fixture --example browser_smoke
RUST_GUI_TEST_PORT=48231 target/debug/examples/browser_fixture
```

In separate terminals, using the absolute paths to installed test tools:

```sh
chromedriver --port=48232 --allowed-ips=127.0.0.1
cargo native-browser-smoke http://127.0.0.1:48232 http://127.0.0.1:48231 /absolute/path/to/chrome test-results/rust-browser
```

Stop the fixture and driver after the run. This version requires explicitly
started processes; automatic process ownership/cleanup remains a follow-up.
Never point the runner at a user's running application or storage. The test
creates sessions and messages. It does not start or download inference runtimes.

## Local Evidence

- Chrome 153.0.8010.48 and official ChromeDriver 153.0.8010.52, macOS arm64.
- Direct `browser_smoke` execution passed with `PATH=/usr/bin:/bin`, without
  Node in the runner's executable search path.
- A streamed reply persists, reload restores exactly one user exchange, and
  response completion is announced.
- Cancellation displays the stopped notice and reload contains no partial exchange.
- Escape dismisses context selection and restores focus to Add Context.
- Desktop has seven live metric canvases and no horizontal overflow.
- Mobile uses WebDriver device emulation and asserts exactly 390x844 CSS pixels;
  resizing an ordinary Chrome window is not equivalent because of minimum widths.
- Mobile and desktop PNG screenshots were captured and inspected.
- Both example unit tests, locked builds, and strict example Clippy passed.

### 2026-09-24: Accessibility Spec Transfer

The legacy accessibility spec was ported and deleted. Chrome 153.0.8010.53 with
official Chrome for Testing ChromeDriver 153.0.8010.52 (mac-arm64 zip SHA-256
`23dc682b73c6473562b4b0d6ddd5b8a0823dbeeccd32a901d085df5f8d87b5cd`, ad-hoc
signed, kept under ignored `target/tools`). Five consecutive runs passed with
`PATH=/usr/bin:/bin`.

- Every session now fails on SEVERE browser log entries except favicon and
  user-initiated abort noise, matching the legacy harness. A manual probe
  confirmed `console.error` and uncaught exceptions both surface as SEVERE.
- Composer textbox name, Send button name and `role=log` messages are asserted.
- Streaming a multi-chunk reply announces exactly `Sending message.` then
  `Response ready.`, never reply content.
- A 320x720 emulated session sends and receives a reply.
- The fixture's test-only `POST /__fixture/update` switches release status: a
  trusted update shows the exact link text, href, `_blank` and
  `noopener noreferrer`; unknown status keeps the link hidden.
- Escape hides the context picker as well as restoring focus.
- One earlier run opened the System prompt panel instead of the context picker
  (a pre-existing click/layout race); it did not recur in eight later runs.

### 2026-09-24: Chat And Formatting Spec Transfer

The legacy chat and Markdown formatting specs were ported and deleted. Their
reply fixture lives in `examples/support/chat-formatting.md`; the native fixture
reproduces the legacy triggers, growing stream cuts, 80-byte scroll chunks, the
1.5 s open-fence pause and the local `formatting.png` artifact. The TS fixture
remains only because the legacy `server.ts` still boots the other four specs.

- Chat: single reply, two-turn counts, heading/list/code structure before and
  after reload, and Stop leaving a Retry action.
- Formatting: every legacy GFM, sanitization and XSS assertion; semantic role
  counts and focus outlines; identical text after reload; streamed DOM equal to
  the complete DOM; bottom-follow then reader hold at 390px; message-log hold
  while streaming and on cancellation; open-fence decoration only when final;
  sandboxed HTML preview with focus restoration; response affordances at
  1440, 768, 390 and 320px widths.
- A deliberate false check made the run fail, proving the aggregated check
  helper is not vacuous. 17 consecutive runs against fresh fixtures passed.

Runner setup waits for the page's initial session activation and for
`finalize()` before starting a new chat. Two client races found while doing so
are recorded, not fixed here: New chat clicked before initial activation
completes can lose to the older activation, and New chat is silently ignored
between the idle composer state and `finalize()` after completion refreshes.
One fixture home holds at most 500 sessions, so repeated runs need a fresh
fixture process.

### 2026-09-24: Remaining Specs And Playwright Retirement

The models, installed-models, tools and workspace specs and the native-host
Playwright spec were ported. The fixture records `/api/models/up` requests
instead of launching a runtime, serves a fixed installed list, can override
recommended context, attaches a demo MCP tool on request, and provides a
disposable workspace with `src/app.ts`.

- Models: detail headings, five score rows, quantization row and evidence note;
  Back restores the catalog; the 390px detail has no page overflow; detail
  Start sends the displayed 65,536-token context after confirmation.
- Installed (1280 and 390px): unknown context fit, fit-only empty state, bypass
  enabling Start, confirmation naming context and integrity, and the exact
  start request.
- Tools: Approve runs the tool and continues; Deny marks the card denied and
  never runs it.
- Workspace: register a root, search, attach `src/app.ts`, and the ledger
  reports `1 of 1`.
- New chat's POST returns 201 with a UUID that becomes the active rail item.

Mutations of the exact installed request and the denied-tool assertion both
failed the run. 20 later isolated runs passed. All Playwright specs, the TS
fixture server, the chat-formatting TS fixture, and both Playwright configs are
deleted. `scripts/native-browser-journeys.sh` builds and runs the journeys
against a disposable fixture and a supplied ChromeDriver, and cleans up both;
three local runs passed with no leftover processes. The desktop verification
workflow now uses it with each runner image's preinstalled Chrome and
ChromeDriver and installs no Node tooling. That CI path has not run yet.
`@playwright/test` remains only for the WHOOP demo recorder script.

## Remaining Retirement Gates

Keep the TypeScript Playwright suites until their assertion transfer is complete.
Every legacy browser journey now runs natively, including console/page-error
collection and session-create status. Linux and Windows runs, CI provisioning
evidence and browser vendored-dependency auditing remain open.
Linux and Windows runs, browser/driver provisioning and ownership, test failure
artifacts in CI, and browser vendored-dependency auditing remain open.

Sources: [Fantoccini ClientBuilder](https://docs.rs/fantoccini/0.22.1/fantoccini/struct.ClientBuilder.html),
[client APIs](https://docs.rs/fantoccini/0.22.1/fantoccini/struct.Client.html),
[ChromeDriver mobile emulation](https://developer.chrome.com/docs/chromedriver/mobile-emulation),
and [official browser/driver versions](https://googlechromelabs.github.io/chrome-for-testing/).