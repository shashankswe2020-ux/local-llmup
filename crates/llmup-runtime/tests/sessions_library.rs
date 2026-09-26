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
fn message(role: &str, content: &str) -> StoredMessage {
    StoredMessage {
        role: role.into(),
        content: content.into(),
        at: "2026-09-24T00:00:00Z".into(),
        attachments: None,
    }
}
#[test]
fn appended_text_keeps_line_structure_and_derives_the_title_once() {
    let root = tempfile::tempdir().unwrap();
    let repository = SessionRepository::new(root.path());
    let session = repository.create("", "2026-09-24T00:00:00Z").unwrap();
    assert_eq!(
        (
            session.title.as_str(),
            session.revision,
            session.messages.len()
        ),
        ("New chat", 0, 0)
    );
    let updated = repository
        .append(
            &session.id,
            message(
                "user",
                "## Result\r\n\r\n```ts\rconst x = 1;\r```\t\u{0}\u{1b}[31m\u{202e}",
            ),
            Some(0),
        )
        .unwrap();
    assert_eq!(
        updated.messages[0].content,
        "## Result\n\n```ts\nconst x = 1;\n```\t"
    );
    let titled = repository.create("", "2026-09-24T00:00:00Z").unwrap();
    let first = repository
        .append(
            &titled.id,
            message("user", "How do I run this model?"),
            Some(0),
        )
        .unwrap();
    assert_eq!(
        (first.title.as_str(), first.revision),
        ("How do I run this model?", 1)
    );
    let later = repository
        .append(&titled.id, message("user", "second question"), Some(1))
        .unwrap();
    assert_eq!(later.title, "How do I run this model?");
}
#[test]
fn session_and_message_lists_page_with_cursors() {
    let root = tempfile::tempdir().unwrap();
    let repository = SessionRepository::new(root.path());
    for index in 0..5 {
        repository
            .create(&format!("s{index}"), &format!("2026-09-24T00:00:0{index}Z"))
            .unwrap();
    }
    let (first, next) = repository.list(false, 0, 2).unwrap();
    assert_eq!(first.len(), 2);
    assert_eq!(first[0].title, "s4");
    assert_eq!(next.as_deref(), Some("2"));
    let (_, next) = repository.list(false, 2, 2).unwrap();
    assert_eq!(next.as_deref(), Some("4"));
    let (last, next) = repository.list(false, 4, 2).unwrap();
    assert_eq!((last.len(), last[0].title.as_str(), next), (1, "s0", None));

    let session = repository
        .create("messages", "2026-09-24T00:00:09Z")
        .unwrap();
    for index in 0..30 {
        repository
            .append(&session.id, message("user", &format!("m{index}")), None)
            .unwrap();
    }
    let (page, next) = repository.messages(&session.id, 0, 2).unwrap();
    assert_eq!(
        (
            page[0].content.as_str(),
            page[1].content.as_str(),
            next.as_deref()
        ),
        ("m0", "m1", Some("2"))
    );
    let (all, next) = repository.messages(&session.id, 0, 500).unwrap();
    assert_eq!((all.len(), next), (30, None));
}
#[test]
fn malformed_ids_and_corrupt_or_foreign_session_files_fail_closed() {
    let root = tempfile::tempdir().unwrap();
    let repository = SessionRepository::new(root.path());
    let kept = repository.create("kept", "2026-09-24T00:00:00Z").unwrap();
    for id in [
        "../../etc/passwd",
        "..%2f..%2fsecret",
        "",
        &kept.id.to_uppercase(),
    ] {
        assert!(repository.get(id).is_err(), "{id}");
        assert!(repository.messages(id, 0, 10).is_err(), "{id}");
    }
    let directory = root.path().join("gui-sessions");
    let corrupt = uuid::Uuid::new_v4().to_string();
    std::fs::write(directory.join(format!("{corrupt}.json")), "{not json").unwrap();
    let foreign = repository
        .create("foreign", "2026-09-24T00:00:01Z")
        .unwrap();
    let path = directory.join(format!("{}.json", foreign.id));
    let raw = std::fs::read_to_string(&path).unwrap();
    std::fs::write(
        &path,
        raw.replace("\"schemaVersion\": 1", "\"schemaVersion\": 99"),
    )
    .unwrap();
    assert!(repository.get(&corrupt).is_err());
    assert!(repository.get(&foreign.id).is_err());
    let listed = repository.list(false, 0, 50).unwrap().0;
    assert_eq!(
        listed
            .iter()
            .map(|session| session.id.as_str())
            .collect::<Vec<_>>(),
        [kept.id.as_str()]
    );
    repository.remove(&kept.id).unwrap();
    repository.remove(&kept.id).unwrap();
    assert!(repository.get(&kept.id).unwrap().is_none());
}
#[cfg(unix)]
#[test]
fn symlinked_session_files_are_not_followed() {
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let repository = SessionRepository::new(root.path());
    let session = repository.create("linked", "2026-09-24T00:00:00Z").unwrap();
    let path = root
        .path()
        .join("gui-sessions")
        .join(format!("{}.json", session.id));
    let target = outside.path().join("session.json");
    std::fs::rename(&path, &target).unwrap();
    std::os::unix::fs::symlink(&target, &path).unwrap();
    assert!(repository.get(&session.id).is_err());
    assert!(repository.list(false, 0, 50).unwrap().0.is_empty());
}
