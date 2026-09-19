use llmup_core::catalog::{Catalog, PerfDataset, resolve};
use serde_json::{Value, json};

fn catalog() -> Value {
    serde_json::from_str(include_str!("../../../data/models.json")).unwrap()
}

#[test]
fn loads_shipped_catalog_and_performance_evidence() {
    let loaded = Catalog::parse(&catalog().to_string()).unwrap();
    assert_eq!(loaded.models.len(), 66);
    assert!(
        !PerfDataset::parse(include_str!("../../../data/perf.json"))
            .unwrap()
            .classes
            .is_empty()
    );
    let entry = &loaded.models[0];
    assert_eq!(resolve(&loaded, &entry.id).unwrap().model.id, entry.id);
    let query = format!("{}-{}", entry.id, entry.quantizations[0].name);
    assert_eq!(
        resolve(&loaded, &query.to_uppercase())
            .unwrap()
            .quant
            .unwrap()
            .name,
        entry.quantizations[0].name
    );
}

#[test]
fn resolver_preserves_precedence_and_rejects_unsafe_input() {
    let mut value = catalog();
    value["models"] = json!([value["models"][0].clone(), value["models"][0].clone()]);
    value["models"][0]["id"] = json!("sample:small");
    value["models"][1]["id"] = json!("sample:large");
    value["models"][0]["family"] = json!("sample");
    value["models"][1]["family"] = json!("sample");
    let loaded = Catalog::parse(&value.to_string()).unwrap();
    assert_eq!(
        resolve(&loaded, " SAMPLE:SMALL ").unwrap().model.id,
        "sample:small"
    );
    assert_eq!(
        resolve(&loaded, "sample:l").unwrap().model.id,
        "sample:large"
    );
    assert_eq!(
        resolve(&loaded, "sample").unwrap_err().candidates,
        ["sample:large", "sample:small"]
    );
    assert!(
        resolve(&loaded, "missing")
            .unwrap_err()
            .candidates
            .is_empty()
    );
    for query in ["", "../escape", "name;command", "-flag"] {
        assert!(resolve(&loaded, query).is_err());
    }
}

#[test]
fn rejects_schema_and_source_integrity_failures() {
    for (field, bad) in [
        ("architecture", json!("other")),
        ("openWeight", json!(false)),
        ("releaseDate", json!("2026-02-30")),
        ("license", json!("closed")),
        ("capabilities", json!([])),
        ("source", json!({})),
        ("unexpected", json!(true)),
    ] {
        let mut value = catalog();
        value["models"][0][field] = bad;
        assert!(Catalog::parse(&value.to_string()).is_err(), "{field}");
    }
    let mut value = catalog();
    value["models"][0]["source"] = json!({"gguf":{"repo":"owner/repo","revision":"a".repeat(40),"file":"../bad.gguf","sha256":"b".repeat(64)}});
    assert!(Catalog::parse(&value.to_string()).is_err());
    value["models"][0]["source"] = json!({"mlx":{"repo":"owner/repo","revision":"a".repeat(40),"files":[
        {"file":"config.json","bytes":1,"sha256":"b".repeat(64)},
        {"file":"tokenizer_config.json","bytes":1,"sha256":"b".repeat(64)},
        {"file":"model.py","bytes":1,"sha256":"b".repeat(64)}]}});
    assert!(Catalog::parse(&value.to_string()).is_err());
}

#[test]
fn rejects_overlapping_performance_classes_and_untrusted_efficiency() {
    let mut value: Value = serde_json::from_str(include_str!("../../../data/perf.json")).unwrap();
    value["classes"][1] = value["classes"][0].clone();
    assert!(PerfDataset::parse(&value.to_string()).is_err());
    value["classes"][1]["id"] = json!("another");
    assert!(PerfDataset::parse(&value.to_string()).is_err());
    value["classes"] = json!([value["classes"][0].clone()]);
    value["classes"][0]["sources"]["efficiencyByBackend"]["llamacpp"]["trustTier"] =
        json!("low-confidence");
    assert!(PerfDataset::parse(&value.to_string()).is_err());
}

#[test]
fn sanitizes_loaded_display_fields_and_checks_sanitized_duplicates() {
    let mut value = catalog();
    value["models"][0]["family"] = json!("\u{1b}[31mfamily\u{1b}[0m\u{202e}");
    assert_eq!(
        Catalog::parse(&value.to_string()).unwrap().models[0].family,
        "family"
    );
    value["models"] = json!([value["models"][0].clone(), value["models"][0].clone()]);
    value["models"][1]["id"] = json!(format!(
        "{}\u{202e}",
        value["models"][0]["id"].as_str().unwrap()
    ));
    assert!(Catalog::parse(&value.to_string()).is_err());
    let mut perf: Value = serde_json::from_str(include_str!("../../../data/perf.json")).unwrap();
    perf["classes"][0]["label"] = json!("\u{1b}[31mlabel\u{1b}[0m");
    assert_eq!(
        PerfDataset::parse(&perf.to_string()).unwrap().classes[0].label,
        "label"
    );
}
