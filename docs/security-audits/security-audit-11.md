# Security Audit Report #11

> **Auditor:** Security Auditor Agent (Security Engineer)
> **Date:** 6 August 2026
> **Scope:** Uncommitted working-tree changes for task **B9** of the
> pluggable-backends plan — widening the curated performance-dataset schema
> (`data/perf.json`, external JSON parsed at load) with an optional
> `efficiencyByBackend` numeric map plus a provenance object
> (`value`, `trustTier`, `basisBytesPerToken`, `url`), and threading an optional
> `backend` through the throughput estimator. Files audited:
> [src/advisor/perf-data.ts](../../src/advisor/perf-data.ts),
> [src/advisor/throughput.ts](../../src/advisor/throughput.ts). Supporting
> context read: [src/advisor/verdict.ts](../../src/advisor/verdict.ts),
> [src/sanitize.ts](../../src/sanitize.ts), [src/types.ts](../../src/types.ts),
> [docs/specs/pluggable-inference-backends.md](../specs/pluggable-inference-backends.md) §12.
> **Dependencies:** 6 known vulnerabilities (`npm audit`: 2 critical, 1 high,
> 3 moderate) — all in the **dev-only** `vitest → vite → vite-node → esbuild`
> chain. None ship in the runtime package (runtime deps: `cac`, `zod`,
> `systeminformation`). Pre-existing, unchanged by B9 (see INFO-1). Zod version
> resolved: `3.25.76`.

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High     | 0 |
| Medium   | 1 |
| Low      | 2 |
| Info     | 1 |

**Verdict:** The B9 change is well-constructed and defensively coded. The
reviewer's primary concern — that a nested provenance `url` might bypass the
`stripControl` / `rejectOnSanitize` integrity path — is **not present**: the new
field is fully covered (see Positive Observations). `.strict()` is applied to
the provenance object, the `z.record(z.enum(BACKEND_NAMES), …)` keys reject
unknown backends, the new validators are ReDoS-free, and the honesty gate holds
for the *runtime* resolution path (an absent `(class, backend)` scalar yields
`known:false`). **No Critical or High findings.**

