#[cfg(unix)]
#[test]
fn retained_memory_handle_refuses_replaced_home() {
    let parent = tempfile::tempdir().unwrap();
    let home = parent.path().join("home");
    let store = MemoryStore::open(&home, "model", "original").unwrap();
    std::fs::rename(&home, parent.path().join("original")).unwrap();
    let replacement = MemoryStore::open(&home, "model", "replacement").unwrap();
    assert!(store.load().is_err());
    assert_eq!(replacement.read_meta().unwrap().created_at, "replacement");
    assert_eq!(
        MemoryStore::existing(&parent.path().join("original"), "model")
            .unwrap()
            .meta
            .created_at,
        "original"
    );
}
#[tokio::test]
async fn prepared_migration_commits_exact_summary_once_and_rejects_later_drift() {
    use llmup_runtime::memory::{CaptureOptions, MemoryError, MigrationOptions, Summarizer, Turn};
    use std::sync::atomic::{AtomicUsize, Ordering};
    struct Summary(AtomicUsize);
    #[async_trait::async_trait]
    impl Summarizer for Summary {
        async fn summarize(
            &self,
            _: &[Turn],
            _: &tokio_util::sync::CancellationToken,
        ) -> Result<String, MemoryError> {
            Ok(format!("summary {}", self.0.fetch_add(1, Ordering::SeqCst)))
        }
    }
    let home = tempfile::tempdir().unwrap();
    let source = MemoryStore::open(home.path(), "source", "now").unwrap();
    let cancel = tokio_util::sync::CancellationToken::new();
    source
        .capture(
            &"history ".repeat(500),
            "reply",
            CaptureOptions {
                timestamp: "now",
                embedder: None,
                embedding_unsupported: false,
            },
            &cancel,
        )
        .await
        .unwrap();
    let summarizer = Summary(AtomicUsize::new(0));
    let options = || MigrationOptions {
        context: 300,
        embedder: None,
        target_dimension: None,
        summarizer: Some(&summarizer),
        embedding_unsupported: false,
    };
    let prepared = source
        .prepare_migration("target", options(), &cancel)
        .await
        .unwrap();
    assert_eq!(prepared.summary().strategy, "summarize");
    let target = source
        .commit_migration(prepared, "now", false, &cancel)
        .unwrap();
    assert_eq!(summarizer.0.load(Ordering::SeqCst), 1);
    assert!(
        target.load().unwrap().turns[0]
            .content
            .ends_with("summary 0")
    );
    let prepared = source
        .prepare_migration("target", options(), &cancel)
        .await
        .unwrap();
    target
        .capture(
            "concurrent",
            "reply",
            CaptureOptions {
                timestamp: "now",
                embedder: None,
                embedding_unsupported: false,
            },
            &cancel,
        )
        .await
        .unwrap();
    assert!(
        source
            .commit_migration(prepared, "now", false, &cancel)
            .is_err()
    );
    assert!(
        target
            .load()
            .unwrap()
            .turns
            .iter()
            .any(|turn| turn.content == "concurrent")
    );
}
#[test]
fn memory_scan_bounds_empty_directory_depth() {
    let root = tempfile::tempdir().unwrap();
    let store = MemoryStore::open(root.path(), "model", "now").unwrap();
    let mut nested = store.dir.clone();
    for _ in 0..42 {
        nested = nested.join("nested");
    }
    std::fs::create_dir_all(nested).unwrap();
    assert!(store.load().is_err());
}
#[test]
fn foreign_home_lock_cannot_authorize_metadata_write() {
    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();
    let first_store = MemoryStore::open(first.path(), "model", "now").unwrap();
    let second_store = MemoryStore::open(second.path(), "model", "now").unwrap();
    let guard = first_store.lock().unwrap();
    let mut meta = second_store.meta.clone();
    meta.embedding_unsupported = Some(true);
    assert!(second_store.write_meta(&guard, &meta).is_err());
    assert_eq!(
        second_store.read_meta().unwrap().embedding_unsupported,
        None
    );
}

