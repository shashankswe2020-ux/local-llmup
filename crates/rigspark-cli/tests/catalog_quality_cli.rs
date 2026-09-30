use serde_json::Value;
use std::process::Command;

#[test]
fn absent_verification_evidence_blocks_publication_without_network_or_keys() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let temporary = tempfile::tempdir().unwrap();
    let mut catalog: Value = serde_json::from_str(rigspark_core::MODELS_JSON).unwrap();
    catalog["generatedAt"] = serde_json::json!("2026-09-30T00:00:00Z");
    let catalog_path = temporary.path().join("catalog.json");
    std::fs::write(&catalog_path, catalog.to_string()).unwrap();
    let evidence = temporary.path().join("evidence.json");
    std::fs::write(
        &evidence,
        r#"{"policyVersion":1,"scopes":[],"observations":[]}"#,
    )
    .unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_llmup-catalog-quality"))
        .current_dir(&root)
        .args(["--now", "2026-09-30T12:00:00Z"])
        .arg("--catalog-path")
        .arg(&catalog_path)
        .arg("--evidence")
        .arg(&evidence)
        .env("PATH", "")
        .output()
        .unwrap();
    assert!(!output.status.success());
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["passed"], false);
    assert!(report["freshnessPercent"].is_null());
    assert_eq!(report["correctnessPercent"], 0.0);
    assert_eq!(report["minimumPercent"], 90);
}
