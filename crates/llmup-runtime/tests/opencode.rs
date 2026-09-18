#[tokio::test]
async fn injected_opencode_runner_streams_and_observes_cancellation() {
    use llmup_runtime::{
        harness::{ChatHarness, DeltaSink, HarnessError},
        opencode::{LaunchSpec, OpenCodeHarness, OpenCodeRunner},
    };
    use tokio_util::sync::CancellationToken;
    struct Runner;
    #[async_trait::async_trait]
    impl OpenCodeRunner for Runner {
        async fn run(
            &self,
            _: &LaunchSpec,
            cancel: &CancellationToken,
            sink: &mut DeltaSink<'_>,
        ) -> Result<(), HarnessError> {
            if cancel.is_cancelled() {
                return Err(HarnessError::Cancelled);
            }
            sink("first")?;
            sink(" second")?;
            Ok(())
        }
    }
    let harness = OpenCodeHarness {
        runner: &Runner,
        unrestricted: false,
    };
    assert!(harness.available().await);
    let input = HarnessRequest {
        model: "test".into(),
        messages: vec![HarnessMessage {
            role: "user".into(),
            content: "question".into(),
        }],
        temperature: None,
    };
    let cancel = CancellationToken::new();
    assert_eq!(
        harness
            .chat(&input, &cancel, &mut |_| Ok(()))
            .await
            .unwrap(),
        "first second"
    );
    cancel.cancel();
    assert!(matches!(
        harness.chat(&input, &cancel, &mut |_| Ok(())).await,
        Err(HarnessError::Cancelled)
    ));
}
use llmup_runtime::harness::{HarnessMessage, HarnessRequest};
use llmup_runtime::opencode::{launch_spec, parse_event};
#[test]
fn opencode_launch_is_discrete_and_default_denies_tools() {
    let input = HarnessRequest {
        model: "llama3.1:8b".into(),
        messages: vec![HarnessMessage {
            role: "user".into(),
            content: "hello; not a shell".into(),
        }],
        temperature: None,
    };
    let spec = launch_spec(&input, false).unwrap();
    assert_eq!(spec.args[0], "run");
    assert_eq!(spec.args[1], "[user]\nhello; not a shell");
    assert_eq!(spec.args[3], "ollama/llama3.1:8b");
    let config: serde_json::Value = serde_json::from_str(&spec.config).unwrap();
    assert_eq!(config["permission"], "deny");
    assert_eq!(config["share"], "disabled");
    assert_eq!(config["agent"]["local-llmup-chat"]["permission"], "deny");
}
#[test]
fn opencode_events_are_validated_and_provider_errors_are_redacted() {
    assert_eq!(parse_event(r#"{"type":"text","timestamp":1,"sessionID":"session","part":{"type":"text","text":"reply"}}"#).unwrap(),"reply");
    assert!(parse_event("bad json").is_err());
    let error=parse_event(r#"{"type":"error","timestamp":1,"sessionID":"session","error":{"message":"secret-api-key"}}"#).unwrap_err();
    assert!(!error.to_string().contains("secret-api-key"));
}
