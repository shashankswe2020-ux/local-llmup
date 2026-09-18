use llmup_runtime::command::{CommandRunner, NativeCommandRunner};
use std::{path::Path, time::Duration};
use tokio_util::sync::CancellationToken;
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
