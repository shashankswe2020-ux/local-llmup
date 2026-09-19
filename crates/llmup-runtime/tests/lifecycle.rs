use llmup_runtime::{
    adapters::{BackendAdapter, BackendError, ServeRequest},
    identity::{Listener, ProcessIdentity, ProcessProbe},
    lifecycle::{Lifecycle, Registry},
    state::{Config, RuntimeState, ServerState, StateError, StateStore},
};
use std::{sync::Mutex, time::Duration};
use tokio_util::sync::CancellationToken;
fn state() -> RuntimeState {
    RuntimeState::parse(r#"{"schemaVersion":2,"active":{"backend":"ollama","modelId":"prior:latest","endpoint":"http://127.0.0.1:11435","port":11435,"ownedByUs":false,"pid":123,"processExecutable":"/trusted/ollama","processStartedAt":"instance"}}"#).unwrap()
}
struct Probe;
#[async_trait::async_trait]
impl ProcessProbe for Probe {
    async fn listener(&self, port: u16, host: &str) -> Result<Listener, StateError> {
        Ok(Listener {
            identity: ProcessIdentity {
                pid: 123,
                process: "ollama".into(),
                executable: "/trusted/ollama".into(),
                started: "instance".into(),
            },
            port,
            address: host.into(),
        })
    }
    async fn process(&self, _pid: u32) -> Result<ProcessIdentity, StateError> {
        Ok(self.listener(11435, "127.0.0.1").await?.identity)
    }
}
struct Adapter {
    fail: bool,
    stopped: Mutex<bool>,
}

#[tokio::test]
async fn health_checks_identity_and_readiness_without_mutating_state() {
    let home = tempfile::tempdir().unwrap();
    let store = StateStore::new(Config::from_home(home.path()).unwrap());
    let guard = store.lock(Duration::from_millis(10)).unwrap();
    store.write(&guard, &state()).unwrap();
    guard.release().unwrap();
    let adapter = Adapter {
        fail: false,
        stopped: Mutex::new(false),
    };
    let registry = Registry::new(vec![&adapter]);
    let lifecycle = Lifecycle {
        store: &store,
        registry: &registry,
        probe: &Probe,
    };
    let active = state().active.unwrap();
    let request = ServeRequest {
        model_id: active.model_id.clone(),
        endpoint: active.endpoint.clone(),
        model_path: None,
        context: None,
    };
    lifecycle
        .health(&active, &request, &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(store.read().unwrap(), state());
    assert!(!store.config.lock.exists());
    let mut changed = active;
    changed.pid = Some(456);
    assert!(
        lifecycle
            .health(&changed, &request, &CancellationToken::new())
            .await
            .is_err()
    );
}
#[async_trait::async_trait]
impl BackendAdapter for Adapter {
    async fn attach_only(
        &self,
        request: &ServeRequest,
        cancel: &CancellationToken,
    ) -> Result<ServerState, BackendError> {
        self.serve(request, cancel).await
    }
    fn name(&self) -> &'static str {
        "ollama"
    }
    fn trusts(&self, identity: &ProcessIdentity) -> bool {
        identity.executable == "/trusted/ollama"
    }
    async fn serve(
        &self,
        request: &ServeRequest,
        _cancel: &CancellationToken,
    ) -> Result<ServerState, BackendError> {
        if self.fail {
            return Err(BackendError("startup failed".into()));
        }
        let mut active = state().active.unwrap();
        active.model_id = request.model_id.clone();
        Ok(active)
    }
    async fn ready(
        &self,
        _request: &ServeRequest,
        _cancel: &CancellationToken,
    ) -> Result<(), BackendError> {
        Ok(())
    }
    async fn stop(
        &self,
        handle: &ServerState,
        _cancel: &CancellationToken,
    ) -> Result<(), BackendError> {
        if handle.process_executable.is_none() || handle.process_started_at.is_none() {
            return Err(BackendError("missing observed identity".into()));
        }
        *self.stopped.lock().unwrap() = true;
        Ok(())
    }
}

#[tokio::test]
async fn legacy_owned_state_is_enriched_from_verified_live_identity_before_stop() {
    let home = tempfile::tempdir().unwrap();
    let store = StateStore::new(Config::from_home(home.path()).unwrap());
    let mut prior = state();
    let active = prior.active.as_mut().unwrap();
    active.owned_by_us = true;
    active.process_executable = None;
    active.process_started_at = None;
    let guard = store.lock(Duration::from_millis(10)).unwrap();
    store.write(&guard, &prior).unwrap();
    guard.release().unwrap();
    let adapter = Adapter {
        fail: false,
        stopped: Mutex::new(false),
    };
    let registry = Registry::new(vec![&adapter]);
    let lifecycle = Lifecycle {
        store: &store,
        registry: &registry,
        probe: &Probe,
    };
    lifecycle.down(&CancellationToken::new()).await.unwrap();
    assert!(*adapter.stopped.lock().unwrap());
    assert!(store.read().unwrap().active.is_none());
}
#[tokio::test]
async fn replacement_failure_preserves_foreign_state_and_drift_prevents_startup() {
    let home = tempfile::tempdir().unwrap();
    let store = StateStore::new(Config::from_home(home.path()).unwrap());
    let guard = store.lock(Duration::from_millis(10)).unwrap();
    store.write(&guard, &state()).unwrap();
    guard.release().unwrap();
    let adapter = Adapter {
        fail: true,
        stopped: Mutex::new(false),
    };
    let registry = Registry::new(vec![&adapter]);
    let lifecycle = Lifecycle {
        store: &store,
        registry: &registry,
        probe: &Probe,
    };
    let cancel = CancellationToken::new();
    let reviewed = lifecycle.review("next:latest", &cancel).await.unwrap();
    let request = ServeRequest {
        model_id: "next:latest".into(),
        endpoint: "http://127.0.0.1:11435".into(),
        model_path: None,
        context: None,
    };
    assert!(
        lifecycle
            .replace("ollama", &request, &reviewed, &cancel)
            .await
            .is_err()
    );
    assert_eq!(store.read().unwrap(), state());
    assert!(!*adapter.stopped.lock().unwrap());
    let guard = store.lock(Duration::from_millis(10)).unwrap();
    store.write(&guard, &RuntimeState::default()).unwrap();
    guard.release().unwrap();
    assert!(
        lifecycle
            .replace("ollama", &request, &reviewed, &cancel)
            .await
            .unwrap_err()
            .to_string()
            .contains("changed")
    );
}
#[tokio::test]
async fn owned_replacement_failure_clears_stale_pid_and_detach_does_not_stop_foreign() {
    let home = tempfile::tempdir().unwrap();
    let store = StateStore::new(Config::from_home(home.path()).unwrap());
    let mut owned = state();
    owned.active.as_mut().unwrap().owned_by_us = true;
    let guard = store.lock(Duration::from_millis(10)).unwrap();
    store.write(&guard, &owned).unwrap();
    guard.release().unwrap();
    let adapter = Adapter {
        fail: true,
        stopped: Mutex::new(false),
    };
    let registry = Registry::new(vec![&adapter]);
    let lifecycle = Lifecycle {
        store: &store,
        registry: &registry,
        probe: &Probe,
    };
    let cancel = CancellationToken::new();
    let reviewed = lifecycle.review("next:latest", &cancel).await.unwrap();
    let request = ServeRequest {
        model_id: "next:latest".into(),
        endpoint: "http://127.0.0.1:11435".into(),
        model_path: None,
        context: None,
    };
    assert!(
        lifecycle
            .replace("ollama", &request, &reviewed, &cancel)
            .await
            .is_err()
    );
    assert!(store.read().unwrap().active.is_none());
    assert!(*adapter.stopped.lock().unwrap());
}

#[tokio::test]
async fn successful_replacement_and_detach_preserve_foreign_process() {
    let home = tempfile::tempdir().unwrap();
    let store = StateStore::new(Config::from_home(home.path()).unwrap());
    let adapter = Adapter {
        fail: false,
        stopped: Mutex::new(false),
    };
    let registry = Registry::new(vec![&adapter]);
    let lifecycle = Lifecycle {
        store: &store,
        registry: &registry,
        probe: &Probe,
    };
    let cancel = CancellationToken::new();
    let review = lifecycle.review("next:latest", &cancel).await.unwrap();
    let request = ServeRequest {
        model_id: "next:latest".into(),
        endpoint: "http://127.0.0.1:11435".into(),
        model_path: None,
        context: None,
    };
    let active = lifecycle
        .replace("ollama", &request, &review, &cancel)
        .await
        .unwrap();
    assert_eq!(store.read().unwrap().active, Some(active.clone()));
    assert_eq!(lifecycle.down(&cancel).await.unwrap(), Some(active));
    assert!(store.read().unwrap().active.is_none());
    assert!(!*adapter.stopped.lock().unwrap());
}
struct Finalize;
struct DriftingActivation(std::path::PathBuf);
#[async_trait::async_trait]
impl llmup_runtime::lifecycle::Activation for DriftingActivation {
    async fn finalize(
        &self,
        handle: &ServerState,
        _cancel: &CancellationToken,
    ) -> Result<ServerState, BackendError> {
        std::fs::write(&self.0, serde_json::to_vec(&state()).unwrap()).unwrap();
        Ok(handle.clone())
    }
}
#[tokio::test]
async fn state_changed_during_activation_is_not_overwritten() {
    let home = tempfile::tempdir().unwrap();
    let store = StateStore::new(Config::from_home(home.path()).unwrap());
    let guard = store.lock(Duration::from_millis(10)).unwrap();
    store.write(&guard, &RuntimeState::default()).unwrap();
    guard.release().unwrap();
    let adapter = Adapter {
        fail: false,
        stopped: Mutex::new(false),
    };
    let registry = Registry::new(vec![&adapter]);
    let lifecycle = Lifecycle {
        store: &store,
        registry: &registry,
        probe: &Probe,
    };
    let cancel = CancellationToken::new();
    let reviewed = lifecycle.review("next:latest", &cancel).await.unwrap();
    let request = ServeRequest {
        model_id: "next:latest".into(),
        endpoint: "http://127.0.0.1:11435".into(),
        model_path: None,
        context: None,
    };
    assert!(
        lifecycle
            .replace_with(
                "ollama",
                &request,
                &reviewed,
                &cancel,
                &DriftingActivation(store.config.state.clone())
            )
            .await
            .is_err()
    );
    assert_eq!(store.read().unwrap(), state());
}
struct FailingStop;
#[async_trait::async_trait]
impl BackendAdapter for FailingStop {
    fn name(&self) -> &'static str {
        "ollama"
    }
    fn trusts(&self, identity: &ProcessIdentity) -> bool {
        identity.executable == "/trusted/ollama"
    }
    async fn serve(
        &self,
        _request: &ServeRequest,
        _cancel: &CancellationToken,
    ) -> Result<ServerState, BackendError> {
        panic!("unexpected spawn")
    }
    async fn ready(
        &self,
        _request: &ServeRequest,
        _cancel: &CancellationToken,
    ) -> Result<(), BackendError> {
        Ok(())
    }
    async fn stop(
        &self,
        _handle: &ServerState,
        _cancel: &CancellationToken,
    ) -> Result<(), BackendError> {
        Err(BackendError("stop failed".into()))
    }
}
#[tokio::test]
async fn failed_shutdown_restores_exact_owned_state_and_releases_lock() {
    let home = tempfile::tempdir().unwrap();
    let store = StateStore::new(Config::from_home(home.path()).unwrap());
    let mut prior = state();
    prior.active.as_mut().unwrap().owned_by_us = true;
    let guard = store.lock(Duration::from_millis(10)).unwrap();
    store.write(&guard, &prior).unwrap();
    guard.release().unwrap();
    let registry = Registry::new(vec![&FailingStop]);
    let lifecycle = Lifecycle {
        store: &store,
        registry: &registry,
        probe: &Probe,
    };
    assert!(
        lifecycle
            .down(&CancellationToken::new())
            .await
            .unwrap_err()
            .to_string()
            .contains("stop failed")
    );
    assert_eq!(store.read().unwrap(), prior);
    assert!(!store.config.lock.exists());
}
#[async_trait::async_trait]
impl llmup_runtime::lifecycle::Activation for Finalize {
    async fn finalize(
        &self,
        handle: &ServerState,
        _cancel: &CancellationToken,
    ) -> Result<ServerState, BackendError> {
        let mut active = handle.clone();
        active.runtime_model_id = Some("llmup-context-fixture:8192".into());
        active.context = Some(8192);
        active.integrity = Some("local-manifest".into());
        active.local_manifest_digest = Some("a".repeat(64));
        Ok(active)
    }
}
#[tokio::test]
async fn installed_attachment_retains_ownership_of_same_recorded_daemon() {
    let home = tempfile::tempdir().unwrap();
    let store = StateStore::new(Config::from_home(home.path()).unwrap());
    let mut prior = state();
    prior.active.as_mut().unwrap().owned_by_us = true;
    let guard = store.lock(Duration::from_millis(10)).unwrap();
    store.write(&guard, &prior).unwrap();
    guard.release().unwrap();
    let adapter = Adapter {
        fail: false,
        stopped: Mutex::new(false),
    };
    let registry = Registry::new(vec![&adapter]);
    let lifecycle = Lifecycle {
        store: &store,
        registry: &registry,
        probe: &Probe,
    };
    let cancel = CancellationToken::new();
    let review = lifecycle.review("next:latest", &cancel).await.unwrap();
    let request = ServeRequest {
        model_id: "next:latest".into(),
        endpoint: "http://127.0.0.1:11435".into(),
        model_path: None,
        context: Some(8192),
    };
    let active = lifecycle
        .attach_installed(&request, &review, &cancel, &Finalize)
        .await
        .unwrap();
    assert!(active.owned_by_us);
    assert_eq!(active.context, Some(8192));
    assert_eq!(store.read().unwrap().active, Some(active));
    assert!(!*adapter.stopped.lock().unwrap());
}
#[tokio::test]
async fn cancelled_replacement_never_rewrites_state() {
    let home = tempfile::tempdir().unwrap();
    let store = StateStore::new(Config::from_home(home.path()).unwrap());
    let adapter = Adapter {
        fail: false,
        stopped: Mutex::new(false),
    };
    let registry = Registry::new(vec![&adapter]);
    let lifecycle = Lifecycle {
        store: &store,
        registry: &registry,
        probe: &Probe,
    };
    let cancel = CancellationToken::new();
    let review = lifecycle.review("next:latest", &cancel).await.unwrap();
    cancel.cancel();
    let request = ServeRequest {
        model_id: "next:latest".into(),
        endpoint: "http://127.0.0.1:11435".into(),
        model_path: None,
        context: None,
    };
    assert!(
        lifecycle
            .replace("ollama", &request, &review, &cancel)
            .await
            .is_err()
    );
    assert!(!store.config.state.exists());
    assert!(!*adapter.stopped.lock().unwrap());
}
