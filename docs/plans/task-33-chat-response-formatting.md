# Implementation Plan: Chat Response Formatting

> Status: Complete — Tasks 33.1-33.6 verified
> Created: 2026-08-30
> Related: [task 32 chat panel workspace experience](./task-32-chat-panel-workspace-experience.md)

## Problem Statement

Assistant responses are difficult to scan because multiline structure is destroyed before rendering. A real browser stress test sent headings, paragraphs, blockquotes, nested lists, task lists, a GFM table, fenced code, links, raw HTML, and a long token through the production chat/SSE path. The assistant DOM contained one paragraph, zero headings, zero lists, zero blockquotes, zero tables, and zero code blocks on both desktop and mobile.

The primary root cause is server-side sanitization, not CSS:

1. `stripControl()` removes all C0 controls, including line feed (`\n`), carriage return (`\r`), and tab (`\t`).
2. `GuiServer` applies it to user messages, prior turns, system prompts, every assistant delta, completed assistant text, and pasted context.
3. The browser therefore receives flattened text. The Markdown renderer cannot recover block structure.
4. The renderer is a regex-based subset that still lacks blockquotes, nested lists, task lists, tables, horizontal rules, robust links, and tilde fences after multiline preservation is fixed.
5. Formatting behavior has no semantic DOM, XSS, streaming, accessibility, or screenshot regression tests.

Observed screenshots:

- `test-results/chat-format-desktop.png`
- `test-results/chat-format-mobile.png`

These are transient test artifacts and must not be committed.

## Goals

- Preserve intentional line breaks and tabs across request validation, model input, SSE streaming, session history, and retry.
- Render a predictable, secure GitHub-Flavored Markdown subset with strong reading hierarchy.
- Keep user-authored messages plain text; rich rendering applies only to assistant output.
- Keep raw HTML inert and remote images blocked.
- Make code, tables, lists, links, and actions usable with keyboard, touch, screen readers, and narrow viewports.
- Preserve streaming responsiveness without reparsing on every token or causing scroll jumps.

## Non-Goals

- WYSIWYG editing or rich user-message composition.
- Executing model-generated HTML, JavaScript, Mermaid, or arbitrary embeds.
- Remote image loading or URL unfurling.
- Full IDE-grade syntax highlighting in the first release.
- Changing terminal/TUI output sanitization semantics.

## Architecture Decisions

### A1. Separate browser multiline sanitization from terminal sanitization

Keep `stripControl()` unchanged for terminal/log/identifier output. Add a GUI text sanitizer that:

- normalizes CRLF and CR to LF;
- preserves LF and tab;
- strips ANSI/escape sequences, NUL, unsafe C0/C1 controls, BiDi overrides, zero-width/invisible controls, and Unicode line/paragraph separators;
- is idempotent and length-bounded by the caller's existing schema/storage limits.

Use it consistently for GUI chat messages, system prompts, assistant deltas, persisted messages, and pasted terminal/diagnostic context. Do not sanitize the same completed assistant response differently from streamed deltas.

### A2. Use a proven Markdown parser and an explicit sanitizer

Recommended implementation: pinned `marked` for GFM parsing plus pinned `DOMPurify` for an allowlisted browser sanitization pass. This is preferable to expanding the current regex parser because nested block parsing, incomplete fences, tables, and link edge cases are established parser concerns.

**Decision Gate 1: dependency approval required before implementation.** The project requires approval for new runtime dependencies. Record exact versions, licenses, transitive closure, packed/install-size delta, Node 18 compatibility, and lifecycle scripts before acceptance.

Serve the browser builds from fixed, explicit local vendor routes. Never use a CDN or broaden arbitrary `node_modules` access. If dependency approval is denied, implement a deliberately smaller documented subset with a tokenizer/state machine; do not add more regex replacements to the current parser.

### A3. Treat parsed output as untrusted

The rendering pipeline is:

```text
model text -> GUI multiline sanitizer -> Markdown parser -> DOMPurify allowlist -> DOM insertion -> link/image policy
```

Allowed elements should be limited to paragraphs, headings, emphasis, lists, task-list inputs, blockquotes, code/pre, tables, horizontal rules, links, and approved local images. Remove raw HTML event handlers, styles, scripts, forms, iframes, SVG, and dangerous URLs. Enforce:

