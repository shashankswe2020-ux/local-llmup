# Catalog Quality Audit: 2026-09-30

## Status

Publication blocked. PR #262 merged as
`0942651628dac9608407195933bf238ef7bbcb43`; its checks passed. The production
evidence file now records one sourced observation for `qwen3.6:35b` and an
explicitly incomplete inventory containing eight verified missing variants.
Correctness verification coverage is 1 / 67 (approximately 1.49%); freshness
remains unknown. This is not an assertion that the other model facts are wrong.

This is a partial upstream audit, not a complete eligible-variant inventory or
a correctness certification. No evidence timestamps or completeness claims have
been manufactured. No model weights were downloaded.

## Coverage Findings

The official Ollama integration inventory at
<https://raw.githubusercontent.com/ollama/ollama/main/integration/reg_library_test.go>
contained 209 active repository names when checked. Of those, 26 have a source
repository represented in the current 67-entry catalog; 183 do not. The source
bytes had SHA-256
`ae3da8f0a0980b744acc0142f44c5172c8de2b7f5e537e65fd88e8ddad34332e`.

These counts are repository-level only, not the policy's variant coverage
percentage. The file explicitly omits cloud-only repositories and comments out
some very large local models; it cannot establish complete local coverage.
The existing coverage command additionally filters to already represented
lineages, so its result cannot certify the broader quality policy.

The following absent local variants were verified directly through registry
manifests. Each exposed an `application/vnd.ollama.image.model` layer with a
different digest. These are not merely aliases of one weight artifact.

| Missing variant | Registry manifest source | Manifest SHA-256 |
| --- | --- | --- |
| qwen3.5:0.8b | <https://registry.ollama.ai/v2/library/qwen3.5/manifests/0.8b> | `f3817196d142eaf72ce79dfebe53dcb20bd21da87ce13e138a8f8e10a866b3a4` |
| qwen3.5:2b | <https://registry.ollama.ai/v2/library/qwen3.5/manifests/2b> | `324d162be6ca5629ae4517c8710434d0bd2d665bc94dbad46e9af8fbf8a2f0df` |
| qwen3.5:4b | <https://registry.ollama.ai/v2/library/qwen3.5/manifests/4b> | `2a654d98e6fba55d452b7043684e9b57a947e393bbffa62485a7aac05ee4eefd` |
| qwen3.5:9b | <https://registry.ollama.ai/v2/library/qwen3.5/manifests/9b> | `6488c96fa5faab64bb65cbd30d4289e20e6130ef535a93ef9a49f42eda893ea7` |
| qwen3.5:27b | <https://registry.ollama.ai/v2/library/qwen3.5/manifests/27b> | `7653528ba5cba4dd8e19da24aaddc7f4d0b5ecd93571c0825dfd4137958ec06e` |
| qwen3.5:35b | <https://registry.ollama.ai/v2/library/qwen3.5/manifests/35b> | `3460ffeede5453ead027dbd2f821b12ad0aa3de54630971993babdb2165221f7` |
| qwen3.5:122b | <https://registry.ollama.ai/v2/library/qwen3.5/manifests/122b> | `8b9d11d807c57feb1e2ecb0d6cbf40334c37dcc3523bed5540af4f927f112a37` |
| qwen3.6:27b | <https://registry.ollama.ai/v2/library/qwen3.6/manifests/27b> | `9d5803d493a991af27b9441c098aa56f2ed7bbd260877f075ec09b575c049bc3` |

Even granting coverage credit to all 67 existing entries, these eight distinct
missing variants give an optimistic ceiling of 67 / 75 = 89.333...%. This is
an upper bound proving a gap, not a measured completeness score. A full audit
can uncover additional missing variants and reduce coverage further. Merely
adding these eight entries would not prove 90% global coverage.

Official library/tag listings used for discovery:
<https://ollama.com/library> and <https://ollama.com/library/qwen3.6/tags>.
Aliases, quantizations, and model-source identity must be reconciled before a
complete canonical variant inventory is approved.

## Integrity Prerequisites

