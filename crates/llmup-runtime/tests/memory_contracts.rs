use llmup_runtime::memory::{
    CaptureOptions, Chunk, Embedder, EmbeddingMeta, EmbeddingOutput, MemoryError, MemoryStore,
    MigrationOptions, SourceEmbedding, SourceMemory, Summarizer, Turn, Vector, extract_facts,
    memory_slug, plan_migration,
};
use serde_json::Value;
use std::sync::Mutex;
use tokio_util::sync::CancellationToken;

fn plain(timestamp: &str) -> CaptureOptions<'_> {
    CaptureOptions {
        timestamp,
        embedder: None,
        embedding_unsupported: false,
    }
}

fn facts(store: &MemoryStore) -> Vec<String> {
    let raw = std::fs::read_to_string(store.dir.join("facts.json")).unwrap();
    let value: Value = serde_json::from_str(&raw).unwrap();
    value["facts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|fact| fact["text"].as_str().unwrap().to_owned())
        .collect()
}

struct Recording {
    model: &'static str,
    dimension: usize,
    reported: usize,
    seen: Mutex<Vec<String>>,
}
impl Recording {
    fn new(model: &'static str, dimension: usize) -> Self {
        Self {
            model,
            dimension,
            reported: dimension,
            seen: Mutex::default(),
        }
    }
}
#[async_trait::async_trait]
impl Embedder for Recording {
    fn model(&self) -> &str {
        self.model
    }
    async fn embed(
        &self,
        texts: &[String],
        _: &CancellationToken,
    ) -> Result<EmbeddingOutput, MemoryError> {
        self.seen.lock().unwrap().extend(texts.iter().cloned());
        Ok(EmbeddingOutput {
            dimension: self.reported,
            vectors: texts.iter().map(|_| vec![0.25; self.dimension]).collect(),
        })
    }
}

#[test]
fn durable_facts_are_extracted_in_rule_order_and_chit_chat_yields_none() {
    assert_eq!(
        extract_facts("My name is Ada Lovelace.").unwrap(),
        ["name = Ada Lovelace"]
    );
    assert_eq!(
        extract_facts("My name is Ada. I live in London. I prefer dark mode.").unwrap(),
        ["name = Ada", "location = London", "preference = dark mode"]
    );
    assert_eq!(
        extract_facts("Please remember that my API key rotates on Mondays").unwrap(),
        ["my API key rotates on Mondays"]
    );
    assert!(
        extract_facts("What is the capital of France?")
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn captures_append_sanitized_turns_and_deduplicate_facts() {
    let home = tempfile::tempdir().unwrap();
    let store = MemoryStore::open(home.path(), "model", "now").unwrap();
    let cancel = CancellationToken::new();
    let first = store
        .capture("\u{1b}[31mred\u{1b}[0m", "ok\u{7}", plain("t1"), &cancel)
        .await
        .unwrap();
    assert_eq!((first.turns_appended, first.facts_extracted), (2, 0));
    assert!(facts(&store).is_empty());
    assert!(!store.dir.join("embeddings").exists());
    let turns = store.load().unwrap().turns;
    assert_eq!(
        turns,
        [
            Turn {
                role: "user".into(),
                content: "red".into(),
                ts: "t1".into()
            },
            Turn {
                role: "assistant".into(),
                content: "ok".into(),
                ts: "t1".into()
            }
        ]
    );
    let named = store
        .capture(
            "My name is Ada. I live in London.",
            "Nice.",
            plain("t2"),
            &cancel,
        )
        .await
        .unwrap();
    assert_eq!(named.facts_extracted, 2);
    let again = store
        .capture("My name is Ada.", "Again.", plain("t3"), &cancel)
        .await
        .unwrap();
    assert_eq!(again.facts_extracted, 0);
    assert_eq!(facts(&store), ["name = Ada", "location = London"]);
    assert_eq!(store.load().unwrap().turns.len(), 6);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for name in ["conversation.jsonl", "facts.json", "meta.json"] {
            let mode = std::fs::metadata(store.dir.join(name))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o077, 0, "{name} {mode:o}");
        }
    }
}

#[tokio::test]
async fn embedding_capture_records_its_space_and_never_fabricates_vectors() {
    let home = tempfile::tempdir().unwrap();
    let store = MemoryStore::open(home.path(), "model", "now").unwrap();
    let cancel = CancellationToken::new();
    let embedder = Recording::new("embed-a", 3);
    let options = CaptureOptions {
        timestamp: "t",
        embedder: Some(&embedder),
        embedding_unsupported: false,
    };
    let result = store
        .capture(
            "\u{1b}[1mbold\u{1b}[0m question",
            "answer",
            options,
            &cancel,
        )
        .await
        .unwrap();
    assert_eq!(result.vectors_embedded, 2);
    assert!(
        embedder
            .seen
            .lock()
            .unwrap()
            .iter()
            .all(|text| !text.contains('\u{1b}'))
    );
    let meta = store.read_meta().unwrap();
    assert_eq!(
        meta.embedding,
        Some(EmbeddingMeta {
            model: "embed-a".into(),
            dimension: 3
        })
    );
    assert_eq!(meta.embedding_unsupported, None);
    let mismatched = Recording {
        reported: 4,
        ..Recording::new("embed-a", 3)
    };
    let before = store.load().unwrap();
    let options = CaptureOptions {
        timestamp: "t",
        embedder: Some(&mismatched),
        embedding_unsupported: false,
    };
    assert!(
        store
            .capture("more", "reply", options, &cancel)
            .await
            .is_err()
    );
    assert_eq!(store.load().unwrap(), before);
    let ignored = Recording::new("embed-a", 3);
    let options = CaptureOptions {
        timestamp: "t",
        embedder: Some(&ignored),
        embedding_unsupported: true,
    };
    let vectorless = store
        .capture("vectorless", "reply", options, &cancel)
        .await
        .unwrap();
    assert_eq!(vectorless.vectors_embedded, 0);
    assert!(ignored.seen.lock().unwrap().is_empty());
    let meta = store.read_meta().unwrap();
    assert_eq!(
        (meta.embedding, meta.embedding_unsupported),
        (None, Some(true))
    );
}

fn source(turns: Vec<Turn>, embedding: Option<SourceEmbedding>) -> SourceMemory {
    SourceMemory {
        turns,
        system_prompt: Some("persona".into()),
        facts_text: "{ \"schemaVersion\": 1, \"facts\": [] }".into(),
        facts_present: true,
        embedding,
    }
}

fn index(model: &str, dimension: usize) -> SourceEmbedding {
    SourceEmbedding {
        meta: EmbeddingMeta {
            model: model.into(),
            dimension,
        },
        chunks: vec![Chunk {
            id: "c1".into(),
            text: "chunk".into(),
            ts: "t".into(),
        }],
        vectors: vec![Vector {
            id: "c1".into(),
            vector: vec![0.5; dimension],
        }],
    }
}

fn turn(content: String) -> Turn {
    Turn {
        role: "user".into(),
        content,
        ts: "t".into(),
    }
}

fn options<'a>(
    context: u32,
    embedder: Option<&'a dyn Embedder>,
    dimension: Option<usize>,
    summarizer: Option<&'a dyn Summarizer>,
) -> MigrationOptions<'a> {
    MigrationOptions {
        context,
        embedder,
        target_dimension: dimension,
        summarizer,
        embedding_unsupported: false,
    }
}

