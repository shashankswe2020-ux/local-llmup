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

struct Client {
    host: Arc<Host>,
    _home: tempfile::TempDir,
}
impl Client {
    fn new(engine: Arc<Capture>) -> Self {
        let home = tempfile::tempdir().unwrap();
        let host = Host::with_engine(home.path(), 43210, engine).unwrap();
        Self { host, _home: home }
    }
    async fn send(
        &self,
        method: &str,
        path: &str,
        payload: Value,
        headers: &[(&str, String)],
    ) -> (StatusCode, Value, String) {
        let mut builder = Request::builder()
            .method(method)
            .uri(path)
            .header("host", format!("127.0.0.1:{}", self.host.port))
            .header("content-type", "application/json");
        for (name, value) in headers {
            builder = builder.header(*name, value);
        }
        let body = if method == "GET" {
            Body::empty()
        } else {
            Body::from(payload.to_string())
        };
        let response = router(self.host.clone())
            .oneshot(builder.body(body).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let text = String::from_utf8(
            to_bytes(response.into_body(), 4 * 1024 * 1024)
                .await
                .unwrap()
                .to_vec(),
        )
        .unwrap();
        (
            status,
            serde_json::from_str(&text).unwrap_or(Value::Null),
            text,
        )
    }
    fn trusted(&self) -> Vec<(&'static str, String)> {
        vec![
            ("origin", self.host.origin()),
            ("x-llmup-token", self.host.token.clone()),
        ]
    }
    async fn call(&self, method: &str, path: &str, payload: Value) -> (StatusCode, Value, String) {
        self.send(method, path, payload, &self.trusted()).await
    }
    async fn register(&self, path: &std::path::Path) -> String {
        let (status, body, _) = self
            .call("POST", "/api/workspace/root", json!({"path": path}))
            .await;
        assert_eq!(status, StatusCode::CREATED);
        body["root"]["id"].as_str().unwrap().to_owned()
    }
}

fn workspace_dir() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir(dir.path().join("src")).unwrap();
    std::fs::write(dir.path().join("src/index.ts"), "alpha\nbeta\ngamma\n").unwrap();
    std::fs::write(dir.path().join("src/app.ts"), "a\nb\nc\n").unwrap();
    std::fs::write(dir.path().join("README.md"), "# hi\n").unwrap();
    std::fs::write(dir.path().join(".env"), "SECRET=1\n").unwrap();
    dir
}

fn update(id: &str, hash: &Value, line: &str) -> Value {
    json!({"workspaceId": id, "operations": [{"op":"update","path":"src/app.ts","baseHash":hash,"hunks":[{"start":2,"end":2,"lines":[line]}]}]})
}

