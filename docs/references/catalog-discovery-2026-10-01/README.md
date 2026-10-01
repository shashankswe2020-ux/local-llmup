# Catalog Discovery Sweep: 2026-10-01

Status: repository discovery exhausted; release quality remains blocked.
This is source evidence, not reviewed catalog admission or a complete variant inventory.

## Completed

- Ran the existing integrity-checking proposal collector in source-only mode,
  in 19 batches of at most ten repositories, against the 69-model development catalog.
- Checked 182 missing repositories, including a fresh check of `alfred`.
  Qwen3.5 is already represented in the development catalog and is excluded by
  the existing repository discovery rule.
- Captured 179 valid local model-layer candidates; 178 also have verified config
  blobs. Three `latest` manifests were unavailable, and one config failed verification.
- Preserved all 19 original batch reports and validated every captured source SHA-256.
- Consolidated all 182 proposals into the existing `catalog-proposals.json`
  report format, retaining incomplete-inventory and review-required flags.
- The final batch reports zero remaining candidates. This means no remaining
  repositories in that discovery sweep, not no remaining model variants.
- No OpenAI calls, model weight downloads, quality-threshold changes, or automatic
  promotion of source claims to reviewed observations.

## Exceptions

- `granite4.1:latest`, `nemotron3:latest`, and `wizardlm:latest` were unavailable.
  Their official tag pages expose explicit local variants, so these repositories
  must not be dropped from the eligible inventory.
- `qwen3-coder:latest` exposes a model layer, but its config was unavailable or
  invalid on the original collection and one retry. The manifest declares a
  539-byte config with digest
  `24a94682582c6045f4950846fc7711479dcecb478b86759f0306a2ef8484d318`.
  A direct bounded request returned 542 bytes with that exact SHA-256. The
  descriptor size contradicts its body, so the collector correctly rejects it.
  The response is retained under `exceptions/qwen3-coder-config.json`; no
  integrity check was weakened.
- Explicit manifests for `granite4.1:3b`, `nemotron3:33b`, and
  `wizardlm:7b-q4_K_M` returned valid model layers and are retained in
  `exceptions/`. They are source captures, not complete model observations.
- Rechecked the admitted Gemma 4 artifact: the current catalog already matches
  its model and projector layers (6,146,491,040 aggregate bytes).
  `kimi-k2:instruct` still returns HTTP 404. Both responses are retained.
- The standard registry tag-list URL
  `https://registry.ollama.ai/v2/library/qwen3.5/tags/list` returned HTTP 404.
  Official HTML tag pages expose variants and aliases but require separate
  enumeration and identity reconciliation.

Sources checked:

- <https://ollama.com/library/granite4.1/tags>
- <https://ollama.com/library/nemotron3/tags>
- <https://ollama.com/library/wizardlm/tags>
- <https://ollama.com/library/qwen3.5/tags>

## Tag Enumeration

`tag-inventory.json` records 7,170 distinct-per-repository tag names from 211
known repository pages: the union of the missing-repository sweep and existing
catalog Ollama repositories. This is not an assertion that the known repository
union exhausts the public library or all non-Ollama sources.

Pages were fetched with bounded HTTPS requests and parsed with the system HTML
parser (`xmllint`), then XML attribute parsing. No linked executable content was
run. Source page hashes were independently rechecked. Raw pages are retained
locally under `test-results/catalog-tag-audit-2026-10-01/`.

No pagination links were observed by the parser. One page (`kimi-k2`) exposed
no explicit tags. The tag list includes aliases, quantizations, different sizes,
and releases; it is not a count of distinct models or a verified eligible-variant
denominator. Each tag's manifest and identity still need reconciliation.

The user approved grouping quantizations under each distinct model/release/size
on 2026-10-01. True aliases may collapse only with source-backed identity;
different releases, sizes, base/instruct models, and fine-tunes remain distinct.
This rule must not exclude unsupported or inconvenient variants merely to raise
the score. Canonical mapping of the captured tags is not yet complete.

The captured configs provide architecture-family, parameter, and quantization
claims for 178 candidates, but no context, license, capabilities, or release-date
claims. They cannot populate complete admission records on their own. An official
card cross-check also found conflicting Alfred metadata: the Ollama tag table
says 2K context while its description says 8K; the config says 42B parameters
while the page describes 40B. These require resolution, not guessed defaults.

## Reviewed Observation Added

