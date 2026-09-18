use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use llmup_gui::{Host, engine::Engine, router};
use llmup_runtime::harness::{DeltaSink, HarnessError, HarnessRequest};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;
use tower::ServiceExt;
struct Fake;
fn chat_request(host: &Host) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri("/api/chat")
        .header("host", format!("127.0.0.1:{}", host.port))
        .header("origin", host.origin())
        .header("content-type", "application/json")
        .body(Body::from(
            r#"{"messages":[{"role":"user","content":"hello"}]}"#,
        ))
        .unwrap()
}

struct Waiting {
    started: tokio::sync::Notify,
}
#[tokio::test]
async fn shutdown_refuses_new_chat_and_cancels_inflight_reply() {
    let home = tempfile::tempdir().unwrap();
    let engine = Arc::new(Waiting {
        started: tokio::sync::Notify::new(),
    });
    let host = Host::with_engine(home.path(), 43210, engine.clone()).unwrap();
    let response = router(host.clone())
        .oneshot(chat_request(&host))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    tokio::time::timeout(std::time::Duration::from_secs(5), engine.started.notified())
        .await
        .expect("engine did not start");
    host.shutdown.cancel();
    host.tasks.close();
    tokio::time::timeout(std::time::Duration::from_secs(2), host.tasks.wait())
        .await
        .unwrap();
    let id = host.ui.lock().await.session.clone().unwrap();
    assert!(host.sessions.get(&id).unwrap().unwrap().messages.is_empty());
    drop(response);
    let refused = router(host.clone())
        .oneshot(chat_request(&host))
        .await
        .unwrap();
    assert_eq!(refused.status(), StatusCode::SERVICE_UNAVAILABLE);
}

#[tokio::test]
async fn session_activation_cancels_inflight_reply_without_leaking_history() {
    let home = tempfile::tempdir().unwrap();
    let engine = Arc::new(Waiting {
        started: tokio::sync::Notify::new(),
    });
    let host = Host::with_engine(home.path(), 43210, engine.clone()).unwrap();
    let response = router(host.clone())
        .oneshot(chat_request(&host))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    tokio::time::timeout(std::time::Duration::from_secs(5), engine.started.notified())
        .await
        .expect("engine did not start");
    let old = host.ui.lock().await.session.clone().unwrap();
    let next = host
        .sessions
        .create("next", "2026-09-18T00:00:00Z")
        .unwrap();
    let activation = router(host.clone())
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/sessions/{}/activate", next.id))
                .header("host", "127.0.0.1:43210")
                .header("origin", host.origin())
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(activation.status(), StatusCode::OK);
    host.tasks.close();
    tokio::time::timeout(std::time::Duration::from_secs(2), host.tasks.wait())
        .await
        .unwrap();
    assert!(
        host.sessions
            .get(&old)
            .unwrap()
            .unwrap()
            .messages
            .is_empty()
    );
    assert!(
        host.sessions
            .get(&next.id)
            .unwrap()
            .unwrap()
            .messages
            .is_empty()
    );
    assert_eq!(
        host.ui.lock().await.session.as_deref(),
        Some(next.id.as_str())
    );
    drop(response);
}
#[async_trait::async_trait]
impl Engine for Waiting {
    async fn chat(
        &self,
        _: &str,
        _: &HarnessRequest,
        cancel: &CancellationToken,
        _: &mut DeltaSink<'_>,
    ) -> Result<String, HarnessError> {
        self.started.notify_one();
        cancel.cancelled().await;
        Err(HarnessError::Cancelled)
    }
}
#[tokio::test]
async fn disconnected_stream_cancels_run_without_persisting_reply() {
    let home = tempfile::tempdir().unwrap();
    let engine = Arc::new(Waiting {
        started: tokio::sync::Notify::new(),
    });
    let host = Host::with_engine(home.path(), 43210, engine.clone()).unwrap();
    let response = router(host.clone())
        .oneshot(chat_request(&host))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    tokio::time::timeout(std::time::Duration::from_secs(5), engine.started.notified())
        .await
        .expect("engine did not start");
    let second = router(host.clone())
        .oneshot(chat_request(&host))
        .await
        .unwrap();
    assert_eq!(second.status(), StatusCode::CONFLICT);
    drop(response);
    host.tasks.close();
    tokio::time::timeout(std::time::Duration::from_secs(2), host.tasks.wait())
        .await
        .unwrap();
    let id = host.ui.lock().await.session.clone().unwrap();
    assert!(host.sessions.get(&id).unwrap().unwrap().messages.is_empty());
    assert!(host.sessions.runs.active_id(&id).unwrap().is_none());
}
#[async_trait::async_trait]
impl Engine for Fake {
    async fn chat(
        &self,
        _: &str,
        request: &HarnessRequest,
        _: &CancellationToken,
        sink: &mut DeltaSink<'_>,
    ) -> Result<String, HarnessError> {
        assert_eq!(request.messages.last().unwrap().content, "hello");
        sink("hello ")?;
        sink("world")?;
        llmup_runtime::usage::record(
            &serde_json::json!({"usage":{"prompt_tokens":100,"completion_tokens":20,"prompt_tokens_details":{"cached_tokens":60}}}),
            llmup_runtime::usage::Provider::OpenAi,
        );
        Ok("hello world".into())
    }
}
#[tokio::test]
async fn sse_chat_streams_and_persists_a_native_session() {
    let home = tempfile::tempdir().unwrap();
    let host = Host::with_engine(home.path(), 43210, Arc::new(Fake)).unwrap();
    let response = router(host.clone())
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/chat")
                .header("host", "127.0.0.1:43210")
                .header("origin", host.origin())
                .header("content-type", "application/json")
                .body(Body::from(
                    r#"{"messages":[{"role":"user","content":"hello"}]}"#,
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(
        response.headers()["content-type"]
            .to_str()
            .unwrap()
            .starts_with("text/event-stream")
    );
    let text = String::from_utf8(
        to_bytes(response.into_body(), 65536)
            .await
            .unwrap()
            .to_vec(),
    )
    .unwrap();
    assert!(text.contains("hello "), "unexpected SSE response: {text}");
    assert!(text.contains("\"type\":\"done\""));
    let id = host.ui.lock().await.session.clone().unwrap();
    assert_eq!(host.sessions.get(&id).unwrap().unwrap().messages.len(), 2);
    let response = router(host)
        .oneshot(
            Request::builder()
                .uri("/api/telemetry")
                .header("host", "127.0.0.1:43210")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let sample: serde_json::Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 65536).await.unwrap()).unwrap();
    assert_eq!(
        sample["inferenceUsage"],
        serde_json::json!({"inputTokens":100,"outputTokens":20,"cacheHitTokens":60,"cacheMissTokens":40})
    );
}
