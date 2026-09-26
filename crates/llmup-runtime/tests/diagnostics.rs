use llmup_core::{catalog::Catalog, sizing::Hardware};
use llmup_runtime::diagnostics::{BackendInfo, format_report, report};
use serde_json::json;

#[test]
fn offline_doctor_reports_unchecked_state_and_backend_failure_honestly() {
    let catalog = Catalog::parse(include_str!("../../llmup-core/data/models.json")).unwrap();
    let hardware: Hardware = serde_json::from_value(json!({"arch":"arm64","platform":"darwin","totalRamBytes":34359738368_u64,"freeRamBytes":24000000000_u64,"freeDiskBytes":500000000000_u64,"gpu":[]})).unwrap();
    let backends = vec![BackendInfo {
        name: "ollama".into(),
        installed: true,
        version: Some("0.32.5".into()),
        is_default: true,
        install_hint: "install ollama".into(),
    }];
    let good = report(&catalog, &hardware, &backends, false);
    assert_eq!(good["ok"], true);
    assert_eq!(good["checks"][3]["detail"], "no active server recorded");
    let existing = report(&catalog, &hardware, &backends, true);
    assert_eq!(existing["checks"][3]["status"], "warn");
    assert!(format_report(&existing).contains("readiness not checked"));
    assert_eq!(report(&catalog, &hardware, &[], false)["ok"], false);
}

#[test]
fn empty_catalog_warns_without_falsely_failing_healthy_hardware() {
    let mut catalog = Catalog::parse(include_str!("../../llmup-core/data/models.json")).unwrap();
    catalog.models.clear();
    let hardware: Hardware = serde_json::from_value(json!({"arch":"arm64","platform":"darwin","totalRamBytes":34359738368_u64,"freeRamBytes":24000000000_u64,"freeDiskBytes":500000000000_u64,"gpu":[]})).unwrap();
    let backends = vec![BackendInfo {
        name: "ollama".into(),
        installed: true,
        version: None,
        is_default: true,
        install_hint: "install ollama".into(),
    }];
    let result = report(&catalog, &hardware, &backends, false);
    assert_eq!(result["ok"], true);
    assert_eq!(result["checks"][0]["status"], "ok");
    assert_eq!(result["checks"][2]["status"], "warn");
    assert!(
        result["checks"][2]["detail"]
            .as_str()
            .unwrap()
            .contains("no models")
    );
}

#[test]
fn failed_inputs_preserve_other_checks_and_never_invent_hardware_score() {
    let catalog = Catalog::parse(include_str!("../../llmup-core/data/models.json")).unwrap();
    let backends = vec![BackendInfo {
        name: "ollama".into(),
        installed: true,
        version: None,
        is_default: true,
        install_hint: "install ollama".into(),
    }];
    let result = llmup_runtime::diagnostics::report_inputs(
        Ok(&catalog),
        Err("probe\u{1b}[31m failed"),
        &backends,
        false,
    );
    assert_eq!(result["ok"], false);
    assert!(result["hardwareScore"].is_null());
    assert_eq!(result["checks"][0]["status"], "fail");
    assert_eq!(result["checks"][1]["status"], "ok");
    assert_eq!(result["checks"][3]["status"], "ok");
    let text = format_report(&result);
    assert!(text.contains("AI Hardware Score: unknown"), "{text}");
    assert!(text.contains("Primary bottleneck: unknown"), "{text}");
    assert!(!text.contains('\u{1b}'));
    let failed = llmup_runtime::diagnostics::report_inputs(
        Err("bad catalog"),
        Err("bad hardware"),
        &backends,
        true,
    );
    assert_eq!(failed["checks"][2]["status"], "fail");
    assert_eq!(failed["checks"].as_array().unwrap().len(), 4);
}

#[test]
fn weak_hardware_and_unverified_digests_do_not_turn_warnings_into_failures() {
    let mut catalog = Catalog::parse(include_str!("../../llmup-core/data/models.json")).unwrap();
    catalog.models[0].quantizations[0].digest_verified = Some(false);
    let hardware: Hardware = serde_json::from_value(json!({"arch":"x64","platform":"linux",
        "totalRamBytes":8589934592_u64,"freeRamBytes":6442450944_u64,
        "freeDiskBytes":42949672960_u64,"gpu":[]}))
    .unwrap();
    let backends = vec![BackendInfo {
        name: "ollama".into(),
        installed: true,
        version: None,
        is_default: true,
        install_hint: "install ollama".into(),
    }];
    let result = report(&catalog, &hardware, &backends, false);
    assert_eq!(result["ok"], true);
    assert!(result["hardwareScore"]["total"].as_f64().unwrap() < 60.0);
    assert_eq!(result["checks"][2]["status"], "warn");
    assert!(format_report(&result).contains("digestVerified:false"));
    assert!(format_report(&result).contains("unknown"));
}
