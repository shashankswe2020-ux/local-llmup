use llmup_runtime::{
    adapters::{BackendAdapter, BackendError, ServeRequest},
    identity::ProcessIdentity,
    pull::with_ollama_daemon,
    state::{RuntimeState, ServerState},
};
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio_util::sync::CancellationToken;

struct Daemon {
    owned: bool,
    fail_stop: bool,
    stops: AtomicUsize,
}
#[async_trait::async_trait]
impl BackendAdapter for Daemon {
    fn name(&self) -> &'static str {
        "ollama"
    }
    fn trusts(&self, _: &ProcessIdentity) -> bool {
        true
    }
    async fn serve(
        &self,
        request: &ServeRequest,
        _: &CancellationToken,
    ) -> Result<ServerState, BackendError> {
        assert_eq!(request.endpoint, "http://127.0.0.1:59125");
        let mut handle = RuntimeState::parse(r#"{"schemaVersion":2,"active":{"backend":"ollama","modelId":"test:latest","endpoint":"http://127.0.0.1:59125","port":59125,"ownedByUs":false,"pid":123,"processExecutable":"/fixture/ollama","processStartedAt":"fixture"}}"#).unwrap().active.unwrap();
        handle.owned_by_us = self.owned;
        Ok(handle)
    }
    async fn ready(&self, _: &ServeRequest, _: &CancellationToken) -> Result<(), BackendError> {
        Ok(())
    }
    async fn stop(
        &self,
        handle: &ServerState,
        cancel: &CancellationToken,
    ) -> Result<(), BackendError> {
        assert!(handle.owned_by_us);
        assert!(!cancel.is_cancelled());
        self.stops.fetch_add(1, Ordering::SeqCst);
        if self.fail_stop {
            Err(BackendError("fixture cleanup failure".into()))
        } else {
            Ok(())
        }
    }
}
#[tokio::test]
async fn acquisition_daemon_cleanup_respects_ownership_and_preserves_errors() {
    for owned in [false, true] {
        for success in [false, true] {
            let daemon = Daemon {
                owned,
                fail_stop: false,
                stops: Default::default(),
            };
            let result = with_ollama_daemon(
                &daemon,
                "http://127.0.0.1:59125",
                &CancellationToken::new(),
                async {
                    if success {
                        Ok(42)
                    } else {
                        Err(BackendError("pull failed".into()))
                    }
                },
            )
            .await;
            assert_eq!(result.is_ok(), success);
            assert_eq!(daemon.stops.load(Ordering::SeqCst), usize::from(owned));
        }
    }
    let daemon = Daemon {
        owned: true,
        fail_stop: true,
        stops: Default::default(),
    };
    let error = with_ollama_daemon(
        &daemon,
        "http://127.0.0.1:59125",
        &CancellationToken::new(),
        async { Ok(42) },
    )
    .await
    .unwrap_err();
    assert!(error.0.contains("cleanup"));
    let error = with_ollama_daemon(
        &daemon,
        "http://127.0.0.1:59125",
        &CancellationToken::new(),
        async { Err::<(), _>(BackendError("pull failed".into())) },
    )
    .await
    .unwrap_err();
    assert!(error.0.contains("pull failed"));
    assert!(error.0.contains("fixture cleanup failure"));
    assert!(error.0.contains("123"));
}
#[tokio::test]
async fn cancellation_uses_fresh_token_for_owned_daemon_cleanup() {
    let daemon = Daemon {
        owned: true,
        fail_stop: false,
        stops: Default::default(),
    };
    let cancel = CancellationToken::new();
    let result = with_ollama_daemon(&daemon, "http://127.0.0.1:59125", &cancel, async {
        cancel.cancel();
        std::future::pending::<Result<(), BackendError>>().await
    })
    .await;
    assert!(result.is_err());
    assert_eq!(daemon.stops.load(Ordering::SeqCst), 1);
}
