#[test]
fn session_search_snippet_includes_a_late_match() {
    let home = tempfile::tempdir().unwrap();
    let sessions = SessionRepository::new(home.path());
    let session = sessions.create("named session", "now").unwrap();
    sessions
        .append(
            &session.id,
            StoredMessage {
                role: "user".into(),
                content: format!("{}needle{}", "x".repeat(120), "z".repeat(120)),
                at: "now".into(),
                attachments: None,
            },
            Some(0),
        )
        .unwrap();
    let found = sessions.search("needle", false).unwrap();
    assert_eq!(
        found[0].1,
        format!("{}needle{}", "x".repeat(24), "z".repeat(50))
    );
}
#[cfg(unix)]
#[test]
fn session_reads_reject_symlinked_home() {
    use llmup_runtime::sessions::SessionRepository;
    let root = tempfile::tempdir().unwrap();
    let links = tempfile::tempdir().unwrap();
    let session = SessionRepository::new(root.path())
        .create("private", "now")
        .unwrap();
    let alias = links.path().join("home");
    std::os::unix::fs::symlink(root.path(), &alias).unwrap();
    assert!(SessionRepository::new(&alias).get(&session.id).is_err());
}
#[test]
fn library_partial_update_preserves_unmentioned_fields() {
    use llmup_runtime::library::{Kind, Library, LibraryItem, LibraryUpdate};
    let root = tempfile::tempdir().unwrap();
    let library = Library::new(root.path());
    let original = library
        .create(
            Kind::Agent,
            LibraryItem {
                id: String::new(),
                name: "Builder".into(),
                description: "description".into(),
                enabled: true,
                body: "instructions".into(),
                skills: Vec::new(),
            },
        )
        .unwrap();
    let updated = library
        .update(
            Kind::Agent,
            &original.id,
            LibraryUpdate {
                enabled: Some(false),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(updated.body, original.body);
    assert_eq!(updated.description, original.description);
    assert!(!updated.enabled);
    assert_eq!(library.compose(Some(&original.id), &[]).unwrap(), None);
}
#[test]
fn exchange_is_atomic_and_revision_checked() {
    use llmup_runtime::sessions::{SessionRepository, StoredMessage};
    let root = tempfile::tempdir().unwrap();
    let repository = SessionRepository::new(root.path());
    let session = repository.create("", "now").unwrap();
    let message = |role: &str, content: &str| StoredMessage {
        role: role.into(),
        content: content.into(),
        at: "now".into(),
        attachments: None,
    };
    let updated = repository
        .append_exchange(
            &session.id,
            message("user", "question"),
            message("assistant", "answer"),
            0,
        )
        .unwrap();
    assert_eq!(updated.revision, 1);
    assert_eq!(updated.messages.len(), 2);
    assert!(
        repository
            .append_exchange(
                &session.id,
                message("user", "stale"),
                message("assistant", "stale"),
                0
            )
            .is_err()
    );
    assert_eq!(
        repository.get(&session.id).unwrap().unwrap().messages.len(),
        2
    );
}
use llmup_runtime::{
    library::{Kind, Library, LibraryItem},
    sessions::{SessionRepository, StoredMessage},
};
#[test]
fn sessions_enforce_revisions_and_persist_no_active_run_state() {
    let root = tempfile::tempdir().unwrap();
    let repository = SessionRepository::new(root.path());
    let session = repository.create("", "2026-09-17T00:00:00Z").unwrap();
    let message = StoredMessage {
        role: "user".into(),
        content: "Hello\nworld".into(),
        at: "2026-09-17T00:00:01Z".into(),
        attachments: None,
    };
    let updated = repository
        .append(&session.id, message.clone(), Some(0))
        .unwrap();
    assert_eq!(updated.revision, 1);
    assert_eq!(updated.messages[0].content, "Hello\nworld");
    assert!(repository.append(&session.id, message, Some(0)).is_err());
    assert_eq!(
        repository.get(&session.id).unwrap().unwrap().messages.len(),
        1
    );
    repository
        .archive(&session.id, true, Some(1), "2026-09-17T00:00:02Z")
        .unwrap();
    assert!(repository.list(false, 0, 50).unwrap().0.is_empty());
    assert_eq!(repository.list(true, 0, 50).unwrap().0.len(), 1);
}
#[test]
fn library_roundtrips_frontmatter_and_composes_enabled_skills_in_order() {
    let root = tempfile::tempdir().unwrap();
    let library = Library::new(root.path());
    let skill = LibraryItem {
        id: "rust".into(),
        name: "Rust".into(),
        description: String::new(),
        enabled: true,
        body: "Use checked arithmetic.".into(),
        skills: Vec::new(),
    };
    library.write(Kind::Skill, &skill).unwrap();
    let agent = LibraryItem {
        id: "engineer".into(),
        name: "Engineer".into(),
        description: "A persona".into(),
        enabled: true,
        body: "Build carefully.".into(),
        skills: vec!["rust".into()],
    };
    library.write(Kind::Agent, &agent).unwrap();
    assert_eq!(
        library.get(Kind::Agent, "engineer").unwrap().unwrap(),
        agent
    );
    assert_eq!(
        library
            .compose(Some("engineer"), &["rust".into()])
            .unwrap()
            .unwrap(),
        "Build carefully.\n\n# Skills\nApply these skills when relevant:\n\n## Rust\nUse checked arithmetic."
    );
    assert!(root.path().join("skills/rust/SKILL.md").exists());
    assert!(root.path().join("agents/engineer.md").exists());
}
