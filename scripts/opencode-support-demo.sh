#!/usr/bin/env bash
set -euo pipefail

model="${OPENCODE_SUPPORT_MODEL:-qwen2.5:0.5b}"

if ! command -v opencode >/dev/null 2>&1; then
  printf '%s\n' "OpenCode is required. Install it with: brew install anomalyco/tap/opencode" >&2
  exit 1
fi

if ! command -v ollama >/dev/null 2>&1; then
  printf '%s\n' "Ollama is required for this demo." >&2
  exit 1
fi

case "$model" in
  ollama/*) ollama_model="${model#ollama/}" ;;
  *) ollama_model="$model" ;;
esac

if ! ollama show "$ollama_model" >/dev/null 2>&1; then
  printf '%s\n' "Missing Ollama model: $ollama_model. Pull it with: ollama pull $ollama_model" >&2
  exit 1
fi

printf '%s\n' "For this local coding integration smoke test, reply with exactly: OPENCODE_HARNESS_OK. Do not use tools." |
  npx tsx src/cli.ts chat --harness opencode --model "$model"