#[tokio::test]
async fn workspace_routes_require_the_capability_token_and_same_origin_mutations() {
    let client = Client::new(Arc::default());
    let dir = workspace_dir();
    let (status, _, _) = client
        .send("GET", "/api/workspace/status", Value::Null, &[])
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let evil = [
        ("origin", "http://evil.example".to_owned()),
        ("x-llmup-token", client.host.token.clone()),
    ];
    let (status, _, _) = client
        .send(
            "POST",
            "/api/workspace/root",
            json!({"path": dir.path()}),
            &evil,
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let id = client.register(dir.path()).await;
    let (_, file, _) = client
        .call(
            "GET",
            &format!("/api/workspace/file?id={id}&path=src%2Fapp.ts"),
            Value::Null,
        )
        .await;
    let proposal = update(&id, &file["snapshot"]["hash"], "x");
    for path in [
        "/api/workspace/edits/review",
        "/api/workspace/edits/apply",
        "/api/workspace/search",
    ] {
        let method = if path.ends_with("search") {
            "GET"
        } else {
            "POST"
        };
        let tokenless = [("origin", client.host.origin())];
        assert_eq!(
            client
                .send(method, path, proposal.clone(), &tokenless)
                .await
                .0,
            StatusCode::FORBIDDEN,
            "{path}"
        );
        if method == "POST" {
            assert_eq!(
                client.send(method, path, proposal.clone(), &evil).await.0,
                StatusCode::FORBIDDEN,
                "{path}"
            );
        }
    }
    assert_eq!(
        std::fs::read_to_string(dir.path().join("src/app.ts")).unwrap(),
        "a\nb\nc\n"
    );
}

#[tokio::test]
async fn roots_tree_file_range_search_and_revoke_follow_the_frontend_contract() {
    let client = Client::new(Arc::default());
    let dir = workspace_dir();
    let id = client.register(dir.path()).await;
    assert_eq!(
        client
            .call("GET", "/api/workspace/status", Value::Null)
            .await
            .1,
        json!({"rootId": id})
    );
    let (_, tree, _) = client
        .call("GET", &format!("/api/workspace/tree?id={id}"), Value::Null)
        .await;
    let names: Vec<_> = tree["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["name"].as_str().unwrap())
        .collect();
    assert!(
        names.contains(&"src") && names.contains(&"README.md") && !names.contains(&".env"),
        "{names:?}"
    );
    let (_, file, _) = client
        .call(
            "GET",
            &format!("/api/workspace/file?id={id}&path=src%2Findex.ts"),
            Value::Null,
        )
        .await;
    assert_eq!(file["snapshot"]["content"], "alpha\nbeta\ngamma\n");
    assert_eq!(file["snapshot"]["hash"].as_str().unwrap().len(), 64);
    let (_, ranged, _) = client
        .call(
            "GET",
            &format!("/api/workspace/file?id={id}&path=src%2Findex.ts&startLine=2&endLine=3"),
            Value::Null,
        )
        .await;
    assert_eq!(ranged["snapshot"]["content"], "beta\ngamma");
    assert_eq!(
        ranged["snapshot"]["range"],
        json!({"startLine": 2, "endLine": 3})
    );
    let (_, page, _) = client
        .call(
            "GET",
            &format!("/api/workspace/search?id={id}&q=index"),
            Value::Null,
        )
        .await;
    assert!(
        page["results"]
            .as_array()
            .unwrap()
            .iter()
            .any(|result| result["path"] == "src/index.ts")
    );
    let (status, _, _) = client
        .call(
            "GET",
            &format!("/api/workspace/file?id={id}&path=.env"),
            Value::Null,
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _, _) = client
        .call("POST", "/api/workspace/root/revoke", json!({"id": id}))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        client
            .call("GET", "/api/workspace/status", Value::Null)
            .await
            .1,
        json!({"rootId": null})
    );

    let parent = tempfile::tempdir().unwrap();
    let requested = parent.path().join("calculator-workspace");
    let (status, created, _) = client
        .call(
            "POST",
            "/api/workspace/root/create",
            json!({"path": requested}),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(created["root"]["name"], "calculator-workspace");
    assert_eq!(
        client
            .call("GET", "/api/workspace/status", Value::Null)
            .await
            .1,
        json!({"rootId": created["root"]["id"]})
    );
}

#[tokio::test]
async fn edit_routes_review_apply_and_revert_without_touching_unreviewed_files() {
    let client = Client::new(Arc::default());
    let dir = workspace_dir();
    let app = dir.path().join("src/app.ts");
    let id = client.register(dir.path()).await;
    let (_, file, _) = client
        .call(
            "GET",
            &format!("/api/workspace/file?id={id}&path=src%2Fapp.ts"),
            Value::Null,
        )
        .await;
    let hash = file["snapshot"]["hash"].clone();
    let proposal = update(&id, &hash, "B");
    let (status, review, _) = client
        .call("POST", "/api/workspace/edits/review", proposal.clone())
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        (
            review["review"]["files"][0]["added"].as_u64(),
            review["review"]["files"][0]["removed"].as_u64()
        ),
        (Some(1), Some(1))
    );
    assert_eq!(std::fs::read_to_string(&app).unwrap(), "a\nb\nc\n");
    let stale = update(&id, &json!("stale"), "x");
    assert_eq!(
        client
            .call("POST", "/api/workspace/edits/review", stale.clone())
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        client
            .call("POST", "/api/workspace/edits/apply", stale)
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    let (status, applied, _) = client
        .call("POST", "/api/workspace/edits/apply", proposal)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(std::fs::read_to_string(&app).unwrap(), "a\nB\nc\n");
    let application = applied["result"]["applicationId"].clone();
    let (status, _, _) = client
        .call(
            "POST",
            "/api/workspace/edits/revert",
            json!({"applicationId": application}),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(std::fs::read_to_string(&app).unwrap(), "a\nb\nc\n");
    let delete = json!({"workspaceId": id, "operations": [{"op":"delete","path":"src/app.ts","baseHash":hash}]});
    assert_eq!(
        client
            .call("POST", "/api/workspace/edits/review", delete.clone())
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        client
            .call("POST", "/api/workspace/edits/apply", delete)
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    assert!(app.exists());
}

fn system_text(request: &HarnessRequest) -> String {
    request
        .messages
        .iter()
        .filter(|message| message.role == "system")
        .map(|message| message.content.as_str())
        .collect::<Vec<_>>()
        .join("\n")
}

#[tokio::test]
async fn pasted_terminal_and_diagnostics_context_is_normalized_announced_and_persisted() {
    let engine = Arc::new(Capture::default());
    let client = Client::new(engine.clone());
    client
        .call(
            "POST",
            "/api/chat",
            json!({"messages":[{"role":"user","content":"why did it fail"}],"contextSources":[
                {"kind":"terminal","label":"npm test","content":"Error: boom\r\n\tat line 3\u{1b}[31m"},
                {"kind":"diagnostics","content":"src/index.ts(2,1):\rerror TS1005\u{202e}"}
            ]}),
        )
        .await;
    let text = system_text(&engine.0.lock().unwrap()[0]);
    assert!(text.contains("Error: boom\n\tat line 3"), "{text}");
    assert!(
        text.contains("src/index.ts(2,1):\nerror TS1005") && !text.contains('\u{202e}'),
        "{text}"
    );
    let (_, sessions, _) = client.call("GET", "/api/sessions", Value::Null).await;
    let id = sessions["activeSessionId"].as_str().unwrap();
    let (_, page, _) = client
        .call("GET", &format!("/api/sessions/{id}/messages"), Value::Null)
        .await;
    let user = page["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|message| message["role"] == "user")
        .unwrap();
    let kinds: Vec<_> = user["attachments"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["kind"].as_str().unwrap())
        .collect();
    assert_eq!(kinds, ["terminal", "diagnostics"]);
    assert_eq!(user["attachments"][0]["label"], "npm test");
}

#[tokio::test]
async fn context_events_name_non_file_sources() {
    let client = Client::new(Arc::default());
    let (_, _, stream) = client
        .call(
            "POST",
            "/api/chat",
            json!({"messages":[{"role":"user","content":"logs"}],"contextSources":[
                {"kind":"terminal","content":"boom"},{"kind":"diagnostics","content":"warn"}
            ]}),
        )
        .await;
    assert!(stream.contains("\"type\":\"context\""), "{stream}");
    assert!(
        stream.contains("\"kind\":\"terminal\"") && stream.contains("\"kind\":\"diagnostics\""),
        "{stream}"
    );
}

#[tokio::test]
async fn unavailable_git_context_is_skipped_and_previewed_honestly() {
    let engine = Arc::new(Capture::default());
    let client = Client::new(engine.clone());
    let dir = workspace_dir();
    let id = client.register(dir.path()).await;
    let (_, preview, _) = client
        .call(
            "GET",
            &format!("/api/workspace/git?id={id}&mode=status"),
            Value::Null,
        )
        .await;
    assert_eq!(preview["snapshot"]["available"], false);
    assert!(
        ["git-failed", "no-changes"].contains(&preview["snapshot"]["reason"].as_str().unwrap()),
        "{preview}"
    );
    let (_, _, stream) = client
        .call(
            "POST",
            "/api/chat",
            json!({"messages":[{"role":"user","content":"status?"}],"contextSources":[{"kind":"git","workspaceId":id,"mode":"status"}]}),
        )
        .await;
    assert!(
        !stream.contains("\"type\":\"context\"") && stream.contains("\"type\":\"done\""),
        "{stream}"
    );
    assert!(!system_text(&engine.0.lock().unwrap()[0]).contains("git status"));
}