#[tokio::test]
async fn embedding_strategy_reuses_matching_spaces_and_reembeds_on_any_difference() {
    let cancel = CancellationToken::new();
    let short = vec![turn("hello".into())];
    let plan = plan_migration(
        &source(short.clone(), None),
        options(8192, None, None, None),
        &cancel,
    )
    .await
    .unwrap();
    assert_eq!(
        (
            plan.summary.strategy.as_str(),
            plan.summary.embedding_strategy.as_str()
        ),
        ("none", "none")
    );
    assert_eq!(
        plan.source.facts_text,
        "{ \"schemaVersion\": 1, \"facts\": [] }"
    );
    let indexed = source(short.clone(), Some(index("embed-a", 2)));
    assert_eq!(
        plan_migration(&indexed, options(8192, None, None, None), &cancel)
            .await
            .unwrap()
            .summary
            .embedding_strategy,
        "reuse"
    );
    let same = Recording::new("embed-a", 2);
    assert_eq!(
        plan_migration(&indexed, options(8192, Some(&same), Some(2), None), &cancel)
            .await
            .unwrap()
            .summary
            .embedding_strategy,
        "reuse"
    );
    assert!(same.seen.lock().unwrap().is_empty());
    for (model, dimension) in [("embed-a", 3), ("embed-b", 2), ("embed-b", 3)] {
        let embedder = Recording::new(model, dimension);
        let plan = plan_migration(
            &indexed,
            options(8192, Some(&embedder), Some(dimension), None),
            &cancel,
        )
        .await
        .unwrap();
        assert_eq!(
            (
                plan.summary.embedding_strategy.as_str(),
                plan.summary.vectors_reembedded
            ),
            ("reembed", 1)
        );
        let migrated = plan.source.embedding.unwrap();
        assert_eq!(
            migrated.meta,
            EmbeddingMeta {
                model: model.into(),
                dimension
            }
        );
        assert_eq!(migrated.vectors[0].id, "c1");
    }
    let lying = Recording {
        reported: 5,
        ..Recording::new("embed-b", 3)
    };
    assert!(
        plan_migration(
            &indexed,
            options(8192, Some(&lying), Some(3), None),
            &cancel
        )
        .await
        .is_err()
    );
}

