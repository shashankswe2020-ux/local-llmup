use llmup_core::{
    MODELS_JSON, PERF_JSON,
    catalog::{Catalog, PerfDataset},
    plan::{format_plan, plan, plan_with_cache},
    ranking::{AdviceOptions, recommend},
    reports::{can_run, recommendation_text},
    sizing::{Hardware, KvCacheType, typed_kv_bytes_per_token},
};
use serde_json::{Value, json};

fn data() -> (Catalog, PerfDataset) {
    (
        Catalog::parse(MODELS_JSON).unwrap(),
        PerfDataset::parse(PERF_JSON).unwrap(),
    )
}

fn laptop() -> Hardware {
    serde_json::from_value(
        json!({"arch":"arm64","platform":"darwin","totalRamBytes":34359738368_u64,
        "freeRamBytes":24000000000_u64,"freeDiskBytes":500000000000_u64,"gpu":[]}),
    )
    .unwrap()
}

fn ranked(report: &Value) -> &Vec<Value> {
    report["ranked"].as_array().unwrap()
}

#[test]
fn with_kv_cache_resizes_only_known_geometry_and_f16_is_identity() {
    let (catalog, _) = data();
    for model in &catalog.models {
        let f16 = model.with_kv_cache(KvCacheType::F16).unwrap();
        assert_eq!(
            f16.kv_bytes_per_token, model.kv_bytes_per_token,
            "{}",
            model.id
        );
        let q8 = model.with_kv_cache(KvCacheType::Q8_0).unwrap();
        assert_eq!(
            q8.kv_bytes_per_token,
            model
                .kv_bytes_per_token
                .map(|rate| typed_kv_bytes_per_token(
                    rate as u64,
                    KvCacheType::Q8_0,
                    KvCacheType::Q8_0
                )
                .unwrap() as f64),
            "{}",
            model.id
        );
        assert_eq!(q8.quantizations.len(), model.quantizations.len());
    }
}

#[test]
fn an_explicit_f16_cache_changes_nothing_and_no_flag_stays_labelled_fp16() {
    let (catalog, perf) = data();
    for base in [
        AdviceOptions {
            context: Some(65536.0),
            ..Default::default()
        },
        AdviceOptions {
            max_context: true,
            ..Default::default()
        },
    ] {
        let legacy = recommend(&catalog, &laptop(), &perf, &base).unwrap();
        let explicit = AdviceOptions {
            kv_cache: Some(KvCacheType::F16),
            ..base
        };
        assert_eq!(
            recommend(&catalog, &laptop(), &perf, &explicit).unwrap(),
            legacy
        );
        assert!(
            ranked(&legacy)
                .iter()
                .all(|entry| entry["kvPrecision"] == "fp16")
        );
        assert!(recommendation_text(&legacy, &explicit).contains("(KV fp16)"));
    }
}

#[test]
fn quantized_caches_shrink_only_the_kv_term_and_never_fit_fewer_models() {
    let (catalog, perf) = data();
    let at = |kv_cache| AdviceOptions {
        context: Some(131072.0),
        kv_cache,
        ..Default::default()
    };
    let f16 = recommend(&catalog, &laptop(), &perf, &at(None)).unwrap();
    let q8 = recommend(&catalog, &laptop(), &perf, &at(Some(KvCacheType::Q8_0))).unwrap();
    let q4 = recommend(&catalog, &laptop(), &perf, &at(Some(KvCacheType::Q4_0))).unwrap();
    assert!(ranked(&q8).len() >= ranked(&f16).len());
    assert!(ranked(&q4).len() >= ranked(&q8).len());
    for entry in ranked(&q8) {
        assert_eq!(entry["kvPrecision"], "q8_0");
        let model = catalog
            .models
            .iter()
            .find(|model| model.id == entry["id"])
            .unwrap();
        let expected = model.kv_bytes_per_token.map(|rate| {
            typed_kv_bytes_per_token(rate as u64, KvCacheType::Q8_0, KvCacheType::Q8_0).unwrap()
                as f64
                * 131072.0
        });
        assert_eq!(entry["kvCacheBytes"].as_f64(), expected, "{}", model.id);
        if let Some(prior) = ranked(&f16).iter().find(|prior| prior["id"] == entry["id"]) {
            assert_eq!(entry["weightsBytes"], prior["weightsBytes"]);
            assert!(
                entry["requiredBytes"].as_f64().unwrap()
                    <= prior["requiredBytes"].as_f64().unwrap()
            );
        }
    }
    assert!(recommendation_text(&q8, &at(Some(KvCacheType::Q8_0))).contains("(KV q8_0)"));
}

