use rigspark_cli::accessible_read_only::can_run_screen;
use rigspark_core::{
    catalog::{Catalog, PerfDataset},
    reports::can_run_report,
};
use serde_json::{Value, json};

fn legacy_screen(report: &Value) -> String {
    let screen = can_run_screen(report).unwrap();
    let warning = "\nRequested context fit unknown: attention geometry unavailable";
    assert_eq!(screen.contains(warning), report["contextFitKnown"] == false);
    screen.replace(warning, "")
}

#[test]
fn native_evidence_and_screens_match_all_frozen_can_run_cases() {
    let cases: Vec<Value> =
        serde_json::from_str(include_str!("can-run-accessible-oracle.json")).unwrap();
    assert_eq!(cases.len(), 58);
    let catalog = Catalog::parse(include_str!("../../rigspark-core/data/models.json")).unwrap();
    let perf = PerfDataset::parse(include_str!("../../rigspark-core/data/perf.json")).unwrap();
    for case in cases {
        assert_eq!(
            legacy_screen(&case["report"]),
            case["expected"].as_str().unwrap(),
            "{}",
            case["report"]
        );
        if let Some(hardware) = case.get("hardware") {
            let report = can_run_report(
                &catalog,
                &serde_json::from_value(hardware.clone()).unwrap(),
                &perf,
                case["query"].as_str().unwrap(),
                &serde_json::from_value(case["options"].clone()).unwrap(),
            )
            .unwrap();
            assert_eq!(
                report.evidence["requiredBytes"].as_f64(),
                case["report"]["requiredBytes"].as_f64()
            );
            assert_eq!(
                report.evidence["usableBytes"].as_f64(),
                case["report"]["usableBytes"].as_f64()
            );
            assert_eq!(
                legacy_screen(&report.evidence),
                case["expected"].as_str().unwrap(),
                "{case}"
            );
        }
    }
}

#[test]
fn malformed_evidence_never_becomes_fabricated_advice() {
    let cases: Vec<Value> =
        serde_json::from_str(include_str!("can-run-accessible-oracle.json")).unwrap();
    let base = cases
        .iter()
        .find(|case| case["report"]["runnable"] == "yes")
        .unwrap()["report"]
        .clone();
    for (field, value) in [
        ("runnable", json!("maybe")),
        ("usableBytes", json!(-1)),
        ("requiredBytes", json!(null)),
        (
            "throughput",
            json!({"known":true,"lowTokPerSec":100,"highTokPerSec":2}),
        ),
        (
            "throughput",
            json!({"known":false,"lowTokPerSec":0,"highTokPerSec":0}),
        ),
        (
            "throughputEvidence",
            json!({"source":"invented","unknownReason":null}),
        ),
        ("backends", json!(vec!["ollama"; 1001])),
    ] {
        let mut report = base.clone();
        report[field] = value;
        assert!(can_run_screen(&report).is_err(), "{field}: {report}");
    }
    assert!(can_run_screen(&json!({})).is_err());
}