Bonsai 8B was independently rechecked against the pinned official model card,
HF artifact metadata (including `?blobs=true` for exact LFS size and SHA-256),
embedded GGUF tool template, and dated Prism announcement. The evidence entry
records the completed check at 2026-10-01T12:32:41Z. The API citation omits the
query because the gate accepts only query-free source URLs; the pinned file
page is also cited. Optional KV geometry and benchmark proxy remain absent.
The 15% RAM allowance remains a derived policy figure, not measured memory.

After this addition, two of 69 entries have recent matching reviewed evidence
(2.8986%). At least 61 more existing entries need verification to reach 90%
at this catalog size, and admitting further models increases that requirement.
Freshness remains unknown because canonical upstream inventory is incomplete.

## Remaining Release Requirements

### Hugging Face Audit

The follow-up public Hugging Face sweep captured 338 source responses for all
69 existing entries. `huggingface-audit.json` preserves URLs, actual check
timestamps, source hashes, pinned revisions, literal metadata, and review flags.
Raw source bodies remain locally in
`test-results/catalog-hf-audit-2026-10-01/report.json`. Capture is not verification.

Thirteen entries returned HTTP 401 for pinned raw cards and configs: Gemma 3n
E2B/E4B, Gemma 3 4B/12B/27B, Gemma 2 2B/9B/27B, Llama 3.3 70B, Llama 3.2
1B/3B, and Llama 3.1 8B/70B. Public API metadata was accessible, but it does not
substitute for the missing documents. Authenticated reads require a Hugging Face
account with the corresponding gated repository access granted. No token was
configured during this sweep.

The source-only helper `scripts/catalog-hf-audit.rb` supports optional
`HF_TOKEN` authentication, restricted to HTTPS `huggingface.co`. It never sends
that header to Ollama, writes credentials to reports, executes model code, or
downloads model weights. Its `--self-test` checks host restrictions, nested
config handling, and selective gated retries. Each response is capped at 2 MiB;
cross-host redirects are refused. HTTP 429 stops collection instead of retrying
indefinitely. Reuse the same output directory to resume against the exact same
catalog digest, or add `--retry-gated` after configuring authorized access.

```sh
ruby scripts/catalog-hf-audit.rb --self-test
ruby scripts/catalog-hf-audit.rb crates/rigspark-core/data/models.json test-results/catalog-hf-audit-2026-10-01 --retry-gated
```

Review findings are not automatically catalog errors:

- `llama3.1` versus `llama-3.1-community`, and `other` with a license name,
  require license normalization and license-text review.
- DeepSeek distillation license metadata must be read alongside the inherited
  base-model conditions; a literal `mit` label alone is not a safe replacement.
- Qwen3 4B, 30B-A3B, and 235B-A22B have a 262K catalog context, while their
  linked older cards describe 32K native context and validated 128K YaRN.
  Reconcile the actual Ollama artifact release with the HF repository before
  changing context or claiming a passing observation.
- Several Qwen2.5 models advertise extended context in their cards while their
  configs default to 32K. Config-only inequality is therefore not conclusive.
- Release dates, active MoE counts, capabilities, existing benchmark proxies,
  and KV geometry still require field-level provenance. Repository creation
  timestamps and tensor totals are not automatic substitutes for release dates
  or the catalog's named parameter-size convention.

The quality gate remains unchanged: two reviewed observations, not 69 verified
models. This sweep does not establish canonical upstream inventory completeness.

1. Enumerate explicit tags across the upstream library, reconcile aliases and
   model variants, and account for non-Ollama sources. The integration-test
   repository list and one `latest` manifest per repository are not sufficient
   to assert a complete upstream variant inventory.
2. Review authoritative model cards/configs for architecture, total/active
   parameters, context, license, capabilities, and release dates. Config claims
   alone do not establish these facts. Preserve unknown optional geometry and
   benchmark values rather than inventing them.
3. Resolve artifact drift and unavailable sources, admit supported candidates
   with exact weight/projector pins, and preserve bootstrap reproducibility.
4. Record only independently checked observations with their actual check
   timestamps, then rerun the unchanged quality gate.

Baseline gate on 2026-10-01: 69 catalog entries, one recent verified entry,
1.4493% correctness verification, unknown freshness and coverage, publication
blocked. The existing incomplete scope names seven missing variants; it is
not the full denominator. At the current catalog size, at least 63 entries
would need verification; that requirement grows as models are admitted.

The batch JSON files retain `inventoryComplete: false` and `requiresReview: true`.
No signed release is justified by this discovery sweep alone.