#[test]
fn max_context_grows_with_a_smaller_cache_and_unknown_geometry_stays_unknown() {
    let (catalog, perf) = data();
    let max = |kv_cache| {
        recommend(
            &catalog,
            &laptop(),
            &perf,
            &AdviceOptions {
                max_context: true,
                kv_cache,
                ..Default::default()
            },
        )
        .unwrap()
    };
    let f16 = max(None);
    let q4 = max(Some(KvCacheType::Q4_0));
    let mut grew = false;
    for entry in ranked(&q4) {
        assert_eq!(entry["kvPrecision"], "q4_0");
        let prior = ranked(&f16)
            .iter()
            .find(|prior| prior["id"] == entry["id"])
            .unwrap();
        match (
            entry["maxContextTokens"].as_f64(),
            prior["maxContextTokens"].as_f64(),
        ) {
            (Some(now), Some(before)) => {
                assert!(now >= before, "{}", entry["id"]);
                grew |= now > before;
            }
            (None, None) => assert_eq!(entry["boundBy"], "unknown"),
            other => panic!("geometry knowledge changed for {}: {other:?}", entry["id"]),
        }
    }
    assert!(
        grew,
        "a smaller cache should raise at least one hardware-bound maximum"
    );
}

#[test]
fn a_cache_type_without_a_sized_context_is_rejected() {
    let (catalog, perf) = data();
    let options = AdviceOptions {
        kv_cache: Some(KvCacheType::Q8_0),
        ..Default::default()
    };
    assert!(options.validate().is_err());
    assert!(recommend(&catalog, &laptop(), &perf, &options).is_err());
    assert!(
        AdviceOptions {
            context_percent: Some(50),
            kv_cache: Some(KvCacheType::Q8_0),
            ..Default::default()
        }
        .validate()
        .is_ok()
    );
}

#[test]
fn can_run_labels_the_cache_and_keeps_legacy_json_without_the_flag() {
    let (catalog, perf) = data();
    let at = |kv_cache| AdviceOptions {
        context: Some(131072.0),
        kv_cache,
        ..Default::default()
    };
    let (legacy, legacy_text) =
        can_run(&catalog, &laptop(), &perf, "llama3.1:8b", &at(None)).unwrap();
    assert!(legacy.get("kvPrecision").is_none());
    assert!(legacy_text.contains("(KV fp16 estimate)"));
    let (q8, q8_text) = can_run(
        &catalog,
        &laptop(),
        &perf,
        "llama3.1:8b",
        &at(Some(KvCacheType::Q8_0)),
    )
    .unwrap();
    assert_eq!(q8["kvPrecision"], "q8_0");
    assert!(q8_text.contains("(KV q8_0 estimate)"));
    assert!(q8["requiredBytes"].as_f64().unwrap() < legacy["requiredBytes"].as_f64().unwrap());
}

#[test]
fn plan_reports_the_cache_type_only_when_one_is_chosen() {
    let (catalog, perf) = data();
    let model = catalog
        .models
        .iter()
        .find(|model| model.id == "llama3.1:8b")
        .unwrap();
    let legacy = plan(model, &laptop(), &perf, Some(131072.0), "ollama").unwrap();
    let json = serde_json::to_value(&legacy).unwrap();
    assert!(json.get("kvCacheType").is_none());
    let q8 = plan_with_cache(
        model,
        &laptop(),
        &perf,
        Some(131072.0),
        "ollama",
        Some(KvCacheType::Q8_0),
    )
    .unwrap();
    assert_eq!(serde_json::to_value(&q8).unwrap()["kvCacheType"], "q8_0");
    assert!(format_plan(&q8).contains("KV q8_0"));
    assert!(!format_plan(&legacy).contains("KV "));
    assert!(q8.paths[0].required_bytes.unwrap() < legacy.paths[0].required_bytes.unwrap());
}