Six entries currently lack the pinned artifact evidence required by the gate:

- `kimi-k2-thinking`
- `kimi-linear`
- `kimi-k2:base`
- `kimi-k2:instruct`
- `kimi-dev-72b`
- `kimi-vl-a3b`

At most 61 of 67 current entries could qualify without first resolving these
pins, even if every other required fact were independently checked and matched.
No such full-fact verification has yet been asserted.

## Current Artifact Audit

All 61 catalogued Ollama references were checked using registry manifests only,
completed at `2026-09-30T11:04:07Z`. Results: 59 artifact-metadata matches, one
drift finding, one unavailable reference. These results do not verify license,
architecture, context, capabilities or release dates and therefore are not
correctness percentages. The six non-Ollama entries were not checked by this
manifest sweep. No catalog digest was automatically replaced.

The checked catalog SHA-256 was
`ae23661ada2ee4995ad41723549df177ff152ba46e2415140100f6773d61ad9a`.
The generated report is preserved in
[catalog-artifact-audit-2026-09-30.json](catalog-artifact-audit-2026-09-30.json), with
SHA-256 `a2cde083fb75e6f429e972fa9a8ba5cb33bbc7e9859b55bda11f885e59974fcc`.
It is a diagnostic artifact, not a signed publication or complete quality
evidence file; its contents include the manifests used for this sweep.

### Gemma 4 Projector Omitted

Source: <https://registry.ollama.ai/v2/library/gemma4/manifests/e4b-it-qat>.
Manifest SHA-256:
`ee665637121887cf3befff38abbb1be4ee117c7db867d97a67e29049ecd7e15f`.

The model layer matches the catalog: 5154939136 bytes, digest
`e8b6a059ba86947a44ace84d6e5679795bc41862c25c30513142588f0e9dba1d`.
The manifest additionally includes a 991551904-byte projector, digest
`c6398448d84a4836fdedf58f9775979e69ae0cc4dfdf4d697b5597693a555b12`.
The current quantization has no projector pin and counts only the model bytes;
aggregate weight size should be 6146491040 bytes for this observed manifest.
The official tag page corroborates the separate projector:
<https://ollama.com/library/gemma4:e4b-it-qat>.

### Kimi K2 Tag Unavailable

<https://registry.ollama.ai/v2/library/kimi-k2/manifests/instruct> returned HTTP
404. <https://ollama.com/library/kimi-k2/tags> reported no models. This is an
availability finding at the audit time, not proof that every Kimi artifact is
unavailable or that a different tag is an equivalent replacement. The catalog's
Ollama source requires correction or removal through review.

## Required Follow-through

The Qwen observation uses the oldest component check timestamp
(`2026-09-30T11:03:28Z`), not a newly invented freshness timestamp. Its sources
include the pinned official configuration and exact Ollama manifest. The
release date and named total/active parameter counts are corroborated by the
[official Qwen announcement](https://qwen.ai/blog?id=qwen3.6-35b-a3b), reviewed
during admission and this audit's preceding research. The gate's URL validator
does not accept query URLs, so that citation is recorded here. The optional KV
geometry and benchmark proxy remain unknown. RAM/VRAM allowances are derived
policy values, not measured memory requirements.

Known Gemma/Kimi failures are recorded above, not entered as fabricated complete
model observations. They must be resolved before any release, even if later
observations make the aggregate percentage pass. The current incomplete
inventory already blocks signing; this partial audit must not be relabelled as
complete to bypass that block.

1. Capture a complete, deduplicated local variant inventory, including absent
   variants and explicit curated scope for non-Ollama backends. Keep incomplete
   scope labelled incomplete.
2. Audit current artifact manifests and authoritative model cards/configs;
   record mismatches as blockers, not fresh passing observations.
3. Correct verified metadata drift and curate missing variants in reviewed
   batches. Do not shrink the denominator or lower thresholds to unblock release.
4. Populate evidence only from the completed audit, then rerun
   `cargo catalog-quality`. Publication can resume only after both scores pass
   and no contradictions remain.