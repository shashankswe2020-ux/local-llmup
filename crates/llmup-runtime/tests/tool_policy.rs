use llmup_runtime::{
    mcp::{Connection, ConnectorFile, Manager, McpError, Tool, ToolResult},
    tool_policy::{SessionGrants, ToolRisk, classify, redact_arguments, redact_result},
};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

#[test]
fn risk_classes_follow_names_then_descriptions() {
    for (name, description, risk) in [
        ("write_file", "", ToolRisk::WorkspaceMutation),
        ("delete_record", "", ToolRisk::WorkspaceMutation),
        ("run_command", "", ToolRisk::ProcessNetwork),
        ("http_fetch", "", ToolRisk::ProcessNetwork),
        ("search_docs", "", ToolRisk::ReadOnly),
        ("frobnicate", "", ToolRisk::Unknown),
        ("x", "delete a row", ToolRisk::WorkspaceMutation),
    ] {
        assert_eq!(classify(name, description), risk, "{name} {description}");
    }
    assert_eq!(
        serde_json::to_value(ToolRisk::ProcessNetwork).unwrap(),
        "process-network"
    );
}

#[test]
fn arguments_mask_secret_keys_recursively_and_bound_long_strings() {
    let redacted = redact_arguments(&json!({
        "query": "weather", "apiKey": "sk-abcdef", "token": "t", "blob": "x".repeat(300),
        "nested": {"password": "p", "ok": 1}, "list": [1, 2]
    }));
    assert_eq!(redacted["query"], "weather");
    assert_eq!(
        (redacted["apiKey"].as_str(), redacted["token"].as_str()),
        (Some("[redacted]"), Some("[redacted]"))
    );
    assert!(redacted["blob"].as_str().unwrap().ends_with("[300 chars]"));
    assert_eq!(
        redacted["nested"],
        json!({"password": "[redacted]", "ok": 1})
    );
    assert_eq!(redacted["list"], json!([1, 2]));
}

#[test]
fn results_mask_opaque_tokens_and_report_truncation() {
    let masked = redact_result("token=abcd1234ABCD5678efgh9012xyz");
    assert_eq!(
        (masked.text.as_str(), masked.truncated),
        ("token=[redacted]", false)
    );
    assert!(redact_result(&"y".repeat(5000)).truncated);
}

struct Schema(Value);
#[async_trait::async_trait]
impl Connection for Schema {
    async fn tools(&mut self, _: &CancellationToken) -> Result<Vec<Tool>, McpError> {
        Ok(vec![Tool {
            name: "t".into(),
            description: "search".into(),
            input_schema: self.0.clone(),
        }])
    }
    async fn call(
        &mut self,
        _: &str,
        _: Value,
        _: &CancellationToken,
    ) -> Result<ToolResult, McpError> {
        Ok(ToolResult {
            content: "ok".into(),
            is_error: false,
        })
    }
    async fn close(&mut self) -> Result<(), McpError> {
        Ok(())
    }
}

#[tokio::test]
async fn session_grants_bind_the_connector_and_tool_schema() {
    let file = ConnectorFile::parse(
        r#"{"schemaVersion":1,"connectors":[
        {"id":"c1","name":"One","transport":"stdio","command":"one"},
        {"id":"c2","name":"Two","transport":"stdio","command":"two"}]}"#,
    )
    .unwrap();
    let mut manager = Manager::new(file).unwrap();
    let cancel = CancellationToken::new();
    for id in ["c1", "c2"] {
        manager
            .attach(id, Box::new(Schema(json!({"type":"object"}))), &cancel)
            .await
            .unwrap();
    }
    let mut grants = SessionGrants::default();
    grants.select("session", None);
    manager
        .approve_session(manager.review("c1", "t", json!({})).unwrap(), &mut grants)
        .unwrap();
    assert!(
        manager
            .session_approval(manager.review("c1", "t", json!({"q": 1})).unwrap(), &grants)
            .is_ok()
    );
    assert!(
        manager
            .session_approval(manager.review("c2", "t", json!({})).unwrap(), &grants)
            .is_err()
    );
    manager
        .attach(
            "c1",
            Box::new(Schema(
                json!({"type":"object","properties":{"q":{"type":"string"}}}),
            )),
            &cancel,
        )
        .await
        .unwrap();
    assert!(
        manager
            .session_approval(manager.review("c1", "t", json!({})).unwrap(), &grants)
            .is_err()
    );
    manager.shutdown().await.unwrap();
}
