#[tokio::test]
async fn builtin_registry_preserves_order_and_disables_missing_configuration() {
    use llmup_runtime::{
        harness::LocalHarness,
        harness_registry::HarnessRegistry,
        identity::NativeProcessProbe,
        lifecycle::Registry,
        opencode::NativeOpenCodeRunner,
        state::{Config, StateStore},
    };
    let root = tempfile::tempdir().unwrap();
    let state = StateStore::new(Config::from_home(root.path()).unwrap());
    let backends = Registry::new(Vec::new());
    let transport = Transport {
        body: Vec::new(),
        request: Mutex::new(None),
    };
    let runner = NativeOpenCodeRunner {
        binary: root.path().join("missing-opencode"),
        env: Default::default(),
    };
    let registry = HarnessRegistry::builtins(
        LocalHarness {
            state: &state,
            registry: &backends,
            probe: &NativeProcessProbe,
        },
        &transport,
        &runner,
        &Default::default(),
    )
    .unwrap();
    assert_eq!(
        registry.all(),
        vec!["local", "claude", "openai", "openai-compatible", "opencode"]
    );
    assert!(registry.available().await.is_empty());
    assert!(registry.get("unknown").is_err());
    let env = [(
        "OPENAI_COMPAT_BASE_URL".into(),
        "http://127.0.0.1:3000/chat".into(),
    )]
    .into();
    let registry = HarnessRegistry::builtins(
        LocalHarness {
            state: &state,
            registry: &backends,
            probe: &NativeProcessProbe,
        },
        &transport,
        &runner,
        &env,
    )
    .unwrap();
    assert_eq!(registry.available().await, vec!["openai-compatible"]);
}
#[tokio::test]
async fn provider_caps_and_cancellation_fail_before_unbounded_output() {
    let transport = Transport {
        body: vec![b'x'; 65],
        request: Mutex::new(None),
    };
    let harness = RemoteHarness::new(
        Provider::Compatible,
        "http://127.0.0.1:3000/chat",
        None,
        &transport,
    )
    .unwrap()
    .with_limit(64)
    .unwrap();
    assert!(matches!(
        harness
            .chat(&input(), &CancellationToken::new(), &mut |_| Ok(()))
            .await,
        Err(HarnessError::Limit)
    ));
    struct Stalled;
    #[async_trait::async_trait]
    impl RemoteTransport for Stalled {
        async fn send(&self, _: RemoteRequest) -> Result<RemoteResponse, HarnessError> {
            std::future::pending().await
        }
    }
    let harness = RemoteHarness::new(
        Provider::Compatible,
        "http://127.0.0.1:3000/chat",
        None,
        &Stalled,
    )
    .unwrap();
    let cancel = CancellationToken::new();
    let cancellation = cancel.clone();
    let input = input();
    let mut sink = |_: &str| Ok(());
    let request = harness.chat(&input, &cancel, &mut sink);
    let cancel_task = async move {
        tokio::task::yield_now().await;
        cancellation.cancel();
    };
    let (result, ()) = tokio::join!(request, cancel_task);
    assert!(matches!(result, Err(HarnessError::Cancelled)));
}
use llmup_runtime::harness::{
    HarnessError, HarnessMessage, HarnessRequest, Provider, RemoteHarness, RemoteRequest,
    RemoteResponse, RemoteTransport, Secret,
};
use std::sync::Mutex;
use tokio_util::sync::CancellationToken;
struct Transport {
    body: Vec<u8>,
    request: Mutex<Option<serde_json::Value>>,
}
#[async_trait::async_trait]
impl RemoteTransport for Transport {
    async fn send(&self, request: RemoteRequest) -> Result<RemoteResponse, HarnessError> {
        *self.request.lock().unwrap() = Some(request.body);
        Ok(RemoteResponse {
            status: 200,
            body: Box::pin(std::io::Cursor::new(self.body.clone())),
        })
    }
}
fn input() -> HarnessRequest {
    HarnessRequest {
        model: "model".into(),
        messages: vec![HarnessMessage {
            role: "user".into(),
            content: "hello".into(),
        }],
        temperature: Some(0.3),
    }
}
#[tokio::test]
async fn remote_harnesses_parse_sse_and_emit_incremental_text() {
    for (provider, url, body) in [
        (
            Provider::OpenAi,
            "https://api.openai.com/v1/chat/completions",
            "data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\r\n\r\ndata: [DONE]\r\n\r\n",
        ),
        (
            Provider::Claude,
            "https://api.anthropic.com/v1/messages",
            "event: content_block_delta\ndata: {\"delta\":{\"type\":\"text_delta\",\"text\":\"hello\"}}\n\n",
        ),
    ] {
        let transport = Transport {
            body: body.as_bytes().to_vec(),
            request: Mutex::new(None),
        };
        let harness = RemoteHarness::new(
            provider,
            url,
            Some(Secret::new("secret-value").unwrap()),
            &transport,
        )
        .unwrap();
        let mut chunks = Vec::new();
        let result = harness
            .chat(&input(), &CancellationToken::new(), &mut |text| {
                chunks.push(text.to_owned());
                Ok(())
            })
            .await
            .unwrap();
        assert_eq!(result, "hello");
        assert_eq!(chunks, vec!["hello"]);
        assert_eq!(
            transport.request.lock().unwrap().as_ref().unwrap()["stream"],
            true
        );
    }
}
#[test]
fn endpoints_and_secret_debug_are_safe() {
    let transport = Transport {
        body: Vec::new(),
        request: Mutex::new(None),
    };
    assert!(
        RemoteHarness::new(
            Provider::OpenAi,
            "https://evil.example/v1",
            Some(Secret::new("secret-value").unwrap()),
            &transport
        )
        .is_err()
    );
    assert!(
        RemoteHarness::new(Provider::Compatible, "http://10.0.0.1/v1", None, &transport).is_err()
    );
    assert!(!format!("{:?}", Secret::new("secret-value").unwrap()).contains("secret-value"));
    assert!(Secret::new("secret\nheader").is_err());
}

