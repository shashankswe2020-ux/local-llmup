#[tokio::test]
async fn chat_preparation_bounds_history_and_preserves_explicit_system_prompt() {
    struct Inspect;
    #[async_trait::async_trait]
    impl ChatHarness for Inspect {
        fn name(&self) -> &'static str {
            "local"
        }
        async fn available(&self) -> bool {
            true
        }
        async fn chat(
            &self,
            input: &HarnessRequest,
            _: &CancellationToken,
            _: &mut DeltaSink<'_>,
        ) -> Result<String, HarnessError> {
            assert_eq!(input.messages.len(), 22);
            assert_eq!(input.messages[0].role, "system");
            assert_eq!(input.messages[0].content, "explicit\nprompt");
            assert_eq!(input.messages[1].content, "turn 5");
            assert_eq!(input.messages.last().unwrap().content, "latest");
            Ok("reply".into())
        }
    }
    let home = tempfile::tempdir().unwrap();
    let sessions = SessionRepository::new(home.path());
    let session = sessions.create("history", "now").unwrap();
    for index in 0..25 {
        sessions
            .append(
                &session.id,
                llmup_runtime::sessions::StoredMessage {
                    role: "user".into(),
                    content: format!("turn {index}"),
                    at: "now".into(),
                    attachments: None,
                },
                Some(index),
            )
            .unwrap();
    }
    let library = Library::new(home.path());
    let workspace = WorkspaceService::new();
    let mut disclosures = DisclosureStore::default();
    let service = ChatService {
        sessions: &sessions,
        library: &library,
        workspace: &workspace,
        disclosures: &mut disclosures,
    };
    let prepared = service
        .prepare_with_prompt(
            ChatOptions {
                session_id: &session.id,
                revision: 25,
                provider: "local",
                model: "test",
                message: "latest",
                context: &[],
                agent: None,
                skills: &[],
                temperature: None,
            },
            Some("explicit\nprompt"),
        )
        .unwrap();
    service
        .run(
            prepared,
            &Inspect,
            "now",
            None,
            &CancellationToken::new(),
            &mut |_| Ok(()),
        )
        .await
        .unwrap();
    assert_eq!(
        sessions.get(&session.id).unwrap().unwrap().messages.len(),
        27
    );
}
#[tokio::test]
async fn concurrent_turn_is_rejected_before_provider_and_cancellation_releases_run() {
    struct Waiting(tokio::sync::Notify);
    #[async_trait::async_trait]
    impl ChatHarness for Waiting {
        fn name(&self) -> &'static str {
            "local"
        }
        async fn available(&self) -> bool {
            true
        }
        async fn chat(
            &self,
            _: &HarnessRequest,
            cancel: &CancellationToken,
            _: &mut DeltaSink<'_>,
        ) -> Result<String, HarnessError> {
            self.0.notify_one();
            cancel.cancelled().await;
            Err(HarnessError::Cancelled)
        }
    }
    let home = tempfile::tempdir().unwrap();
    let sessions = SessionRepository::new(home.path());
    let session = sessions.create("", "now").unwrap();
    let library = Library::new(home.path());
    let workspace = WorkspaceService::new();
    let mut disclosures = DisclosureStore::default();
    let service = ChatService {
        sessions: &sessions,
        library: &library,
        workspace: &workspace,
        disclosures: &mut disclosures,
    };
    let options = || ChatOptions {
        session_id: &session.id,
        revision: 0,
        provider: "local",
        model: "test",
        message: "question",
        context: &[],
        agent: None,
        skills: &[],
        temperature: None,
    };
    let first = service.prepare(options()).unwrap();
    let second = service.prepare(options()).unwrap();
    let harness = Waiting(tokio::sync::Notify::new());
    let cancel = CancellationToken::new();
    let first_run = async {
        service
            .run(first, &harness, "now", None, &cancel, &mut |_| Ok(()))
            .await
    };
    let second_run = async {
        harness.0.notified().await;
        let result = service
            .run(second, &harness, "now", None, &cancel, &mut |_| Ok(()))
            .await;
        assert!(matches!(
            result,
            Err(ChatError::Session(
                llmup_runtime::sessions::SessionError::Conflict
            ))
        ));
        sessions.runs.cancel(&session.id, None).unwrap();
    };
    let (result, ()) = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        tokio::join!(first_run, second_run)
    })
    .await
    .unwrap();
    assert!(result.is_err());
    assert!(sessions.runs.active_id(&session.id).unwrap().is_none());
    assert!(
        sessions
            .get(&session.id)
            .unwrap()
            .unwrap()
            .messages
            .is_empty()
    );
}
#[tokio::test]
async fn completion_never_overwrites_concurrent_session_changes_or_cancelled_runs() {
    struct Mutating<'repo> {
        sessions: &'repo SessionRepository,
        id: &'repo str,
        cancel: bool,
    }
    #[async_trait::async_trait]
    impl ChatHarness for Mutating<'_> {
        fn name(&self) -> &'static str {
            "local"
        }
        async fn available(&self) -> bool {
            true
        }
        async fn chat(
            &self,
            _: &HarnessRequest,
            token: &CancellationToken,
            _: &mut DeltaSink<'_>,
        ) -> Result<String, HarnessError> {
            if self.cancel {
                token.cancel();
            } else {
                self.sessions
                    .rename(self.id, "concurrent change", Some(0), "now")
                    .unwrap();
            }
            Ok("stale reply".into())
        }
    }
    for cancelled in [false, true] {
        let home = tempfile::tempdir().unwrap();
        let sessions = SessionRepository::new(home.path());
        let session = sessions.create("", "now").unwrap();
        let library = Library::new(home.path());
        let workspace = WorkspaceService::new();
        let mut disclosures = DisclosureStore::default();
        let service = ChatService {
            sessions: &sessions,
            library: &library,
            workspace: &workspace,
            disclosures: &mut disclosures,
        };
        let prepared = service
            .prepare(ChatOptions {
                session_id: &session.id,
                revision: 0,
                provider: "local",
                model: "test",
                message: "question",
                context: &[],
                agent: None,
                skills: &[],
                temperature: None,
            })
            .unwrap();
        let harness = Mutating {
            sessions: &sessions,
            id: &session.id,
            cancel: cancelled,
        };
        assert!(
            service
                .run(
                    prepared,
                    &harness,
                    "now",
                    None,
                    &CancellationToken::new(),
                    &mut |_| Ok(())
                )
                .await
                .is_err()
        );
        let after = sessions.get(&session.id).unwrap().unwrap();
        assert!(after.messages.is_empty());
        assert_eq!(after.revision, if cancelled { 0 } else { 1 });
    }
}
use llmup_runtime::{
    chat_service::{ChatError, ChatOptions, ChatService},
    context::{ContextRef, DisclosureStore},
    harness::{ChatHarness, DeltaSink, HarnessError, HarnessRequest},
    library::Library,
    sessions::SessionRepository,
    workspace::WorkspaceService,
};
use tokio_util::sync::CancellationToken;
struct Fake;
#[async_trait::async_trait]
impl ChatHarness for Fake {
    fn name(&self) -> &'static str {
        "openai"
    }
    async fn available(&self) -> bool {
        true
    }
    async fn chat(
        &self,
        input: &HarnessRequest,
        _: &CancellationToken,
        sink: &mut DeltaSink<'_>,
    ) -> Result<String, HarnessError> {
        assert!(
            input
                .messages
                .iter()
                .any(|message| message.content.contains("reviewed file"))
        );
        sink("answer")?;
        Ok("answer".into())
    }
}
#[tokio::test]
async fn composed_chat_requires_disclosure_and_commits_one_exchange() {
    let home = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("note.txt"), "reviewed file").unwrap();
    let sessions = SessionRepository::new(home.path());
    let session = sessions.create("", "now").unwrap();
    let library = Library::new(home.path());
    let mut workspace = WorkspaceService::new();
    let capability = workspace.register(root.path()).unwrap();
    let context = [ContextRef::File {
        workspace_id: capability.id,
        path: "note.txt".into(),
        range: None,
    }];
    let mut disclosures = DisclosureStore::default();
    let mut service = ChatService {
        sessions: &sessions,
        library: &library,
        workspace: &workspace,
        disclosures: &mut disclosures,
    };
    let options = || ChatOptions {
        session_id: &session.id,
        revision: 0,
        provider: "openai",
        model: "test",
        message: "question",
        context: &context,
        agent: None,
        skills: &[],
        temperature: None,
    };
    let pending = service.prepare(options()).unwrap();
    let result = service
        .run(
            pending,
            &Fake,
            "now",
            None,
            &CancellationToken::new(),
            &mut |_| Ok(()),
        )
        .await;
    assert!(matches!(result, Err(ChatError::Disclosure)));
    let prepared = service.prepare(options()).unwrap();
    service.approve_disclosure(&prepared);
    std::fs::write(root.path().join("note.txt"), "changed after approval").unwrap();
    let result = service
        .run(
            prepared,
            &Fake,
            "now",
            None,
            &CancellationToken::new(),
            &mut |_| Ok(()),
        )
        .await
        .unwrap();
    assert_eq!(result.session.revision, 1);
    assert_eq!(result.session.messages.len(), 2);
    assert_eq!(
        result.session.messages[0]
            .attachments
            .as_ref()
            .unwrap()
            .len(),
        1
    );
    assert!(service.prepare(options()).is_err());
}
