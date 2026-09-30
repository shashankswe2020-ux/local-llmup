# Catalog Enrichment Workflow

The Catalog Freshness workflow runs Mondays at 03:17 UTC and can be dispatched
manually on `main`. It refreshes existing catalog metadata, collects source-backed
candidate proposals, reports release quality, and opens a review PR. It does not
merge, sign, or publish a catalog.

## Optional OpenAI Setup

In GitHub Settings > Secrets and variables > Actions, configure:

- Repository secret `OPENAI_API_KEY`: enter the key directly in GitHub, never in
  chat, a committed file, or a workflow command argument.
- Repository variable `OPENAI_CATALOG_MODEL`: an explicitly selected model that
  supports the Responses API and strict structured outputs. There is no default
  model. Prefer a pinned model version and configure provider-side spending alerts.

If either setting is absent or blank, registry collection still runs and AI
extraction is disabled. The secret is exposed only to the already-built collector
step, not builds or tests. The signing environment and its key remain separate.
GitHub Actions must be allowed to create pull requests in repository settings.

Each run selects at most 10 candidates, makes at most one OpenAI request per
candidate, and permits at most 2,000 output tokens per request (including reasoning
tokens). There are no application or HTTP-client retries. A candidate config is
limited to 64 KiB; requests have a 10-second connection and 60-second total timeout.
These are request/token bounds, not a dollar guarantee; cost depends on the chosen
model and input tokens. Re-running a workflow can incur a new set of charges.

## Sources and Trust

Discovery uses Ollama's public integration inventory and excludes repositories
already represented in the curated catalog. It examines the first 10 missing
repository names alphabetically, deduplicated, fetching their `latest` manifests.
Until those repositories are admitted, later runs can revisit the same batch.
It does not enumerate tags within known repositories or certify complete variant
coverage. Unavailable or cloud-only manifests are reported without inventing pins.

Only manifests and small config blobs are downloaded, never model weights.
Config bytes must match the manifest's exact size and SHA-256 before extraction.
Registry GET redirects are limited to three and restricted to HTTPS on
`registry.ollama.ai` and the observed Ollama storage account
`dd20bb891979d25aebc8bec07b2b3bbc.r2.cloudflarestorage.com`. Storage-host changes
fail closed and require a reviewed allowlist change. OpenAI requests cannot redirect.

OpenAI receives the verified public config JSON, not repository files or secrets.
The request supplies no tools and sets `store: false` (this disables response
retrieval storage, not all provider retention). Returned claims must match an
allowed field/JSON-pointer pair and the literal source value. Unsupported, null,
duplicate, fabricated, malformed, incomplete, or oversized results are rejected.
An empty claim list is valid; unknown facts remain unknown.

Manifest-derived artifact pins and sizes are independent of AI. The proposal
collector never modifies the curated catalog or quality evidence. Existing
`catalog-enrich` updates to known artifact metadata still appear separately in
the same reviewed PR.

## Review and Publication

The PR contains `docs/references/catalog-proposals.json` (raw source documents,
their hashes, artifact observations, extraction status, and unverified claims)
and `docs/references/catalog-quality-latest-report.json` (the offline quality
diagnostic). Treat source text as untrusted data, not commands or instructions.

Reviewers must independently verify model identity, license, capabilities,
parameter counts, context, geometry, and integrity pins before admission. Registry
config often lacks these facts; this collector does not fetch Hugging Face model
cards or infer missing values. `inventoryComplete` is always false and
`requiresReview` always true. Reviewers must separately maintain the evidence
described in [catalog-quality.md](catalog-quality.md).

Quality failure permits a remediation PR but never publication. The independent
90% freshness and correctness thresholds, complete inventory requirement, known
mismatch blocking, and protected signing approval remain unchanged.

## Local Verification

```sh
cargo test --locked -p rigspark-runtime --test catalog_proposals
cargo test --locked -p rigspark-cli --test catalog_propose_cli
env -u OPENAI_API_KEY -u OPENAI_CATALOG_MODEL cargo catalog-propose --limit 1 --out /tmp/catalog-proposals.json
```

The first two commands use injected fixtures with no live API calls. The third is
an explicit public-metadata smoke check with AI disabled. `--fixture` selects a
recorded inventory/response transport with no network fallback; `--now` fixes the
report timestamp. Output cannot replace the input catalog or fixture.

OpenAI request/response contract:
[official Responses API reference](https://developers.openai.com/api/reference/resources/responses/methods/create).
The integration has fixture coverage and a public metadata smoke check; paid
OpenAI extraction must be validated in Actions after secret/model configuration.