use llmup_core::{
    catalog::Catalog,
    registry_collector::{apply_layer, parse_layer, parse_reference, quant_from_tag},
};
use serde_json::json;

fn model() -> llmup_core::catalog::CatalogModel {
    Catalog::parse(include_str!("../../llmup-core/data/models.json"))
        .unwrap()
        .models
        .into_iter()
        .find(|model| model.id == "llama3.1:8b")
        .unwrap()
}
fn manifest(size: f64, digest: &str) -> String {
    json!({"layers":[{"mediaType":"application/vnd.ollama.image.license","size":1,"digest":"ignored"},{"mediaType":"application/vnd.ollama.image.model","size":size,"digest":format!("sha256:{digest}")}]}).to_string()
}

#[test]
fn references_and_quant_suffixes_preserve_retained_rules() {
    for (reference, path, tag) in [
        (" llama3.1:8b ", "llama3.1", "8b"),
        ("llama3.1", "llama3.1", "latest"),
        ("library/qwen3:8b", "library/qwen3", "8b"),
        ("host:5000/repo", "host:5000/repo", "latest"),
    ] {
        assert_eq!(parse_reference(reference), (path, tag));
    }
    for (tag, expected) in [
        ("8b-instruct-q4_K_M", Some("Q4_K_M")),
        ("70b-q8_0", Some("Q8_0")),
        ("7b-f16", Some("F16")),
        ("7b-bf16", Some("BF16")),
        ("f32", Some("F32")),
        ("8b", None),
        ("latest", None),
    ] {
        assert_eq!(quant_from_tag(tag).as_deref(), expected);
    }
}

#[test]
fn model_layer_requires_positive_size_and_full_digest() {
    let digest = "a".repeat(64);
    assert_eq!(
        parse_layer(&manifest(1000.0, &digest))
            .unwrap()
            .unwrap()
            .disk_bytes,
        1000.0
    );
    for raw in [
        "{}".into(),
        "invalid".into(),
        manifest(0.0, &digest),
        manifest(1.5, &digest),
        manifest(1000.0, "bad"),
        manifest(9_007_199_254_740_992.0, &digest),
    ] {
        assert!(parse_layer(&raw).is_err() || parse_layer(&raw).unwrap().is_none());
    }
    assert!(parse_layer(&"x".repeat(4 * 1024 * 1024 + 1)).is_err());
}

#[test]
fn patches_only_target_quant_and_preserves_all_curated_metadata() {
    let mut original = model();
    original.source.ollama = Some("llama3.1:8b-q4_K_M".into());
    original.quantizations[0].disk_bytes = 1000.0;
    original.quantizations[0].min_ram_bytes = 1000.0;
    original.quantizations[0].min_vram_bytes = 1000.0;
    let mut other = original.quantizations[0].clone();
    other.name = "Q8_0".into();
    original.quantizations.push(other);
    let layer = parse_layer(&manifest(4_661_211_808.0, &"a".repeat(64)))
        .unwrap()
        .unwrap();
    let updated = apply_layer(&original, &layer).unwrap().unwrap();
    let mut expected = original.clone();
    let target = expected
        .quantizations
        .iter_mut()
        .find(|quant| quant.name == "Q4_K_M")
        .unwrap();
    target.disk_bytes = layer.disk_bytes;
    target.sha256 = Some(layer.sha256.clone());
    let resident = 4_700_000_000.0_f64;
    target.min_ram_bytes = resident + (resident * 0.15).ceil();
    target.min_vram_bytes = target.min_ram_bytes;
    assert_eq!(
        serde_json::to_value(&updated).unwrap(),
        serde_json::to_value(expected).unwrap()
    );
    assert!(apply_layer(&updated, &layer).unwrap().is_none());
    original.source.ollama = Some("llama3.1:8b-f32".into());
    assert!(apply_layer(&original, &layer).unwrap().is_none());
    original.source.ollama = None;
    assert!(apply_layer(&original, &layer).unwrap().is_none());
}

#[test]
fn digest_only_changes_preserve_memory_and_moe_uses_total_parameters() {
    let mut original = model();
    original.source.ollama = Some("llama3.1:8b".into());
    let first = &original.quantizations[0];
    let layer = parse_layer(&manifest(first.disk_bytes, &"f".repeat(64)))
        .unwrap()
        .unwrap();
    let updated = apply_layer(&original, &layer).unwrap().unwrap();
    assert_eq!(updated.quantizations[0].min_ram_bytes, first.min_ram_bytes);
    assert_eq!(
        updated.quantizations[0].min_vram_bytes,
        first.min_vram_bytes
    );
    let mut moe = original.clone();
    moe.architecture = llmup_core::sizing::Architecture::Moe;
    moe.params = "30B".into();
    moe.active_params = Some("3B".into());
    let layer = parse_layer(&manifest(1_000_000.0, &"a".repeat(64)))
        .unwrap()
        .unwrap();
    let updated = apply_layer(&moe, &layer).unwrap().unwrap();
    let bits = llmup_core::sizing::quant_bits(&moe.quantizations[0].name).unwrap();
    let resident = (30e9 * bits / 8.0).ceil();
    assert_eq!(
        updated.quantizations[0].min_ram_bytes,
        resident + (resident * 0.15).ceil()
    );
    moe.quantizations[0].name = "UNKNOWN".into();
    assert!(apply_layer(&moe, &layer).is_err());
    let mut dense = original;
    dense.quantizations[0].name = "UNKNOWN".into();
    let updated = apply_layer(&dense, &layer).unwrap().unwrap();
    assert_eq!(updated.quantizations[0].min_ram_bytes, 1_150_000.0);
}
