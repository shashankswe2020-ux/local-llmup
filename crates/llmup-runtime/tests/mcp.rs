#[test]
fn tool_result_previews_mask_opaque_credentials_and_cap_output() {
    use llmup_runtime::tool_policy::redact_result;
    let secret = format!("key{}", "123456789".repeat(4));
    assert_eq!(
        redact_result(&format!("value: {secret} done")).text,
        "value: [redacted] done"
    );
    let result = redact_result(&"plain ".repeat(1000));
    assert!(result.truncated);
    assert_eq!(result.text.len(), 2051);
}
#[tokio::test]
async fn session_grants_expire_on_scope_or_connection_change_and_reviews_redact() {
    use llmup_runtime::tool_policy::{SessionGrants, ToolRisk, classify};
    assert_eq!(classify("readFile", ""), ToolRisk::ReadOnly);
    assert_eq!(
        classify("readFile", "execute command"),
        ToolRisk::ProcessNetwork
    );
    assert_eq!(
        classify("writeFile", "read output"),
        ToolRisk::WorkspaceMutation
    );
    assert_eq!(classify("mystery", ""), ToolRisk::Unknown);
    let file=ConnectorFile::parse(r#"{"schemaVersion":1,"connectors":[{"id":"local","name":"Local","transport":"stdio","command":"tool-server"}]}"#).unwrap();
    let mut manager = Manager::new(file).unwrap();
    let cancel = CancellationToken::new();
    manager
        .attach("local", Box::new(Fake), &cancel)
        .await
        .unwrap();
    let reviewed = manager
        .review(
            "local",
            "echo",
            json!({"apiKey":"do-not-publish","nested":{"password":"hidden"}}),
        )
        .unwrap();
    let serialized = serde_json::to_string(&reviewed).unwrap();
    assert!(!serialized.contains("do-not-publish"));
    assert!(!serialized.contains("hidden"));
    let mut grants = SessionGrants::default();
    grants.select("session-one", Some("workspace-one"));
    manager.approve_session(reviewed, &mut grants).unwrap();
    assert!(
        manager
            .session_approval(
                manager
                    .review("local", "echo", json!({"text":"new args"}))
                    .unwrap(),
                &grants
            )
            .is_ok()
    );
    grants.select("session-one", Some("workspace-two"));
    assert!(
        manager
            .session_approval(manager.review("local", "echo", json!({})).unwrap(), &grants)
            .is_err()
    );
    manager
        .approve_session(
            manager.review("local", "echo", json!({})).unwrap(),
            &mut grants,
        )
        .unwrap();
    manager
        .attach("local", Box::new(Fake), &cancel)
        .await
        .unwrap();
    assert!(
        manager
            .session_approval(manager.review("local", "echo", json!({})).unwrap(), &grants)
            .is_err()
    );
    let approval = manager
        .approve(manager.review("local", "echo", json!({})).unwrap())
        .unwrap();
    cancel.cancel();
    assert!(matches!(
        manager
            .call("local", "echo", json!({}), Some(approval), &cancel)
            .await,
        Err(McpError::Cancelled)
    ));
    assert!(manager.tools().is_empty());
}
use llmup_runtime::mcp::{
    Connection, ConnectorFile, ConnectorStore, Manager, McpError, Tool, ToolResult,
};
use serde_json::json;
use tokio_util::sync::CancellationToken;
#[test]
fn connector_documents_match_existing_schema_and_reject_remote_targets() {
    let file=ConnectorFile::parse(&json!({"schemaVersion":1,"connectors":[{"id":"local","name":"Local","transport":"stdio","command":"tool-server","args":[]},{"id":"http","name":"HTTP","transport":"http","url":"http://127.0.0.1:3000/mcp"}]}).to_string()).unwrap();
    let root = tempfile::tempdir().unwrap();
    let store = ConnectorStore::new(root.path());
    store.save(&file).unwrap();
    assert_eq!(store.load().unwrap(), file);
    assert!(ConnectorFile::parse(r#"{"schemaVersion":1,"connectors":[{"id":"remote","name":"Remote","transport":"http","url":"https://example.com/mcp"}]}"#).is_err());
}
struct Fake;
struct CloseFailure;
#[async_trait::async_trait]
impl Connection for CloseFailure {
    async fn tools(&mut self, cancel: &CancellationToken) -> Result<Vec<Tool>, McpError> {
        Fake.tools(cancel).await
    }
    async fn call(
        &mut self,
        name: &str,
        args: serde_json::Value,
        cancel: &CancellationToken,
    ) -> Result<ToolResult, McpError> {
        Fake.call(name, args, cancel).await
    }
    async fn close(&mut self) -> Result<(), McpError> {
        Err(McpError::Transport)
    }
}
#[tokio::test]
async fn replacement_revokes_all_old_clients_even_when_close_fails() {
    let file=ConnectorFile::parse(r#"{"schemaVersion":1,"connectors":[{"id":"first","name":"First","transport":"stdio","command":"tool-server"},{"id":"second","name":"Second","transport":"stdio","command":"tool-server"}]}"#).unwrap();
    let mut manager = Manager::new(file).unwrap();
    let cancel = CancellationToken::new();
    manager
        .attach("first", Box::new(CloseFailure), &cancel)
        .await
        .unwrap();
    manager
        .attach("second", Box::new(Fake), &cancel)
        .await
        .unwrap();
    let root = tempfile::tempdir().unwrap();
    let store = ConnectorStore::new(root.path());
    assert!(
        manager
            .replace(ConnectorFile::default(), &store)
            .await
            .is_err()
    );
    assert_eq!(manager.snapshot(), store.load().unwrap());
    assert!(manager.tools().is_empty());
}
#[tokio::test]
async fn stdio_reader_rejects_oversized_frames_before_sdk_parsing() {
    use tokio::io::AsyncReadExt;
    let mut reader =
        llmup_runtime::mcp_sdk::BoundedLines::new(std::io::Cursor::new(vec![b'x'; 1048577]));
    let mut output = Vec::new();
    assert!(reader.read_to_end(&mut output).await.is_err());
    assert!(output.len() <= 1048576);
    let mut reader = llmup_runtime::mcp_sdk::BoundedLines::new(std::io::Cursor::new(b"one\ntwo\n"));
    let mut output = String::new();
    reader.read_to_string(&mut output).await.unwrap();
    assert_eq!(output, "one\ntwo\n");
}
#[async_trait::async_trait]
impl Connection for Fake {
    async fn tools(&mut self, _cancel: &CancellationToken) -> Result<Vec<Tool>, McpError> {
        Ok(vec![Tool {
            name: "echo".into(),
            description: "echo".into(),
            input_schema: json!({"type":"object"}),
        }])
    }
    async fn call(
        &mut self,
        _name: &str,
        args: serde_json::Value,
        _cancel: &CancellationToken,
    ) -> Result<ToolResult, McpError> {
        Ok(ToolResult {
            content: args.to_string(),
            is_error: false,
        })
    }
    async fn close(&mut self) -> Result<(), McpError> {
        Ok(())
    }
}
#[tokio::test]
async fn tool_calls_require_exact_single_use_approval() {
    let file=ConnectorFile::parse(r#"{"schemaVersion":1,"connectors":[{"id":"local","name":"Local","transport":"stdio","command":"tool-server","args":[]}]}"#).unwrap();
    let mut manager = Manager::new(file).unwrap();
    let cancel = CancellationToken::new();
    manager
        .attach("local", Box::new(Fake), &cancel)
        .await
        .unwrap();
    assert!(
        manager
            .call("local", "echo", json!({"text":"hello"}), None, &cancel)
            .await
            .is_err()
    );
    let reviewed = manager
        .review("local", "echo", json!({"text":"hello"}))
        .unwrap();
    let approval = manager.approve(reviewed).unwrap();
    assert!(
        manager
            .call(
                "local",
                "echo",
                json!({"text":"changed"}),
                Some(approval),
                &cancel
            )
            .await
            .is_err()
    );
    let approval = manager
        .approve(
            manager
                .review("local", "echo", json!({"text":"hello"}))
                .unwrap(),
        )
        .unwrap();
    assert!(
        manager
            .call(
                "local",
                "echo",
                json!({"text":"hello"}),
                Some(approval),
                &cancel
            )
            .await
            .unwrap()
            .content
            .contains("hello")
    );
    manager.shutdown().await.unwrap();
}
