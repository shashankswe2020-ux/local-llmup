#[test]
fn artifact_percent_encoding_accepts_only_a_decoded_basename() {
    use llmup_runtime::context::read_artifact;
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("chart.png"), [1, 2, 3]).unwrap();
    assert_eq!(
        read_artifact(root.path(), "%63hart.png").unwrap().content,
        vec![1, 2, 3]
    );
    for name in [
        "%2e%2e%2fchart.png",
        "%2fchart.png",
        "%ff.png",
        "%xy.png",
        "chart.png%00",
    ] {
        assert!(read_artifact(root.path(), name).is_err());
    }
}
use llmup_runtime::{
    context::{ContextBundle, ContextRef, DisclosureStore, read_artifact},
    workspace::WorkspaceService,
};
#[test]
fn context_disclosure_binds_provider_session_and_exact_content() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("file.txt"), "first\nsecond\n").unwrap();
    let mut workspace = WorkspaceService::new();
    let capability = workspace.register(root.path()).unwrap();
    let refs = vec![
        ContextRef::File {
            workspace_id: capability.id.clone(),
            path: "file.txt".into(),
            range: None,
        },
        ContextRef::Terminal {
            label: None,
            content: "echo never executed".into(),
        },
    ];
    let bundle = ContextBundle::resolve(&workspace, &refs).unwrap();
    assert_eq!(bundle.manifest.len(), 2);
    assert!(bundle.text.contains("FILE: file.txt"));
    let mut disclosure = DisclosureStore::default();
    assert!(!disclosure.allowed("session", "openai", &bundle));
    disclosure.approve("session", "openai", &bundle);
    assert!(disclosure.allowed("session", "openai", &bundle));
    assert!(!disclosure.allowed("other", "openai", &bundle));
    std::fs::write(root.path().join("file.txt"), "changed").unwrap();
    assert!(!disclosure.allowed(
        "session",
        "openai",
        &ContextBundle::resolve(&workspace, &refs).unwrap()
    ));
}
#[test]
fn artifacts_are_bounded_images_and_never_follow_symlinks() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("plot.png"), [137, 80, 78, 71]).unwrap();
    let artifact = read_artifact(root.path(), "plot.png").unwrap();
    assert_eq!(artifact.content_type, "image/png");
    for name in [
        "../plot.png",
        "%2e%2e%2fplot.png",
        ".hidden.png",
        "script.html",
    ] {
        assert!(read_artifact(root.path(), name).is_err());
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(root.path().join("plot.png"), root.path().join("link.png"))
            .unwrap();
        assert!(read_artifact(root.path(), "link.png").is_err());
    }
}
