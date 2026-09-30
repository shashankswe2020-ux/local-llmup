# Catalog Freshness and Correctness Policy

## Release Requirements

Both scores must independently be at least 90%. A high score cannot compensate
for the other being below threshold. Decisions use exact integer counts, not
rounded display percentages. Scores apply at the recorded publication time;
they are not a claim that a historical release stays fresh forever.

| Metric | Definition |
| --- | --- |
| Upstream coverage | Represented eligible variants / all eligible variants in the declared, complete upstream inventories |
| Verification recency | Catalog entries checked within the preceding seven days / all catalog entries |
| Freshness | Minimum of coverage and verification recency |
| Correctness | Entries with recent matching required facts and pinned integrity / all catalog entries |

Correctness is **evidence verification coverage**, not a statistical guarantee
that 90% of real-world behavior is correct. For a 67-entry catalog, at least 61
entries must be recently verified, and upstream coverage must separately pass.
Entries without observations remain in the denominator. A new `generatedAt`
does not make old evidence fresh. Seven days is inclusive to the second;
future-dated checks are invalid.

Known contradictory facts, invalid catalog/evidence schemas, and mismatched
artifact pins block publication even when both computed scores are >= 90%.
Missing integrity evidence does not count as verified. Unknown optional KV
geometry and performance values remain unknown. Existing claimed geometry or
benchmark facts must agree with the submitted observation. Derived RAM/VRAM
allowances and transient digest-verification flags are excluded from comparison.

## Evidence Collection and Review

Edit `docs/references/catalog-quality-evidence.json` only after collecting and
reviewing authoritative evidence. The initial empty document is intentional:
it yields unknown freshness, 0% verification coverage, and a blocked release.
It does not mean that all catalog facts are incorrect. Revision 1 predates this
policy and must not be retroactively labelled as passing it.

The evaluator is offline. It checks the submitted evidence, but it does not
fetch sources or establish that a maintainer actually visited them. Reviewers
must verify observations and inventory completeness independently. Copying the
catalog into observations or merely citing a URL is not an audit. This trust
boundary is the same reviewed-main and protected-signing boundary as publication.

Evidence is a strict JSON object:

```json
{
  "policyVersion": 1,
  "scopes": [],
  "observations": []
}
```

Each scope contains `name`, `checkedAt` (RFC3339), `source` (HTTPS), `complete`
and `variants` (unique canonical catalog IDs). `ollama-local-variants` is
mandatory. Other backends must have explicit curated inventories; every catalog
entry must appear in the union. Record eligible missing variants too, using the
canonical ID they would receive on admission. Do not shrink the inventory to
only already-catalogued models to improve coverage.

For Ollama, review local model variants from its library/tag listings. Exclude
cloud-only entries and aliases of the exact same artifact under a documented
review policy. Repository coverage alone cannot prove variant coverage. If a
complete inventory cannot be obtained, set `complete: false`; freshness is
unknown and publication is blocked. Empty inventories and inventories older
than seven days also produce unknown freshness, not 100%.

Each observation contains `id`, `checkedAt`, `sources` and `model`. `model` is
a full schema-v2 CatalogModel-shaped observation assembled from authoritative
facts, including identity, parameters/architecture, license, native context,
capabilities, release date, source coordinates, quantization sizes/digests and
projector pins where present. No duplicate observations or unknown IDs are
accepted. Missing observations reduce the scores rather than disappearing.

`sources` must contain HTTPS citations matching every declared Hugging Face
repository and the exact Ollama registry manifest URL when applicable. Without
a Hugging Face source, include the exact Ollama tag page as well. Prefer pinned
repository revisions when available. Signed reports retain these citations and
the original evidence bytes for audit. URLs alone are not cryptographic proof
of what their pages contained; source capture and review remain operational work.

## Commands and Publication

```sh
cargo catalog-quality
cargo catalog-quality --catalog-path reviewed-models.json --evidence reviewed-evidence.json
```

The command prints the report and exits nonzero on low/unknown scores or hard
blockers. It needs no signing key, makes no network requests, and writes no files.
`--now <RFC3339>` is for reproducible rehearsals/tests, not artificially making
stale evidence pass. Production CI uses the actual clock.

The publishing workflow runs this gate before signing. The signer independently
recomputes it at `--published-at`, requires `--quality-evidence`, and writes a
signed sidecar to `--quality-output`. There is no threshold-lowering CLI flag.

Every passing future revision publishes `catalog.json` and
`catalog-quality.json` to its immutable revision release and the mutable
`catalog-v1` channel. Channel assets are not replaced atomically by GitHub;
always match the signed report's `catalogArtifactSha256` to the downloaded
catalog bytes rather than assuming two separately downloaded assets match.
Historical revision assets provide the stable pair.

The sidecar uses an Ed25519 envelope (`payload` string, hex `signature`) signed
by the catalog key. Verify that signature before trusting the payload. The
payload has `reportType: rigspark-catalog-quality`, `reportVersion: 1`, the
revision, exact catalog artifact digest, `quality` report, and `evidence` as the
original JSON string. Hash the original evidence string to reproduce
`quality.evidenceSha256`. `quality.catalogSha256` hashes the inner catalog bytes.

v2.1.0 clients continue reading the unchanged catalog format. They do not yet
display quality scores or enforce sidecars; the release workflow and signer
enforce this policy. Tests and binary releases are not substitutes for a fresh
catalog evidence audit. No performance benchmark or model-download smoke test
is implied by these scores.