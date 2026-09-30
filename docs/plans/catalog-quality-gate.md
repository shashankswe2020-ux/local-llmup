# Catalog Quality Release Gate

## Approved Policy

Approved on 2026-09-30: every future catalog publication must independently score
at least 90% for freshness and correctness. The evidence window is seven days.
Ollama local variants are the required upstream scope; other backends use
explicit curated scopes. Cloud-only variants and duplicate aliases are excluded
by the reviewed inventory, not silently dropped by the evaluator.

Freshness is the lesser of upstream coverage and catalog verification recency.
Correctness measures the fraction of entries whose required facts agree with
recent, cited, reviewed observations and have pinned artifact integrity.
Unknown inventory blocks publication. Known contradictions and malformed
catalogs/evidence block regardless of percentage. Unknown optional KV geometry
or performance evidence is not fabricated to improve a score.

## Implementation

- [x] Runtime evaluator with bounded typed evidence, exact integer threshold
  decisions, source binding, timestamp checks, and per-entry diagnostics.
- [x] Offline `cargo catalog-quality` returns JSON and nonzero on a failing gate.
- [x] `cargo catalog-sign` requires quality evidence and recomputes both gates
  before key reads; low or unknown scores never produce a catalog artifact.
- [x] Signed quality sidecar binds the catalog artifact SHA-256, original
  evidence bytes, revision, publication-time evaluation and all score counts.
- [x] Publish workflow checks quality before signing and publishes both assets.
- [x] Evidence baseline explicitly contains no assertions; do not backdate or
  fabricate a passing report for catalog revision 1.
- [x] Full workspace tests, build, formatting, lint, packaging and retirement.
- [ ] Review and merge policy branch before claiming the gate is enforced live.
- [ ] Populate/review authoritative inventory and observations before the next
  catalog publication. This operational audit is not satisfied by tests.

## Verification

Focused tests cover exact 90% versus 89%, stale/missing evidence, unknown or
incomplete inventory, missing upstream variants, hard metadata contradictions,
future dates, duplicate records, unrelated citations, exact seven-day cutoff,
signed artifact binding and signer refusal without creating output files.

The policy introduces an evidence schema and signed sidecar, not a new catalog
wire format. Existing v2.1.0 readers remain compatible; they do not display or
enforce the sidecar themselves. Enforcement is at publication/signing time.

Evidence is a maintainer-reviewed attestation, not automatic proof of upstream
truth. No network collector or universal Ollama tag enumerator is claimed.
The live evidence file is initially empty, so correctness verification coverage
is zero and freshness is unknown. Publication remains fail-closed until a
reviewed audit meets both thresholds. Advice remains deterministic and offline.

## Verification Record

On 2026-09-30, all workspace tests, build, Clippy with warnings denied,
formatting and native-retirement checks passed. All four packages verified in a
fresh target directory; an initial package attempt reused stale v2.1.0 artifacts
from the earlier release rehearsal, so that result was discarded and repeated
with an isolated temporary registry/build directory.

The real empty-evidence baseline returned nonzero, 67 catalog entries, zero
fresh/verified observations, unknown freshness and 0% correctness verification
coverage. No passing score was assigned to revision 1. No catalog or crates were
published for this policy change. Unrelated concurrent Homebrew formula edits
remain outside this feature's scope.