use llmup_runtime::{
    identity::{Listener, ProcessIdentity, ProcessProbe},
    process_control::{ChildProcess, ProcessControl, SpawnSpec, stop_owned, wait_owned},
    state::StateError,
};
use std::sync::{Arc, Mutex};
use tokio_util::sync::CancellationToken;
fn identity() -> ProcessIdentity {
    ProcessIdentity {
        pid: 123,
        process: "runtime".into(),
        executable: "/opt/runtime".into(),
        started: "instance".into(),
    }
}
struct Probe;
#[async_trait::async_trait]
impl ProcessProbe for Probe {
    async fn listener(&self, port: u16, host: &str) -> Result<Listener, StateError> {
        Ok(Listener {
            identity: identity(),
            port,
            address: host.into(),
        })
    }
    async fn process(&self, _pid: u32) -> Result<ProcessIdentity, StateError> {
        Ok(identity())
    }
}
struct Child {
    terminated: Arc<Mutex<bool>>,
}
#[async_trait::async_trait]
impl ChildProcess for Child {
    fn pid(&self) -> u32 {
        123
    }
    fn exited(&mut self) -> Result<bool, String> {
        Ok(false)
    }
    async fn terminate(&mut self) -> Result<(), String> {
        *self.terminated.lock().unwrap() = true;
        Ok(())
    }
    fn detach(&mut self) {}
}
struct Control {
    signals: Mutex<Vec<u32>>,
}
#[async_trait::async_trait]
impl ProcessControl for Control {
    async fn occupied(&self, _endpoint: &str) -> Result<bool, String> {
        Ok(false)
    }
    async fn spawn(&self, _spec: &SpawnSpec) -> Result<Box<dyn ChildProcess>, String> {
        unreachable!()
    }
    async fn signal(&self, process: &ProcessIdentity, _force: bool) -> Result<(), String> {
        self.signals.lock().unwrap().push(process.pid);
        Ok(())
    }
    async fn alive(&self, _pid: u32) -> Result<bool, String> {
        Ok(false)
    }
}
#[tokio::test]
async fn failed_readiness_terminates_child_and_success_preserves_it() {
    for ready in [true, false] {
        let terminated = Arc::new(Mutex::new(false));
        let child: Box<dyn ChildProcess> = Box::new(Child {
            terminated: terminated.clone(),
        });
        let result = wait_owned(
            child,
            "http://127.0.0.1:11435",
            "/opt/runtime",
            &Probe,
            &CancellationToken::new(),
            || async move {
                if ready {
                    Ok(())
                } else {
                    Err("failed readiness".into())
                }
            },
        )
        .await;
        assert_eq!(result.is_ok(), ready);
        assert_eq!(*terminated.lock().unwrap(), !ready);
    }
}
#[tokio::test]
async fn stop_refuses_reused_pid_before_signalling() {
    let control = Control {
        signals: Mutex::new(Vec::new()),
    };
    let mut changed = identity();
    changed.started = "old instance".into();
    assert!(
        stop_owned(
            "http://127.0.0.1:11435",
            &changed,
            &Probe,
            &control,
            &CancellationToken::new()
        )
        .await
        .is_err()
    );
    assert!(control.signals.lock().unwrap().is_empty());
    stop_owned(
        "http://127.0.0.1:11435",
        &identity(),
        &Probe,
        &control,
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(*control.signals.lock().unwrap(), vec![123]);
}

#[tokio::test]
async fn startup_uses_backend_deadline_and_cleans_up_on_timeout() {
    let terminated = Arc::new(Mutex::new(false));
    let child: Box<dyn ChildProcess> = Box::new(Child {
        terminated: terminated.clone(),
    });
    let result = llmup_runtime::process_control::wait_owned_with_timeout(
        child,
        "http://127.0.0.1:11435",
        "/opt/runtime",
        &Probe,
        &CancellationToken::new(),
        std::time::Duration::from_millis(5),
        std::future::pending::<Result<(), String>>,
    )
    .await;
    assert!(result.unwrap_err().contains("timed out"));
    assert!(*terminated.lock().unwrap());
}
