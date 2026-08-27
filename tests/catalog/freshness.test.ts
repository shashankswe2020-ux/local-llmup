import { describe, expect, it } from "vitest";
import type { EnrichDiff } from "../../src/catalog/enrich.js";
import {
  CATALOG_STALE_AFTER_DAYS,
  catalogAgeDays,
  evaluateCatalogFreshness,
  formatFreshnessReport,
} from "../../src/catalog/freshness.js";
import type { Catalog } from "../../src/types.js";

// Freshness only reads `generatedAt`; a minimal stub keeps the tests focused.
function catalog(generatedAt: string): Catalog {
  return { schemaVersion: 2, generatedAt, models: [] } as unknown as Catalog;
}

function diff(overrides: Partial<Record<keyof EnrichDiff, readonly string[]>> = {}): EnrichDiff {
  return {
    added: overrides.added ?? [],
    updated: overrides.updated ?? [],
    removed: overrides.removed ?? [],
    skipped: overrides.skipped ?? [],
    capped: overrides.capped ?? [],
  };
}

const JAN1 = "2026-01-01T00:00:00.000Z";

describe("catalogAgeDays", () => {
  it("returns whole days between generatedAt and now", () => {
    expect(catalogAgeDays(JAN1, new Date("2026-01-15T00:00:00.000Z"))).toBe(14);
  });

  it("floors a partial day", () => {
    expect(catalogAgeDays(JAN1, new Date("2026-01-02T23:59:59.000Z"))).toBe(1);
  });

  it("clamps a future timestamp (clock skew) to zero rather than a negative age", () => {
    expect(catalogAgeDays("2026-06-01T00:00:00.000Z", new Date(JAN1))).toBe(0);
  });

  it("throws on an unparseable timestamp instead of guessing", () => {
    expect(() => catalogAgeDays("not-a-date", new Date(JAN1))).toThrow(/valid date/u);
  });
});

describe("evaluateCatalogFreshness", () => {
  it("reports fresh with no attention when recent and in sync", () => {
    const report = evaluateCatalogFreshness({
      catalog: catalog(JAN1),
      diff: diff(),
      now: new Date("2026-01-10T00:00:00.000Z"),
    });
    expect(report.status).toBe("fresh");
    expect(report.ageDays).toBe(9);
    expect(report.hasDrift).toBe(false);
    expect(report.needsAttention).toBe(false);
    expect(report.reasons).toEqual([]);
  });

  it("flags stale when older than the threshold", () => {
    const report = evaluateCatalogFreshness({
      catalog: catalog(JAN1),
      diff: diff(),
      now: new Date("2026-03-01T00:00:00.000Z"),
    });
    expect(report.status).toBe("stale");
    expect(report.needsAttention).toBe(true);
    expect(report.reasons.join(" ")).toMatch(/stale/u);
  });

  it("flags drift as needing attention even when the catalog is fresh", () => {
    const report = evaluateCatalogFreshness({
      catalog: catalog(JAN1),
      diff: diff({ added: ["qwen3:32b"], updated: ["llama3.1:8b"] }),
      now: new Date("2026-01-05T00:00:00.000Z"),
    });
    expect(report.status).toBe("fresh");
    expect(report.hasDrift).toBe(true);
    expect(report.needsAttention).toBe(true);
    expect(report.drift.added).toBe(1);
    expect(report.drift.updated).toBe(1);
  });

  it("does not treat license-gated skips or size-cap drops as actionable drift", () => {
    const report = evaluateCatalogFreshness({
      catalog: catalog(JAN1),
      diff: diff({ skipped: ["closed:70b"], capped: ["tiny:1b"] }),
      now: new Date("2026-01-05T00:00:00.000Z"),
    });
    expect(report.hasDrift).toBe(false);
    expect(report.needsAttention).toBe(false);
    expect(report.drift.skipped).toBe(1);
    expect(report.drift.capped).toBe(1);
  });

  it("treats exactly the threshold age as fresh and one day past as stale", () => {
    const atThreshold = new Date(
      new Date(JAN1).getTime() + CATALOG_STALE_AFTER_DAYS * 24 * 60 * 60 * 1000,
    );
    const pastThreshold = new Date(atThreshold.getTime() + 24 * 60 * 60 * 1000);
    expect(evaluateCatalogFreshness({ catalog: catalog(JAN1), diff: diff(), now: atThreshold }).status).toBe(
      "fresh",
    );
    expect(
      evaluateCatalogFreshness({ catalog: catalog(JAN1), diff: diff(), now: pastThreshold }).status,
    ).toBe("stale");
  });

  it("honors a custom staleAfterDays threshold", () => {
    const report = evaluateCatalogFreshness({
      catalog: catalog(JAN1),
      diff: diff(),
      now: new Date("2026-01-08T00:00:00.000Z"),
      staleAfterDays: 5,
    });
    expect(report.status).toBe("stale");
    expect(report.staleAfterDays).toBe(5);
  });
});

describe("formatFreshnessReport", () => {
  it("renders the key fields and reasons", () => {
    const report = evaluateCatalogFreshness({
      catalog: catalog(JAN1),
      diff: diff({ added: ["qwen3:32b"] }),
      now: new Date("2026-03-01T00:00:00.000Z"),
    });
    const text = formatFreshnessReport(report);
    expect(text).toContain("Catalog freshness");
    expect(text).toContain(JAN1);
    expect(text).toContain("stale");
    expect(text).toMatch(/added=1/u);
    expect(text).toContain("attention: yes");
  });
});
