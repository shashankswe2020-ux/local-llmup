import { sanitizeTerminalText } from "../../src/tui/sanitize.js";
import type {
  CanRunViewModel,
  CatalogViewModel,
  DoctorViewModel,
  LsViewModel,
  RecommendViewModel,
  SafeActionId,
} from "../../src/tui/types.js";

const text = (value: string) => sanitizeTerminalText(value, "single_line");
const model = (canonical: string) => ({
  actionable: true as const,
  canonical,
  display: text(canonical),
});

export function recommendViewModel(): RecommendViewModel {
  return {
    scope: {
      task: text("reasoning"),
      context: 32_768,
      maxContextMode: false,
      backend: text("ollama"),
      availableBackendsOnly: false,
    },
    hardware: {
      arch: text("arm64"),
      platform: text("darwin"),
      totalRamBytes: 32 * 1024 ** 3,
      freeRamBytes: 24 * 1024 ** 3,
      usableBytes: 30 * 1024 ** 3,
      memoryKind: "ram",
      freeDiskBytes: 100 * 1024 ** 3,
      gpu: [{ vendor: text("apple"), vramBytes: 0 }],
    },
    rows: [
      {
        rank: 1,
        model: model("qwen3:14b"),
        params: text("14B"),
        quant: text("Q4_K_M"),
        requiredBytes: 9 * 1024 ** 3,
        verdict: "yes",
        throughput: {
          known: true,
          lowTokPerSec: 18.2,
          highTokPerSec: 33.7,
          label: text("18.2–33.7 tok/s"),
        },
        backends: [text("ollama"), text("llamacpp")],
        license: text("apache-2.0"),
        score: 0.82,
        scores: { quality: 0.84, fit: 0.9, speed: 0.71, recency: 0.88, capability: 1 },
        capabilities: [text("chat"), text("reasoning")],
        contextLength: 32_768,
        contextEvidence: text("32768 tokens; weights 8589934592 bytes; KV cache sourced"),
        throughputBackend: text("ollama"),
        throughputEvidence: text("offline-estimate"),
      },
      {
        rank: 2,
        model: model("deepseek-r1:14b"),
        params: text("14B"),
        quant: text("Q4_K_M"),
        requiredBytes: 10 * 1024 ** 3,
        verdict: "slow",
        throughput: {
          known: false,
          label: text("unknown"),
          reason: "no-sourced-performance-profile",
        },
        backends: [text("ollama")],
        license: text("mit"),
        score: 0.76,
        scores: { quality: 0.8, fit: 0.75, speed: 0.5, recency: 0.9, capability: 1 },
        capabilities: [text("chat"), text("reasoning")],
        contextLength: 16_384,
        contextEvidence: text("default context footprint"),
        throughputBackend: text("ollama"),
        throughputEvidence: text("offline-estimate; no-sourced-performance-profile"),
      },
    ],
    wontFit: [{ model: model("giant:70b"), reason: text("ram-bound") }],
    command: {
      argv: [
        "local-llmup" as SafeActionId,
        "up" as SafeActionId,
        "qwen3:14b" as SafeActionId,
      ],
      display: text("local-llmup up qwen3:14b"),
    },
  };
}

export function canRunViewModel(verdict: "yes" | "slow" | "no" = "yes"): CanRunViewModel {
  const known = verdict === "yes";
  return {
    model: model("qwen3:14b"),
    verdict,
    quant: verdict === "no" ? null : text("Q4_K_M"),
    reason: verdict === "no" ? text("vram-bound") : null,
    throughput: known
      ? { known: true, lowTokPerSec: 18, highTokPerSec: 30, label: text("18–30 tok/s") }
      : {
          known: false,
          label: text("unknown"),
          reason:
            verdict === "no"
              ? "not-evaluated-model-does-not-fit"
              : "no-sourced-performance-profile",
        },
    backends: [text("ollama")],
    throughputBackend: text("ollama"),
    requiredBytes: verdict === "no" ? 20 * 1024 ** 3 : 9 * 1024 ** 3,
    usableBytes: 16 * 1024 ** 3,
    fitEvidence: text(verdict === "no" ? "requires 21474836480 bytes; 17179869184 usable" : "fits"),
    throughputEvidence: text("offline-estimate"),
  };
}

export function doctorViewModel(): DoctorViewModel {
  return {
    ok: false,
    checks: [
      { name: text("hardware"), status: "ok", detail: text("arm64/darwin") },
      { name: text("backend"), status: "fail", detail: text("run: brew install ollama") },
    ],
    backends: [
      {
        name: text("ollama"),
        installed: false,
        version: null,
        isDefault: false,
        installHint: text("brew install ollama"),
      },
    ],
    score: 73,
    scoreSub: { vram: 60, ram: 80, compute: 70, storage: 90 },
    bottleneck: text("VRAM"),
  };
}

export function catalogViewModel(): CatalogViewModel {
  return {
    hardware: recommendViewModel().hardware,
    filter: "all",
    total: 1,
    rows: [
      {
        model: model("qwen3:14b"),
        params: text("14B"),
        architecture: text("dense"),
        quant: text("Q4_K_M"),
        requiredBytes: 9 * 1024 ** 3,
        fit: "fit",
        releaseDate: text("2025-01-01"),
        family: text("qwen3"),
        activeParams: null,
        openWeight: true,
        capabilities: [text("chat"), text("reasoning")],
        license: text("apache-2.0"),
        contextLength: 32_768,
        kvBytesPerToken: 65_536,
        benchmarkProxy: 0.82,
        sources: [
          { type: "ollama", id: text("qwen3:14b") },
          { type: "hf", repo: text("Qwen/Qwen3-14B") },
        ],
        supportedBackends: [text("ollama"), text("llamacpp")],
        quantizations: [
          {
            name: text("Q4_K_M"),
            diskBytes: 8 * 1024 ** 3,
            minRamBytes: 9 * 1024 ** 3,
            minVramBytes: 9 * 1024 ** 3,
            sha256: text("a".repeat(64)),
            digestVerified: true,
          },
        ],
      },
    ],
    refresh: {
      added: [text("new:model")],
      updated: [],
      removed: [],
      skipped: [text("closed:model")],
      capped: [],
    },
    emptyReason: null,
  };
}

export function lsViewModel(active = true): LsViewModel {
  return active
    ? {
        type: "active",
        model: model("qwen3:14b"),
        backend: text("ollama"),
        endpoint: text("http://127.0.0.1:11434"),
        port: 11434,
        ownership: "attached",
      }
    : { type: "empty", nextCommand: text("local-llmup up <model>") };
}
