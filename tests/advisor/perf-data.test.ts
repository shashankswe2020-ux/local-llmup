import { describe, expect, it } from "vitest";
import {
  DEFAULT_PERF_PATH,
  loadPerf,
  matchPerf,
  parsePerf,
} from "../../src/advisor/perf-data.js";
import { ValidationError } from "../../src/errors.js";
import type { HardwareProfile } from "../../src/types.js";

const GIB = 1024 ** 3;

function hw(overrides: Partial<HardwareProfile> = {}): HardwareProfile {
  return {
    arch: "x64",
    platform: "linux",
    totalRamBytes: 32 * GIB,
    freeRamBytes: 28 * GIB,
    gpu: [{ vendor: "nvidia", vramBytes: 24 * GIB }],
    freeDiskBytes: 500 * GIB,
    ...overrides,
  };
}

const SOURCES = { bandwidth: "vendor spec sheet", efficiency: "llama.cpp decode benchmark" };

/** A minimal, valid dataset used to unit-test the matcher in isolation. */
function dataset(): ReturnType<typeof parsePerf> {
  return parsePerf(
    JSON.stringify({
      schemaVersion: 1,
      generatedAt: "2026-08-06T00:00:00Z",
      classes: [
        {
          id: "nvidia-24gb-class",
          label: "NVIDIA 24GB class",
          vendor: "nvidia",
          kind: "discrete",
          memBandwidthGBps: 950,
          efficiency: 0.68,
          minBytes: 20 * GIB,
          maxBytes: 28 * GIB,
          sources: SOURCES,
        },
        {
          id: "apple-silicon-max",
          label: "Apple silicon Max",
          vendor: "apple",
          kind: "unified",
          memBandwidthGBps: 400,
          efficiency: 0.7,
          minBytes: 40 * GIB,
          maxBytes: 96 * GIB,
          sources: SOURCES,
        },
        {
          id: "cpu-desktop-ddr",
          label: "Desktop DDR",
          vendor: "none",
          kind: "cpu",
          memBandwidthGBps: 50,
          efficiency: 0.5,
          minBytes: 1 * GIB,
          maxBytes: 1024 * GIB,
          sources: SOURCES,
        },
      ],
    }),
  );
}

