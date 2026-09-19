use llmup_core::enrich::EnrichDiff;
use llmup_core::freshness::{evaluate, format_report};

const GENERATED: &str = "2026-01-01T00:00:00.000Z";

#[test]
fn each_actionable_change_independently_requires_attention() {
    for diff in [
        EnrichDiff {
            added: vec!["new:8b".into()],
            ..EnrichDiff::default()
        },
        EnrichDiff {
            updated: vec!["updated:8b".into()],
            ..EnrichDiff::default()
        },
        EnrichDiff {
            removed: vec!["removed:8b".into()],
            ..EnrichDiff::default()
        },
    ] {
        let report = evaluate(GENERATED, &diff, GENERATED, 7).unwrap();
        let json = serde_json::to_value(report).unwrap();
        assert_eq!(json["status"], "fresh");
        assert_eq!(json["hasDrift"], true);
        assert_eq!(json["needsAttention"], true);
        assert_eq!(json["reasons"].as_array().unwrap().len(), 1);
    }
}

#[test]
fn whole_day_age_and_threshold_match_retained_contract() {
    for (now, age, status) in [
        ("2025-12-01T00:00:00Z", 0, "fresh"),
        ("2026-01-02T23:59:59Z", 1, "fresh"),
        ("2026-01-08T23:59:59Z", 7, "fresh"),
        ("2026-01-09T00:00:00Z", 8, "stale"),
    ] {
        let report = evaluate(GENERATED, &EnrichDiff::default(), now, 7).unwrap();
        let json = serde_json::to_value(&report).unwrap();
        assert_eq!(json["ageDays"], age);
        assert_eq!(json["status"], status);
        assert_eq!(json["needsAttention"], status == "stale");
    }
    assert!(evaluate("invalid", &EnrichDiff::default(), GENERATED, 7).is_err());
    assert!(evaluate(GENERATED, &EnrichDiff::default(), "invalid", 7).is_err());
    let custom = evaluate(GENERATED, &EnrichDiff::default(), "2026-01-08T00:00:00Z", 5).unwrap();
    assert_eq!(serde_json::to_value(custom).unwrap()["status"], "stale");
}

#[test]
fn skipped_and_capped_models_are_not_actionable() {
    let diff = EnrichDiff {
        skipped: vec!["closed:70b".into()],
        capped: vec!["tiny:1b".into()],
        ..EnrichDiff::default()
    };
    let report = evaluate(GENERATED, &diff, "2026-01-05T00:00:00Z", 7).unwrap();
    assert_eq!(
        serde_json::to_value(&report).unwrap(),
        serde_json::json!({
            "generatedAt": GENERATED, "ageDays": 4, "staleAfterDays": 7,
            "status": "fresh", "hasDrift": false, "needsAttention": false,
            "drift": {"added": 0, "updated": 0, "removed": 0, "skipped": 1, "capped": 1},
            "reasons": []
        })
    );
    assert!(!format_report(&report).contains("reasons:"));
}

#[test]
fn exact_json_and_human_report_preserve_both_attention_reasons() {
    let diff = EnrichDiff {
        added: vec!["qwen3:32b".into()],
        updated: vec!["llama3.1:8b".into()],
        removed: vec!["withdrawn:8b".into()],
        ..EnrichDiff::default()
    };
    let report = evaluate(GENERATED, &diff, "2026-03-01T00:00:00Z", 7).unwrap();
    assert_eq!(
        serde_json::to_value(&report).unwrap(),
        serde_json::json!({
            "generatedAt": GENERATED, "ageDays": 59, "staleAfterDays": 7,
            "status": "stale", "hasDrift": true, "needsAttention": true,
            "drift": {"added": 1, "updated": 1, "removed": 1, "skipped": 0, "capped": 0},
            "reasons": ["catalog is 59 days old (stale after 7)", "registry snapshot yields drift: +1 ~1 -1"]
        })
    );
    assert_eq!(
        format_report(&report),
        "Catalog freshness\n  generated: 2026-01-01T00:00:00.000Z\n  age:       59 day(s) (stale after 7)\n  status:    stale\n  drift:     added=1 updated=1 removed=1 skipped=0 capped=0\n  attention: yes\n  reasons:\n    - catalog is 59 days old (stale after 7)\n    - registry snapshot yields drift: +1 ~1 -1"
    );
    let fresh = evaluate(GENERATED, &diff, GENERATED, 7).unwrap();
    assert_eq!(serde_json::to_value(fresh).unwrap()["needsAttention"], true);
}
