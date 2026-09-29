use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use rigspark_gui::{Host, engine::Engine, router};
use rigspark_runtime::harness::{DeltaSink, HarnessError, HarnessRequest};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use tokio_util::sync::CancellationToken;
use tower::ServiceExt;

#[derive(Default)]
struct Capture(Mutex<Vec<HarnessRequest>>);
#[async_trait::async_trait]
impl Engine for Capture {
    async fn chat(
        &self,
        _: &str,
        request: &HarnessRequest,
        _: &CancellationToken,
        sink: &mut DeltaSink<'_>,
    ) -> Result<String, HarnessError> {
        self.0.lock().unwrap().push(request.clone());
        sink("ok")?;
        Ok("ok".into())
    }
}

async fn call(
    host: &Arc<Host>,
    method: &str,
    path: &str,
    payload: Value,
) -> (StatusCode, Value, Vec<u8>, Option<String>) {
    let body = if payload.is_null() {
        Body::empty()
    } else {
        Body::from(payload.to_string())
    };
    let response = router(host.clone())
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("host", format!("127.0.0.1:{}", host.port))
                .header("origin", host.origin())
                .header("content-type", "application/json")
                .body(body)
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let kind = response
        .headers()
        .get("content-type")
        .map(|value| value.to_str().unwrap().to_owned());
    let bytes = to_bytes(response.into_body(), 4 * 1024 * 1024)
        .await
        .unwrap()
        .to_vec();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        bytes,
        kind,
    )
}

#[tokio::test]
async fn agents_and_skills_support_crud_and_reject_invalid_drafts() {
    let home = tempfile::tempdir().unwrap();
    let host = Host::new(home.path(), 43210).unwrap();
    let (status, created, _, _) = call(
        &host,
        "POST",
        "/api/agents",
        json!({"name":"Code Reviewer","description":"Reviews code","body":"You are a reviewer."}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(
        (
            created["item"]["id"].as_str(),
            created["item"]["enabled"].as_bool()
        ),
        (Some("code-reviewer"), Some(true))
    );
    assert_eq!(
        call(&host, "GET", "/api/agents", Value::Null).await.1["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        call(&host, "GET", "/api/agents/code-reviewer", Value::Null)
            .await
            .1["item"]["body"],
        "You are a reviewer."
    );
    let (_, updated, _, _) = call(
        &host,
        "PUT",
        "/api/agents/code-reviewer",
        json!({"enabled": false}),
    )
    .await;
    assert_eq!(updated["item"]["enabled"], false);
    assert_eq!(
        call(&host, "DELETE", "/api/agents/code-reviewer", Value::Null)
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        call(&host, "GET", "/api/agents", Value::Null).await.1["items"],
        json!([])
    );
    let (status, skill, _, _) = call(
        &host,
        "POST",
        "/api/skills",
        json!({"name":"Cite","body":"Cite sources."}),
    )
    .await;
    assert_eq!(
        (status, skill["item"]["id"].as_str()),
        (StatusCode::CREATED, Some("cite"))
    );
    assert_eq!(
        call(&host, "GET", "/api/skills", Value::Null).await.1["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        call(
            &host,
            "POST",
            "/api/agents",
            json!({"description":"no name"})
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn selected_agent_and_skills_compose_one_leading_system_message() {
    let home = tempfile::tempdir().unwrap();
    let engine = Arc::new(Capture::default());
    let host = Host::with_engine(home.path(), 43210, engine.clone()).unwrap();
    call(
        &host,
        "POST",
        "/api/agents",
        json!({"name":"Persona","body":"You are helpful."}),
    )
    .await;
    call(
        &host,
        "POST",
        "/api/skills",
        json!({"name":"Cite","body":"Always cite."}),
    )
    .await;
    call(&host, "POST", "/api/chat", json!({"messages":[{"role":"user","content":"hi"}],"agentId":"persona","skillIds":["cite"]})).await;
    call(
        &host,
        "POST",
        "/api/chat",
        json!({"messages":[{"role":"user","content":"plain"}]}),
    )
    .await;
    let requests = engine.0.lock().unwrap().clone();
    let first = &requests[0].messages;
    assert_eq!(first[0].role, "system");
    assert!(
        first[0].content.contains("You are helpful.") && first[0].content.contains("Always cite.")
    );
    assert_eq!(
        (first[1].role.as_str(), first[1].content.as_str()),
        ("user", "hi")
    );
    assert!(!requests[1].messages.iter().any(|message| message.role == "system" && message.content.contains("You are helpful.")));
}

#[tokio::test]
async fn artifact_images_are_typed_bounded_and_traversal_safe() {
    let home = tempfile::tempdir().unwrap();
    let host = Host::new(home.path(), 43210).unwrap();
    let png = [
        137u8, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82,
    ];
    std::fs::create_dir_all(home.path().join("artifacts")).unwrap();
    std::fs::write(home.path().join("artifacts/equation_plot.png"), png).unwrap();
    let (status, _, bytes, kind) =
        call(&host, "GET", "/api/images/equation_plot.png", Value::Null).await;
    assert_eq!(
        (status, kind.as_deref(), bytes.len()),
        (StatusCode::OK, Some("image/png"), png.len())
    );
    assert_eq!(
        call(&host, "GET", "/api/images/nope.png", Value::Null)
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    for path in [
        "/api/images/..%2F..%2Fetc%2Fpasswd",
        "/api/images/secret.txt",
        "/api/images/a%2Fb.png",
    ] {
        assert_eq!(
            call(&host, "GET", path, Value::Null).await.0,
            StatusCode::BAD_REQUEST,
            "{path}"
        );
    }
}