The one Medium item is an **integrity / honesty-gate structural gap**: the
numeric scalar that actually drives the estimate is validated *independently* of
its provenance object, so the schema will accept an **uncited** efficiency figure
and produce a throughput number from it — contradicting spec §12 ("every
efficiency figure must be cited"). The two Low items are defense-in-depth
hardening (URL scheme allowlist, string length bounds).

---

## Findings

### [MEDIUM-1] Numeric efficiency scalar is decoupled from its provenance — an uncited figure still produces a throughput number

- **Location:** [src/advisor/perf-data.ts:86-108](../../src/advisor/perf-data.ts#L86-L108) (`PerfClassSchema`), consumed at [src/advisor/throughput.ts:55-58](../../src/advisor/throughput.ts#L55-L58) (`resolveEfficiency`).
- **Description:** The estimator reads the number that appears in the class-level
  `efficiencyByBackend` map (`EfficiencyByBackendSchema = z.record(z.enum(BACKEND_NAMES), EFFICIENCY)`).
  The provenance object (`value` / `trustTier` / `basisBytesPerToken` / `url`)
  lives in a **separate, independently-optional** field,
  `sources.efficiencyByBackend`, and is **never referenced** by `resolveEfficiency`.
  `PerfClassSchema` carries only one `.refine` (`maxBytes > minBytes`); there is
  **no cross-field refinement** asserting that every numeric scalar key has a
  matching provenance key, nor that `provenance.value === scalar`. Consequently
  the schema accepts a class such as:

  ```jsonc
  {
    "efficiencyByBackend": { "ollama": 0.99 },   // drives the DEFAULT advice path
    "sources": { "bandwidth": "…", "efficiency": "…" }  // no efficiencyByBackend provenance
  }
  ```

  and `estimateTokPerSec(..., { backend: "ollama" })` will emit a concrete
  `tok/s` range from the uncited `0.99`.
- **Impact:** This is a **fail-open on the honesty gate**, a non-negotiable
  domain principle ("when a figure can't be sourced … output `unknown` — never
  fabricate a number"). Because an explicit scalar *overrides* the shared-class
  rule, an uncited scalar for `ollama`/`llamacpp` silently alters the default
  advice-path number, and an uncited scalar for `mlx`/`lmstudio` manufactures a
  figure that the resolution rule was specifically designed to withhold. The
  vector is a malformed or maliciously-edited `data/perf.json` (the bundled
  dataset, or a user-supplied `--perf`/non-default path where `rejectOnSanitize`
  is off). Not remotely exploitable; scope is dataset integrity, hence Medium.
- **Proof of concept:** Add the JSON above to a perf dataset and load it via
  `loadPerf`. `rejectOnSanitize` only inspects control characters, so it does not
  fire; `assertUniqueIds`/`assertNoOverlap` are orthogonal. The row validates and
  the estimator returns a number with no citation backing it.
- **Recommendation:** Enforce the "every figure is cited" invariant at the schema
  boundary with a `superRefine` on `PerfClassSchema` that, for every key present
  in `efficiencyByBackend`, requires a matching key in `sources.efficiencyByBackend`
  and (ideally) `provenance.value === scalar`:

  ```ts
  .superRefine((c, ctx) => {
    const scalars = c.efficiencyByBackend ?? {};
    const prov = c.sources.efficiencyByBackend ?? {};
    for (const [backend, value] of Object.entries(scalars)) {
      const p = prov[backend as keyof typeof prov];
      if (p === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["efficiencyByBackend", backend],
          message: `efficiencyByBackend.${backend} has no provenance in sources.efficiencyByBackend`,
        });
      } else if (p.value !== value) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["efficiencyByBackend", backend],
          message: `efficiencyByBackend.${backend} (${value}) disagrees with its cited provenance value (${p.value})`,
        });
      }
    }
  })
  ```

  This makes the honesty gate a structural guarantee rather than a curation
  convention, and closes the gap between "the estimator uses this number" and
  "this number is sourced."

### [LOW-1] `z.string().url()` accepts dangerous schemes and credential-bearing citation URLs

- **Location:** [src/advisor/perf-data.ts:59](../../src/advisor/perf-data.ts#L59) (`url: z.string().url()` in `EfficiencyProvenanceSchema`).
- **Description:** In zod 3.x, `.url()` validates by constructing `new URL(value)`,
  which accepts `javascript:alert(1)`, `data:text/html,…`, `file:///etc/passwd`,
  and credential-embedding forms such as `https://user:pass@host/…`. `stripControl`
  removes ANSI/control/BiDi bytes but does **not** constrain the URL scheme, so a
  hostile citation URL passes both schema and sanitize.
- **Impact:** Currently **latent** — provenance URLs are validated but not yet
  rendered anywhere (they are display-only citations, never fetched in the advice
  path, and `resolveEfficiency` ignores them). The risk materializes the moment
  any surface renders these URLs: an HTML sink (e.g. the `site/` page) turning a
  `javascript:` citation into an `href` is stored XSS; a terminal that
  auto-linkifies `file:`/`data:` URIs is a lesser lure. Defense-in-depth: pin the
  scheme now, before a consumer exists.
- **Proof of concept:** `EfficiencyProvenanceSchema.parse({ value: 0.7, trustTier: "spec-grade", basisBytesPerToken: 4.4e9, url: "javascript:fetch('//evil')" })` succeeds today.
- **Recommendation:** Restrict to `http(s)` and reject credentials/length abuse:

  ```ts
  url: z
    .string()
    .max(512)
    .url()
    .refine((u) => {
      try {
        const { protocol, username, password } = new URL(u);
        return (protocol === "https:" || protocol === "http:") && !username && !password;
      } catch {
        return false;
      }
    }, { message: "citation url must be an http(s) URL without embedded credentials" }),
  ```

### [LOW-2] No maximum length on provenance `url` (and sibling citation strings)

- **Location:** [src/advisor/perf-data.ts:59](../../src/advisor/perf-data.ts#L59) (`url`), consistent with the pre-existing unbounded `label`/`bandwidth`/`efficiency` strings ([perf-data.ts:74-78](../../src/advisor/perf-data.ts#L74-L78)).
- **Description:** None of the free-form dataset strings carry a `.max()`. A
  pathological dataset could embed multi-megabyte strings. For the bundled,
  trusted `data/perf.json` this is a non-issue; for a user-supplied
  non-default path it is bounded by available memory only.
- **Impact:** Minor local resource pressure; not a regression (matches existing
  fields). Bounding input at the boundary is cheap defensive hygiene.
- **Recommendation:** Add `.max(512)` to `url` and modest caps (e.g. `.max(200)`)
  to `label`/`bandwidth`/`efficiency` when convenient. Folded into LOW-1's
  snippet for `url`.

---

## Positive Observations

- **Reviewer's sanitize concern is fully addressed — no bypass.** `cleanProvenance`
  ([perf-data.ts:139-148](../../src/advisor/perf-data.ts#L139-L148)) routes every
  provenance `url` through the same `clean()` closure that flips the shared
  `changed` flag, and it is invoked for every class whose
  `sources.efficiencyByBackend` is present ([perf-data.ts:149-159](../../src/advisor/perf-data.ts#L149-L159)).
  A control/ANSI/BiDi byte in any provenance URL therefore trips
  `rejectOnSanitize` for the bundled dataset exactly like the top-level citation
  strings. The other provenance fields cannot smuggle escapes: `trustTier` is a
  fixed `z.enum`, and `value`/`basisBytesPerToken` are numbers — `url` is the only
  free string, and it is covered. **No gap.**
- **`.strict()` and enum-keyed records reject unknown keys.**
  `EfficiencyProvenanceSchema` is `.strict()`, so unknown provenance keys are
  rejected; `z.record(z.enum(BACKEND_NAMES), …)` validates each key against the
  backend enum, so unknown backend keys are rejected on both the numeric map and
  the provenance map. Partial (optional per-backend) coverage is preserved.
- **ReDoS-free.** No new custom regexes are introduced; `z.string().url()` uses
  the native WHATWG `URL` parser (not a backtracking regex), and the reused
  `stripControl` patterns are linear character classes/alternations with no nested
  quantifiers.
- **Honesty gate holds on the runtime resolution path.** `resolveEfficiency`
  returns `undefined` for any backend that is neither present in the class's
  numeric `efficiencyByBackend` nor in `{ollama, llamacpp}`, and
  `estimateTokPerSec` maps that to `UNKNOWN` — so `recommend --backend mlx` on a
  class with no `mlx` scalar correctly yields `known:false` rather than a guess.
  (MEDIUM-1 concerns the orthogonal case where a scalar *is* present but uncited.)
- **Schema error messages are sanitized** before surfacing
  (`stripControl(result.error.message)`, [perf-data.ts:210](../../src/advisor/perf-data.ts#L210)),
  and the control-character rejection message does not echo attacker input.
- **Byte-identical default path.** `backend` defaults to `ollama` and threads
  through `verdict.ts` without altering existing call sites, minimizing blast
  radius.

---

## Action Items (Priority Order)

| # | Severity | Finding | Recommendation |
|---|----------|---------|----------------|
| 1 | Medium | Numeric scalar decoupled from provenance; uncited figure still emits a number | Add `superRefine` requiring provenance for every scalar key and `value` agreement (MEDIUM-1) |
| 2 | Low | `z.string().url()` accepts `javascript:`/`data:`/`file:`/credential URLs | Restrict to http(s), reject embedded credentials (LOW-1) |
| 3 | Low | Unbounded provenance/citation string length | Add `.max()` bounds at the boundary (LOW-2) |

---

## Info

### [INFO-1] Dev-only dependency vulnerabilities (pre-existing, out of scope)

`npm audit` reports 6 vulnerabilities (2 critical, 1 high, 3 moderate), all in
the `vitest → vite → vite-node → esbuild` dev chain. None are runtime
dependencies of the published package (`cac`, `zod`, `systeminformation`), so
they do not affect installed users. Unchanged by B9; tracked in prior audits
(#10 INFO-2). Recommend a scheduled `devDependencies` bump when a
non-breaking upgrade path is available.
