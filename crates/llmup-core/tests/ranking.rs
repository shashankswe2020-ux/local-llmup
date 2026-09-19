use llmup_core::{
    catalog::{Catalog, PerfDataset},
    ranking::{AdviceOptions, recommend},
    sizing::Hardware,
};
use serde_json::json;

#[test]
fn ranks_deterministically_at_explicit_and_relative_contexts() {
    let catalog = Catalog::parse(include_str!("../../../data/models.json")).unwrap();
    let perf = PerfDataset::parse(include_str!("../../../data/perf.json")).unwrap();
    let hardware: Hardware = serde_json::from_value(json!({"arch":"arm64","platform":"darwin","totalRamBytes":34359738368_u64,"freeRamBytes":24000000000_u64,"freeDiskBytes":500000000000_u64,"gpu":[]})).unwrap();
    let options = AdviceOptions {
        context: Some(65536.0),
        ..Default::default()
    };
    let result = recommend(&catalog, &hardware, &perf, &options).unwrap();
    assert_eq!(
        result,
        recommend(&catalog, &hardware, &perf, &options).unwrap()
    );
    assert_eq!(
        result["ranked"].as_array().unwrap().len() + result["wontFit"].as_array().unwrap().len(),
        catalog.models.len()
    );
    assert!(
        result["ranked"]
            .as_array()
            .unwrap()
            .iter()
            .all(|entry| entry["context"] == 65536.0)
    );
    let relative = recommend(
        &catalog,
        &hardware,
        &perf,
        &AdviceOptions {
            context_percent: Some(25),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(!relative["ranked"].as_array().unwrap().is_empty());
    assert!(
        recommend(
            &catalog,
            &hardware,
            &perf,
            &AdviceOptions {
                context: Some(1.0),
                max_context: true,
                ..Default::default()
            }
        )
        .is_err()
    );
}

#[test]
fn ties_use_id_and_available_backend_filters_renumber_results() {
    let mut catalog = Catalog::parse(include_str!("../../../data/models.json")).unwrap();
    let mut first = catalog
        .models
        .iter()
        .find(|model| model.id == "llama3.1:8b")
        .unwrap()
        .clone();
    first.id = "tie:z".into();
    let mut second = first.clone();
    second.id = "tie:a".into();
    catalog.models = vec![first, second];
    let hardware: Hardware = serde_json::from_value(json!({"arch":"x64","platform":"linux","totalRamBytes":68719476736_u64,"freeRamBytes":60000000000_u64,"freeDiskBytes":500000000000_u64,"gpu":[{"vendor":"nvidia","vramBytes":25769803776_u64}]})).unwrap();
    let perf = PerfDataset::parse(include_str!("../../../data/perf.json")).unwrap();
    let result = recommend(&catalog, &hardware, &perf, &AdviceOptions::default()).unwrap();
    assert_eq!(result["ranked"][0]["id"], "tie:a");
    let result = recommend(
        &catalog,
        &hardware,
        &perf,
        &AdviceOptions {
            available_backends: Some(vec![]),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(result["ranked"].as_array().unwrap().is_empty());
    assert!(result["command"].is_null());
}