- links: `http:`/`https:` only, `target="_blank"`, `rel="noopener noreferrer"`;
- images: existing `/api/images/<validated-name>` and approved `data:image` forms only;
- code: text only, never interpreted;
- parser/sanitizer failure: render escaped plain text rather than an empty response.

Add a response CSP for the main GUI document after auditing existing inline styles and blob-based artifact preview requirements.

### A4. Separate rendering from the chat controller

Extract assistant formatting from the large `chat.js` controller into a browser module with a narrow API:

- `renderAssistantMarkdown(container, source, options)`;
- `decorateCodeBlocks(container)`;
- validated link/image hooks;
- final-render and streaming-render modes.

The controller remains responsible for run state and scrolling, not Markdown grammar.

### A5. Batch streaming renders

Accumulate sanitized source text as today, but schedule rich rendering at most once per animation frame (or a measured 30-50 ms interval). Always perform one final synchronous render before adding copy/preview actions. Preserve the user's scroll position unless they were already near the bottom.

Incomplete Markdown during streaming must degrade predictably: open fences render as code, partial links remain text, and parser errors never interrupt the run.

## Task Breakdown

### Task 33.1: Preserve multiline text end to end

**Status:** Complete (2026-08-30). Added a GUI-specific multiline sanitizer and
stateful provider-stream sanitizer; verified request, system prompt, SSE,
canonical history, durable history, pasted context, and restored browser output.

**Files likely touched:**

- `src/gui/text-sanitize.ts` (new)
- `src/gui/handlers.ts`
- `src/gui/server.ts`
- `src/gui/session-repository.ts`
- `tests/gui/handlers.test.ts` or new focused test
- `tests/gui/chat-runs.test.ts`
- `tests/gui/session-repository.test.ts`
- `tests/gui/context-sources.test.ts`

**Acceptance criteria:**

- Headings and fenced code retain LF boundaries from request through harness input, SSE output, canonical history, durable history, and retry.
- CRLF/CR normalize to LF; tabs remain available inside code/context.
- ANSI, NUL, C1, BiDi, and invisible-control attacks are removed without flattening text.
- Existing terminal sanitizer tests and TUI behavior remain unchanged.

**Verification:**

```bash
npx vitest run tests/gui/chat-runs.test.ts tests/gui/session-repository.test.ts tests/gui/context-sources.test.ts tests/sanitize.test.ts
npm run typecheck
```

### Task 33.2: Approve and integrate the Markdown dependency boundary

**Status:** Complete (2026-08-30). Approved exact pins `marked@15.0.12` (MIT,
Node.js `>=18`) and `dompurify@3.4.13` (MPL-2.0 OR Apache-2.0), plus DOMPurify's
optional type-only `@types/trusted-types@2.0.7` closure. `dompurify@3.4.0` was
rejected after the production audit reported active advisories through 3.4.12.
The accepted lock entries have `hasInstallScript: false`, no native artifacts,
and a clean production audit. DOMPurify's source manifest contains a maintainer
`prepare` command, but it is not a consumer install hook and does not execute
for the published dependency. The browser bundles are available only at the
fixed `/vendor/marked.min.js` and `/vendor/dompurify.min.js` routes; arbitrary
package paths and traversal fail closed.

**Files likely touched:**

- `package.json`
- `package-lock.json`
- `src/gui/static.ts`
- `src/gui/server.ts`
- `tests/gui/server.test.ts`
- dependency policy/budget tests as required

**Acceptance criteria:**

- Human approval records exact pinned versions of `marked` and `DOMPurify` (or approved alternatives).
- Vendor assets are served only from fixed local paths with correct content types and no traversal route into `node_modules`.
- No consumer install scripts, native binaries, remote runtime fetches, or CDN dependencies are introduced.
- Node 18, package budget, production audit, and npm packaging gates pass.

**Verification:**

```bash
npm audit --omit=dev --audit-level=low
npm run tui:dependency-policy
npm run tui:package-budget
npm pack --dry-run --json
```

### Task 33.3: Replace the regex renderer with sanitized GFM rendering

**Status:** Complete (2026-08-30). Replaced the inline regex parser with a
standalone Marked + DOMPurify renderer using explicit element/attribute and URL
policies. Verified semantic GFM, plain user messages, inert raw HTML, unsafe
link/remote-image rejection, approved inline/local images, escaped fallback,
code actions, and equivalent durable-history rendering in Chromium.

