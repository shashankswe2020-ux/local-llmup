# Security Audit Report #27

> **Auditor:** Security Auditor Agent (Security Engineer)
> **Date:** 2026-08-09
> **Scope:** Final U1d-only re-audit of read-only visual and accessible screens, model picker, cooked input queue, CLI routing/failure semantics, output authority, immutability/capability boundaries, and at-most-once execution
> **Dependencies:** 6 known vulnerabilities (`npm audit`: 2 critical, 1 high, 3 moderate; development toolchain only); 0 production vulnerabilities (`npm audit --omit=dev`)

---

## Summary

| Severity | Count |
| -------- | ----- |
| Critical | 0     |
| High     | 0     |
| Medium   | 0     |
| Low      | 0     |
| Info     | 0     |

---

## Findings

No Critical, High, Medium, Low, or Info findings remain in the reviewed U1d scope.

---

## Positive Observations

- Accessible full documents and dynamic list/detail/help responses are passed through the 256 KiB document bound; list screens expose at most 20 rows per response and nested evidence is bounded.
- The accessible model picker displays only the first 20 sanitized identifiers, validates 1–1,000 unique canonical choices, and rejects model IDs over 8,192 UTF-8 bytes.
- Cooked input never enables raw mode, incrementally bounds each line, retains at most 200 lines and 50 KiB, applies stream backpressure, and restores a pause it owns during close.
- Explicit visual initialization/runtime failures fail closed, while automatic renderer failures use stable notices and preserve one authoritative plain result without rerunning collection.
- Display-only command text is ignored as stdout authority; the final stdout result is always produced by the existing plain formatter from the single collected domain result.
- Read-only U1d paths expose projected immutable view models rather than backend, filesystem, state mutation, or process capabilities; visual actions only navigate, filter, compare, display details, print presentation text, or exit.
- Full verification passed: 77 files and 1,303 tests, type checking, repository lint, build, package dry-run, and `git diff --check`.
- A built no-color pseudo-TTY smoke rendered the recommendation screen, accepted quit, restored terminal state, emitted no color SGR, and left no child process.
- Production dependencies have zero known vulnerabilities, sensitive environment files are ignored, no `.env` or `tokens.json` history was found, and no U1d console logging can disclose secrets.

---

## Action Items (Priority Order)

| #   | Severity | Finding | Recommendation |
| --- | -------- | ------- | -------------- |
| —   | —        | None    | U1d security gate may proceed. |
