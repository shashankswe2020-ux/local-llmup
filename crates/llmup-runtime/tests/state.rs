use llmup_runtime::state::{Config, RuntimeState, StateStore};
use serde_json::json;

#[test]
fn state_migrates_legacy_and_rejects_unsafe_runtime_identity() {
    let legacy = json!({"schemaVersion":1,"active":{"modelId":"test:latest","endpoint":"http://127.0.0.1:11434","port":11434,"ownedByUs":false,"pid":0}});
    let state = RuntimeState::parse(&legacy.to_string()).unwrap();
    assert_eq!(state.schema_version, 2);
    assert_eq!(state.active.unwrap().backend, "ollama");
    for bad in [
        json!({"schemaVersion":3,"active":null}),
        json!({"schemaVersion":2,"active":{"backend":"mlx","modelId":"test","endpoint":"http://127.0.0.1:8080","port":8080,"ownedByUs":false}}),
    ] {
        assert!(RuntimeState::parse(&bad.to_string()).is_err());
    }
}

#[test]
fn locked_atomic_updates_revalidate_state_and_preserve_permissions() {
    let home = tempfile::tempdir().unwrap();
    let store = StateStore::new(Config::from_home(home.path()).unwrap());
    let empty = store.read().unwrap();
    assert!(empty.active.is_none());
    let guard = store.lock(std::time::Duration::from_millis(20)).unwrap();
    store.write(&guard, &empty).unwrap();
    assert!(store.lock(std::time::Duration::from_millis(1)).is_err());
    assert_eq!(store.read().unwrap(), empty);
    guard.release().unwrap();
    assert!(!home.path().join("lock").exists());
}

#[test]
fn lock_release_refuses_replaced_ownership() {
    let home = tempfile::tempdir().unwrap();
    let store = StateStore::new(Config::from_home(home.path()).unwrap());
    let guard = store.lock(std::time::Duration::from_millis(20)).unwrap();
    std::fs::rename(home.path().join("lock"), home.path().join("old-lock")).unwrap();
    std::fs::write(home.path().join("lock"), b"123456\n").unwrap();
    assert!(guard.release().is_err());
    assert_eq!(
        std::fs::read_to_string(home.path().join("lock")).unwrap(),
        "123456\n"
    );
}

#[test]
fn config_reads_are_strict_bounded_and_allow_absent_or_blank_preferences() {
    let home = tempfile::tempdir().unwrap();
    let config = Config::from_home(home.path()).unwrap();
    let path = home.path().join("config.json");
    assert_eq!(config.user_backend().unwrap(), None);
    std::fs::write(&path, "   \n").unwrap();
    assert_eq!(config.user_backend().unwrap(), None);
    std::fs::write(&path, r#"{"schemaVersion":1,"defaultBackend":"mlx"}"#).unwrap();
    assert_eq!(config.user_backend().unwrap(), Some("mlx".into()));
    for raw in [
        r#"{"schemaVersion":2,"defaultBackend":"ollama"}"#.to_owned(),
        r#"{"schemaVersion":1,"defaultBackend":"other"}"#.to_owned(),
        r#"{"schemaVersion":1,"defaultBackend":"ollama","extra":true}"#.to_owned(),
        "x".repeat(4097),
    ] {
        std::fs::write(&path, raw).unwrap();
        assert!(config.user_backend().is_err());
    }
}

#[cfg(unix)]
#[test]
fn config_refuses_symlinks_and_writable_preferences() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let home = tempfile::tempdir().unwrap();
    let config = Config::from_home(home.path()).unwrap();
    let target = home.path().join("target");
    let path = home.path().join("config.json");
    std::fs::write(&target, r#"{"schemaVersion":1,"defaultBackend":"ollama"}"#).unwrap();
    symlink(&target, &path).unwrap();
    assert!(config.user_backend().is_err());
    std::fs::remove_file(&path).unwrap();
    std::fs::rename(&target, &path).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o666)).unwrap();
    assert!(config.user_backend().is_err());
}

#[test]
fn stale_locks_require_positive_death_and_valid_bounded_pid() {
    let home = tempfile::tempdir().unwrap();
    let store = StateStore::new(Config::from_home(home.path()).unwrap());
    let timeout = std::time::Duration::from_millis(10);
    for contents in [
        "",
        "garbage",
        "0",
        "-12",
        "4294967295",
        "1e3",
        "123\n456",
        "000123",
    ] {
        std::fs::write(&store.config.lock, contents).unwrap();
        assert!(
            store
                .lock_with(timeout, |_| panic!("invalid PID must not be probed"))
                .is_err()
        );
        assert_eq!(
            std::fs::read_to_string(&store.config.lock).unwrap(),
            contents
        );
    }
    std::fs::write(&store.config.lock, "12345\n").unwrap();
    assert!(store.lock_with(timeout, |_| true).is_err());
    let guard = store
        .lock_with(timeout, |pid| {
            assert_eq!(pid, 12345);
            false
        })
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(&store.config.lock).unwrap(),
        format!("{}\n", std::process::id())
    );
    guard.release().unwrap();
}

#[cfg(unix)]
#[test]
fn state_permissions_and_symlinked_lock_are_enforced() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let home = tempfile::tempdir().unwrap();
    let store = StateStore::new(Config::from_home(home.path()).unwrap());
    let guard = store.lock(std::time::Duration::from_millis(10)).unwrap();
    store.write(&guard, &RuntimeState::default()).unwrap();
    assert_eq!(
        std::fs::metadata(&store.config.state)
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    guard.release().unwrap();
    std::fs::set_permissions(&store.config.state, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert!(store.read().is_err());
    let target = home.path().join("target");
    std::fs::write(&target, "12345\n").unwrap();
    symlink(&target, &store.config.lock).unwrap();
    assert!(
        store
            .lock_with(std::time::Duration::from_millis(10), |_| panic!(
                "symlink must not be probed"
            ))
            .is_err()
    );
    assert!(
        std::fs::symlink_metadata(&store.config.lock)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert_eq!(std::fs::read_to_string(target).unwrap(), "12345\n");
}
