use llmup_runtime::library::{Kind, Library, LibraryItem, LibraryUpdate, compose, parse_document};

fn item(name: &str, body: &str) -> LibraryItem {
    LibraryItem {
        id: String::new(),
        name: name.into(),
        description: String::new(),
        enabled: true,
        body: body.into(),
        skills: Vec::new(),
    }
}

#[test]
fn frontmatter_parsing_is_fail_soft_and_unwraps_quoted_values() {
    let (fields, body) = parse_document(
        "---\nname: Reviewer\ndescription: \"Checks: correctness\"\n---\n\nBody text\n",
    );
    assert_eq!(fields["name"], "Reviewer");
    assert_eq!(fields["description"], "Checks: correctness");
    assert_eq!(body, "Body text");
    let (fields, body) = parse_document("Just a body\nwith lines");
    assert!(fields.is_empty());
    assert_eq!(body, "Just a body\nwith lines");
    let unterminated = "---\nname: Broken\nno closing fence";
    let (fields, body) = parse_document(unterminated);
    assert!(fields.is_empty());
    assert_eq!(body, unterminated);
    let (fields, _) = parse_document("\u{feff}---\nname: 'single: quoted'\n---\n");
    assert_eq!(fields["name"], "single: quoted");
}

#[test]
fn documents_round_trip_including_values_that_need_quoting() {
    let home = tempfile::tempdir().unwrap();
    let library = Library::new(home.path());
    let mut agent = item(
        "Reviewer: \"strict\" \\ mode",
        "Review carefully.\n\nTwice.",
    );
    agent.id = "reviewer".into();
    agent.description = "Has: colons".into();
    agent.enabled = false;
    agent.skills = vec!["rust".into(), "tests".into()];
    library.write(Kind::Agent, &agent).unwrap();
    assert_eq!(
        library.get(Kind::Agent, "reviewer").unwrap().unwrap(),
        agent
    );
    let raw = std::fs::read_to_string(home.path().join("agents/reviewer.md")).unwrap();
    assert!(raw.starts_with("---\nname: \""), "{raw}");
    let (fields, body) = parse_document(&raw);
    assert_eq!(fields["enabled"], "false");
    assert_eq!(body, agent.body);
}

#[test]
fn stores_list_sorted_items_and_skip_unsafe_or_foreign_entries() {
    let home = tempfile::tempdir().unwrap();
    let library = Library::new(home.path());
    assert!(library.list(Kind::Agent).unwrap().is_empty());
    assert_eq!(library.get(Kind::Agent, "absent").unwrap(), None);
    for name in ["Zeta", "Alpha"] {
        library.create(Kind::Agent, item(name, "body")).unwrap();
    }
    library
        .create(Kind::Skill, item("Rust", "Use checked arithmetic."))
        .unwrap();
    assert!(home.path().join("skills/rust/SKILL.md").is_file());
    std::fs::write(home.path().join("agents/notes.txt"), "ignored").unwrap();
    std::fs::write(
        home.path().join("agents/external.md"),
        "Plain body without frontmatter",
    )
    .unwrap();
    let writable = home.path().join("agents/writable.md");
    std::fs::write(&writable, "---\nname: Writable\n---\nbody").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&writable, std::fs::Permissions::from_mode(0o664)).unwrap();
    }
    let ids: Vec<_> = library
        .list(Kind::Agent)
        .unwrap()
        .into_iter()
        .map(|item| item.id)
        .collect();
    assert_eq!(ids, ["alpha", "external", "zeta"]);
    let external = library.get(Kind::Agent, "external").unwrap().unwrap();
    assert_eq!(
        (
            external.name.as_str(),
            external.body.as_str(),
            external.enabled
        ),
        ("external", "Plain body without frontmatter", true)
    );
    for invalid in ["../escape", "Upper", "-lead", ""] {
        assert!(library.get(Kind::Agent, invalid).is_err(), "{invalid:?}");
    }
}

#[test]
fn creation_slugs_names_disambiguates_and_removal_deletes_files_and_skill_directories() {
    let home = tempfile::tempdir().unwrap();
    let library = Library::new(home.path());
    let first = library
        .create(Kind::Agent, item("Code Reviewer!", "one"))
        .unwrap();
    let second = library
        .create(Kind::Agent, item("Code Reviewer!", "two"))
        .unwrap();
    assert_eq!(
        (first.id.as_str(), second.id.as_str()),
        ("code-reviewer", "code-reviewer-2")
    );
    let skill = library.create(Kind::Skill, item("Rust", "body")).unwrap();
    library.remove(Kind::Agent, &first.id).unwrap();
    library.remove(Kind::Skill, &skill.id).unwrap();
    assert!(!home.path().join("agents/code-reviewer.md").exists());
    assert!(!home.path().join("skills/rust").exists());
    assert!(library.remove(Kind::Agent, &first.id).is_err());
    assert!(
        library
            .update(Kind::Agent, "missing", LibraryUpdate::default())
            .is_err()
    );
}

#[test]
fn composition_uses_enabled_items_and_includes_agent_skills_once() {
    assert_eq!(compose(None, &[]), None);
    let mut blank = item("Blank", "   ");
    blank.id = "blank".into();
    assert_eq!(compose(Some(&blank), &[]), None);
    let home = tempfile::tempdir().unwrap();
    let library = Library::new(home.path());
    let rust = library
        .create(Kind::Skill, item("Rust", "Use checked arithmetic."))
        .unwrap();
    let tests = library
        .create(Kind::Skill, item("Tests", "Write tests first."))
        .unwrap();
    let mut disabled = item("Hidden", "Never included.");
    disabled.enabled = false;
    let hidden = library.create(Kind::Skill, disabled).unwrap();
    let mut persona = item("Engineer", "Build carefully.");
    persona.skills = vec![rust.id.clone()];
    let agent = library.create(Kind::Agent, persona).unwrap();
    assert_eq!(
        library
            .compose(None, std::slice::from_ref(&rust.id))
            .unwrap()
            .unwrap(),
        "# Skills\nApply these skills when relevant:\n\n## Rust\nUse checked arithmetic."
    );
    let composed = library
        .compose(
            Some(&agent.id),
            &[rust.id.clone(), tests.id.clone(), hidden.id.clone()],
        )
        .unwrap()
        .unwrap();
    assert_eq!(
        composed,
        "Build carefully.\n\n# Skills\nApply these skills when relevant:\n\n## Rust\nUse checked arithmetic.\n\n## Tests\nWrite tests first."
    );
    library
        .update(
            Kind::Agent,
            &agent.id,
            LibraryUpdate {
                enabled: Some(false),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(
        library
            .compose(Some(&agent.id), std::slice::from_ref(&tests.id))
            .unwrap()
            .unwrap(),
        "# Skills\nApply these skills when relevant:\n\n## Tests\nWrite tests first."
    );
}
