use llmup_core::catalog::Catalog;
use llmup_runtime::registry_collector::{
    ManifestResponse, ManifestTransport, manifest_url, refresh,
};
use std::{io, sync::Mutex};
use tokio_util::sync::CancellationToken;

struct MockTransport {
    calls: Mutex<Vec<String>>,
    fail_first: bool,
    status: u16,
    body: String,
    declared: Option<u64>,
}
#[async_trait::async_trait]
impl ManifestTransport for MockTransport {
    async fn fetch(&self, url: &url::Url) -> io::Result<ManifestResponse> {
        let mut calls = self.calls.lock().unwrap();
        calls.push(url.to_string());
        if self.fail_first && calls.len() == 1 {
            return Err(io::Error::other("network failed"));
        }
        Ok(ManifestResponse {
            status: self.status,
            declared_bytes: self.declared,
            body: Box::pin(std::io::Cursor::new(self.body.as_bytes().to_vec())),
        })
    }
}
fn mock() -> MockTransport {
    MockTransport {calls:Mutex::new(Vec::new()),fail_first:false,status:200,declared:None,body:serde_json::json!({"layers":[{"mediaType":"application/vnd.ollama.image.model","digest":format!("sha256:{}","a".repeat(64)),"size":6_000_000_000_u64}]}).to_string()}
}
fn catalog() -> Catalog {
    let mut catalog = Catalog::parse(include_str!("../../llmup-core/data/models.json")).unwrap();
    catalog
        .models
        .retain(|model| ["llama3.1:8b", "qwen3:8b"].contains(&model.id.as_str()));
    assert_eq!(catalog.models.len(), 2);
    catalog
}

