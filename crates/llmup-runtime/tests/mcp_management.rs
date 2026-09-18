use llmup_runtime::mcp::{
    ClientFactory, Connection, Connector, ConnectorFile, ConnectorStore, Manager, McpError,
};
use tokio_util::sync::CancellationToken;
struct Unavailable;
#[async_trait::async_trait]
impl ClientFactory for Unavailable {
    async fn connect(
        &self,
        _: &Connector,
        _: &CancellationToken,
    ) -> Result<Box<dyn Connection>, McpError> {
        Err(McpError::Unavailable)
    }
}
#[tokio::test]
async fn connector_crud_persists_definitions_and_exposes_redacted_runtime_status() {
    let home = tempfile::tempdir().unwrap();
    let store = ConnectorStore::new(home.path());
    let mut manager = Manager::new(ConnectorFile::default()).unwrap();
    let connector:Connector=serde_json::from_value(serde_json::json!({"transport":"stdio","id":"fixture","name":"Fixture","command":"unused","args":[],"env":{"API_KEY":"private-token"}})).unwrap();
    manager.add(connector.clone(), &store).await.unwrap();
    assert_eq!(store.load().unwrap().connectors, vec![connector.clone()]);
    assert!(manager.add(connector, &store).await.is_err());
    assert!(
        manager
            .connect("fixture", &Unavailable, &CancellationToken::new())
            .await
            .is_err()
    );
    let views = serde_json::to_value(manager.list()).unwrap();
    assert_eq!(views[0]["status"], "error");
    assert!(!views.to_string().contains("private-token"));
    manager.remove("fixture", &store).await.unwrap();
    assert!(store.load().unwrap().connectors.is_empty());
    assert!(manager.list().is_empty());
}
