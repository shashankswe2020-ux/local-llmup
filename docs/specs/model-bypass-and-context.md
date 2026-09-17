# Model Bypass and Context Controls

Status: Implemented; approved by the user on 2026-09-17.

## Objective

Allow users to try models they already run in Ollama, including models absent
from the curated catalog, at an explicit context size in both CLI and desktop.
Conservative fit predictions must not prevent an informed trial, but a bypass
must not disable integrity, endpoint, process-ownership, or input validation.

The motivating case is an installed `gemma4:e4b-it-qat` at 65,536 tokens.
The user's observed 40-50 output tokens/s is not a sourced general performance
profile. New Qwen model tags must be selected from actual installed inventory,
not guessed or added to the catalog with fabricated metadata.

## User Contract

- `up` and `switch` accept `--bypass` to override estimated memory-fit rejection.
  They retain the original warning and never change an estimate to "fits".
- `--context <tokens>` affects both the fit calculation and the effective model
  context used for inference. It is not an output-token limit.
- `can-run` accepts `--context`; existing recommendation context controls remain
  supported. Default advice remains deterministic, offline, and catalog-based.
- An explicit installed-model workflow obtains inventory and metadata from a
  validated loopback Ollama endpoint. It is distinguished from offline advice;
  ordinary `recommend` and `can-run` must not silently contact Ollama.
- Installed model tags are selected exactly. Uncatalogued launch requires
  `--bypass` and must not silently pull a different model or replace the tag.
- Inventory shows context-specific estimated memory and fit where metadata is
  sufficient. Missing architecture geometry or performance evidence remains
  `unknown`; unknown models stay visible and selectable.
- Distinguish estimated full GPU residency from CPU offload and actual observed
  runtime allocation. Fitting weights alone does not prove a 64K KV cache fits.
- Desktop offers catalog/installed model selection, numeric context control
  with a 65,536-token preset, VRAM-fit filtering, and an explicit bypass toggle.
  The confirmation view preserves warnings and shows the selected context.
- Context changes and model switching must take effect in desktop chat and
  supported OpenAI-compatible client connections, including an already-running
  Ollama daemon. Report unsupported operations instead of silently ignoring them.
- Never alter or terminate the user's external Ollama daemon without existing
  ownership and confirmation checks. Never mutate the original installed model
  implicitly to configure a context.

## Approved Integrity Decision

Catalog models keep their existing catalog digest or size-floor verification.
For uncatalogued installed models, verify local content against a pinned local
manifest and revalidate identity before activation. Describe that evidence as
local content integrity, not catalog verification or independent provenance.
Missing or mismatched integrity evidence blocks activation even with `--bypass`.

This introduces a distinct trust source for installed models; it must not be
implemented as "ignore verification errors". No curated catalog schema or
dataset-format change, new backend, or runtime dependency is authorized here.

## Implementation Boundaries

- `src/commands/` and `src/cli.ts`: validated context and bypass inputs.
- `src/backend/`: installed inventory, runtime metadata, integrity checks, and
  effective runtime context behind adapter capabilities, not command-specific
  Ollama logic.
- `src/advisor/`, `src/ranking/`, and `src/hardware/`: reuse existing sizing math;
  preserve unknown results when geometry cannot be modeled honestly.
- `src/state/`: backward-compatible active context and model identity if needed.
- `src/gui/`: reuse current contracts, confirmation flow, and desktop styling.
- `tests/`: mirror the touched source modules with Vitest tests and mocked I/O.

Use strict TypeScript, named exports, explicit exported return types, and Zod
validation for external data. Follow existing patterns; introduce no `any`.

## Verification

Write failing tests before each behavioral change. Cover default compatibility,
invalid contexts, 65,536-token sizing, fit rejection with/without bypass, unknown
metadata, installed tag selection, failed integrity, context propagation,
custom loopback ports, and externally owned daemon preservation. Mock network,
filesystem, and child-process interactions in automated tests.

Verify desktop controls, confirmation, loading/error states, and context changes
in a real browser using mocked runtime data at desktop and narrow viewports.
Any live Ollama test is a separately authorized smoke test, not a unit test.

Required gates: `npm test`, `npm run lint`, `npm run typecheck`, `npm run build`.

## Implementation Sequence

1. Add context-aware single-model checks and regression tests.
2. Add adapter-level installed model discovery and local integrity validation.
3. Add bypass/context activation, persistence, and inference propagation.
4. Add desktop selection, context, filtering, and bypass controls.
5. Document CLI examples and verification limits; run all quality gates.

Each slice requires focused validation before starting the next. Do not commit
or push without an explicit request.

## Runtime Semantics

- Installed comparisons use `recommend --installed` and `can-run --installed`.
  Both accept `--context`, `--port`, and `--json`; installed recommendations also
  accept `--fits-only`. Unknown context fits remain visible unless filtered.
- Activation uses `up` or `switch` with `--bypass`; `--installed` explicitly
  selects exact local tags even when a catalog entry exists.
- Ollama context is configured through `/api/create` using `from` and
  `parameters.num_ctx`, under a unique `llmup-context-...:<tokens>` tag. Its
  parameter is read back, content verified, and runtime tag persisted for chat.
  External OpenAI clients must select the emitted runtime tag themselves.
- Context variants are not automatically deleted. A failed operation may leave
  a variant in Ollama, but must not replace the active state on failure.
- Installed models are checked against the daemon's local model store, selected
  using `OLLAMA_MODELS` or the conventional user directory. An inaccessible
  service-owned store fails closed with a diagnostic.
- Memory comparisons do not measure runtime allocation or observed throughput.
  Hybrid or unsupported KV geometry is reported unknown. No claim is made that
  Gemma or a particular Qwen model will fit every GPU at 64K.

Sources: [Ollama model creation](https://docs.ollama.com/api/create),
[installed inventory](https://docs.ollama.com/api/tags),
[OpenAI context configuration](https://docs.ollama.com/openai#setting-the-local-context-size),
[num_ctx parameter](https://docs.ollama.com/modelfile#valid-parameters-and-values).

## Verification Results

- Release verification with Vitest 5: 2,047 tests passed across 142 files,
  including the existing coverage thresholds.
- `npm run lint`, `npm run typecheck`, `npm run build`: passed.
- Five Playwright model journeys passed, including 390px and 1280px installed
  selection, filtering, confirmation, and context activation payloads.
- No real inference runtime or model weights were used for these checks. Actual
  GPU residency, throughput, and live Ollama context behavior remain unmeasured.
- The user approved development-tooling upgrades before shipping 0.11.4.
  Root and desktop dependency audits now report zero vulnerabilities.