**Files likely touched:**

- `src/gui/static/markdown.js` (new)
- `src/gui/static/chat.js`
- `src/gui/static/index.html`
- `tests/gui/client-markdown.test.ts` or browser-focused equivalent
- `tests/e2e/chat-formatting.spec.ts` (new)

**Acceptance criteria:**

- Assistant output supports paragraphs, H1-H6, emphasis, inline code, ordered/unordered/nested lists, blockquotes, task lists, GFM tables, horizontal rules, links, backslash escapes, triple-backtick and tilde fences, and language labels.
- Raw HTML remains visible as inert text or is removed according to the documented policy; scripts/events never execute.
- Unsafe links and remote images are not emitted; approved local artifact images continue to work.
- Parser failure falls back to escaped multiline text.
- User messages remain plain text and never execute/render Markdown.

**Verification:**

```bash
npx vitest run tests/gui/client-markdown.test.ts tests/gui/client-stream.test.ts
npx playwright test tests/e2e/chat-formatting.spec.ts
```

### Task 33.4: Make streaming formatting stable

**Status:** Complete (2026-08-30). Added an animation-frame render scheduler
that coalesces token updates, cancels stale pending work, and performs one
synchronous final render before decoration. Verified a 1,000-update batch,
split Markdown delimiters, an incomplete code fence, final-DOM equivalence,
non-duplicated code actions, document/message scroll ownership, bottom-follow,
and preservation after the reader scrolls upward.

**Files likely touched:**

- `src/gui/static/markdown.js`
- `src/gui/static/chat.js`
- `src/gui/static/run-reducer.js`
- `tests/gui/client-stream.test.ts`
- `tests/e2e/chat-formatting.spec.ts`

**Acceptance criteria:**

- Rich rendering is frame/throttle batched rather than performed for every token.
- Split UTF-8, split Markdown delimiters, and incomplete fences converge to the same final DOM as a single complete response.
- Completion performs exactly one decorated final render; code actions are not duplicated.
- Auto-scroll follows only when the user is near the bottom; reading earlier output is not interrupted.

**Verification:**

- Feed the formatting fixture at every byte boundary and compare normalized final DOM.
- Measure render-call count for a 1,000-delta fixture.
- Playwright verifies no visible flicker/duplicate controls and stable scroll position.

### Task 33.5: Redesign response typography and code/table affordances

**Status:** Complete (2026-08-30). Constrained assistant responses to a readable
72ch measure and added distinct heading, nested-list, task-list, blockquote,
rule, and table treatments. Added persistent code toolbars with language labels
and keyboard/touch-visible Copy and HTML Preview actions. Verified long-token
wrapping, local table/code scrolling, preview focus return, and no page-level
overflow with screenshots at 1440x900, 768x1024, 390x844, and 320x720.

**Files likely touched:**

- `src/gui/static/styles.css`
- `src/gui/static/markdown.js`
- `tests/e2e/chat-formatting.spec.ts`

**Acceptance criteria:**

- Body measure stays readable (roughly 65-80 characters), with clear paragraph rhythm and restrained H2/H3 hierarchy.
- Nested lists have visible hierarchy; blockquotes, rules, task states, and tables are distinguishable without relying only on color.
- Tables scroll inside their own wrapper on narrow screens and do not widen the page.
- Code blocks show a language label when known, preserve indentation, scroll horizontally, and expose Copy/Preview controls on keyboard focus and touch, not hover only.
- Long URLs/tokens wrap safely outside code; inline code does not break layout.
- Message actions remain discoverable on touch and keyboard.

**Verification:**

- Playwright screenshots at 1440x900, 768x1024, 390x844, and 320x720.
- Assert `document.documentElement.scrollWidth <= window.innerWidth`.
- Inspect screenshots for hierarchy, contrast, code controls, and table containment.

### Task 33.6: Add accessibility and security regression coverage

