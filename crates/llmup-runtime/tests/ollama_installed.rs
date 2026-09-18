use llmup_runtime::ollama_installed::{inspect_metadata, parse_inventory, verify_manifest};
use serde_json::json;
use sha2::{Digest, Sha256};

#[test]
fn exact_local_inventory_and_honest_context_geometry() {
    let inventory=parse_inventory(json!({"models":[{"name":"local:tag","digest":"a".repeat(64),"size":100,"details":{"quantization_level":"Q4_K_M"}},{"name":"cloud:tag","digest":"b".repeat(64),"size":10,"remote_host":"https://example.com"}]})).unwrap();
    assert_eq!(inventory.len(), 1);
    let metadata=inspect_metadata(inventory[0].clone(),json!({"model_info":{"general.architecture":"llama","llama.context_length":8192,"llama.block_count":32,"llama.attention.head_count_kv":8,"llama.attention.key_length":128,"llama.attention.value_length":128},"capabilities":["completion"]})).unwrap();
    assert_eq!(metadata.context_length, Some(8192));
    assert_eq!(metadata.kv_bytes_per_token, Some(131072));
    assert_eq!(
        inspect_metadata(
            inventory[0].clone(),
            json!({"model_info":{"general.architecture":"unknown"}})
        )
        .unwrap()
        .kv_bytes_per_token,
        None
    );
    assert!(
        parse_inventory(json!({"models":[{"name":"../escape","digest":"a".repeat(64),"size":1}]}))
            .is_err()
    );
    assert!(parse_inventory(json!({"models":[{"name":"x","digest":"bad","size":1}]})).is_err());
}

#[test]
fn installed_sizing_keeps_unknown_geometry_and_enforces_context_caps() {
    let hardware:llmup_core::sizing::Hardware=serde_json::from_value(json!({"arch":"arm64","platform":"darwin","totalRamBytes":17179869184u64,"freeRamBytes":12884901888u64,"freeDiskBytes":100000000000u64,"gpu":[{"vendor":"apple","vramBytes":0}]})).unwrap();
    let mut model = parse_inventory(
        json!({"models":[{"name":"test:latest","digest":"a".repeat(64),"size":1000000000u64}]}),
    )
    .unwrap()
    .remove(0);
    let sized =
        llmup_runtime::ollama_installed::size_installed(&model, &hardware, Some(8192)).unwrap();
    assert_eq!(sized["fit"], "unknown");
    assert_eq!(sized["throughput"], "unknown");
    model.context_length = Some(4096);
    model.kv_bytes_per_token = Some(1024);
    assert_eq!(
        llmup_runtime::ollama_installed::size_installed(&model, &hardware, Some(8192)).unwrap()["fit"],
        "no"
    );
    assert_eq!(
        llmup_runtime::ollama_installed::size_installed(&model, &hardware, Some(4096)).unwrap()["fit"],
        "yes"
    );
}

#[tokio::test]
async fn verifies_every_local_blob_and_preserves_catalog_integrity() {
    let root = tempfile::tempdir().unwrap();
    let bytes = b"verified weights";
    let config = b"{}";
    let weight_digest = format!("{:x}", Sha256::digest(bytes));
    let config_digest = format!("{:x}", Sha256::digest(config));
    let manifest=json!({"schemaVersion":2,"config":{"digest":format!("sha256:{config_digest}"),"size":config.len(),"mediaType":"config"},"layers":[{"digest":format!("sha256:{weight_digest}"),"size":bytes.len(),"mediaType":"application/vnd.ollama.image.model"}]}).to_string();
    let digest = format!("{:x}", Sha256::digest(manifest.as_bytes()));
    let directory = root
        .path()
        .join("manifests/registry.ollama.ai/library/test");
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::create_dir_all(root.path().join("blobs")).unwrap();
    std::fs::write(directory.join("latest"), manifest).unwrap();
    std::fs::write(
        root.path().join(format!("blobs/sha256-{weight_digest}")),
        bytes,
    )
    .unwrap();
    std::fs::write(
        root.path().join(format!("blobs/sha256-{config_digest}")),
        config,
    )
    .unwrap();
    let cancel = tokio_util::sync::CancellationToken::new();
    verify_manifest(
        root.path(),
        "test:latest",
        &digest,
        Some(&weight_digest),
        Some(bytes.len() as u64),
        &cancel,
    )
    .await
    .unwrap();
    assert!(
        verify_manifest(
            root.path(),
            "test:latest",
            &digest,
            Some(&"a".repeat(64)),
            None,
            &cancel
        )
        .await
        .is_err()
    );
    assert!(
        verify_manifest(
            root.path(),
            "test:latest",
            &digest,
            None,
            Some(1000),
            &cancel
        )
        .await
        .is_err()
    );
    std::fs::write(
        root.path().join(format!("blobs/sha256-{config_digest}")),
        b"!!",
    )
    .unwrap();
    assert!(
        verify_manifest(root.path(), "test:latest", &digest, None, None, &cancel)
            .await
            .is_err()
    );
}

