use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use llmup_gui::{Host, router};
use serde_json::{Value, json};
use std::sync::Arc;
use tower::ServiceExt;
async fn call(host: &Arc<Host>, method: &str, path: &str, payload: Value) -> (StatusCode, Value) {
    let response = router(host.clone())
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("host", format!("127.0.0.1:{}", host.port))
                .header("origin", host.origin())
                .header("x-llmup-token", &host.token)
                .header("content-type", "application/json")
                .body(Body::from(payload.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}
#[tokio::test]
async fn persistence_routes_match_frontend_payloads() {
    let home = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let host = Host::new(home.path(), 43210).unwrap();
    let (status, created) = call(&host, "POST", "/api/sessions", json!({"title":"Session"})).await;
    assert_eq!(status, StatusCode::CREATED);
    let id = created["session"]["id"].as_str().unwrap();
    assert_eq!(
        call(
            &host,
            "PATCH",
            &format!("/api/sessions/{id}"),
            json!({"title":"Renamed","expectedRevision":0})
        )
        .await
        .1["session"]["revision"],
        1
    );
    assert_eq!(
        call(
            &host,
            "PATCH",
            &format!("/api/sessions/{id}"),
            json!({"title":"Stale","expectedRevision":0})
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        call(
            &host,
            "POST",
            "/api/agents",
            json!({"name":"Builder","body":"instructions"})
        )
        .await
        .0,
        StatusCode::CREATED
    );
    let connector = call(
        &host,
        "POST",
        "/api/connectors",
        json!({"name":"Fixture","transport":"stdio","command":"never-run"}),
    )
    .await;
    assert_eq!(connector.0, StatusCode::CREATED);
    assert_eq!(connector.1["connector"]["id"], "fixture");
    let registered = call(
        &host,
        "POST",
        "/api/workspace/root",
        json!({"path":root.path()}),
    )
    .await
    .1;
    let proposal = json!({"workspaceId":registered["root"]["id"],"operations":[{"op":"create","path":"new.txt","text":"created"}]});
    assert_eq!(
        call(
            &host,
            "POST",
            "/api/workspace/edits/apply",
            proposal.clone()
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        call(
            &host,
            "POST",
            "/api/workspace/edits/review",
            proposal.clone()
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(&host, "POST", "/api/workspace/edits/apply", proposal)
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        std::fs::read_to_string(root.path().join("new.txt")).unwrap(),
        "created"
    );
}
#[tokio::test]
async fn oversized_json_is_rejected_before_storage() {
    let home = tempfile::tempdir().unwrap();
    let host = Host::new(home.path(), 43210).unwrap();
    assert_eq!(
        call(
            &host,
            "POST",
            "/api/sessions",
            json!({"title":"x".repeat(65536)})
        )
        .await
        .0,
        StatusCode::PAYLOAD_TOO_LARGE
    );
    assert!(host.sessions.list(false, 0, 50).unwrap().0.is_empty());
}
