use llmup_core::{bootstrap::derive_benchmark_proxy, catalog::Catalog};

#[test]
fn reproduces_every_curated_catalog_proxy() {
    let catalog = Catalog::parse(include_str!("../../../data/models.json")).unwrap();
    for model in catalog.models {
        assert_eq!(
            Some(derive_benchmark_proxy(&model.family, &model.params).unwrap()),
            model.benchmark_proxy,
            "{}",
            model.id
        );
    }
}

#[test]
fn parameter_ladder_uses_exclusive_ceilings() {
    for (params, expected) in [
        ("0.49B", 0.05),
        ("0.5B", 0.12),
        ("1B", 0.2),
        ("2B", 0.28),
        ("4B", 0.36),
        ("7B", 0.44),
        ("10B", 0.52),
        ("15B", 0.58),
        ("25B", 0.64),
        ("40B", 0.7),
        ("80B", 0.78),
        ("200B", 0.85),
    ] {
        assert_eq!(
            derive_benchmark_proxy("unknown-family", params).unwrap(),
            expected
        );
    }
}

#[test]
fn family_offsets_and_total_moe_parameters_match_bootstrap() {
    assert_eq!(derive_benchmark_proxy("qwen3", "30B").unwrap(), 0.74);
    assert_eq!(
        derive_benchmark_proxy("kimi-k2-thinking", "1T").unwrap(),
        0.99
    );
    assert_eq!(derive_benchmark_proxy("phi4", "14B").unwrap(), 0.64);
    assert!(derive_benchmark_proxy("qwen3", "invalid").is_err());
}
