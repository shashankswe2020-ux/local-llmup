use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use llmup_gui::{Host, router};
use tower::ServiceExt;

#[tokio::test]
async fn artifacts_are_sandboxed_and_vendor_assets_are_embedded() {
    let home = tempfile::tempdir().unwrap();
    let host = Host::new(home.path(), 43210).unwrap();
    std::fs::create_dir_all(home.path().join("artifacts")).unwrap();
    std::fs::write(
        home.path().join("artifacts/chart.svg"),
        "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>",
    )
    .unwrap();
    for path in [
        "/api/images/chart.svg",
        "/vendor/marked.min.js",
        "/vendor/dompurify.min.js",
        "/static/chat.js",
    ] {
        let response = router(host.clone())
            .oneshot(
                Request::builder()
                    .uri(path)
                    .header("host", "127.0.0.1:43210")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK, "{path}");
        assert_eq!(response.headers()["x-content-type-options"], "nosniff");
        assert_eq!(response.headers()["cache-control"], "no-store");
        if path.starts_with("/api/images/") {
            assert_eq!(
                response.headers()["content-security-policy"],
                "default-src 'none'; sandbox"
            );
        }
        assert!(
            !to_bytes(response.into_body(), 1024 * 1024)
                .await
                .unwrap()
                .is_empty()
        );
    }
    for path in [
        "/api/images/%2e%2e%2fchart.svg",
        "/static/%2e%2e/package.json",
        "/vendor/unknown.js",
    ] {
        let response = router(host.clone())
            .oneshot(
                Request::builder()
                    .uri(path)
                    .header("host", "127.0.0.1:43210")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(response.status().is_client_error(), "{path}");
    }
}

#[tokio::test]
async fn mutations_without_origin_and_cross_site_reads_are_denied() {
    let home = tempfile::tempdir().unwrap();
    let host = Host::new(home.path(), 43210).unwrap();
    for (method, path, cross_site) in [
        ("POST", "/api/sessions", false),
        ("GET", "/api/status", true),
    ] {
        let mut request = Request::builder()
            .method(method)
            .uri(path)
            .header("host", "127.0.0.1:43210");
        if cross_site {
            request = request.header("sec-fetch-site", "cross-site");
        }
        let response = router(host.clone())
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }
}

#[tokio::test]
async fn serve_rejects_mismatched_or_non_loopback_listeners() {
    for address in ["127.0.0.1:0", "0.0.0.0:0"] {
        let home = tempfile::tempdir().unwrap();
        let listener = tokio::net::TcpListener::bind(address).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let host = Host::new(
            home.path(),
            if address.starts_with("127") { 0 } else { port },
        )
        .unwrap();
        host.shutdown.cancel();
        let result = llmup_gui::serve(listener, host).await;
        assert_eq!(result.unwrap_err().kind(), std::io::ErrorKind::InvalidInput);
    }
}

#[tokio::test]
async fn launch_boundary_rejects_rebinding_cross_origin_and_missing_tokens() {
    let home = tempfile::tempdir().unwrap();
    let host = Host::new(home.path(), 43210).unwrap();
    let app = router(host.clone());
    let wrong = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/status")
                .header("host", "evil.example:43210")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(wrong.status(), StatusCode::BAD_REQUEST);
    let denied = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/sessions")
                .header("host", "127.0.0.1:43210")
                .header("origin", "https://evil.example")
                .header("content-type", "application/json")
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(denied.status(), StatusCode::FORBIDDEN);
    let no_token = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/workspace/tree?id=unknown")
                .header("host", "127.0.0.1:43210")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(no_token.status(), StatusCode::FORBIDDEN);
    let index = app
        .oneshot(
            Request::builder()
                .uri("/")
                .header("host", "127.0.0.1:43210")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(index.status(), StatusCode::OK);
    assert!(index.headers().contains_key("content-security-policy"));
    let body = to_bytes(index.into_body(), 1024 * 1024).await.unwrap();
    assert!(
        String::from_utf8(body.to_vec())
            .unwrap()
            .contains("llmup-token")
    );
}