struct Verbose;
#[async_trait::async_trait]
impl Summarizer for Verbose {
    async fn summarize(
        &self,
        turns: &[Turn],
        _: &CancellationToken,
    ) -> Result<String, MemoryError> {
        Ok(format!("{} turns: {}", turns.len(), "detail ".repeat(2000)))
    }
}

#[tokio::test]
async fn overflowing_history_is_summarized_within_bounds_or_deterministically_truncated() {
    let cancel = CancellationToken::new();
    let history: Vec<_> = (0..6)
        .map(|number| turn(format!("{number} {}", "word ".repeat(200))))
        .chain([turn("latest".into())])
        .collect();
    let summarized = plan_migration(
        &source(history.clone(), None),
        options(600, None, None, Some(&Verbose)),
        &cancel,
    )
    .await
    .unwrap();
    assert_eq!(summarized.summary.strategy, "summarize");
    let head = &summarized.source.turns[0];
    assert_eq!(head.role, "system");
    assert!(head.content.starts_with("Summary of prior conversation: "));
    assert!(head.content.encode_utf16().count() <= 1024);
    assert_eq!(summarized.source.turns.last().unwrap().content, "latest");
    assert_eq!(summarized.source.system_prompt.as_deref(), Some("persona"));
    assert_eq!(
        summarized.summary.turns_summarized + summarized.summary.turns_carried,
        history.len()
    );
    let truncated = plan_migration(
        &source(history.clone(), None),
        options(600, None, None, None),
        &cancel,
    )
    .await
    .unwrap();
    assert_eq!(truncated.summary.strategy, "truncate");
    assert_eq!(
        truncated.source.turns[0].content,
        format!(
            "[{} earlier turns omitted during migration]",
            truncated.summary.turns_summarized
        )
    );
    for context in [0, 10_000_001] {
        assert!(
            plan_migration(
                &source(history.clone(), None),
                options(context, None, None, None),
                &cancel
            )
            .await
            .is_err()
        );
    }
}

