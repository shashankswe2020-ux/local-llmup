use llmup_core::{
    catalog::{Catalog, PerfDataset},
    ranking::AdviceOptions,
    reports::{can_run, can_run_report},
    sizing::Hardware,
};

#[test]
fn accessibility_evidence_does_not_change_public_json_or_plain_contracts() {
    let catalog = Catalog::parse(include_str!("../../llmup-core/data/models.json")).unwrap();
    let perf = PerfDataset::parse(include_str!("../../llmup-core/data/perf.json")).unwrap();
    let hardware:Hardware=serde_json::from_str(r#"{"arch":"x64","platform":"linux","totalRamBytes":68719476736,"freeRamBytes":60000000000,"freeDiskBytes":500000000000,"gpu":[{"vendor":"nvidia","vramBytes":25769803776}]}"#).unwrap();
    for context in [None, Some(8192.0)] {
        let options = AdviceOptions {
            context,
            ..Default::default()
        };
        for query in ["llama3.1:8b", "deepseek-r1:671b"] {
            let old = can_run(&catalog, &hardware, &perf, query, &options).unwrap();
            let report = can_run_report(&catalog, &hardware, &perf, query, &options).unwrap();
            assert_eq!(report.json, old.0);
            assert_eq!(report.text, old.1);
            assert_eq!(report.evidence["modelId"], report.json["model"]);
            assert_eq!(report.evidence["runnable"], report.json["verdict"]);
            assert!(report.evidence["usableBytes"].as_f64().unwrap() > 0.0);
            assert_eq!(report.json.get("usableBytes").is_some(), context.is_some());
            if report.evidence["runnable"] == "no" {
                let model = catalog
                    .models
                    .iter()
                    .find(|model| model.id == query)
                    .unwrap();
                let verdict =
                    llmup_core::advice::verdict(model, &hardware, &perf, context, "ollama")
                        .unwrap();
                assert_eq!(report.evidence["requiredBytes"], verdict["requiredBytes"]);
                assert_eq!(
                    report.evidence["throughputEvidence"]["unknownReason"],
                    "not-evaluated-model-does-not-fit"
                );
            } else {
                assert!(report.evidence["requiredBytes"].as_f64().unwrap() > 0.0);
            }
        }
    }
}
