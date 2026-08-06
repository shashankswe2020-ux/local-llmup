# Security Audit Report #15

> **Auditor:** Security Auditor Agent (Security Engineer)
> **Date:** 7 August 2026
> **Scope:** B13 self-managed weight-acquisition module — `src/backend/acquire.ts`
> (new), `tests/backend/acquire.test.ts` (new), and its use of `assertSafeFetchUrl`
> from `src/backend/net.ts` (previously audited helper).
> **Dependencies:** 0 production vulnerabilities (`npm audit --omit=dev`). 6 dev-only
> findings (3 moderate, 1 high, 2 critical) all in `vite-node`/`vitest`; not shipped,
> out of scope for this module.

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 0 |
| Medium | 1 |
| Low | 3 |
| Info | 3 |

**Verdict: B13 is SAFE TO SHIP.** The module is fail-closed on integrity, correctly
applies the anti-SSRF guard to the constructed URL, blocks path traversal and
symlink escape, writes owner-only (`0600`/`0700`), and never fabricates
`digestVerified`. The one Medium finding (redirect targets are not re-validated
against the SSRF policy) is a defence-in-depth gap that requires a compromised or
malicious first-hop (Hugging Face, over TLS) to exploit and is further contained by
digest verification; it does not block ship but should be scheduled.

---

## Findings

### [MEDIUM-1] Redirect targets bypass the anti-SSRF policy (`redirect: "follow"` re-validated only on the initial URL)

- **Location:** `src/backend/acquire.ts:99` (`createAcquireFetch` → `fetch(url, { redirect: "follow" })`); guard applied at `src/backend/acquire.ts:200`.
- **Description:** The SSRF guard (`assertSafeFetchUrl`) validates only the *initial*
  resolve URL. The production fetch then follows 3xx redirects with `redirect: "follow"`,
  and Node's `fetch` will follow a `Location` to **any** host — including `http://`,
  a private/loopback address, or a non-allow-listed host — without re-applying the
  policy. Hugging Face `resolve/` URLs legitimately redirect to a CDN, so
  `redirect: "follow"` is necessary; the gap is that intermediate/final hops are
  unchecked.
- **Impact:** A malicious or compromised first hop could redirect the download to a
  private/loopback service (e.g. `http://169.254.169.254/` cloud metadata) or a
  non-HTTPS host. Because no `Authorization` header is ever sent, no credentials
  leak, and the response body is streamed to a local file (not returned to a remote
  attacker), so this is SSRF-to-local-disk rather than data exfiltration. When a
  digest is supplied, substituted bytes fail closed at verification. Residual risk:
  a request is still *issued* to the attacker-chosen host before any content check,
  and — with no digest and no `X-Repo-Commit` header (see LOW-1) — unverified bytes
  from that host would be promoted (reported honestly as `digestVerified: false`).
- **Proof of concept:** Not directly reproducible against real HF (the first hop is
  TLS-authenticated). Conceptually: MITM/compromise of `huggingface.co` returns
  `HTTP/1.1 302 Found\r\nLocation: http://169.254.169.254/latest/meta-data/` →
  `fetch` follows it, opening a connection to the metadata endpoint from the user's
  host.
- **Recommendation:** Re-validate every hop. Switch to `redirect: "manual"`, and on a
  3xx re-run `assertSafeFetchUrl(locationHeader, { allowedHosts: [...] })` before
  following, bounding the redirect count (e.g. ≤ 5). Sketch:
  ```ts
  export function createAcquireFetch(allowedHosts: readonly string[]): AcquireFetch {
    return async (url: string): Promise<FetchResponseLike> => {
      let current = url;
      for (let hop = 0; hop < 5; hop++) {
        const res = await fetch(current, { redirect: "manual" });
        if (res.status < 300 || res.status >= 400) return adapt(res);
        const location = res.headers.get("location");
        if (location === null) return adapt(res);
        // Resolve relative Location against current, then re-apply the SSRF policy.
        current = assertSafeFetchUrl(new URL(location, current).toString(), { allowedHosts }).toString();
      }
      throw new BackendError("too many redirects while acquiring weight");
    };
  }
  ```
  Note the allow-list must include the real HF CDN host(s) the resolve endpoint
  redirects to, or the download will break — confirm the current redirect target and
  add it explicitly rather than widening to `*`.