describe("parsePerf — schema validation", () => {
  it("rejects malformed JSON", () => {
    expect(() => parsePerf("{ not json")).toThrow(ValidationError);
  });

  it("rejects a negative bandwidth", () => {
    const raw = JSON.stringify({
      schemaVersion: 1,
      generatedAt: "2026-08-06T00:00:00Z",
      classes: [
        {
          id: "bad",
          label: "Bad",
          vendor: "nvidia",
          kind: "discrete",
          memBandwidthGBps: -1,
          efficiency: 0.5,
          minBytes: 1 * GIB,
          maxBytes: 2 * GIB,
          sources: SOURCES,
        },
      ],
    });
    expect(() => parsePerf(raw)).toThrow(ValidationError);
  });

  it("rejects a missing bandwidth", () => {
    const raw = JSON.stringify({
      schemaVersion: 1,
      generatedAt: "2026-08-06T00:00:00Z",
      classes: [
        {
          id: "bad",
          label: "Bad",
          vendor: "nvidia",
          kind: "discrete",
          efficiency: 0.5,
          minBytes: 1 * GIB,
          maxBytes: 2 * GIB,
          sources: SOURCES,
        },
      ],
    });
    expect(() => parsePerf(raw)).toThrow(ValidationError);
  });

  it("rejects an efficiency above 1", () => {
    const raw = JSON.stringify({
      schemaVersion: 1,
      generatedAt: "2026-08-06T00:00:00Z",
      classes: [
        {
          id: "bad",
          label: "Bad",
          vendor: "nvidia",
          kind: "discrete",
          memBandwidthGBps: 100,
          efficiency: 1.5,
          minBytes: 1 * GIB,
          maxBytes: 2 * GIB,
          sources: SOURCES,
        },
      ],
    });
    expect(() => parsePerf(raw)).toThrow(ValidationError);
  });

  it("rejects an efficiency of zero", () => {
    const raw = JSON.stringify({
      schemaVersion: 1,
      generatedAt: "2026-08-06T00:00:00Z",
      classes: [
        {
          id: "bad",
          label: "Bad",
          vendor: "nvidia",
          kind: "discrete",
          memBandwidthGBps: 100,
          efficiency: 0,
          minBytes: 1 * GIB,
          maxBytes: 2 * GIB,
          sources: SOURCES,
        },
      ],
    });
    expect(() => parsePerf(raw)).toThrow(ValidationError);
  });

  it("rejects a missing per-figure source citation", () => {
    const raw = JSON.stringify({
      schemaVersion: 1,
      generatedAt: "2026-08-06T00:00:00Z",
      classes: [
        {
          id: "bad",
          label: "Bad",
          vendor: "nvidia",
          kind: "discrete",
          memBandwidthGBps: 100,
          efficiency: 0.5,
          minBytes: 1 * GIB,
          maxBytes: 2 * GIB,
          sources: { bandwidth: "vendor spec" },
        },
      ],
    });
    expect(() => parsePerf(raw)).toThrow(ValidationError);
  });

  it("rejects an inverted byte range (maxBytes <= minBytes)", () => {
    const raw = JSON.stringify({
      schemaVersion: 1,
      generatedAt: "2026-08-06T00:00:00Z",
      classes: [
        {
          id: "bad",
          label: "Bad",
          vendor: "nvidia",
          kind: "discrete",
          memBandwidthGBps: 100,
          efficiency: 0.5,
          minBytes: 2 * GIB,
          maxBytes: 1 * GIB,
          sources: SOURCES,
        },
      ],
    });
    expect(() => parsePerf(raw)).toThrow(ValidationError);
  });

  it("rejects duplicate class ids", () => {
    const entry = {
      id: "dup",
      label: "Dup",
      vendor: "nvidia",
      kind: "discrete",
      memBandwidthGBps: 100,
      efficiency: 0.5,
      minBytes: 1 * GIB,
      maxBytes: 2 * GIB,
      sources: SOURCES,
    };
    const raw = JSON.stringify({
      schemaVersion: 1,
      generatedAt: "2026-08-06T00:00:00Z",
      classes: [entry, { ...entry, minBytes: 3 * GIB, maxBytes: 4 * GIB }],
    });
    expect(() => parsePerf(raw)).toThrow(ValidationError);
  });

  it("rejects overlapping ranges within the same vendor+kind", () => {
    const raw = JSON.stringify({
      schemaVersion: 1,
      generatedAt: "2026-08-06T00:00:00Z",
      classes: [
        {
          id: "a",
          label: "A",
          vendor: "nvidia",
          kind: "discrete",
          memBandwidthGBps: 100,
          efficiency: 0.5,
          minBytes: 1 * GIB,
          maxBytes: 10 * GIB,
          sources: SOURCES,
        },
        {
          id: "b",
          label: "B",
          vendor: "nvidia",
          kind: "discrete",
          memBandwidthGBps: 200,
          efficiency: 0.5,
          minBytes: 8 * GIB,
          maxBytes: 16 * GIB,
          sources: SOURCES,
        },
      ],
    });
    expect(() => parsePerf(raw)).toThrow(ValidationError);
  });
});

describe("matchPerf — hardware → performance class", () => {
  it("matches a discrete NVIDIA GPU by VRAM bracket", () => {
    const match = matchPerf(hw({ gpu: [{ vendor: "nvidia", vramBytes: 24 * GIB }] }), dataset());
    expect(match?.id).toBe("nvidia-24gb-class");
  });

  it("matches Apple silicon by unified memory bracket", () => {
    const match = matchPerf(
      hw({ arch: "arm64", platform: "darwin", gpu: [{ vendor: "apple", vramBytes: 0 }], totalRamBytes: 64 * GIB }),
      dataset(),
    );
    expect(match?.id).toBe("apple-silicon-max");
  });

  it("matches a CPU-only machine by system RAM", () => {
    const match = matchPerf(hw({ gpu: [], totalRamBytes: 32 * GIB }), dataset());
    expect(match?.id).toBe("cpu-desktop-ddr");
  });

  it("returns undefined for a discrete GPU outside every seeded range (honesty gate)", () => {
    const match = matchPerf(hw({ gpu: [{ vendor: "nvidia", vramBytes: 48 * GIB }] }), dataset());
    expect(match).toBeUndefined();
  });

  it("returns undefined for an AMD GPU with no seeded class (honesty gate)", () => {
    const match = matchPerf(hw({ gpu: [{ vendor: "amd", vramBytes: 16 * GIB }] }), dataset());
    expect(match).toBeUndefined();
  });

  it("is deterministic — identical inputs yield identical matches", () => {
    const profile = hw();
    const ds = dataset();
    expect(matchPerf(profile, ds)).toEqual(matchPerf(profile, ds));
  });
});

