use crate::enrich::EnrichDiff;
use serde::Serialize;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

pub const STALE_AFTER_DAYS: u64 = 7;

#[derive(Serialize)]
pub struct DriftCounts {
    pub added: usize,
    pub updated: usize,
    pub removed: usize,
    pub skipped: usize,
    pub capped: usize,
}

#[derive(PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Fresh,
    Stale,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub generated_at: String,
    pub age_days: u64,
    pub stale_after_days: u64,
    pub status: Status,
    pub has_drift: bool,
    pub drift: DriftCounts,
    pub needs_attention: bool,
    pub reasons: Vec<String>,
}

pub fn evaluate(
    generated_at: &str,
    diff: &EnrichDiff,
    now: &str,
    stale_after_days: u64,
) -> Result<Report, time::error::Parse> {
    let generated = OffsetDateTime::parse(generated_at, &Rfc3339)?;
    let now = OffsetDateTime::parse(now, &Rfc3339)?;
    let age_days = u64::try_from((now - generated).whole_days()).unwrap_or(0);
    let drift = DriftCounts {
        added: diff.added.len(),
        updated: diff.updated.len(),
        removed: diff.removed.len(),
        skipped: diff.skipped.len(),
        capped: diff.capped.len(),
    };
    let has_drift = drift.added > 0 || drift.updated > 0 || drift.removed > 0;
    let status = if age_days > stale_after_days {
        Status::Stale
    } else {
        Status::Fresh
    };
    let mut reasons = Vec::new();
    if status == Status::Stale {
        reasons.push(format!(
            "catalog is {age_days} days old (stale after {stale_after_days})"
        ));
    }
    if has_drift {
        reasons.push(format!(
            "registry snapshot yields drift: +{} ~{} -{}",
            drift.added, drift.updated, drift.removed
        ));
    }
    Ok(Report {
        generated_at: generated_at.into(),
        age_days,
        stale_after_days,
        needs_attention: status == Status::Stale || has_drift,
        status,
        has_drift,
        drift,
        reasons,
    })
}

pub fn format_report(report: &Report) -> String {
    let status = if report.status == Status::Stale {
        "stale"
    } else {
        "fresh"
    };
    let attention = if report.needs_attention { "yes" } else { "no" };
    let mut text = format!(
        "Catalog freshness\n  generated: {}\n  age:       {} day(s) (stale after {})\n  status:    {status}\n  drift:     added={} updated={} removed={} skipped={} capped={}\n  attention: {attention}",
        report.generated_at,
        report.age_days,
        report.stale_after_days,
        report.drift.added,
        report.drift.updated,
        report.drift.removed,
        report.drift.skipped,
        report.drift.capped
    );
    if !report.reasons.is_empty() {
        text.push_str("\n  reasons:");
        for reason in &report.reasons {
            text.push_str("\n    - ");
            text.push_str(reason);
        }
    }
    text
}
