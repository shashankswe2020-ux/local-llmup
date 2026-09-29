use crate::{
    catalog::{parse_document, require},
    coverage::INVENTORY_URL,
    freshness::{Report, Status},
    sizing::ValidationError,
};
use serde::Deserialize;
use std::collections::BTreeSet;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CoverageReport {
    source: String,
    checked_at: String,
    inventory_count: usize,
    upstream_count: usize,
    covered_count: usize,
    missing: Vec<String>,
}

fn timestamp(value: &str) -> Result<(), ValidationError> {
    require(
        value.len() <= 64 && value.ends_with('Z') && OffsetDateTime::parse(value, &Rfc3339).is_ok(),
        "invalid report timestamp",
    )
}

fn freshness(raw: &str) -> Result<Report, ValidationError> {
    let report: Report = parse_document(raw)?;
    timestamp(&report.generated_at)?;
    require(
        report.age_days <= 9_007_199_254_740_991
            && report.stale_after_days <= 9_007_199_254_740_991,
        "invalid freshness age",
    )?;
    let drift = &report.drift;
    require(
        [
            drift.added,
            drift.updated,
            drift.removed,
            drift.skipped,
            drift.capped,
        ]
        .iter()
        .all(|count| *count <= 10000),
        "invalid drift counts",
    )?;
    let stale = report.age_days > report.stale_after_days;
    let has_drift = drift.added > 0 || drift.updated > 0 || drift.removed > 0;
    require(
        (report.status == Status::Stale) == stale
            && report.has_drift == has_drift
            && report.needs_attention == (stale || has_drift),
        "inconsistent freshness report",
    )?;
    let mut reasons = Vec::new();
    if stale {
        reasons.push(format!(
            "catalog is {} days old (stale after {})",
            report.age_days, report.stale_after_days
        ));
    }
    if has_drift {
        reasons.push(format!(
            "registry snapshot yields drift: +{} ~{} -{}",
            drift.added, drift.updated, drift.removed
        ));
    }
    require(report.reasons == reasons, "inconsistent freshness reasons")?;
    Ok(report)
}

fn coverage(raw: &str) -> Result<CoverageReport, ValidationError> {
    let report: CoverageReport = parse_document(raw)?;
    timestamp(&report.checked_at)?;
    require(
        report.source == INVENTORY_URL,
        "unexpected inventory source",
    )?;
    require(
        report.inventory_count <= 10000
            && report.upstream_count <= report.inventory_count
            && report.covered_count <= report.upstream_count,
        "invalid coverage counts",
    )?;
    require(
        report.missing.len() == report.upstream_count - report.covered_count,
        "inconsistent missing count",
    )?;
    let mut unique = BTreeSet::new();
    for name in &report.missing {
        require(
            !name.is_empty()
                && name.len() <= 256
                && name.as_bytes()[0].is_ascii_alphanumeric()
                && name.bytes().all(|byte| {
                    byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"._-".contains(&byte)
                })
                && unique.insert(name),
            "invalid missing repository",
        )?;
    }
    Ok(report)
}

pub fn render(kind: &str, raw: &str) -> Result<String, ValidationError> {
    require(raw.len() <= 1024 * 1024, "catalog report exceeds 1 MiB")?;
    match kind {
        "needs-attention" => Ok(freshness(raw)?.needs_attention.to_string()),
        "refresh-pr" => {
            let report = freshness(raw)?;
            Ok(format!(
                "Automated weekly refresh of `crates/rigspark-core/data/models.json` \u{2014} quant disk sizes and content digests refreshed from the live registry (curated fields untouched).\n\n- generated: {}\n\nTypecheck, lint, build, and the full test suite passed on this branch. Review the model changes before merging.\n\n_Opened automatically by the Catalog Freshness workflow._",
                report.generated_at
            ))
        }
        "freshness-issue" => {
            let report = freshness(raw)?;
            let status = if report.status == Status::Stale {
                "stale"
            } else {
                "fresh"
            };
            Ok(format!(
                "The catalog is stale but the committed registry snapshot yields no drift \u{2014} a maintainer needs to add newer entries to the snapshot.\n\n- generated: {}\n- age: {} day(s) (stale after {})\n- status: {status}\n\nUpdate `crates/rigspark-core/fixtures/registry-snapshot.json` with new pinned model entries; the next weekly run will open a refresh PR.\n\n_Filed automatically by the Catalog Freshness workflow._",
                report.generated_at, report.age_days, report.stale_after_days
            ))
        }
        "missing-count" => Ok(coverage(raw)?.missing.len().to_string()),
        "coverage-issue" => {
            let report = coverage(raw)?;
            let missing = report
                .missing
                .iter()
                .map(|name| format!("- `{name}`"))
                .collect::<Vec<_>>()
                .join("\n");
            Ok(format!(
                "The curated catalog does not represent every repository in Ollama\u{2019}s monitored local-model inventory.\n\n- upstream repositories: {}\n- covered repositories: {}\n- missing repositories: {}\n- source: {}\n\nMissing candidates:\n\n{missing}\n\nThese are discovery candidates only. Verify license, architecture, context, capabilities, quantization, and source metadata before adding an entry to `crates/rigspark-core/fixtures/registry-snapshot.json`.\nThis repository-level audit cannot detect missing variants inside a repository that is already represented because Ollama does not expose a public tag-enumeration endpoint.\n\n_Updated automatically by the Catalog Freshness workflow._",
                report.upstream_count,
                report.covered_count,
                report.missing.len(),
                report.source
            ))
        }
        _ => Err(ValidationError("unknown catalog notice kind".into())),
    }
}