#[tokio::test]
async fn usage_only_stream_frame_records_exact_counts_without_emitting_text() {
    use llmup_runtime::usage::{InferenceUsage, scope};
    let transport = Transport { body: b"data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\n\ndata: {\"choices\":[],\"usage\":{\"prompt_tokens\":100,\"completion_tokens\":20,\"prompt_tokens_details\":{\"cached_tokens\":60}}}\n\ndata: [DONE]\n\n".to_vec(), request: Mutex::new(None) };
    let harness = RemoteHarness::new(
        Provider::OpenAi,
        "https://api.openai.com/v1/chat/completions",
        Some(Secret::new("fixture-key").unwrap()),
        &transport,
    )
    .unwrap();
    let usage = std::sync::Arc::new(Mutex::new(InferenceUsage::default()));
    let mut emitted = String::new();
    let result = scope(usage.clone(), async {
        harness
            .chat(&input(), &CancellationToken::new(), &mut |text| {
                emitted.push_str(text);
                Ok(())
            })
            .await
    })
    .await
    .unwrap();
    assert_eq!(result, "hello");
    assert_eq!(emitted, "hello");
    assert_eq!(
        *usage.lock().unwrap(),
        InferenceUsage {
            input_tokens: Some(100),
            output_tokens: Some(20),
            cache_hit_tokens: Some(60),
            cache_miss_tokens: Some(40)
        }
    );
    assert_eq!(
        transport.request.lock().unwrap().as_ref().unwrap()["stream_options"]["include_usage"],
        true
    );
}

#[tokio::test]
async fn secrets_split_across_events_never_reach_delta_sink() {
    let body = ["safe sec", "ret-", "value tail"]
        .map(|text| {
            format!(
                "data: {}\n\n",
                serde_json::json!({"choices":[{"delta":{"content":text}}]})
            )
        })
        .join("");
    let transport = Transport {
        body: body.into_bytes(),
        request: Mutex::new(None),
    };
    let harness = RemoteHarness::new(
        Provider::OpenAi,
        "https://api.openai.com/v1/chat/completions",
        Some(Secret::new("secret-value").unwrap()),
        &transport,
    )
    .unwrap();
    let mut emitted = String::new();
    let result = harness
        .chat(&input(), &CancellationToken::new(), &mut |text| {
            emitted.push_str(text);
            Ok(())
        })
        .await
        .unwrap();
    assert_eq!(result, "safe [REDACTED] tail");
    assert_eq!(result, emitted);
}
