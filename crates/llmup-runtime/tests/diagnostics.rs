use llmup_core::{catalog::Catalog, sizing::Hardware};
use llmup_runtime::diagnostics::{BackendInfo, format_report, report};
use serde_json::json;

#[test]
fn offline_doctor_reports_unchecked_state_and_backend_failure_honestly() {
    let catalog = Catalog::parse(include_str!("../../../data/models.json")).unwrap();
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
