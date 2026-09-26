#[path = "../../llmup-runtime/examples/workflow_bridge.rs"]
mod bridge;

use llmup_runtime::memory::MemoryStore;
use serde_json::{Value, json};
use std::{
    fs,
    path::Path,
    process::Stdio,
    time::{Duration, UNIX_EPOCH},
};

fn relocate(value: &mut Value, home: &Path, workspace: &Path) {
    match value {
        Value::String(text) => {
            *text = text
                .replace("<HOME>", home.to_str().unwrap())
                .replace("<WORKSPACE>", workspace.to_str().unwrap());
        }
        Value::Array(values) => values
            .iter_mut()
            .for_each(|value| relocate(value, home, workspace)),
        Value::Object(values) => values
            .values_mut()
            .for_each(|value| relocate(value, home, workspace)),
        _ => {}
    }
}

fn restore(root: &Path, files: &Value) {
    for file in files.as_array().unwrap() {
        let relative = Path::new(file["path"].as_str().unwrap());
        assert!(
            relative
                .components()
                .all(|part| matches!(part, std::path::Component::Normal(_)))
        );
        let path = root.join(relative);
        // The TypeScript stores that produced this fixture always created directories 0700.
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(path.parent().unwrap()).unwrap();
        fs::write(&path, file["text"].as_str().unwrap()).unwrap();
        fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(
                UNIX_EPOCH + Duration::from_secs_f64(file["modifiedMs"].as_f64().unwrap() / 1000.0),
            )
            .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(
                &path,
                fs::Permissions::from_mode(file["mode"].as_u64().unwrap() as u32),
            )
            .unwrap();
        }
    }
}

fn fixture(home: &Path, workspace: &Path) -> Value {
    let mut fixture: Value =
        serde_json::from_str(include_str!("../fixtures/workflow-parity.json")).unwrap();
    relocate(&mut fixture, home, workspace);
    fixture
}

#[tokio::test]
async fn all_34_workflow_contracts_match_independent_typescript_storage() {
    let home = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let fixture = fixture(home.path(), workspace.path());
    restore(home.path(), &fixture["seedHome"]);
    restore(workspace.path(), &fixture["seedWorkspace"]);
    let requests = fixture["requests"].as_array().unwrap();
    assert_eq!(requests.len(), 34);
    let expected = fixture["expected"].as_array().unwrap();
    assert_eq!(expected.len(), requests.len());
    for (request, expected) in requests.iter().zip(expected) {
        let actual = bridge::evaluate(&json!([request]).to_string())
            .await
            .unwrap();
        if cfg!(windows) && request["op"] == "slug" && request["id"] == "CON.json" {
            assert_eq!(expected, "con.json");
            assert_eq!(actual[0], "x-con.json");
        } else {
            assert_eq!(&actual[0], expected, "{request}");
        }
    }
    bridge::evaluate(
        &json!([{
            "op": "capture", "home": home.path(), "model": "bridge:model",
            "user": "I prefer Rust.", "assistant": "Recorded."
        }])
        .to_string(),
    )
    .await
    .unwrap();
    let source = MemoryStore::existing(home.path(), "bridge:model")
        .unwrap()
        .load()
        .unwrap();
    assert_eq!(
        serde_json::to_value(source).unwrap(),
        fixture["afterNative"]
    );
}

#[tokio::test]
async fn native_cli_migration_preserves_typescript_memory_for_dry_run_copy_and_move() {
    let home = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let fixture = fixture(home.path(), workspace.path());
    restore(home.path(), &fixture["migrationHome"]);
    assert!(home.path().join("memory/bridge-model").is_dir());
    let source = MemoryStore::existing(home.path(), "bridge:model").unwrap();
    assert_eq!(
        serde_json::to_value(source.load().unwrap()).unwrap(),
        fixture["beforeMigration"]
    );
    for (target, flags) in [
        ("dry-target", vec!["--dry-run"]),
        ("copy-target", vec![]),
        ("move-target", vec!["--move", "--yes"]),
    ] {
        let mut command = tokio::process::Command::new(env!("CARGO_BIN_EXE_llmup"));
        let output = tokio::time::timeout(
            Duration::from_secs(15),
            command
                .args([
                    "migrate",
                    "--from",
                    "bridge:model",
                    "--to",
                    target,
                    "--context",
                    "8192",
                ])
                .args(flags)
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
        if target == "dry-target" {
            assert!(!home.path().join("memory/dry-target").exists());
        } else {
            let migrated = MemoryStore::existing(home.path(), target)
                .unwrap()
                .load()
                .unwrap();
            assert_eq!(
                serde_json::to_value(migrated).unwrap(),
                fixture["beforeMigration"]
            );
        }
        if target != "move-target" {
            assert_eq!(
                serde_json::to_value(source.load().unwrap()).unwrap(),
                fixture["beforeMigration"]
            );
        }
    }
    assert!(!home.path().join("memory/bridge-model").exists());
}

#[tokio::test]
async fn bridge_rejects_unbounded_and_unknown_requests() {
    assert!(
        bridge::evaluate(&" ".repeat(8 * 1024 * 1024 + 1))
            .await
            .is_err()
    );
    assert!(
        bridge::evaluate(&json!(vec![json!({"op":"slug","id":"demo"}); 4097]).to_string())
            .await
            .is_err()
    );
    assert!(bridge::evaluate(r#"[{"op":"unknown"}]"#).await.is_err());
}

#[tokio::test]
async fn migration_rejects_alias_collisions_missing_sources_and_unknown_context() {
    for args in [
        vec!["--from", "same", "--to", "same", "--context", "8192"],
        vec![
            "--from",
            "same:model",
            "--to",
            "same-model",
            "--context",
            "8192",
        ],
        vec!["--from", "absent", "--to", "other", "--context", "8192"],
        vec!["--from", "absent", "--to", "not-in-catalog"],
    ] {
        let home = tempfile::tempdir().unwrap();
        let mut command = tokio::process::Command::new(env!("CARGO_BIN_EXE_llmup"));
        let output = tokio::time::timeout(
            Duration::from_secs(5),
            command
                .arg("migrate")
                .args(args)
                .env("LOCAL_LLMUP_HOME", home.path())
                .env("PATH", "")
                .stdin(Stdio::null())
                .kill_on_drop(true)
                .output(),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
        assert!(!home.path().join("memory").exists());
        assert!(!home.path().join("lock").exists());
    }
}