struct EmbeddingFixture {
    model: &'static str,
    dimension: usize,
}
#[async_trait::async_trait]
impl llmup_runtime::memory::Embedder for EmbeddingFixture {
    fn model(&self) -> &str {
        self.model
    }
    async fn embed(
        &self,
        texts: &[String],
        _: &tokio_util::sync::CancellationToken,
    ) -> Result<llmup_runtime::memory::EmbeddingOutput, llmup_runtime::memory::MemoryError> {
        Ok(llmup_runtime::memory::EmbeddingOutput {
            dimension: self.dimension,
            vectors: texts.iter().map(|_| vec![0.5; self.dimension]).collect(),
        })
    }
}
#[tokio::test]
async fn embedding_capture_pins_space_and_migration_reembeds_exact_chunks() {
    use llmup_runtime::memory::{CaptureOptions, MigrationOptions};
    let root = tempfile::tempdir().unwrap();
    let source = MemoryStore::open(root.path(), "source", "now").unwrap();
    let first = EmbeddingFixture {
        model: "embed-first",
        dimension: 2,
    };
    let second = EmbeddingFixture {
        model: "embed-second",
        dimension: 3,
    };
    let cancel = tokio_util::sync::CancellationToken::new();
    let options = |embedder| CaptureOptions {
        timestamp: "now",
        embedder: Some(embedder),
        embedding_unsupported: false,
    };
    source
        .capture("question", "answer", options(&first), &cancel)
        .await
        .unwrap();
    let before = source.load().unwrap();
    assert!(
        source
            .capture("other", "reply", options(&second), &cancel)
            .await
            .is_err()
    );
    assert_eq!(source.load().unwrap(), before);
    let target = source
        .migrate(
            "target",
            "now",
            MigrationOptions {
                context: 8192,
                embedder: Some(&second),
                target_dimension: Some(3),
                summarizer: None,
                embedding_unsupported: false,
            },
            false,
            &cancel,
        )
        .await
        .unwrap();
    let migrated = target.load().unwrap().embedding.unwrap();
    assert_eq!(migrated.meta.model, "embed-second");
    assert_eq!(migrated.meta.dimension, 3);
    assert_eq!(migrated.chunks, before.embedding.unwrap().chunks);
    assert_eq!(migrated.vectors.len(), 2);
}
use llmup_runtime::memory::{MemoryStore, memory_slug};
#[test]
fn slugs_preserve_existing_layout_and_bound_long_names() {
    assert_eq!(
        memory_slug(" Owner/Model:Q4_K_M ", false).unwrap(),
        "owner-model-q4_k_m"
    );
    assert_eq!(memory_slug("../evil", false).unwrap(), "evil");
    assert_eq!(memory_slug("CON.json", true).unwrap(), "x-con.json");
    assert!(memory_slug("...///", false).is_err());
    let long = memory_slug(&"model".repeat(100), false).unwrap();
    assert_eq!(long.len(), 128);
}
#[test]
fn metadata_roundtrips_and_slug_collisions_never_replace_ownership() {
    let root = tempfile::tempdir().unwrap();
    let store = MemoryStore::open(root.path(), "owner/model", "2026-09-17T00:00:00Z").unwrap();
    assert_eq!(store.meta.model_id, "owner/model");
    assert_eq!(
        MemoryStore::open(root.path(), "owner/model", "ignored")
            .unwrap()
            .meta,
        store.meta
    );
    assert!(MemoryStore::open(root.path(), "owner:model", "2026-09-17T00:00:00Z").is_err());
    assert_eq!(store.read_meta().unwrap().model_id, "owner/model");
}

#[test]
fn opening_recovers_crash_between_publication_renames() {
    let root = tempfile::tempdir().unwrap();
    let store = MemoryStore::open(root.path(), "model", "original").unwrap();
    let transaction = root.path().join(".staging/memory-model");
    std::fs::create_dir_all(transaction.join("next")).unwrap();
    std::fs::rename(&store.dir, transaction.join("previous")).unwrap();
    std::fs::write(transaction.join("phase"), "prepared\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(
            transaction.join("phase"),
            std::fs::Permissions::from_mode(0o600),
        )
        .unwrap();
    }
    let reopened = MemoryStore::open(root.path(), "model", "replacement").unwrap();
    assert_eq!(reopened.meta.created_at, "original");
    assert!(!transaction.exists());
}

