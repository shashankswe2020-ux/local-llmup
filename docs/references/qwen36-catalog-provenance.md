# Qwen 3.6 Catalog Provenance

Verified 2026-09-30. Catalog ID: `qwen3.6:35b`.

## Authoritative Sources

- [Qwen announcement](https://qwen.ai/blog?id=qwen3.6-35b-a3b), dated
  2026-04-15: 35B total / 3B active MoE parameters, multimodal model.
- [Official model card](https://huggingface.co/Qwen/Qwen3.6-35B-A3B): Apache 2.0,
  chat, code, vision, reasoning, tools and native 262144-token context.
- [Pinned configuration](https://huggingface.co/Qwen/Qwen3.6-35B-A3B/blob/995ad96eacd98c81ed38be0c5b274b04031597b0/config.json):
  hybrid linear/full attention; 40 layers, full attention every fourth layer.
- [Ollama tag](https://ollama.com/library/qwen3.6:35b): Q4_K_M language weights
  plus an F16 vision projector.
- [Ollama registry manifest](https://registry.ollama.ai/v2/library/qwen3.6/manifests/35b):
  exact sizes and digests below. The mutable tag may change; pins must be reviewed
  before an updated package can be accepted by the catalog.

## Weight Artifacts

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| Language model | 21718480960 | `d372de8e934898a59e6ccfabc3368474711384d8f1fd4d22d87a3f0a45400cdc` |
| Vision projector | 902821728 | `a62390d25b4b4a2d8afd7cc3c90021c11935c1fdd48d7cb0723ab71cd02a598e` |

Total weight bytes: 22621302688. The existing sizing policy adds a rounded-up
15% allowance, producing 26014498092 bytes for RAM/VRAM weight sizing. This is
not a measured full-context memory requirement. Small config/license/parameter
files are not included in this weight-byte total; all local manifest blobs are
still individually hashed and checked before serving.

KV bytes per token remain unknown because the current geometry model does not
represent hybrid recurrent state. Benchmark proxy remains absent: published
benchmark results are not converted into an invented cross-model scalar.
Short-context throughput, where the existing advisor has a supported evidence
path, remains an estimate rather than a measured Qwen 3.6 benchmark.

No GGUF/MLX source is claimed by this entry. Ollama is the curated serving path.
Adding an independent backend artifact requires its own reviewed provenance.