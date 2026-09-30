use rigspark_runtime::catalog_proposals::{choose_candidates, validate_claims};
use serde_json::json;

#[test]
fn discovery_is_deterministic_bounded_and_excludes_existing_repositories() {
    let catalog = rigspark_core::catalog::Catalog::parse(rigspark_core::MODELS_JSON).unwrap();
    let upstream = vec![
        "new-z".into(),
        "qwen3.6".into(),
        "new-a".into(),
        "new-a".into(),
    ];
    assert_eq!(
        choose_candidates(&catalog, &upstream, 1).unwrap(),
        ["new-a"]
    );
    assert!(choose_candidates(&catalog, &upstream, 11).is_err());
    assert!(choose_candidates(&catalog, &["../escape".into()], 1).is_err());
}

#[test]
fn proposed_facts_must_match_source_values_and_known_field_paths() {
    let config = json!({"model_family":"qwen35moe","file_type":"Q4_K_M"});
    let valid = json!({"claims":[{"field":"architecture","pointer":"/model_family","valueJson":"\"qwen35moe\""}]});
    assert!(validate_claims(&valid.to_string(), &config).is_ok());
    let mut wrong = valid.clone();
    wrong["claims"][0]["valueJson"] = json!("\"dense\"");
    assert!(validate_claims(&wrong.to_string(), &config).is_err());
    let mut wrong = valid;
    wrong["claims"][0]["field"] = json!("license");
    assert!(validate_claims(&wrong.to_string(), &config).is_err());
    assert!(validate_claims(r#"{"claims":[]}"#, &config).is_ok());
}

#[test]
fn ollama_model_type_is_parameter_label_not_architecture() {
    let config = json!({"model_family":"falcon","model_type":"42B","file_type":"Q4_0"});
    let claims = json!({"claims":[
        {"field":"architecture","pointer":"/model_family","valueJson":"\"falcon\""},
        {"field":"parameters","pointer":"/model_type","valueJson":"\"42B\""},
        {"field":"quantization","pointer":"/file_type","valueJson":"\"Q4_0\""}
    ]});
    assert!(validate_claims(&claims.to_string(), &config).is_ok());
    let invalid =
        json!({"claims":[{"field":"architecture","pointer":"/model_type","valueJson":"\"42B\""}]});
    assert!(validate_claims(&invalid.to_string(), &config).is_err());
}

struct Fixture {
    corrupt: bool,
    ai: bool,
}

#[async_trait::async_trait]
impl rigspark_runtime::catalog_proposals::ProposalTransport for Fixture {
    async fn fetch(
        &self,
        url: &str,
        _: usize,
    ) -> Result<Vec<u8>, rigspark_runtime::catalog_proposals::ProposalError> {
        use sha2::{Digest, Sha256};
        let config = br#"{"model_family":"qwen"}"#;
        if url.ends_with("/manifests/latest") {
            Ok(json!({"config":{"digest":format!("sha256:{:x}", Sha256::digest(config)),"size":config.len()},
                "layers":[{"mediaType":"application/vnd.ollama.image.model","size":1234,"digest":format!("sha256:{}","a".repeat(64))}]}).to_string().into_bytes())
        } else if self.corrupt {
            Ok(b"tampered".to_vec())
        } else {
            Ok(config.to_vec())
        }
    }
    async fn extract(
        &self,
        _: &serde_json::Value,
    ) -> Result<Option<String>, rigspark_runtime::catalog_proposals::ProposalError> {
        assert!(!self.corrupt, "tampered config must never reach OpenAI");
        Ok(self.ai.then(|| r#"{"claims":[{"field":"architecture","pointer":"/model_family","valueJson":"\"qwen\""}]}"#.into()))
    }
}

#[tokio::test]
async fn collects_public_sources_without_claiming_quality_verification() {
    use rigspark_runtime::catalog_proposals::collect;
    let catalog = rigspark_core::catalog::Catalog::parse(rigspark_core::MODELS_JSON).unwrap();
    for (corrupt, ai, expected) in [
        (false, false, "disabled"),
        (false, true, "source-matched-needs-review"),
        (true, true, "config-unavailable-or-invalid"),
    ] {
        let report = collect(
            &catalog,
            &["new-model".into()],
            10,
            "2026-09-30T00:00:00Z",
            &Fixture { corrupt, ai },
        )
        .await
        .unwrap();
        assert!(!report.inventory_complete);
        assert!(report.requires_review);
        assert_eq!(report.proposals[0].extraction_status, expected);
        assert_eq!(report.proposals[0].artifact_bytes, Some(1234.0));
        let serialized = serde_json::to_value(&report).unwrap();
        assert_eq!(
            serialized["proposals"][0]["sourceClaims"]
                .as_array()
                .unwrap()
                .len(),
            if corrupt { 0 } else { 1 }
        );
    }
}

#[test]
fn literal_source_extraction_uses_one_preferred_path_and_never_infers() {
    use rigspark_runtime::catalog_proposals::source_claims;
    let config = json!({"model_family":"falcon","model_type":"42B","parameter_size":"42.0B","file_type":"Q4_0","context_length":null});
    let claims = source_claims(&config);
    let raw = json!({"claims":claims});
    assert_eq!(raw["claims"].as_array().unwrap().len(), 3);
    assert!(validate_claims(&raw.to_string(), &config).is_ok());
    assert!(
        raw["claims"]
            .as_array()
            .unwrap()
            .iter()
            .any(|claim| claim["field"] == "parameters" && claim["pointer"] == "/parameter_size")
    );
    assert!(source_claims(&json!({"architecture":"amd64"})).is_empty());
}

#[test]
fn rejection_reasons_distinguish_duplicates_from_source_mismatches() {
    let config = json!({"model_family":"qwen"});
    let claim = json!({"field":"architecture","pointer":"/model_family","valueJson":"\"qwen\""});
    assert_eq!(
        validate_claims(
            &json!({"claims":[claim.clone(),claim]}).to_string(),
            &config
        )
        .unwrap_err()
        .0,
        "duplicate claim field"
    );
    assert_eq!(validate_claims(r#"{"claims":[{"field":"architecture","pointer":"/model_family","valueJson":"\"fabricated\""}]}"#, &config).unwrap_err().0, "claim value differs from source");
}

struct RejectingExtractor;

#[async_trait::async_trait]
impl rigspark_runtime::catalog_proposals::ProposalTransport for RejectingExtractor {
    async fn fetch(
        &self,
        url: &str,
        maximum: usize,
    ) -> Result<Vec<u8>, rigspark_runtime::catalog_proposals::ProposalError> {
        Fixture {
            corrupt: false,
            ai: false,
        }
        .fetch(url, maximum)
        .await
    }
    async fn extract(
        &self,
        _: &serde_json::Value,
    ) -> Result<Option<String>, rigspark_runtime::catalog_proposals::ProposalError> {
        Ok(Some(r#"{"claims":[{"field":"architecture","pointer":"/model_family","valueJson":"\"fabricated\""}]}"#.into()))
    }
}

#[tokio::test]
async fn batches_advance_and_source_only_never_calls_extractor() {
    use rigspark_runtime::catalog_proposals::collect_batch;
    let catalog = rigspark_core::catalog::Catalog::parse(rigspark_core::MODELS_JSON).unwrap();
    let upstream = vec!["new-a".into(), "new-b".into(), "new-c".into()];
    let first = collect_batch(
        &catalog,
        &upstream,
        2,
        None,
        "2026-09-30T00:00:00Z",
        true,
        &RejectingExtractor,
    )
    .await
    .unwrap();
    assert_eq!(first.next_after.as_deref(), Some("new-b"));
    assert_eq!(first.remaining_candidates, 1);
    assert!(
        first
            .proposals
            .iter()
            .all(|proposal| proposal.extraction_status == "disabled")
    );
    let second = collect_batch(
        &catalog,
        &upstream,
        2,
        first.next_after.as_deref(),
        "2026-09-30T00:00:00Z",
        false,
        &RejectingExtractor,
    )
    .await
    .unwrap();
    assert_eq!(second.proposals[0].repository, "new-c");
    assert_eq!(second.next_after, None);
    assert_eq!(second.remaining_candidates, 0);
    assert_eq!(
        second.proposals[0].extraction_error,
        Some("claim value differs from source")
    );
    assert_eq!(second.proposals[0].source_claims.len(), 1);
    assert!(second.proposals[0].claims.is_empty());
    assert!(
        collect_batch(
            &catalog,
            &upstream,
            2,
            Some("../unsafe"),
            "2026-09-30T00:00:00Z",
            true,
            &RejectingExtractor
        )
        .await
        .is_err()
    );
}

#[test]
fn openai_contract_has_no_tools_storage_or_unbounded_output() {
    use rigspark_runtime::catalog_proposals::{extraction_request, response_claims};
    let request = extraction_request("configured-model", &json!({}));
    assert_eq!(request["store"], false);
    assert_eq!(request["max_output_tokens"], 2000);
    assert!(request.get("tools").is_none());
    let response = json!({"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"{\"claims\":[]}"}]}]});
    assert_eq!(
        response_claims(&response.to_string()).unwrap(),
        "{\"claims\":[]}"
    );
    assert!(response_claims(r#"{"status":"incomplete","output":[]}"#).is_err());
    assert!(response_claims(r#"{"status":"completed","output":[{"type":"message","content":[{"type":"refusal","refusal":"no"}]}]}"#).is_err());
}

#[test]
fn config_redirect_policy_rejects_unknown_hosts_and_insecure_urls() {
    use rigspark_runtime::catalog_proposals::allowed_registry_redirect;
    assert!(allowed_registry_redirect(
        "https://dd20bb891979d25aebc8bec07b2b3bbc.r2.cloudflarestorage.com/ollama/data?signature=public-download"
    ));
    for url in [
        "http://registry.ollama.ai/path",
        "https://evil.r2.cloudflarestorage.com/data",
        "https://127.0.0.1/path",
        "https://user@registry.ollama.ai/path",
        "https://registry.ollama.ai:8443/path",
    ] {
        assert!(!allowed_registry_redirect(url));
    }
}

#[test]
fn rejects_duplicate_null_extra_and_oversized_claims() {
    let config = json!({"license":null,"model_family":"qwen"});
    let claim = json!({"field":"architecture","pointer":"/model_family","valueJson":"\"qwen\""});
    for raw in [
        json!({"claims":[claim.clone(),claim]}).to_string(),
        json!({"claims":[{"field":"license","pointer":"/license","valueJson":"null"}]}).to_string(),
        json!({"claims":[],"verified":true}).to_string(),
        " ".repeat(16385),
    ] {
        assert!(validate_claims(&raw, &config).is_err());
    }
}

#[tokio::test]
async fn absent_configuration_disables_ai_and_untrusted_urls_never_fetch() {
    use rigspark_runtime::catalog_proposals::{NativeProposalTransport, ProposalTransport};
    for (key, model) in [
        (None, Some("configured-model".into())),
        (Some("not-a-real-key".into()), None),
    ] {
        let transport = NativeProposalTransport::new(key, model).unwrap();
        assert_eq!(transport.extract(&json!({})).await.unwrap(), None);
        for url in [
            "http://127.0.0.1/",
            "https://example.com/",
            "https://registry.ollama.ai/v2/library/test?override=yes",
        ] {
            assert!(transport.fetch(url, 1024).await.is_err());
        }
    }
    assert!(
        NativeProposalTransport::new(Some("invalid\nkey".into()), Some("model".into())).is_err()
    );
}
