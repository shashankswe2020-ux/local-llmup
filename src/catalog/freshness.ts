/**
 * Catalog freshness: how old the committed catalog is, and whether a refresh
 * against the offline registry snapshot would change it. Pure and deterministic
 * — it reads the catalog's `generatedAt` and an enrich diff, and makes no I/O.
 * The weekly freshness pipeline uses this to alert maintainers without ever
 * mutating `data/models.json` or making a network call from an advice path.
 */
import type { EnrichDiff } from "./enrich.js";
import type { Catalog } from "../types.js";

/** Days after which the committed catalog is considered stale and should be refreshed. */
export const CATALOG_STALE_AFTER_DAYS = 7;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type FreshnessStatus = "fresh" | "stale";

/**
 * Whole-day age of a catalog `generatedAt` timestamp relative to `now`. Throws on
 * an unparseable timestamp (honesty gate — never guess an age) and clamps a
 * future timestamp to 0 so clock skew can't read as "fresh" by accident.
 */
export function catalogAgeDays(generatedAt: string, now: Date): number {
  const generatedMs = new Date(generatedAt).getTime();
  if (Number.isNaN(generatedMs)) {
    throw new Error(`catalog generatedAt is not a valid date: ${generatedAt}`);
  }
  return Math.max(0, Math.floor((now.getTime() - generatedMs) / MS_PER_DAY));
}

/** Counts of what a refresh against the committed snapshot would change. */
export interface DriftCounts {
  readonly added: number;
  readonly updated: number;
  readonly removed: number;
  readonly skipped: number;
  readonly capped: number;
}

export interface FreshnessReport {
  readonly generatedAt: string;
  readonly ageDays: number;
  readonly staleAfterDays: number;
  readonly status: FreshnessStatus;
  readonly hasDrift: boolean;
  readonly drift: DriftCounts;
  /** True when a maintainer should refresh: stale, or actionable drift exists. */
  readonly needsAttention: boolean;
  /** Human-readable reasons; empty when fresh and in sync. */
  readonly reasons: readonly string[];
}

export interface FreshnessInput {
  readonly catalog: Catalog;
  readonly diff: EnrichDiff;
  readonly now: Date;
  readonly staleAfterDays?: number;
}

/** Evaluate catalog freshness + drift into a single actionable report. */
export function evaluateCatalogFreshness(input: FreshnessInput): FreshnessReport {
  const staleAfterDays = input.staleAfterDays ?? CATALOG_STALE_AFTER_DAYS;
  const ageDays = catalogAgeDays(input.catalog.generatedAt, input.now);
  const drift: DriftCounts = {
    added: input.diff.added.length,
    updated: input.diff.updated.length,
    removed: input.diff.removed.length,
    skipped: input.diff.skipped.length,
    capped: input.diff.capped.length,
  };
  // Actionable drift = real catalog changes only. License-gated skips and
  // size-cap drops are intentional and not something a refresh should chase.
  const hasDrift = drift.added > 0 || drift.updated > 0 || drift.removed > 0;
  const status: FreshnessStatus = ageDays > staleAfterDays ? "stale" : "fresh";

  const reasons: string[] = [];
  if (status === "stale") {
    reasons.push(`catalog is ${String(ageDays)} days old (stale after ${String(staleAfterDays)})`);
  }
  if (hasDrift) {
    reasons.push(
      `registry snapshot yields drift: +${String(drift.added)} ~${String(
        drift.updated,
      )} -${String(drift.removed)}`,
    );
  }

  return {
    generatedAt: input.catalog.generatedAt,
    ageDays,
    staleAfterDays,
    status,
    hasDrift,
    drift,
    needsAttention: status === "stale" || hasDrift,
    reasons,
  };
}

/** Render a freshness report as human-readable lines (for logs and issue bodies). */
export function formatFreshnessReport(report: FreshnessReport): string {
  const lines = [
    "Catalog freshness",
    `  generated: ${report.generatedAt}`,
    `  age:       ${String(report.ageDays)} day(s) (stale after ${String(report.staleAfterDays)})`,
    `  status:    ${report.status}`,
    `  drift:     added=${String(report.drift.added)} updated=${String(
      report.drift.updated,
    )} removed=${String(report.drift.removed)} skipped=${String(
      report.drift.skipped,
    )} capped=${String(report.drift.capped)}`,
    `  attention: ${report.needsAttention ? "yes" : "no"}`,
  ];
  if (report.reasons.length > 0) {
    lines.push("  reasons:");
    for (const reason of report.reasons) {
      lines.push(`    - ${reason}`);
    }
  }
  return lines.join("\n");
}