**Status:** Complete (2026-08-30). Added native semantic-structure assertions,
stable accessible names and visible keyboard focus checks for code actions, and
verified that streaming announces only concise lifecycle changes. Expanded the
browser XSS corpus across scripts, event handlers, malformed tags, SVG, style
injection, dangerous link schemes, and hostile image sources. The token-bearing
main document now uses `Cache-Control: no-store`, MIME/referrer/frame/permissions
hardening, and a deny-by-default CSP limited to same-origin app resources plus
approved data images. `style-src 'unsafe-inline'` remains narrowly required by
the existing runtime width/textarea style assignments. HTML previews retain
static HTML/CSS rendering in a permissionless sandbox; model-generated scripts
cannot execute.

**Files likely touched:**

- `tests/e2e/chat-formatting.spec.ts`
- `tests/e2e/a11y.spec.ts`
- `tests/gui/server.test.ts`

**Acceptance criteria:**

- Native heading/list/table/blockquote semantics appear in the accessibility tree.
- Every Copy/Preview control has a stable accessible name and keyboard focus style.
- Completion announcements remain concise and do not announce the entire response repeatedly during streaming.
- XSS corpus covers script tags, event handlers, malformed tags, `javascript:`/`data:text/html` URLs, SVG, style injection, and hostile image sources.
- Main document CSP is present and compatible with approved local scripts, styles, images, connections, and sandboxed artifact previews.

**Verification:**

```bash
npx playwright test tests/e2e/chat-formatting.spec.ts tests/e2e/a11y.spec.ts
npx vitest run tests/gui/server.test.ts
```

## Checkpoints

### Checkpoint A: Text integrity (after 33.1)

- Multiline content survives all server/storage paths.
- TUI/CLI sanitization is unchanged.
- Focused GUI and sanitizer tests pass.

### Checkpoint B: Secure semantic rendering (after 33.2-33.4)

- Dependency approval and audit are recorded.
- GFM fixture produces expected semantic DOM.
- XSS fixture remains inert.
- Streamed and complete final DOM are equivalent.

### Checkpoint C: Production UX (after 33.5-33.6)

- Desktop/mobile screenshots reviewed.
- Keyboard, touch, screen-reader, and no-overflow checks pass.
- Full lint, typecheck, unit/integration, E2E, package, runtime, desktop, and Docker gates pass.

## Required Formatting Fixture

One shared fixture should include:

- paragraphs separated by blank lines;
- H1-H4 headings;
- bold, italic, strike, escaped punctuation, inline code, and links;
- nested ordered/unordered lists and task lists;
- blockquote with multiple paragraphs;
- GFM table with alignment and long cells;
- fenced JS/TS/bash/HTML blocks using backticks and tildes;
- an incomplete fence delivered during streaming;
- long unbroken tokens and long URLs;
- approved local image plus rejected remote/file images;
- raw HTML and an XSS payload corpus;
- mixed CRLF/LF, tabs, Unicode, and split multibyte input.

Use this fixture for server preservation tests, complete render tests, byte-fragment streaming tests, accessibility assertions, and visual screenshots so the layers cannot drift.

## Risks and Mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Preserving LF weakens terminal safety | High | Add a GUI-only sanitizer; never change `stripControl()` semantics globally. |
| Markdown introduces DOM XSS | High | Escape/sanitize with a strict allowlist, URL hooks, CSP, and hostile browser fixtures. |
| New dependencies expand install/package size | Medium | Approval gate, exact pinning, license/lifecycle audit, local-only serving, package budgets. |
| Streaming reparses cause jank | Medium | Animation-frame/throttled rendering, final synchronous render, measured render-count test. |
| Tables/code overflow mobile | Medium | Local scroll containers plus viewport-width assertions and screenshots. |
| Rich output becomes visually noisy | Medium | Restrained hierarchy, readable measure, no decorative cards inside messages, fixture review. |
| Stored legacy messages are already flattened | Low | Do not invent lost line breaks; improve only new responses and document the cutoff. |

## Definition of Done

- A stress response produces semantic headings, nested lists, blockquotes, task lists, a table, links, and code blocks in both live streaming and restored history.
- Raw HTML/XSS remains inert and unsafe URLs/images are rejected.
- Desktop and 320-390 px mobile output is readable with no page-level overflow.
- Code actions work with mouse, keyboard, and touch.
- The final DOM is equivalent regardless of SSE fragmentation.
- Existing chat/session/tool/edit behavior is unchanged.
- Full repository and release gates pass.
