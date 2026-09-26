use llmup_runtime::state::{Config, RuntimeState, StateStore};
use serde_json::Value;
use std::{
    io::{BufRead, Write},
    process::Stdio,
    time::Duration,
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

fn write_legacy_state(path: &std::path::Path, value: &Value) {
    std::fs::write(path, serde_json::to_vec(value).unwrap()).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
}

#[tokio::test]
async fn frozen_typescript_state_and_ls_contracts_survive_native_roundtrip() {
    let oracle: Value =
        serde_json::from_str(include_str!("../fixtures/state-parity.json")).unwrap();
    let contracts = oracle["contracts"].as_array().unwrap();
    assert_eq!(contracts.len(), 6);
    for contract in contracts {
        let home = tempfile::tempdir().unwrap();
        let store = StateStore::new(Config::from_home(home.path()).unwrap());
        write_legacy_state(&store.config.state, &contract["input"]);
        let original = store.read().unwrap();
        assert_eq!(
            serde_json::to_value(&original).unwrap(),
            contract["normalized"]
        );
        let guard = store.lock(Duration::from_secs(1)).unwrap();
        store.write(&guard, &original).unwrap();
        guard.release().unwrap();
        assert_eq!(store.read().unwrap(), original);
        assert_eq!(
            serde_json::from_slice::<Value>(&std::fs::read(&store.config.state).unwrap()).unwrap(),
            contract["normalized"]
        );
        let bytes = std::fs::read(&store.config.state).unwrap();
        for binary in [
            env!("CARGO_BIN_EXE_llmup"),
            env!("CARGO_BIN_EXE_local-llmup"),
        ] {
            for json in [false, true] {
                let mut command = tokio::process::Command::new(binary);
                command.arg("ls");
                if json {
                    command.arg("--json");
                }
                let output = tokio::time::timeout(
                    Duration::from_secs(5),
                    command
                        .env("LOCAL_LLMUP_HOME", home.path())
                        .env("PATH", "")
                        .env("TERM", "dumb")
                        .stdin(Stdio::null())
                        .kill_on_drop(true)
                        .output(),
                )
                .await
                .unwrap()
                .unwrap();
                assert!(output.status.success(), "{output:?}");
                assert!(output.stderr.is_empty());
                if json {
                    assert_eq!(
                        serde_json::from_slice::<Value>(&output.stdout).unwrap(),
                        contract["ls"]
                    );
                } else {
                    assert_eq!(
                        String::from_utf8(output.stdout).unwrap(),
                        contract["text"].as_str().unwrap()
                    );
                }
                assert_eq!(std::fs::read(&store.config.state).unwrap(), bytes);
                assert!(!store.config.lock.exists());
            }
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&store.config.state)
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }
}

#[test]
fn state_lock_child() {
    let Some(mode) = std::env::var_os("LLMUP_STATE_PARITY_CHILD") else {
        return;
    };
    let home = std::env::var_os("LLMUP_STATE_PARITY_HOME").unwrap();
    let store = StateStore::new(Config::from_home(home).unwrap());
    if mode == "blocked" {
        assert_eq!(
            store.lock(Duration::from_millis(100)).err().unwrap().kind,
            "locked"
        );
    } else {
        assert_eq!(mode, "hold");
        let guard = store.lock(Duration::from_secs(1)).unwrap();
        println!("LOCKED");
        std::io::stdout().flush().unwrap();
        let mut release = String::new();
        std::io::stdin().lock().read_line(&mut release).unwrap();
        assert_eq!(release.trim(), "release");
        guard.release().unwrap();
    }
}

fn child(home: &std::path::Path, mode: &str) -> tokio::process::Command {
    let mut command = tokio::process::Command::new(std::env::current_exe().unwrap());
    command
        .args(["--exact", "state_lock_child", "--nocapture"])
        .env("LLMUP_STATE_PARITY_CHILD", mode)
        .env("LLMUP_STATE_PARITY_HOME", home)
        .env("PATH", "")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    command
}

#[tokio::test]
async fn native_processes_mutually_exclude_state_locks_without_node() {
    let home = tempfile::tempdir().unwrap();
    let store = StateStore::new(Config::from_home(home.path()).unwrap());
    let guard = store.lock(Duration::from_secs(1)).unwrap();
    store.write(&guard, &RuntimeState::default()).unwrap();
    let bytes = std::fs::read(&store.config.state).unwrap();
    let output = tokio::time::timeout(
        Duration::from_secs(5),
        child(home.path(), "blocked").output(),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(output.status.success(), "{output:?}");
    guard.release().unwrap();
    let mut holder = child(home.path(), "hold").spawn().unwrap();
    let mut lines = BufReader::new(holder.stdout.take().unwrap()).lines();
    tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(line) = lines.next_line().await.unwrap() {
            if line == "LOCKED" {
                return;
            }
        }
        panic!("child exited without acquiring lock");
    })
    .await
    .unwrap();
    assert_eq!(
        store.lock(Duration::from_millis(100)).err().unwrap().kind,
        "locked"
    );
    holder
        .stdin
        .take()
        .unwrap()
        .write_all(b"release\n")
        .await
        .unwrap();
    assert!(
        tokio::time::timeout(Duration::from_secs(5), holder.wait())
            .await
            .unwrap()
            .unwrap()
            .success()
    );
    store
        .lock(Duration::from_secs(1))
        .unwrap()
        .release()
        .unwrap();
    assert_eq!(std::fs::read(&store.config.state).unwrap(), bytes);
    assert!(!store.config.lock.exists());
}
