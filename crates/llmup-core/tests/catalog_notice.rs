use llmup_core::catalog_notice::render;
use serde_json::{Value, json};

fn freshness() -> Value {
    json!({"generatedAt":"2026-09-01T02:44:54.336Z","ageDays":16,"staleAfterDays":7,"status":"stale","hasDrift":false,"drift":{"added":0,"updated":0,"removed":0,"skipped":0,"capped":0},"needsAttention":true,"reasons":["catalog is 16 days old (stale after 7)"]})
}
fn coverage() -> Value {
    json!({"source":llmup_core::coverage::INVENTORY_URL,"checkedAt":"2026-09-19T00:00:00.000Z","inventoryCount":4,"upstreamCount":3,"coveredCount":1,"missing":["gemma999","qwen999"]})
}

#[test]
fn freshness_flags_and_notice_bodies_match_existing_workflow_contracts() {
    let report = freshness().to_string();
    assert_eq!(render("needs-attention", &report).unwrap(), "true");
    assert_eq!(
        render("refresh-pr", &report).unwrap(),
        "Automated weekly refresh of `data/models.json` \u{2014} quant disk sizes and content digests refreshed from the live registry (curated fields untouched).\n\n- generated: 2026-09-01T02:44:54.336Z\n\nTypecheck, lint, build, and the full test suite passed on this branch. Review the model changes before merging.\n\n_Opened automatically by the Catalog Freshness workflow._"
    );
    assert_eq!(
        render("freshness-issue", &report).unwrap(),
        "The catalog is stale but the committed registry snapshot yields no drift \u{2014} a maintainer needs to add newer entries to the snapshot.\n\n- generated: 2026-09-01T02:44:54.336Z\n- age: 16 day(s) (stale after 7)\n- status: stale\n\nUpdate `crates/llmup-core/fixtures/registry-snapshot.json` with new pinned model entries; the next weekly run will open a refresh PR.\n\n_Filed automatically by the Catalog Freshness workflow._"
    );
    let mut fresh = freshness();
    fresh["ageDays"] = json!(1);
    fresh["status"] = json!("fresh");
    fresh["needsAttention"] = json!(false);
    fresh["reasons"] = json!([]);
    assert_eq!(
        render("needs-attention", &fresh.to_string()).unwrap(),
        "false"
    );
}

#[test]
fn coverage_count_and_issue_body_match_existing_workflow_contracts() {
    let report = coverage().to_string();
    assert_eq!(render("missing-count", &report).unwrap(), "2");
    assert_eq!(
        render("coverage-issue", &report).unwrap(),
        format!(
            "The curated catalog does not represent every repository in Ollama\u{2019}s monitored local-model inventory.\n\n- upstream repositories: 3\n- covered repositories: 1\n- missing repositories: 2\n- source: {}\n\nMissing candidates:\n\n- `gemma999`\n- `qwen999`\n\nThese are discovery candidates only. Verify license, architecture, context, capabilities, quantization, and source metadata before adding an entry to `crates/llmup-core/fixtures/registry-snapshot.json`.\nThis repository-level audit cannot detect missing variants inside a repository that is already represented because Ollama does not expose a public tag-enumeration endpoint.\n\n_Updated automatically by the Catalog Freshness workflow._",
            llmup_core::coverage::INVENTORY_URL
        )
    );
}

#[test]
fn rejects_malformed_reports_inconsistent_counts_and_markdown_injection() {
    for raw in ["null", "{}", "invalid"] {
        assert!(render("refresh-pr", raw).is_err());
    }
    assert!(render("unknown", &freshness().to_string()).is_err());
    assert!(render("refresh-pr", &"x".repeat(1024 * 1024 + 1)).is_err());
    for (field, value) in [
        ("generatedAt", json!("today\n@everyone")),
        ("needsAttention", json!(false)),
        ("status", json!("unknown")),
        ("ageDays", json!(-1)),
    ] {
        let mut report = freshness();
        report[field] = value;
        assert!(
            render("needs-attention", &report.to_string()).is_err(),
            "{field}"
        );
    }
    for (field, value) in [
        ("source", json!("https://attacker.invalid")),
        ("missing", json!(["bad`\n@everyone"])),
        ("coveredCount", json!(2)),
        ("inventoryCount", json!(1)),
        ("checkedAt", json!("invalid")),
    ] {
        let mut report = coverage();
        report[field] = value;
        assert!(
            render("coverage-issue", &report.to_string()).is_err(),
            "{field}"
        );
    }
}

#[test]
fn validates_actionable_drift_and_rejects_duplicate_missing_entries() {
    let mut report = freshness();
    report["ageDays"] = json!(1);
    report["status"] = json!("fresh");
    report["hasDrift"] = json!(true);
    report["drift"]["added"] = json!(1);
    report["reasons"] = json!(["registry snapshot yields drift: +1 ~0 -0"]);
    assert_eq!(
        render("needs-attention", &report.to_string()).unwrap(),
        "true"
    );
    report["reasons"] = json!([]);
    assert!(render("needs-attention", &report.to_string()).is_err());
    let mut report = coverage();
    report["missing"] = json!(["qwen999", "qwen999"]);
    assert!(render("missing-count", &report.to_string()).is_err());
}
