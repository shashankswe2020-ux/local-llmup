use rigspark_core::{
    MODELS_JSON,
    catalog::Catalog,
    sizing::{KvCacheType, kv_cache_bytes, typed_kv_bytes_per_token},
};

const ALL: [KvCacheType; 3] = [KvCacheType::F16, KvCacheType::Q8_0, KvCacheType::Q4_0];

fn catalog_rates() -> Vec<(String, u64)> {
    let catalog = Catalog::parse(MODELS_JSON).unwrap();
    let rates: Vec<_> = catalog
        .models
        .iter()
        .filter_map(|model| {
            model
                .kv_bytes_per_token
                .map(|rate| (model.id.clone(), rate as u64))
        })
        .collect();
    assert!(!rates.is_empty());
    rates
}

#[test]
fn f16_cache_matches_the_legacy_rate_for_every_catalog_model() {
    for (id, rate) in catalog_rates() {
        let typed = typed_kv_bytes_per_token(rate, KvCacheType::F16, KvCacheType::F16).unwrap();
        assert_eq!(typed, rate, "{id}");
        assert_eq!(
            kv_cache_bytes(typed, 32_768).unwrap(),
            kv_cache_bytes(rate, 32_768).unwrap(),
            "{id}"
        );
    }
}

#[test]
fn quantized_caches_follow_ggml_block_layouts() {
    // 16 KiB/token f16: 4096 K and 4096 V elements, i.e. 128 blocks of 32 each.
    let cases = [
        (KvCacheType::Q8_0, KvCacheType::Q8_0, 2 * 128 * 34),
        (KvCacheType::Q4_0, KvCacheType::Q4_0, 2 * 128 * 18),
        (KvCacheType::Q8_0, KvCacheType::F16, 128 * 34 + 8192),
        (KvCacheType::F16, KvCacheType::Q4_0, 8192 + 128 * 18),
    ];
    for (k, v, expected) in cases {
        assert_eq!(
            typed_kv_bytes_per_token(16_384, k, v).unwrap(),
            expected,
            "{k:?}/{v:?}"
        );
    }
    // A partial trailing block is sized as a whole block, never rounded down.
    assert_eq!(
        typed_kv_bytes_per_token(8, KvCacheType::Q8_0, KvCacheType::Q8_0).unwrap(),
        2 * 34
    );
}

#[test]
fn smaller_cache_types_never_need_more_memory_for_any_catalog_model() {
    for (id, rate) in catalog_rates() {
        let size = |kind| typed_kv_bytes_per_token(rate, kind, kind).unwrap();
        assert!(size(KvCacheType::Q4_0) < size(KvCacheType::Q8_0), "{id}");
        assert!(size(KvCacheType::Q8_0) < size(KvCacheType::F16), "{id}");
    }
}

#[test]
fn rejects_rates_that_cannot_be_split_into_whole_f16_k_and_v_halves() {
    for rate in [0, 1, 2, 6, 16_386] {
        assert!(
            typed_kv_bytes_per_token(rate, KvCacheType::F16, KvCacheType::F16).is_err(),
            "{rate}"
        );
    }
    assert!(typed_kv_bytes_per_token(u64::MAX - 3, KvCacheType::F16, KvCacheType::F16).is_err());
}

#[test]
fn cache_type_names_round_trip_and_unknown_names_are_rejected() {
    for kind in ALL {
        assert_eq!(KvCacheType::parse(kind.name()), Some(kind));
        assert_eq!(
            serde_json::to_value(kind).unwrap(),
            serde_json::json!(kind.name())
        );
        assert_eq!(
            serde_json::from_value::<KvCacheType>(serde_json::json!(kind.name())).unwrap(),
            kind
        );
    }
    assert_eq!(ALL.map(KvCacheType::name), ["f16", "q8_0", "q4_0"]);
    for name in ["", "F16", "q8", "q4_1", "bf16", "f32", "q8_0 "] {
        assert_eq!(KvCacheType::parse(name), None, "{name:?}");
    }
    assert!(serde_json::from_value::<KvCacheType>(serde_json::json!("q4_1")).is_err());
    assert_eq!(KvCacheType::default(), KvCacheType::F16);
}