describe("loadPerf — bundled dataset", () => {
  it("loads and validates the seeded default dataset", () => {
    const ds = loadPerf();
    expect(ds.schemaVersion).toBe(1);
    expect(ds.classes.length).toBeGreaterThan(0);
  });
  it("resolves the default dataset to data/perf.json", () => {
    expect(DEFAULT_PERF_PATH.endsWith("data/perf.json")).toBe(true);
  });

  it("every seeded class cites a source for each figure (D2)", () => {
    for (const cls of loadPerf().classes) {
      expect(cls.sources.bandwidth.trim().length).toBeGreaterThan(0);
      expect(cls.sources.efficiency.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("parsePerf — efficiencyByBackend (B9)", () => {
  const provenance = {
    value: 0.7,
    trustTier: "session-verified",
    basisBytesPerToken: 4.4e9,
    url: "https://github.com/ggml-org/llama.cpp/discussions/4167",
  };

  function classWith(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: "apple-silicon-max",
      label: "Apple silicon Max",
      vendor: "apple",
      kind: "unified",
      memBandwidthGBps: 400,
      efficiency: 0.7,
      minBytes: 40 * GIB,
      maxBytes: 96 * GIB,
      sources: SOURCES,
      ...overrides,
    };
  }

  function parse(cls: Record<string, unknown>): ReturnType<typeof parsePerf> {
    return parsePerf(
      JSON.stringify({
        schemaVersion: 1,
        generatedAt: "2026-08-06T00:00:00Z",
        classes: [cls],
      }),
    );
  }

  it("accepts optional per-backend scalars plus provenance", () => {
    const ds = parse(
      classWith({
        efficiencyByBackend: { ollama: 0.7, llamacpp: 0.7 },
        sources: { ...SOURCES, efficiencyByBackend: { llamacpp: provenance } },
      }),
    );
    expect(ds.classes[0]?.efficiencyByBackend).toEqual({ ollama: 0.7, llamacpp: 0.7 });
    expect(ds.classes[0]?.sources.efficiencyByBackend?.llamacpp?.value).toBe(0.7);
  });

  it("keeps schemaVersion at 1 (additive, no bump)", () => {
    const ds = parse(classWith({ efficiencyByBackend: { llamacpp: 0.7 } }));
    expect(ds.schemaVersion).toBe(1);
  });

  it("accepts a class with no efficiencyByBackend (fully optional)", () => {
    expect(() => parse(classWith())).not.toThrow();
  });

  it("rejects a per-backend scalar above 1", () => {
    expect(() => parse(classWith({ efficiencyByBackend: { llamacpp: 1.5 } }))).toThrow(
      ValidationError,
    );
  });

  it("rejects a per-backend scalar of zero", () => {
    expect(() => parse(classWith({ efficiencyByBackend: { llamacpp: 0 } }))).toThrow(
      ValidationError,
    );
  });

  it("rejects an unknown backend key", () => {
    expect(() => parse(classWith({ efficiencyByBackend: { bogus: 0.7 } }))).toThrow(
      ValidationError,
    );
  });

  it("rejects an unknown key in a provenance entry (strict)", () => {
    expect(() =>
      parse(
        classWith({
          sources: {
            ...SOURCES,
            efficiencyByBackend: { llamacpp: { ...provenance, rogue: true } },
          },
        }),
      ),
    ).toThrow(ValidationError);
  });

  it("rejects an invalid trustTier", () => {
    expect(() =>
      parse(
        classWith({
          sources: {
            ...SOURCES,
            efficiencyByBackend: { llamacpp: { ...provenance, trustTier: "made-up" } },
          },
        }),
      ),
    ).toThrow(ValidationError);
  });

  it("rejects a non-URL provenance url", () => {
    expect(() =>
      parse(
        classWith({
          sources: {
            ...SOURCES,
            efficiencyByBackend: { llamacpp: { ...provenance, url: "not a url" } },
          },
        }),
      ),
    ).toThrow(ValidationError);
  });
});