struct QueueTransport {
    responses: std::sync::Mutex<std::collections::VecDeque<serde_json::Value>>,
    requests: std::sync::Mutex<Vec<(String, Option<serde_json::Value>)>>,
}
#[async_trait::async_trait]
impl llmup_runtime::http::Transport for QueueTransport {
    async fn send(
        &self,
        request: llmup_runtime::http::Request,
    ) -> Result<llmup_runtime::http::Response, llmup_runtime::http::HttpError> {
        self.requests
            .lock()
            .unwrap()
            .push((request.url.path().into(), request.body().cloned()));
        let value = self
            .responses
            .lock()
            .unwrap()
            .pop_front()
            .expect("unexpected HTTP request");
        Ok(llmup_runtime::http::Response {
            status: 200,
            body: Box::pin(std::io::Cursor::new(serde_json::to_vec(&value).unwrap())),
        })
    }
}
struct Verifier(std::sync::Mutex<Vec<String>>);
#[async_trait::async_trait]
impl llmup_runtime::ollama_installed::InstalledVerifier for Verifier {
    async fn verify(
        &self,
        id: &str,
        _digest: &str,
        _cancel: &tokio_util::sync::CancellationToken,
    ) -> Result<(), llmup_runtime::ollama_installed::OllamaError> {
        self.0.lock().unwrap().push(id.into());
        Ok(())
    }
}
#[tokio::test]
async fn context_activation_verifies_variant_and_detects_source_drift() {
    use llmup_runtime::ollama_installed::InstalledModels;
    let tag = |id: &str, digest: &str| json!({"name":id,"digest":digest,"size":100});
    let original = tag("test:latest", &"a".repeat(64));
    let variant = "llmup-context-fixed:8192";
    let model = parse_inventory(json!({"models":[original.clone()]}))
        .unwrap()
        .remove(0);
    for drift in [false, true] {
        let transport=QueueTransport { responses:std::sync::Mutex::new([
            json!({"models":[original.clone()]}),json!({"status":"success"}),json!({"parameters":"num_ctx 8192\n"}),json!({"models":[original.clone(),tag(variant,&"b".repeat(64))]}),json!({"models":[if drift {tag("test:latest",&"c".repeat(64))} else {original.clone()}]})
        ].into()),requests:std::sync::Mutex::new(Vec::new()) };
        let verifier = Verifier(std::sync::Mutex::new(Vec::new()));
        let service = InstalledModels::new(&transport, &verifier);
        let result = service
            .activate_with_id(
                "http://127.0.0.1:11435",
                &model,
                Some(8192),
                "fixed",
                &tokio_util::sync::CancellationToken::new(),
            )
            .await;
        if drift {
            assert!(result.is_err());
        } else {
            assert_eq!(result.unwrap(), variant);
        }
        assert_eq!(*verifier.0.lock().unwrap(), vec!["test:latest", variant]);
        let requests = transport.requests.lock().unwrap();
        assert_eq!(
            requests[1].1.as_ref().unwrap(),
            &json!({"model":variant,"from":"test:latest","parameters":{"num_ctx":8192},"stream":false})
        );
    }
}