#[tokio::test]
async fn complete_catalogs_match_frozen_typescript_registry_collector_oracle() {
    let cases: Vec<serde_json::Value> = serde_json::from_str(include_str!(
        "../../llmup-core/fixtures/registry-collector-parity.json"
    ))
    .unwrap();
    assert_eq!(cases.len(), 8);
    for case in cases {
        let input: Catalog = serde_json::from_value(case["existing"].clone()).unwrap();
        let transport = llmup_runtime::registry_collector::RecordedTransport::parse(
            &case["manifests"].to_string(),
        )
        .unwrap();
        let actual = refresh(
            &input,
            &transport,
            case["now"].as_str().unwrap(),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
        let expected: Catalog =
            serde_json::from_value(case["expected"]["catalog"].clone()).unwrap();
        assert_eq!(
            serde_json::to_value(actual.catalog).unwrap(),
            serde_json::to_value(expected).unwrap(),
            "{}",
            case["name"]
        );
        assert_eq!(
            serde_json::to_value(actual.updated).unwrap(),
            case["expected"]["updated"],
            "{}",
            case["name"]
        );
    }
}

#[test]
fn registry_urls_are_fixed_https_and_reject_unsafe_coordinates() {
    assert_eq!(
        manifest_url("llama3.1:8b-q4_K_M").unwrap().as_str(),
        "https://registry.ollama.ai/v2/library/llama3.1/manifests/8b-q4_K_M"
    );
    assert_eq!(
        manifest_url("namespace/model").unwrap().as_str(),
        "https://registry.ollama.ai/v2/namespace/model/manifests/latest"
    );
    for reference in [
        "https://evil.test/model",
        "../model:tag",
        "library/../model:tag",
        "model:tag?x",
        "model:tag#x",
        "model:%2e",
        "model:",
        "model:tag\n",
        "host:5000/model",
        "library//model:tag",
    ] {
        assert!(manifest_url(reference).is_err(), "{reference}");
    }
}

#[tokio::test]
async fn refresh_isolates_lookup_failure_and_preserves_unrelated_models() {
    let input = catalog();
    let before = serde_json::to_value(&input).unwrap();
    let mut transport = mock();
    transport.fail_first = true;
    let result = refresh(
        &input,
        &transport,
        "2026-09-19T00:00:00Z",
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(result.updated, vec![input.models[1].id.clone()]);
    assert_eq!(
        serde_json::to_value(&result.catalog.models[0]).unwrap(),
        before["models"][0]
    );
    assert_eq!(result.catalog.generated_at, "2026-09-19T00:00:00.000Z");
    assert_eq!(serde_json::to_value(&input).unwrap(), before);
    assert_eq!(transport.calls.lock().unwrap().len(), 2);
    let repeated = refresh(
        &result.catalog,
        &mock(),
        "2026-09-20T00:00:00Z",
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(repeated.updated.len(), 1);
    let unchanged = refresh(
        &repeated.catalog,
        &mock(),
        "2026-09-21T00:00:00Z",
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    assert!(unchanged.updated.is_empty());
    assert_eq!(
        serde_json::to_value(unchanged.catalog).unwrap(),
        serde_json::to_value(repeated.catalog).unwrap()
    );
}

#[tokio::test]
async fn failure_invalid_manifest_and_oversize_keep_catalog_unchanged() {
    let input = catalog();
    for (status, body, declared) in [
        (404, "{}".into(), None),
        (302, "{}".into(), None),
        (200, "invalid".into(), None),
        (200, "{}".into(), Some(4 * 1024 * 1024 + 1)),
        (200, "x".repeat(4 * 1024 * 1024 + 1), None),
    ] {
        let mut transport = mock();
        transport.status = status;
        transport.body = body;
        transport.declared = declared;
        let result = refresh(
            &input,
            &transport,
            "2026-09-19T00:00:00Z",
            &CancellationToken::new(),
        )
        .await
        .unwrap();
        assert!(result.updated.is_empty());
        assert_eq!(
            serde_json::to_value(result.catalog).unwrap(),
            serde_json::to_value(&input).unwrap()
        );
    }
}

#[tokio::test]
async fn no_source_and_cancelled_requests_do_not_fetch() {
    let mut input = catalog();
    for model in &mut input.models {
        model.source.ollama = None;
    }
    let transport = mock();
    assert!(
        refresh(
            &input,
            &transport,
            "2026-09-19T00:00:00Z",
            &CancellationToken::new()
        )
        .await
        .unwrap()
        .updated
        .is_empty()
    );
    assert!(transport.calls.lock().unwrap().is_empty());
    let cancel = CancellationToken::new();
    cancel.cancel();
    assert_eq!(
        refresh(&catalog(), &transport, "2026-09-19T00:00:00Z", &cancel)
            .await
            .err()
            .unwrap()
            .kind(),
        io::ErrorKind::Interrupted
    );
    assert!(transport.calls.lock().unwrap().is_empty());
}

struct CountingBody {
    read: std::sync::Arc<std::sync::atomic::AtomicUsize>,
}
impl tokio::io::AsyncRead for CountingBody {
    fn poll_read(
        self: std::pin::Pin<&mut Self>,
        _: &mut std::task::Context<'_>,
        buffer: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<io::Result<()>> {
        let bytes = buffer.initialize_unfilled();
        let count = bytes.len();
        bytes.fill(b'x');
        buffer.advance(count);
        self.read
            .fetch_add(count, std::sync::atomic::Ordering::SeqCst);
        std::task::Poll::Ready(Ok(()))
    }
}
struct CountingTransport {
    read: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    declared: Option<u64>,
}
#[async_trait::async_trait]
impl ManifestTransport for CountingTransport {
    async fn fetch(&self, _: &url::Url) -> io::Result<ManifestResponse> {
        Ok(ManifestResponse {
            status: 200,
            declared_bytes: self.declared,
            body: Box::pin(CountingBody {
                read: self.read.clone(),
            }),
        })
    }
}

#[tokio::test]
async fn response_limit_is_enforced_during_read_not_after_unbounded_allocation() {
    let maximum = llmup_core::registry_collector::MAX_MANIFEST_BYTES;
    for declared in [None, Some(maximum as u64 + 1)] {
        let read = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let transport = CountingTransport {
            read: read.clone(),
            declared,
        };
        assert!(
            llmup_runtime::registry_collector::fetch_layer(
                &transport,
                "model:latest",
                &CancellationToken::new()
            )
            .await
            .is_err()
        );
        assert_eq!(
            read.load(std::sync::atomic::Ordering::SeqCst),
            if declared.is_some() { 0 } else { maximum + 1 }
        );
    }
}

struct StalledTransport {
    started: tokio::sync::Notify,
}
#[async_trait::async_trait]
impl ManifestTransport for StalledTransport {
    async fn fetch(&self, _: &url::Url) -> io::Result<ManifestResponse> {
        self.started.notify_one();
        std::future::pending().await
    }
}

#[tokio::test]
async fn in_flight_cancellation_is_not_swallowed_as_a_model_lookup_failure() {
    let transport = StalledTransport {
        started: tokio::sync::Notify::new(),
    };
    let cancel = CancellationToken::new();
    let input = catalog();
    let operation = refresh(&input, &transport, "2026-09-19T00:00:00Z", &cancel);
    let stop = async {
        transport.started.notified().await;
        cancel.cancel();
    };
    let (result, ()) = tokio::time::timeout(std::time::Duration::from_secs(1), async {
        tokio::join!(operation, stop)
    })
    .await
    .unwrap();
    assert_eq!(result.err().unwrap().kind(), io::ErrorKind::Interrupted);
}

#[tokio::test]
async fn native_transport_rejects_untrusted_origins_before_network_access() {
    let transport = llmup_runtime::registry_collector::NativeManifestTransport::new().unwrap();
    for raw in [
        "http://registry.ollama.ai/v2/model",
        "https://127.0.0.1/v2/model",
        "https://evil.example/v2/model",
        "https://user:pass@registry.ollama.ai/v2/model",
        "https://registry.ollama.ai:444/v2/model",
        "https://registry.ollama.ai/v2/model?redirect=1",
        "https://registry.ollama.ai/v2/model#fragment",
    ] {
        assert!(
            transport
                .fetch(&url::Url::parse(raw).unwrap())
                .await
                .is_err(),
            "{raw}"
        );
    }
}

#[test]
fn recorded_fixture_schema_and_origin_validation_fail_closed() {
    use llmup_runtime::registry_collector::RecordedTransport;
    for value in [
        serde_json::json!({"https://evil.example/v2/model":{"status":200,"body":{}}}),
        serde_json::json!({"https://registry.ollama.ai/v2/model":{"status":0,"body":{}}}),
        serde_json::json!({"https://registry.ollama.ai/v2/model":{"status":200,"body":{},"extra":true}}),
        serde_json::json!({"https://registry.ollama.ai/v2/model":{"status":200,"body":null}}),
    ] {
        assert!(RecordedTransport::parse(&value.to_string()).is_err());
    }
    assert!(RecordedTransport::parse(&"x".repeat(16 * 1024 * 1024 + 1)).is_err());
}
