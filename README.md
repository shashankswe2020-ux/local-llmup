# RigSpark

[![CI](https://github.com/shashankswe2020-ux/rigspark/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/shashankswe2020-ux/rigspark/actions/workflows/ci.yml)
[![crates.io](https://img.shields.io/crates/v/rigspark-cli.svg?label=crates.io)](https://crates.io/crates/rigspark-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

**Which local LLMs can your computer run? Find out before downloading the weights.**

Get `yes / slow / no` verdicts, memory-fit explanations, and estimated tok/s.
Then verify, serve, and chat with a model that fits. Native Rust CLI, interactive
terminal UI, and browser workspace for macOS, Linux, and Windows.

[![rigspark demo preview; click to watch](assets/rigspark-preview.gif)](assets/rigspark.mp4)

[Watch on YouTube](https://youtu.be/MI2wfI1eeCM?si=QA2teeDmeT_fNIqf)

Advice uses an offline catalog. Unknown figures stay `unknown`; estimates are
not benchmarks. Managed downloads are integrity-checked and servers bind to
`127.0.0.1`. Supports **Ollama, llama.cpp, MLX** (Apple Silicon), and
**LM Studio** (attach-only).

## Rename Migration

This is a breaking product rename. The public executable alias is now `rigspark`;
`llmup` and the `llmup-*` Rust crate names remain available. Environment variables
now use the `RIGSPARK_` prefix, including `RIGSPARK_HOME`.

Before switching, stop running servers and back up your previous application data.
Move that data directory to `~/.rigspark`, or set `RIGSPARK_HOME` to its existing
location. No data is moved or deleted automatically. The desktop bundle identifier
is now `org.rigspark.desktop`, so operating-system permissions may need reapproval.

Repository, release, Pages, container, and Homebrew references now target `rigspark`.
Their remote rename and publication must be completed separately before release.
The README demo and documented screenshots use the current RigSpark branding.

## Install

Homebrew (macOS and Linux):

```bash
brew install shashankswe2020-ux/tap/rigspark
```

Windows and other platforms: download a
[prebuilt archive](https://github.com/shashankswe2020-ux/rigspark/releases/latest)
and add its extracted folder to `PATH`. Keep `llmup`, `rigspark`, and the
`rigspark-gui` companion together. No Node.js, Python, or compiler is needed to run
these binaries; inference backends have their own requirements.

[Cargo, checksums, macOS unsigned-archive guidance, and upgrades](docs/references/guide.md#install)
 · [Docker caveats](docs/references/guide.md#docker)

## Try It

```bash
llmup recommend                 # rank models for your hardware
llmup can-run llama3.1:8b        # check one model before downloading
llmup catalog --all             # browse the offline catalog
llmup up llama3.1:8b             # pull, verify, and serve
llmup chat                      # chat with the active model
llmup down                      # stop when done
```

Advice works without a backend. To serve and chat, install
[Ollama](https://ollama.com) or another [supported backend](docs/references/guide.md#supported-backends),
then choose a model your machine can run. `rigspark` is an alias for `llmup`.

Prefer a browser? Run **`llmup gui`** to choose models and chat, with agents,
skills, and MCP tools. Local chat stays local; cloud harnesses and external tools
can send data to their providers. Use `llmup --help` for commands,
`--json` for scripting, or `--accessible` for screen readers.

## References

- [Commands, installed Ollama models, and custom context](docs/references/guide.md#commands)
- [Terminal UI](docs/references/guide.md#terminal-ui) · [Browser workspace, agents, and tools](docs/references/guide.md#browser-gui)
- [Catalog and maintenance](docs/references/guide.md#model-catalog) · [How advice works](docs/references/guide.md#how-advice-works)
- [Scripting and exit codes](docs/references/guide.md#scripting--exit-codes) · [Performance measurements](docs/references/guide.md#performance-10-native-vs-0114-node)
- [FAQ](docs/references/guide.md#faq) · [Troubleshooting](docs/references/guide.md#troubleshooting) · [Tool comparisons](docs/references/guide.md#rigspark-vs-ollama)
- [Development and testing](docs/references/guide.md#development) · [Specification](docs/specs/rigspark.md) · [Changelog](CHANGELOG.md)

[MIT License](LICENSE)
