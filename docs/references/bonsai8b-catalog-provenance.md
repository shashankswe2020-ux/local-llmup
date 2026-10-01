# Bonsai 8B Catalog Provenance

Checked 2026-09-30. This entry is the original binary Bonsai 8B, not
Ternary-Bonsai or Bonsai 2. Catalog ID: `bonsai:8b`.

## Authoritative Sources

- [Announcement, March 31, 2026](https://prismml.com/news/bonsai-8b).
- [Pinned official model card](https://huggingface.co/prism-ml/Bonsai-8B-gguf/blob/48516770dd04643643e9f9019a2a349cf26c5dbd/README.md).
- [Official artifact metadata](https://huggingface.co/api/models/prism-ml/Bonsai-8B-gguf/revision/48516770dd04643643e9f9019a2a349cf26c5dbd?blobs=true).
- [Bonsai 1 runtime guide](https://github.com/PrismML-Eng/Bonsai-demo/blob/bfaea577522626b883f755236878e4583f3d6e68/Bonsai1_README.md).

The model card identifies a dense Qwen3-derived architecture, 8.19B parameters,
65,536-token context, Apache-2.0 license, and Q1_0 group-128 weights. Hugging Face
GGUF metadata reports 8,188,548,096 parameters. Chat, coding and tool-use capabilities
are supported by the card's instruction/code/tool evaluations and embedded tool
chat template. No vision or dedicated reasoning-mode capability is asserted.

## Artifact and Sizing

Repository: `prism-ml/Bonsai-8B-gguf`

Revision: `48516770dd04643643e9f9019a2a349cf26c5dbd`

File: `Bonsai-8B-Q1_0.gguf`

SHA-256: `284a335aa3fb2ced3b1b01fcb40b08aa783e3b70832767f0dd2e3fdfa134bd54`

Exact file size: 1,158,654,496 bytes, from Hugging Face LFS metadata. The alternate
`Bonsai-8B.gguf` filename has the same digest and size; it is not a second variant.

RigSpark's existing dense-model policy adds a rounded-up 15% weight-memory
allowance: 1,332,452,671 bytes. This is a derived estimate, not measured peak RSS
or total memory at maximum context. No generic Q1 quantization rule is introduced;
the dense-model sizing path uses the exact artifact size for this unknown label.
The card's 1.125 bits/weight includes scales and is not the same as IQ1 sizing.

KV bytes per token and benchmark proxy remain absent. The companion MLX config
was consulted but is not treated as independently verified GGUF geometry. The
announcement's device throughput figures are not imported into the performance
dataset or turned into a synthetic quality score.

GUI validation found the generic throughput estimator could still produce numbers
from file size despite the absent benchmark proxy. Q1_0 now explicitly returns
unknown throughput because the bundled efficiency profiles do not calibrate its
binary kernels. Weight-fit advice remains available.

## Runtime Boundary

The newer Bonsai 1 guide states binary Q1_0 is supported in upstream llama.cpp
on CPU, Metal, CUDA and Vulkan. The older model card still shows fork commands.
Use a current llama.cpp build with Q1_0 support; older installations may reject
the file. RigSpark does not install a PrismML fork or enforce a minimum llama.cpp
version for this entry.

Only the pinned llama.cpp GGUF source is admitted. No Ollama tag is assumed.
The official MLX 1-bit pack still requires a fork according to the runtime guide,
so it is not registered as a stock MLX source. No new backend is introduced.

The entry is included in the registry snapshot and bootstrap metadata so catalog
regeneration preserves its source pins. Historical migration oracles are unchanged.
This metadata admission does not certify runtime inference or downloaded weight
contents; no weights were downloaded for this change. Runtime acquisition must
still verify the pinned digest. Reviewed quality evidence and release eligibility
are separate and have not been promoted by this admission.

## GUI Verification (2026-10-01)

Real Chrome journeys passed at desktop, 390px, 320px and 768px widths using the
disposable native browser fixture. Recommendation requests use the production
router and current bundled catalog; model-start requests are recorded instead of
executed. Console-error checks passed with the harness's existing expected-error
allowlist for deliberately failed catalog updates.

Verified Bonsai visibility beyond the default top-eight recommendations, exact
artifact bytes in API data, Q1_0 and license display, unknown decode speed and KV
cost, source provenance, responsive action bounds, back navigation, confirmation
cancellation without a request, and the explicit llama.cpp / 65,536-token start
payload. The default f16 cache option is intentionally omitted from that payload.

The GUI now requests up to 100 ranked entries; the API still defaults to eight and
rejects limits outside 1-100. This is bounded browsing, not pagination over an
arbitrarily large future catalog. The generic attach-only LM Studio option remains
visible for GGUF sources; its presence is not certification of LM Studio's bundled
Q1_0 runtime. Automatic selection excludes LM Studio and selects llama.cpp here.

Screenshots and API snapshots are generated under `test-results/bonsai-browser/`.
No model weights were downloaded, no real runtime was started, and live inference
is not covered by these GUI checks.

A subsequent [live performance check](bonsai8b-live-performance.md) downloaded and
hashed the weights and measured real inference. It also found that the production
CLI currently rejects explicit context overrides for llama.cpp; the recorded GUI
payload check must not be treated as a successful live 65K-context launch.