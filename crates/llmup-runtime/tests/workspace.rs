#[test]
fn search_matches_trimmed_query_and_existing_wire_shape() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("note.txt"), "data").unwrap();
    let mut workspace = WorkspaceService::new();
    let capability = workspace.register(root.path()).unwrap();
    let result = serde_json::to_value(
        workspace
            .search(&capability.id, " NOTE ", 10, None)
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        result,
        serde_json::json!({"results":[{"name":"note.txt","path":"note.txt","size":4}],"nextCursor":null,"scanTruncated":false})
    );
}
#[test]
fn recovery_preserves_user_edits_and_requires_the_recorded_root() {
    let root = tempfile::tempdir().unwrap();
    let other = tempfile::tempdir().unwrap();
    let records = tempfile::tempdir().unwrap();
    for name in ["first.txt", "second.txt"] {
        std::fs::write(root.path().join(name), "before").unwrap();
    }
    let mut workspace = WorkspaceService::new();
    let capability = workspace.register(root.path()).unwrap();
    let operations:Vec<_>=["first.txt","second.txt"].map(|path|json!({"op":"update","path":path,"baseHash":workspace.read(&capability.id,path,None).unwrap().hash,"hunks":[{"start":1,"end":1,"lines":["after"]}]})).into();
    let proposal =
        serde_json::from_value(json!({"workspaceId":capability.id,"operations":operations}))
            .unwrap();
    let review = workspace.review(&proposal).unwrap();
    let result = workspace.apply_with(review, records.path(), "now", |index| {
        if index == 1 {
            std::fs::write(root.path().join("first.txt"), "user changes")?;
            return Err(llmup_runtime::workspace::WorkspaceError(
                "injected failure".into(),
            ));
        }
        Ok(())
    });
    assert!(result.is_err());
    let mut restarted = WorkspaceService::new();
    let wrong = restarted.register(other.path()).unwrap();
    assert!(
        restarted
            .recover(&wrong.id, records.path())
            .unwrap()
            .is_empty()
    );
    let authorized = restarted.register(root.path()).unwrap();
    let recovered = restarted.recover(&authorized.id, records.path()).unwrap();
    assert_eq!(recovered[0].skipped, vec!["first.txt"]);
    assert_eq!(
        std::fs::read_to_string(root.path().join("first.txt")).unwrap(),
        "user changes"
    );
    assert!(std::fs::read_dir(records.path()).unwrap().any(|entry| {
        entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".pending.json")
    }));
}
#[test]
fn git_context_uses_injected_runner_and_validates_mode() {
    use llmup_runtime::workspace_git::{GitOutput, GitRunner};
    struct FakeGit;
    impl GitRunner for FakeGit {
        fn output(
            &self,
            _: &std::path::Path,
            mode: &str,
        ) -> Result<GitOutput, llmup_runtime::workspace::WorkspaceError> {
            assert_eq!(mode, "status");
            Ok(GitOutput {
                success: true,
                bytes: b" M file.txt\n".to_vec(),
            })
        }
    }
    let root = tempfile::tempdir().unwrap();
    let mut workspace = WorkspaceService::new();
    let capability = workspace.register(root.path()).unwrap();
    let snapshot = workspace
        .git_context_with(&capability.id, "status", &FakeGit)
        .unwrap();
    assert_eq!(snapshot["content"], " M file.txt\n");
    assert_eq!(snapshot["available"], true);
    assert!(
        workspace
            .git_context_with(&capability.id, "--exec", &FakeGit)
            .is_err()
    );
}
#[test]
fn review_serializes_diff_contract_without_internal_write_bytes() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("file.txt"), "before\ncontext").unwrap();
    let mut workspace = WorkspaceService::new();
    let capability = workspace.register(root.path()).unwrap();
    let base = workspace.read(&capability.id, "file.txt", None).unwrap();
    let proposal: EditProposal = serde_json::from_value(json!({"workspaceId":capability.id,"operations":[{"op":"update","path":"file.txt","baseHash":base.hash,"hunks":[{"start":1,"end":1,"lines":["after"]}]}]})).unwrap();
    let review = serde_json::to_value(workspace.review(&proposal).unwrap()).unwrap();
    let file = &review["files"][0];
    assert_eq!(file["added"], 1);
    assert_eq!(file["removed"], 1);
    assert_eq!(file["baseHash"], base.hash);
    assert_eq!(
        file["hunks"][0],
        json!({"header":"@@ -1,1 +1,1 @@","lines":[{"type":"del","text":"before"},{"type":"add","text":"after"},{"type":"context","text":"context"}]})
    );
    assert!(file.get("original").is_none());
    assert!(file.get("newText").is_none());
}
use llmup_runtime::workspace::{EditProposal, WorkspaceService};
use serde_json::json;
#[test]
fn pending_transaction_recovers_after_restart_without_overwriting_drift() {
    let root = tempfile::tempdir().unwrap();
    let records = tempfile::tempdir().unwrap();
    for name in ["first.txt", "second.txt"] {
        std::fs::write(root.path().join(name), "before").unwrap();
    }
    let mut workspace = WorkspaceService::new();
    let capability = workspace.register(root.path()).unwrap();
    let operations: Vec<_> = ["first.txt", "second.txt"].map(|path| json!({"op":"update","path":path,"baseHash":workspace.read(&capability.id,path,None).unwrap().hash,"hunks":[{"start":1,"end":1,"lines":["after"]}]})).into();
    let proposal =
        serde_json::from_value(json!({"workspaceId":capability.id,"operations":operations}))
            .unwrap();
    let review = workspace.review(&proposal).unwrap();
    let interrupted = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        workspace.apply_with(review, records.path(), "now", |index| {
            if index == 1 {
                panic!("simulated interruption");
            }
            Ok(())
        })
    }));
    assert!(interrupted.is_err());
    assert_eq!(
        std::fs::read_to_string(root.path().join("first.txt")).unwrap(),
        "after"
    );
    let mut restarted = WorkspaceService::new();
    let authorized = restarted.register(root.path()).unwrap();
    let recovery = restarted.recover(&authorized.id, records.path()).unwrap();
    assert_eq!(recovery.len(), 1);
    assert!(recovery[0].skipped.is_empty());
    assert_eq!(
        std::fs::read_to_string(root.path().join("first.txt")).unwrap(),
        "before"
    );
    assert_eq!(
        std::fs::read_to_string(root.path().join("second.txt")).unwrap(),
        "before"
    );
}
#[test]
fn workspace_reads_require_capability_and_reject_secrets_traversal_and_symlinks() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("file.txt"), "hello\nworld\n").unwrap();
    std::fs::write(root.path().join(".env"), "secret").unwrap();
    let mut workspace = WorkspaceService::new();
    let capability = workspace.register(root.path()).unwrap();
    assert_eq!(
        workspace
            .read(&capability.id, "file.txt", None)
            .unwrap()
            .content,
        "hello\nworld\n"
    );
    for path in [
        "../file.txt",
        ".env",
        "/file.txt",
        ".git/config",
        "nested//file",
    ] {
        assert!(workspace.read(&capability.id, path, None).is_err());
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(root.path().join("file.txt"), root.path().join("linked"))
            .unwrap();
        assert!(workspace.read(&capability.id, "linked", None).is_err());
    }
    workspace.revoke(&capability.id);
    assert!(workspace.read(&capability.id, "file.txt", None).is_err());
}
#[test]
fn reviewed_edits_reject_drift_and_revert_never_overwrites_user_changes() {
    let root = tempfile::tempdir().unwrap();
    let records = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("file.txt"), "before\n").unwrap();
    let mut workspace = WorkspaceService::new();
    let capability = workspace.register(root.path()).unwrap();
    let snapshot = workspace.read(&capability.id, "file.txt", None).unwrap();
    let proposal:EditProposal=serde_json::from_value(json!({"workspaceId":capability.id,"operations":[{"op":"update","path":"file.txt","baseHash":snapshot.hash,"hunks":[{"start":1,"end":1,"lines":["after"]}]}]})).unwrap();
    let review = workspace.review(&proposal).unwrap();
    std::fs::write(root.path().join("file.txt"), "changed\n").unwrap();
    assert!(workspace.apply(review, records.path(), "now").is_err());
    assert_eq!(
        std::fs::read_to_string(root.path().join("file.txt")).unwrap(),
        "changed\n"
    );
    std::fs::write(root.path().join("file.txt"), "before\n").unwrap();
    let review = workspace.review(&proposal).unwrap();
    let result = workspace.apply(review, records.path(), "now").unwrap();
    assert_eq!(
        std::fs::read_to_string(root.path().join("file.txt")).unwrap(),
        "after\n"
    );
    std::fs::write(root.path().join("file.txt"), "user change\n").unwrap();
    let revert = workspace
        .revert(&result.application_id, records.path())
        .unwrap();
    assert_eq!(revert.skipped, vec!["file.txt"]);
    assert_eq!(
        std::fs::read_to_string(root.path().join("file.txt")).unwrap(),
        "user change\n"
    );
}
