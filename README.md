# RigSpark: Check Which Local LLMs Your Computer Can Run

[![CI](https://github.com/shashankswe2020-ux/rigspark/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/shashankswe2020-ux/rigspark/actions/workflows/ci.yml)
[![crates.io](https://img.shields.io/crates/v/rigspark-cli.svg?label=crates.io)](https://crates.io/crates/rigspark-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

**Which local LLMs can your computer run? Find out before downloading the weights.**

RigSpark scores your hardware and gives every model a `yes / slow / no` verdict,
a memory-fit explanation, and an estimated tok/s range. Then it verifies, serves,
and chats with the model you pick. It is an open-source, privacy-first Rust CLI
with a terminal UI and a browser workspace for macOS, Linux, and Windows.

[![RigSpark demo: rigspark recommend ranks local LLMs with yes / slow / no verdicts, then the same verdicts in the browser GUI; click to watch with sound](assets/rigspark-preview.gif)](assets/rigspark.mp4)

*20-second tour:* `rigspark recommend` ranks the offline catalog on an arm64 Mac with
34 GiB of usable RAM and lists the models that won't fit; `rigspark gui` then shows
the same verdicts and a local chat.
[Watch in 1080p with sound](assets/rigspark.mp4) · [Earlier demo on YouTube](https://youtu.be/MI2wfI1eeCM?si=QA2teeDmeT_fNIqf)

## Why RigSpark

- **Know before you download.** Estimates RAM and GPU/VRAM fit for models such as
  Llama, Qwen, Mistral, and Gemma.
- **Honest numbers.** Advice uses a bundled offline catalog. Unknown figures stay
  `unknown`; estimates are not benchmarks.
- **Safe by default.** Managed downloads are integrity-checked, and servers bind
  to `127.0.0.1`.
- **Bring your backend.** Works with **Ollama**, **llama.cpp**, **MLX** (Apple
  Silicon), and **LM Studio** (attach-only).

## Install

Homebrew (macOS and Linux):

```bash
brew install shashankswe2020-ux/tap/rigspark
```

Windows and other platforms: download a
[prebuilt archive](https://github.com/shashankswe2020-ux/rigspark/releases/latest),
extract it, and add the folder to `PATH`. Keep `rigspark`, `llmup`, and
`rigspark-gui` together. The binaries need no Node.js, Python, or compiler;
inference backends have their own requirements.

More: [Cargo, checksums, unsigned macOS archives, and upgrades](docs/references/guide.md#install)
· [Docker caveats](docs/references/guide.md#docker)

## Quick Start

```bash
rigspark recommend              # rank models for your hardware
rigspark can-run llama3.1:8b    # check one model before downloading
rigspark catalog --all          # browse the offline catalog
rigspark up llama3.1:8b         # pull, verify, and serve
rigspark chat                   # chat with the active model
rigspark down                   # stop when done
```

Advice works without a backend. To serve and chat, install
[Ollama](https://ollama.com) or another [supported backend](docs/references/guide.md#supported-backends).
Use `rigspark --help` for all commands, `--json` for scripting, and
`--accessible` for screen readers. `llmup` remains a compatibility alias.

## Browser Workspace

Run **`rigspark gui`** to pick a model that fits and chat with it, with agents,
skills, and MCP tools. Local chat stays on your machine; cloud harnesses and
external tools can send data to their providers.

![RigSpark browser GUI Models view with Runs well and Runs slowly verdicts](assets/screenshot-gui.png)

## References

- [Commands, installed Ollama models, and custom context](docs/references/guide.md#commands)
- [Terminal UI](docs/references/guide.md#terminal-ui) · [Browser workspace, agents, and tools](docs/references/guide.md#browser-gui)
- [Catalog and maintenance](docs/references/guide.md#model-catalog) · [How advice works](docs/references/guide.md#how-advice-works)
- [Scripting and exit codes](docs/references/guide.md#scripting--exit-codes) · [Performance measurements](docs/references/guide.md#performance-10-native-vs-0114-node)
- [FAQ](docs/references/guide.md#faq) · [Troubleshooting](docs/references/guide.md#troubleshooting) · [Tool comparisons](docs/references/guide.md#rigspark-vs-ollama)
- [Development and testing](docs/references/guide.md#development) · [Specification](docs/specs/rigspark.md) · [Changelog](CHANGELOG.md)

[MIT License](LICENSE)

**Keywords:** local LLM, run LLM locally, LLM hardware requirements, VRAM calculator, tokens per second, Ollama, llama.cpp, MLX, LM Studio, Rust CLI.
