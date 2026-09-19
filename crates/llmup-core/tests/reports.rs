use llmup_core::{
    catalog::{Catalog, PerfDataset},
    ranking::{AdviceOptions, recommend},
    reports::{can_run, catalog_text, recommendation_text, strip_control},
    sizing::Hardware,
};
use serde_json::json;

#[test]
fn formats_existing_advice_contracts() {
    let catalog = Catalog::parse(include_str!("../../../data/models.json")).unwrap();
    let perf = PerfDataset::parse(include_str!("../../../data/perf.json")).unwrap();
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
            .starts_with("Catalog (Filter: all, shown: 66/66)")
    );
    assert_eq!(strip_control("\u{1b}[31mred\u{1b}[0m\u{202e}\n"), "red");
}
