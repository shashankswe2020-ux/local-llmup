# Security Audit Report #10

> **Auditor:** Security Auditor Agent (Security Engineer)
> **Date:** 6 August 2026
> **Scope:** Uncommitted working-tree changes for task **B7** of the
> pluggable-backends plan — extending the catalog `ModelSource` schema (external,
> untrusted JSON) with optional `gguf{repo,revision,file,sha256}` and
> `mlx{repo,revision}` sub-schemas. Files audited:
> [src/catalog/schema.ts](../../src/catalog/schema.ts),
> [src/types.ts](../../src/types.ts). Supporting context read:
> [tests/catalog/schema.test.ts](../../tests/catalog/schema.test.ts),
> [docs/specs/pluggable-inference-backends.md](../specs/pluggable-inference-backends.md) §2.4.
> **Dependencies:** 6 known vulnerabilities (`npm audit`: 2 critical, 1 high,
> 3 moderate) — all in the **dev-only** `vitest → vite → vite-node → esbuild`
> chain. None ship in the runtime package (runtime deps: `cac`, `zod`,
> `systeminformation`). Pre-existing and out of scope for B7 (see INFO-2).

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High     | 0 |
| Medium   | 1 |
| Low      | 2 |
| Info     | 2 |

**Verdict:** The B7 validators are strong and well-tested. The anchored regexes
are ReDoS-free, `.strict()` is applied to every new object, and the `file` /
`repo` / `revision` validators correctly reject the traversal, absolute-path,
glob, multi-slash, leading-dash, and non-ASCII/homoglyph vectors called out in
the review request. **No Critical or High findings.** The one Medium item is an
integrity divergence from the spec (`gguf.sha256` made optional); the two Low
items are boundary-hardening gaps (case-insensitive revision, unrejected control
characters in `file`). The remaining items are guidance for the not-yet-written
download flow, where the true SSRF / URL-traversal defenses must live.

---

## Threat Model

The catalog (`data/models.json`) is treated as **untrusted input**: it can be
regenerated from a network-sourced registry snapshot (`catalog/bootstrap`,
`registry-snapshot`), so a compromised or man-in-the-middled refresh could inject
malicious `source.gguf`/`source.mlx` values. These values later:

1. compose an HTTPS download URL (`https://huggingface.co/<repo>/resolve/<revision>/<file>`), and
2. compose a local cache path (`~/.local-llmup/cache/<backend>/<repo>@<revision>/<file>`).

The relevant attacker goals are: **path traversal / arbitrary file write** (via
`file` or `repo`), **SSRF / host-spoofing** (via `repo`), **pin bypass** (via
`revision`), and **serving unverified weights** (via a missing digest → malicious
GGUF → potential parser RCE in llama.cpp/LM Studio).

---

## Focus-Area Verification

### Path traversal / glob injection via `file` — PASS (with a Low gap)

