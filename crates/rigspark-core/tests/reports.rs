use rigspark_core::{
    catalog::{Catalog, PerfDataset},
    ranking::{AdviceOptions, recommend},
    reports::{can_run, catalog_text, recommendation_text, strip_control},
    sizing::Hardware,
};
use serde_json::json;

#[test]
fn formats_existing_advice_contracts() {
    let catalog = Catalog::parse(include_str!("../../rigspark-core/data/models.json")).unwrap();
    let perf = PerfDataset::parse(include_str!("../../rigspark-core/data/perf.json")).unwrap();
    let hardware: Hardware = serde_json::from_value(json!({"arch":"x64","platform":"linux","totalRamBytes":68719476736_u64,"freeRamBytes":60000000000_u64,"freeDiskBytes":500000000000_u64,"gpu":[{"vendor":"nvidia","vramBytes":25769803776_u64}]})).unwrap();
    let options = AdviceOptions::default();
    let report = recommend(&catalog, &hardware, &perf, &options).unwrap();
    assert!(recommendation_text(&report, &options).contains("Run the top pick:"));
    let (json, text) = can_run(&catalog, &hardware, &perf, "llama3.1:8b", &options).unwrap();
    assert_eq!(json["model"], "llama3.1:8b");
    assert!(text.contains("Estimated throughput:"));
    assert!(
        catalog_text(&catalog, &hardware, true)
            .unwrap()
            .starts_with("Catalog (Filter: all, shown: 69/69)")
    );
    assert_eq!(strip_control("\u{1b}[31mred\u{1b}[0m\u{202e}\n"), "red");
}

#[test]
fn recommendation_text_suppresses_unsafe_or_truncated_commands_without_changing_json() {
    let mut catalog = Catalog::parse(include_str!("../../rigspark-core/data/models.json")).unwrap();
    catalog.models.truncate(1);
    let perf = PerfDataset::parse(include_str!("../../rigspark-core/data/perf.json")).unwrap();
    let hardware: Hardware = serde_json::from_value(json!({"arch":"x64","platform":"linux","totalRamBytes":68719476736_u64,"freeRamBytes":60000000000_u64,"freeDiskBytes":500000000000_u64,"gpu":[]})).unwrap();
    let options = AdviceOptions::default();
    for id in [
        "model;echo injected",
        "-flag",
        "org/../model",
        &"a".repeat(257 - "rigspark up ".len()),
    ] {
        catalog.models[0].id = id.into();
        let validated = Catalog::parse(&serde_json::to_string(&catalog).unwrap()).unwrap();
        let report = recommend(&validated, &hardware, &perf, &options).unwrap();
        let original = report.clone();
        assert_eq!(report["command"], format!("rigspark up {id}"));
        assert!(
            !recommendation_text(&report, &options).contains("Run the top pick:"),
            "{id:?}"
        );
        assert_eq!(report, original);
    }
}

#[test]
fn empty_catalogs_are_distinguished_from_catalogs_where_nothing_fits() {
    let mut catalog = Catalog::parse(include_str!("../../rigspark-core/data/models.json")).unwrap();
    let perf = PerfDataset::parse(include_str!("../../rigspark-core/data/perf.json")).unwrap();
    let tiny: Hardware = serde_json::from_value(json!({"arch":"arm64","platform":"darwin","totalRamBytes":1_000_000,"freeRamBytes":1_000_000,"freeDiskBytes":500000000000_u64,"gpu":[]})).unwrap();
    let options = AdviceOptions::default();
    let too_big = recommendation_text(
        &recommend(&catalog, &tiny, &perf, &options).unwrap(),
        &options,
    );
    assert!(
        too_big.contains("No models fit this hardware."),
        "{too_big}"
    );
    assert!(too_big.contains(&catalog.models[0].id));
    assert!(!too_big.contains("No models in the catalog"));
    catalog.models.clear();
    let empty = recommendation_text(
        &recommend(&catalog, &tiny, &perf, &options).unwrap(),
        &options,
    );
    assert_eq!(empty, "No models in the catalog.");
}