### [LOW-1] Commit pinning is skipped when the `X-Repo-Commit` header is absent

- **Location:** `src/backend/acquire.ts:205` — `if (resolvedCommit !== null && resolvedCommit.toLowerCase() !== ...)`.
- **Description:** The pinned-commit confirmation only fires when the header is
  present. An upstream (or redirect target) that simply omits `X-Repo-Commit`
  bypasses this secondary control. The URL still pins the commit (`/resolve/<sha>/`),
  so this is a *secondary* check, but combined with a missing expected digest there
  is no post-fetch verification that the bytes correspond to the pinned commit.
- **Impact:** With no digest **and** no header, arbitrary bytes served for the URL are
  promoted. This is surfaced honestly as `digestVerified: false` (the honesty gate is
  respected and the caller owns the serve/no-serve policy), so it is not a silent
  fail-open, but the control is weaker than the header-present path.
- **Recommendation:** Treat a missing `X-Repo-Commit` as a soft integrity signal:
  when **neither** a digest **nor** the header is available, either refuse to promote
  or ensure the calling policy never serves such an artifact. At minimum, document
  that `digestVerified: false` with an absent header means "commit-unconfirmed".

### [LOW-2] No download size cap or request timeout (resource-exhaustion DoS)

- **Location:** `src/backend/acquire.ts:215-224` (streaming pipeline); `src/backend/acquire.ts:100` (`fetch` with no `AbortSignal`).
- **Description:** The stream-to-disk loop accumulates `bytes` but enforces no upper
  bound, and the fetch has no timeout. A compromised/malicious source (reachable via
  MEDIUM-1) could stream unbounded data to fill the user's disk, or stall the
  connection indefinitely (slow-loris). No decompression occurs here, so classic
  zip-bomb amplification does not apply.
- **Impact:** Local disk exhaustion or a hung acquisition. Requires a hostile source;
  weights are legitimately multi-GB, so a naive small cap is not viable.
- **Recommendation:** Pass an expected/maximum size (from the catalog entry, plus a
  small margin) and abort the pipeline once `bytes` exceeds it; attach an
  `AbortSignal` with an idle/overall timeout to the fetch so a stalled transfer fails
  closed. The partial is already discarded on throw.

### [LOW-3] Leftover `.part` temp files can accumulate across crashes

- **Location:** `src/backend/acquire.ts:213` (temp name) and `discard()` at `src/backend/acquire.ts:319`.
- **Description:** On a hard process kill (SIGKILL, power loss) between temp creation
  and rename, `discard()` never runs and a `.<name>.<pid>.<uuid>.part` file remains.
  These are never promoted (they are dotfiles, not `finalPath`, and `flags: "wx"`
  prevents reuse), so this is a housekeeping/disk-usage concern, not an integrity one.
- **Recommendation:** Sweep stale `*.part` files in the repo dir on the next
  acquisition (best-effort `unlink` of dotfiles older than a threshold), or document
  that a future `doctor`/cache-clean step reclaims them.

### [INFO-1] `baseUrl` test seam is not a production SSRF vector

- **Location:** `src/backend/acquire.ts:120,201`.
- **Description:** `AcquireDeps.baseUrl` is injectable and defaults to
  `https://huggingface.co`. It is used only to construct the URL, which then always
  passes through `assertSafeFetchUrl` with `allowedHosts: ["huggingface.co"]`, so even
  an attacker-chosen `baseUrl` cannot reach a non-HTTPS/private/non-allow-listed host.
  Confirmed by grep: `acquireWeight` has no production callers yet and `baseUrl` is
  never wired to catalog or user input.
- **Recommendation:** Keep `baseUrl` test-only. When wiring `acquireWeight` into
  commands, never source `baseUrl` (or `allowedHosts`) from the catalog or CLI input.

### [INFO-2] TOCTOU between the `realpath` cache check and the write is accepted at this trust level