`isSafeModelFile` ([src/catalog/schema.ts:30](../../src/catalog/schema.ts#L30)) rejects:

- glob metacharacters `* ? [ ] { }` — `/[*?[\]{}]/`,
- backslashes (Windows separators / escape confusion),
- leading `/` (absolute paths),
- any empty segment (blocks `//`, leading/trailing `/`),
- `.` and `..` **path segments** (blocks traversal).

Because the check splits on ASCII `/` and requires every segment to be non-empty
and neither `.` nor `..`, no traversal sequence survives, and a safe
subdirectory path (`subdir/model.gguf`) is still allowed. Unicode look-alike
separators (e.g. U+FF0F `／`) are treated as ordinary in-segment characters by
both `split("/")` and the POSIX filesystem, so they cannot introduce a
separator. **Gap:** control characters (NUL, `\n`, `\t`) are not rejected — see
LOW-2.

### Repo-spoofing / SSRF precursor via `repo` — PASS (schema layer)

`HF_REPO_ID_RE` ([src/catalog/schema.ts:18](../../src/catalog/schema.ts#L18)),
anchored `^…$`, capped at 200 chars, correctly rejects every requested vector:

| Input | Result | Why |
| --- | --- | --- |
| `../x` | reject | first char must be `[a-zA-Z0-9]`; `.` fails |
| `/absolute/path` | reject | leading `/` fails first char class |
| `-leading/name` | reject | leading `-` fails first char class |
| `owner\name` | reject | `\` not in class, and no `/` present |
| `owner/name/extra` | reject | second segment excludes `/`, so `$` fails |
| `оwner/name` (Cyrillic о) | reject | class is ASCII-only; no `u` flag |
| `owner/name\n` | reject | JS `$` (non-`m`) does not match before a trailing newline |

Note the schema is a **necessary precursor, not the SSRF control**: `repo =
"evil.com/x"` is a *syntactically valid* HF id and, composed into
`https://huggingface.co/evil.com/x/resolve/…`, stays under the fixed host — but
only if the download flow hardcodes the `huggingface.co` origin and does not let
`repo` influence scheme/host or follow cross-host redirects. See INFO-1.

### Pinning integrity via `revision` — PASS (with a Low nuance)

`REVISION_RE = /^[0-9a-f]{40}$/i` ([src/catalog/schema.ts:16](../../src/catalog/schema.ts#L16))
enforces exactly 40 hex characters, rejecting floating refs (`main`, `HEAD`,
`v1.0`) and off-length values, as the tests confirm. The `/i` flag is a minor
concern for cache-path determinism/collision — see LOW-1.

### ReDoS — PASS

All new regexes are linear:

- `REVISION_RE` — fixed-count `{40}`, no unbounded quantifier, no backtracking.
- `HF_REPO_ID_RE` — two `[…]*` quantifiers separated by a literal `/` that is
  **not** in either character class, so there is no overlap/ambiguity and no
  catastrophic backtracking; additionally bounded by `min(1).max(200)`.
- `isSafeModelFile` — a single-pass character-class test plus a linear
  `split("/")`, bounded by `max(255)`.

### `.strict()` + ≥1-source refine — PASS

Both sub-schemas and `ModelSourceSchema` use `.strict()`, so unknown/smuggled
keys are rejected (tests cover `rogue: true`). The `.refine` still requires at
least one of `ollama | hf | gguf | mlx`. No structural gap found.

---

## Findings

### [MEDIUM-1] `gguf.sha256` is optional — weakens per-source integrity vs. spec

- **Location:** [src/catalog/schema.ts:52](../../src/catalog/schema.ts#L52) (`sha256: z.string().regex(SHA256_RE).optional()`), mirrored by [src/types.ts:131](../../src/types.ts#L131) (`readonly sha256?: string`).
- **Description:** Spec §2.4 defines the per-source GGUF digest as **required**
  (`readonly sha256: string; // digest of that exact GGUF file`), precisely
  because review findings H1–H3 established that a single Ollama `quant.sha256`
  (a manifest-layer digest) cannot verify a raw GGUF file — each self-managed
  source must carry its own digest. The schema instead makes it optional,
  re-opening the possibility of a catalog `gguf` source that ships **no digest**.
- **Impact:** When the (future) `up`/`switch` download flow encounters a GGUF
  source with no `sha256`, it must fall back to size-only verification. For a raw
  file fetched from a third-party HF repo, a size floor is a very weak control:
  any sufficiently large file passes. A compromised catalog refresh could then
  cause an unverified GGUF to be served to llama.cpp / LM Studio, where malformed
  GGUF has historically driven parser memory-corruption / RCE. This is the exact
  fail-open the per-source-digest design was meant to close.
- **Proof of concept:** A malicious catalog entry
  `{"source":{"gguf":{"repo":"attacker/x","revision":"<40hex>","file":"m.gguf"}}}`
  validates today (sha256 omitted). Integrity then rests solely on whatever
  size-floor the download flow applies.
- **Severity rationale:** Not High because (a) it requires a compromised catalog
  (in the threat model, but a meaningful precondition), and (b) the dangerous
  step — actually serving — lives in a download flow not yet written; the
  domain principle explicitly permits a documented “size-floor fallback.” It
  becomes **High** if that flow ever treats size-floor as sufficient for raw
  GGUFs or marks such weights `digestVerified: true`.
- **Recommendation:** Prefer making the digest **required** to match the spec:

  ```ts
  const GgufSourceSchema = z
    .object({
      repo: HfRepoIdSchema,
      revision: z.string().regex(REVISION_RE, { message: "revision must be a 40-hex commit SHA" }),
      file: z.string().min(1).max(255).refine(isSafeModelFile, { /* … */ }),
      sha256: z.string().regex(SHA256_RE), // required — per-source digest (spec §2.4, H1–H3)
    })
    .strict();
  ```

  If an optional digest is a deliberate honesty-gate concession, document it in
  the spec and add a schema-level comment, and make the download flow
  **fail-closed**: absent `sha256` ⇒ record `digestVerified: false`, emit a
  visible `unknown`/warning, and never promote a size-floor pass to “verified.”

### [LOW-1] Case-insensitive `revision` allows cache-path collision / non-determinism

- **Location:** [src/catalog/schema.ts:16](../../src/catalog/schema.ts#L16) (`/^[0-9a-f]{40}$/i`).
- **Description:** Git commit SHAs are canonically lowercase, but `/i` also
  accepts `A`–`F`. Two catalog entries whose revisions differ only in case are
  distinct on a case-sensitive filesystem yet collide in the
  `…/<repo>@<revision>/…` cache directory on case-insensitive filesystems
  (default macOS APFS, Windows NTFS). This undermines the determinism principle
  and could enable a subtle cache-mixing where one revision’s verified file is
  reused under a different revision string.
- **Impact:** Cross-platform non-determinism and a low-likelihood cache-reuse /
  poisoning edge; requires a crafted catalog. No direct code execution.
- **Recommendation:** Require canonical lowercase and/or normalize before the
  value is ever used in a path:

  ```ts
  const REVISION_RE = /^[0-9a-f]{40}$/; // drop /i — SHAs are lowercase
  // …
  revision: z
    .string()
    .regex(REVISION_RE, { message: "revision must be a 40-hex commit SHA (lowercase)" }),
  ```

  If accepting uppercase input is desirable, keep `/i` but add
  `.transform((r) => r.toLowerCase())` so downstream path composition is
  deterministic.

### [LOW-2] `isSafeModelFile` accepts control characters / NUL / newline in `file`

- **Location:** [src/catalog/schema.ts:30](../../src/catalog/schema.ts#L30).
- **Description:** The validator blocks globs, backslashes, absolute paths, and
  `.`/`..` segments, but a segment may still contain non-printable characters —
  e.g. `"weights\u0000.gguf"`, `"a\nb.gguf"`, or a bare tab all pass. NUL bytes
  will be rejected later by Node’s `fs` (fail-closed), but newlines/tabs survive
  into log lines (log-injection / spoofed output) and into URL construction.
- **Impact:** Low — primarily log injection and defense-in-depth; no traversal.
- **Recommendation:** Reject control characters at the boundary and constrain to
  a conservative printable set:

  ```ts
  function isSafeModelFile(f: string): boolean {
    if (f.length === 0) return false;
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(f)) return false; // control chars / NUL
    if (/[*?[\]{}]/.test(f)) return false;
    if (f.includes("\\")) return false;
    if (f.startsWith("/")) return false;
    return f.split("/").every((seg) => seg.length > 0 && seg !== "." && seg !== "..");
  }
  ```

### [INFO-1] Download-flow guidance — where the real SSRF / URL-traversal defenses must live

The schema constrains syntax but cannot enforce runtime origin safety. When the
GGUF/MLX download flow is implemented, it must:

- **Hardcode** the `https://huggingface.co` origin; never derive scheme/host from
  `repo`.
- **Percent-encode each path segment** of `repo`/`file` (`encodeURIComponent`)
  so values like `file = "a%2e%2e/b"` cannot be decoded into `..` server-side.
- **Reject cross-host redirects** (do not follow a 3xx to a non-`huggingface.co`
  host) to prevent redirect-based SSRF/exfiltration.
- **Recompose the cache path with `path.join` + a post-`path.resolve` prefix
  check** (assert the resolved path stays under `~/.local-llmup/cache/`) as
  defense-in-depth behind the schema validators.
- Enforce the MEDIUM-1 fail-closed digest behavior.

### [INFO-2] Dev-only dependency CVEs (pre-existing, out of B7 scope)

`npm audit` reports 6 vulnerabilities (2 critical, 1 high, 3 moderate), all in
the `vitest → @vitest/mocker → vite → vite-node → esbuild` dev chain (e.g.
`GHSA-5xrq-8626-4rwp` vitest UI arbitrary file read/exec, `GHSA-fx2h-pf6j-xcff`
vite `server.fs.deny` bypass). None of these ship in the runtime package (runtime
deps are `cac`, `zod`, `systeminformation`). Carried over from prior audits;
track separately from B7.

---

## Positive Observations

- **Anchored, ReDoS-free regexes.** `HF_REPO_ID_RE` and `REVISION_RE` are fully
  anchored, length-bounded, and free of overlapping quantifiers — no
  catastrophic backtracking is possible.
- **Traversal-hardened `file` validator.** Rejecting globs, backslashes,
  absolute paths, empty segments, and `.`/`..` segments closes the standard
  path-traversal vectors while still allowing legitimate subdirectory files.
- **Strong pinning.** `revision` is forced to a 40-hex commit SHA, rejecting
  floating tags/branches (`main`, `HEAD`) exactly as the spec demands.
- **`.strict()` everywhere.** Both sub-schemas plus `ModelSourceSchema` reject
  unknown keys, preventing field smuggling; the ≥1-source refine still holds.
- **Excellent negative-test coverage.** The new tests exercise traversal,
  glob, absolute-path, backslash, multi-slash, leading-dash, off-length-hex, and
  floating-ref cases — a genuine boundary-focused test suite.
- **Type/schema alignment.** `AssertAssignable` keeps the Zod output conformant
  to the domain `Catalog` type, guarding against a loosened schema silently
  widening the inferred type.

---

## Action Items (Priority Order)

| # | Severity | Finding | Recommendation |
|---|----------|---------|----------------|
| 1 | Medium | `gguf.sha256` optional diverges from spec §2.4 | Make digest required, or document the concession and make the download flow fail-closed (`digestVerified:false` + warn) |
| 2 | Low | Case-insensitive `revision` → cache collision/non-determinism | Drop `/i` (lowercase-only) or `.transform(toLowerCase)` |
| 3 | Low | `isSafeModelFile` allows control chars / NUL / newline | Reject `[\u0000-\u001f\u007f]` at the boundary |
| 4 | Info | SSRF / URL-traversal defenses belong in the download flow | Hardcode HF origin, encode segments, block cross-host redirects, resolve-prefix-check cache path |
| 5 | Info | Dev-only dependency CVEs | Track/update vitest/vite chain separately; not shipped at runtime |

---

## Unresolved Findings From Prior Audits

No open Critical/High findings from audits #1–#9 fall within the B7 scope
(catalog schema / integrity). The dev-dependency CVEs (INFO-2) recur across
recent audits and remain a standing tracking item, not a B7 regression.
