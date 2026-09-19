use llmup_core::{
    catalog::Catalog,
    coverage::{evaluate, monitored, parse_inventory},
};

fn catalog(sources: &[&str]) -> Catalog {
    let mut catalog = Catalog::parse(include_str!("../../../data/models.json")).unwrap();
    let template = catalog.models[0].clone();
    catalog.models = sources
        .iter()
        .enumerate()
        .map(|(index, source)| {
            let mut model = template.clone();
            model.id = format!("model-{index}");
            model.source.ollama = Some((*source).into());
            model
        })
        .collect();
    catalog
}

#[test]
fn inventory_reads_active_entries_and_rejects_invalid_structure() {
    let source = "package integration\nvar libraryModels = []string{\n  \"qwen3.6\",\n  // \"closed\",\n /*\n \"excluded\",\n */\n \"gemma4\", // note\n \"qwen3.6\",\n}\n";
    assert_eq!(parse_inventory(source).unwrap(), vec!["gemma4", "qwen3.6"]);
    for source in [
        "package integration",
        "var libraryModels = []string{",
        "var libraryModels = []string{\n}\n",
    ] {
        assert!(parse_inventory(source).is_err());
    }
    assert!(parse_inventory(&"x".repeat(1024 * 1024 + 1)).is_err());
}

#[test]
fn coverage_uses_exact_official_repositories_not_community_or_registry_hosts() {
    let catalog = catalog(&[
        "gemma4:e4b-it-qat",
        "library/qwen3:8b",
        "namespace/community:latest",
        "registry.example:5000/library/remote:latest",
    ]);
    let upstream = vec![
        "qwen3.6".into(),
        "gemma4".into(),
        "qwen3".into(),
        "community".into(),
        "remote".into(),
    ];
    let result = evaluate(&catalog, &upstream).unwrap();
    assert_eq!(
        serde_json::to_value(result).unwrap(),
        serde_json::json!({"upstreamCount":5,"coveredCount":2,"missing":["community","qwen3.6","remote"]})
    );
    assert!(evaluate(&catalog, &["bad/name".into()]).is_err());
    assert_eq!(evaluate(&catalog, &[]).unwrap().upstream_count, 0);
}

#[test]
fn monitored_lineages_and_deduplication_match_existing_contract() {
    let catalog = catalog(&["gemma4:e4b-it-qat", "qwen3:8b", "mistral-small:24b"]);
    let upstream = [
        "alfred",
        "gemma3n",
        "gemma4",
        "mistral-small3.2",
        "qwen3.6",
        "qwen3.6",
    ]
    .map(String::from);
    assert_eq!(
        monitored(&catalog, &upstream).unwrap(),
        vec!["gemma3n", "gemma4", "mistral-small3.2", "qwen3.6"]
    );
    assert_eq!(
        evaluate(&catalog, &["zeta".into(), "alpha".into(), "zeta".into()])
            .unwrap()
            .missing,
        vec!["alpha", "zeta"]
    );
}

#[test]
fn restricted_repository_collation_matches_frozen_legacy_order() {
    let names = ["qwen2", "qwen.2", "qwen-2", "qwen_2", "qwen10", "qwen_2"].map(String::from);
    let result = evaluate(&catalog(&[]), &names).unwrap();
    assert_eq!(
        result.missing,
        vec!["qwen_2", "qwen-2", "qwen.2", "qwen10", "qwen2"]
    );
}