- **Location:** `src/backend/acquire.ts:290-299` (`ensureCacheDir` realpath check) vs. the later `createWriteStream(..., { flags: "wx" })` and `renameSync`.
- **Description:** A same-user attacker could swap a cache component to a symlink
  between the realpath containment check and the write. Only the owning user (or root)
  can modify the `0700` cache tree, so this is out of scope for a single-user local
  tool. It is further mitigated: the temp file uses `flags: "wx"` (`O_EXCL`, no
  symlink follow / no clobber), and `renameSync` replaces a symlink at the destination
  rather than writing through it.
- **Recommendation:** None required; note the accepted assumption (single-user,
  owner-only cache) in the module docs.

### [INFO-3] Intermediate cache directories are correctly owner-only

- **Location:** `src/backend/acquire.ts:288-290` (`mkdirSync(..., { recursive: true, mode: DIR_MODE })`, then `chmodSync(parentDir, DIR_MODE)`).
- **Description:** `mkdirSync({ recursive: true, mode: 0o700 })` applies `0700` to all
  created directories, and `0700` has no group/other bits for umask to matter. The
  final file is `0600` and the leaf dir `0700` (verified by tests). No repo/revision
  directory names leak to other local users. Positive observation, recorded for
  completeness.

---

## Positive Observations

- **Fail-closed integrity is airtight on the download path:** a digest mismatch, a
  wrong `X-Repo-Commit`, a non-`ok` response, or a missing body all throw *before* the
  `renameSync`, the partial is `discard()`-ed, and the artifact is never promoted.
- **`digestVerified` is never fabricated:** it is `true` only after an actual SHA-256
  match (download or cache-hit); a missing expected digest yields `false`, honouring
  the honesty gate.
- **Atomic promotion:** the temp file lives in the destination directory and is moved
  with a same-dir `renameSync` (atomic on POSIX, no cross-device copy), and
  `flags: "wx"` (`O_EXCL`) prevents symlink-follow and clobbering of the temp path.
- **Strong input validation:** repo (`HF_REPO_ID_RE`), revision (40-hex `REVISION_RE`),
  digest (64-hex `SHA256_RE`), and file (`isSafeRepoRelativePath`, rejecting `..`,
  `.`, absolute paths, backslashes, `%`-encoding, control chars, and glob metachars)
  are all validated before use; the file is additionally per-segment
  `encodeURIComponent`-encoded when building the URL.
- **Defence-in-depth path containment:** textual `isWithin` on the composed path,
  plus a `realpath`-based containment check that refuses cache components resolving
  outside the cache root (symlink escape), plus an `lstat` symlink refusal at the
  final path — all exercised by tests.
- **SSRF guard correctly applied:** the constructed URL is passed through
  `assertSafeFetchUrl` with an explicit `["huggingface.co"]` allow-list (HTTPS-only,
  no credentials, standard port, no private/loopback host), tested against
  `http://169.254.169.254` and `https://evil.example.com`.
- **No secrets:** the module sends no `Authorization` header and logs nothing; error
  messages carry only repo/revision/file/digest (all non-secret), and
  `assertSafeFetchUrl` redacts URLs in its messages.
- **Stream-based, no full-buffer:** bytes are hashed and written incrementally,
  avoiding buffering a multi-GB artifact into memory.
- **0 production dependency vulnerabilities.**

---

## Action Items (Priority Order)

| # | Severity | Finding | Recommendation |
|---|----------|---------|----------------|
| 1 | Medium | Redirects not re-validated against SSRF policy | Use `redirect: "manual"`, re-run `assertSafeFetchUrl` on each `Location`, bound hop count; add real HF CDN host(s) to the allow-list |
| 2 | Low | Commit check skipped when `X-Repo-Commit` absent | Refuse promotion (or ensure caller never serves) when neither digest nor header confirms the commit |
| 3 | Low | No size cap / fetch timeout | Enforce a max byte bound from catalog size + margin; attach an `AbortSignal` timeout |
| 4 | Low | Stale `.part` files on crash | Best-effort sweep of stale dotfile partials on next acquisition or in a cache-clean step |
| 5 | Info | `baseUrl` test seam | Keep `baseUrl`/`allowedHosts` test-only; never source from catalog/CLI when wiring callers |
