use llmup_runtime::command::{CommandRunner, NativeCommandRunner};
use std::{path::Path, time::Duration};
use tokio_util::sync::CancellationToken;

#[test]
fn ollama_context_rejects_unsafe_hosts_and_paths_and_adds_only_two_variables() {
    use llmup_runtime::command::OllamaCommandContext;
    let root = tempfile::tempdir().unwrap();
    let context = OllamaCommandContext::new("http://127.0.0.1:59125", root.path()).unwrap();
    let env = context.environment();
    assert_eq!(env.len(), 2);
    assert_eq!(env["OLLAMA_HOST"], "http://127.0.0.1:59125/");
    assert_eq!(env["OLLAMA_MODELS"], root.path().to_str().unwrap());
    for host in [
        "http://0.0.0.0:59125",
        "https://example.com",
        "http://127.0.0.1:59125/private",
        "http://user:secret@127.0.0.1:59125",
    ] {
        assert!(OllamaCommandContext::new(host, root.path()).is_err());
    }
    assert!(OllamaCommandContext::new("http://127.0.0.1:59125", Path::new("relative")).is_err());
}
#[tokio::test]
async fn command_validation_and_cancellation_happen_before_spawn() {
    let cancel = CancellationToken::new();
    cancel.cancel();
    assert!(
        NativeCommandRunner
            .run(
                Path::new("/never/spawn"),
                &[],
                &cancel,
                Duration::from_secs(1)
            )
            .await
            .unwrap_err()
            .contains("cancelled")
    );
    assert!(
        NativeCommandRunner
            .run(
                Path::new("relative"),
                &[],
                &CancellationToken::new(),
                Duration::from_secs(1)
            )
            .await
            .unwrap_err()
            .contains("invalid")
    );
}