#[tokio::test]
async fn capture_preserves_layout_facts_and_embedding_failure_leaves_no_turns() {
    use llmup_runtime::memory::{CaptureOptions, Embedder, EmbeddingOutput};
    struct Broken;
    #[async_trait::async_trait]
    impl Embedder for Broken {
        fn model(&self) -> &str {
            "embedding"
        }
        async fn embed(
            &self,
            _texts: &[String],
            _cancel: &tokio_util::sync::CancellationToken,
        ) -> Result<EmbeddingOutput, llmup_runtime::memory::MemoryError> {
            Err(llmup_runtime::memory::MemoryError("offline".into()))
        }
    }
    let root = tempfile::tempdir().unwrap();
    let store = MemoryStore::open(root.path(), "test:latest", "2026-09-17T00:00:00Z").unwrap();
    let cancel = tokio_util::sync::CancellationToken::new();
    assert!(
        store
            .capture(
                "My name is Ada.",
                "Hello.",
                CaptureOptions {
                    timestamp: "2026-09-17T00:00:00Z",
                    embedder: Some(&Broken),
                    embedding_unsupported: false
                },
                &cancel
            )
            .await
            .is_err()
    );
    assert!(!store.dir.join("conversation.jsonl").exists());
    let result = store
        .capture(
            "My name is Ada. I prefer Rust.",
            "Hello.",
            CaptureOptions {
                timestamp: "2026-09-17T00:00:00Z",
                embedder: None,
                embedding_unsupported: true,
            },
            &cancel,
        )
        .await
        .unwrap();
    assert_eq!(result.turns_appended, 2);
    assert_eq!(result.facts_extracted, 2);
    let memory = store.load().unwrap();
    assert_eq!(memory.turns.len(), 2);
    assert!(memory.facts_text.contains("name = Ada"));
    assert_eq!(store.read_meta().unwrap().embedding_unsupported, Some(true));
}

#[tokio::test]
async fn migration_preserves_facts_persona_and_remaps_old_turns() {
    use llmup_runtime::memory::{MigrationOptions, SourceMemory, Turn, plan_migration};
    let source = SourceMemory {
        turns: vec![
            Turn {
                role: "user".into(),
                content: "old ".repeat(400),
                ts: "old".into(),
            },
            Turn {
                role: "assistant".into(),
                content: "recent".into(),
                ts: "new".into(),
            },
        ],
        system_prompt: Some("persona".into()),
        facts_text: "{ \"schemaVersion\": 1, \"facts\": [] }\n".into(),
        facts_present: true,
        embedding: None,
    };
    let plan = plan_migration(
        &source,
        MigrationOptions {
            context: 300,
            embedder: None,
            target_dimension: None,
            summarizer: None,
            embedding_unsupported: false,
        },
        &tokio_util::sync::CancellationToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(plan.source.facts_text, source.facts_text);
    assert_eq!(plan.source.system_prompt, source.system_prompt);
    assert_eq!(plan.summary.strategy, "truncate");
    assert_eq!(plan.source.turns.last().unwrap().content, "recent");
}

#[tokio::test]
async fn migration_copy_preserves_source_and_move_removes_only_after_verification() {
    use llmup_runtime::memory::{CaptureOptions, MigrationOptions};
    let root = tempfile::tempdir().unwrap();
    let source = MemoryStore::open(root.path(), "source", "2026-09-17T00:00:00Z").unwrap();
    let cancel = tokio_util::sync::CancellationToken::new();
    source
        .capture(
            "remember that durable fact",
            "reply",
            CaptureOptions {
                timestamp: "now",
                embedder: None,
                embedding_unsupported: false,
            },
            &cancel,
        )
        .await
        .unwrap();
    let options = || MigrationOptions {
        context: 8192,
        embedder: None,
        target_dimension: None,
        summarizer: None,
        embedding_unsupported: false,
    };
    let target = source
        .migrate("target", "2026-09-17T00:00:00Z", options(), false, &cancel)
        .await
        .unwrap();
    assert_eq!(source.load().unwrap(), target.load().unwrap());
    let moved = source
        .migrate("moved", "2026-09-17T00:00:00Z", options(), true, &cancel)
        .await
        .unwrap();
    assert!(!source.dir.exists());
    assert_eq!(target.load().unwrap(), moved.load().unwrap());
}