#[tokio::test]
async fn migration_refuses_overlapping_stores_and_atomically_replaces_an_existing_target() {
    let home = tempfile::tempdir().unwrap();
    let cancel = CancellationToken::new();
    let source = MemoryStore::open(home.path(), "owner/model", "now").unwrap();
    source
        .capture("My name is Ada.", "Hi Ada.", plain("t"), &cancel)
        .await
        .unwrap();
    let overlapping = source
        .migrate(
            "owner:model",
            "now",
            options(8192, None, None, None),
            true,
            &cancel,
        )
        .await;
    assert!(overlapping.is_err());
    assert!(source.dir.exists());
    let existing = MemoryStore::open(home.path(), "target", "now").unwrap();
    existing
        .capture("old target turn", "old reply", plain("t"), &cancel)
        .await
        .unwrap();
    let target = source
        .migrate(
            "target",
            "later",
            options(8192, None, None, None),
            false,
            &cancel,
        )
        .await
        .unwrap();
    assert_eq!(target.load().unwrap(), source.load().unwrap());
    assert_eq!(
        std::fs::read(target.dir.join("facts.json")).unwrap(),
        std::fs::read(source.dir.join("facts.json")).unwrap()
    );
    assert!(!home.path().join(".staging/memory-target").exists());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&target.dir).unwrap().permissions().mode() & 0o077,
            0
        );
        for name in ["conversation.jsonl", "facts.json", "meta.json"] {
            assert_eq!(
                std::fs::metadata(target.dir.join(name))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o077,
                0,
                "{name}"
            );
        }
    }
}

#[test]
fn long_ids_get_bounded_unique_slugs_and_stores_stay_separate() {
    let prefix = "vendor/".to_owned() + &"x".repeat(200);
    let first = memory_slug(&format!("{prefix}-alpha"), false).unwrap();
    let second = memory_slug(&format!("{prefix}-beta"), false).unwrap();
    assert!(first.len() <= 128 && second.len() <= 128);
    assert_ne!(first, second);
    assert_eq!(
        first,
        memory_slug(&format!("{prefix}-alpha"), false).unwrap()
    );
    assert_eq!(memory_slug("CON", false).unwrap(), "con");
    for reserved in ["nul", "COM1.txt", "aux. "] {
        assert!(
            memory_slug(reserved, true).unwrap().starts_with("x-"),
            "{reserved}"
        );
    }
    let home = tempfile::tempdir().unwrap();
    let a = MemoryStore::open(home.path(), &format!("{prefix}-alpha"), "now").unwrap();
    let b = MemoryStore::open(home.path(), &format!("{prefix}-beta"), "now").unwrap();
    assert_ne!(a.dir, b.dir);
}

#[cfg(unix)]
#[test]
fn stores_fail_closed_on_permissive_modes_corrupt_metadata_and_escaping_symlinks() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let set = |path: &std::path::Path, mode| {
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap()
    };
    let home = tempfile::tempdir().unwrap();
    let store = MemoryStore::open(home.path(), "model", "now").unwrap();
    assert_eq!(
        std::fs::metadata(&store.dir).unwrap().permissions().mode() & 0o077,
        0
    );
    set(&store.dir, 0o755);
    assert!(MemoryStore::open(home.path(), "model", "now").is_err());
    set(&store.dir, 0o700);
    let meta = store.dir.join("meta.json");
    set(&meta, 0o644);
    assert!(MemoryStore::existing(home.path(), "model").is_err());
    set(&meta, 0o600);
    let original = std::fs::read(&meta).unwrap();
    for corrupt in ["{not json", "{\"schemaVersion\":1}"] {
        std::fs::write(&meta, corrupt).unwrap();
        assert!(
            MemoryStore::existing(home.path(), "model").is_err(),
            "{corrupt}"
        );
    }
    std::fs::write(&meta, &original).unwrap();
    MemoryStore::existing(home.path(), "model").unwrap();
    let outside = tempfile::tempdir().unwrap();
    let escaped = MemoryStore::open(outside.path(), "escaped", "now").unwrap();
    symlink(&escaped.dir, home.path().join("memory/escaped")).unwrap();
    assert!(MemoryStore::existing(home.path(), "escaped").is_err());
    assert!(MemoryStore::open(home.path(), "escaped", "now").is_err());
}
