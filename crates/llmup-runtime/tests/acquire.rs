use llmup_runtime::acquire::{Acquisition, Artifact, DownloadResponse, DownloadTransport};
use sha2::{Digest, Sha256};
use std::{io::Cursor, pin::Pin};

struct FakeTransport {
    bytes: Vec<u8>,
}
#[async_trait::async_trait]
impl DownloadTransport for FakeTransport {
    async fn get(&self, _url: &str) -> Result<DownloadResponse, String> {
        Ok(DownloadResponse {
            status: 200,
            commit: Some("a".repeat(40)),
            length: Some(self.bytes.len() as u64),
            body: Box::pin(Cursor::new(self.bytes.clone()))
                as Pin<Box<dyn tokio::io::AsyncRead + Send>>,
        })
    }
}
fn artifact(bytes: &[u8]) -> Artifact {
    Artifact {
        backend: "llamacpp".into(),
        repo: "owner/model".into(),
        revision: "a".repeat(40),
        file: "weights.gguf".into(),
        sha256: format!("{:x}", Sha256::digest(bytes)),
        bytes: bytes.len() as u64,
    }
}

#[test]
fn download_dns_rejects_private_mixed_mapped_and_special_addresses() {
    use llmup_runtime::acquire::public_addresses;
    for address in [
        "127.0.0.1:443",
        "10.0.0.1:443",
        "169.254.169.254:443",
        "100.64.0.1:443",
        "0.0.0.0:443",
        "192.0.2.1:443",
        "[::1]:443",
        "[::ffff:127.0.0.1]:443",
        "[fc00::1]:443",
        "[2001:db8::1]:443",
    ] {
        assert!(
            public_addresses(vec![address.parse().unwrap()]).is_err(),
            "{address}"
        );
        assert!(
            public_addresses(vec![
                "8.8.8.8:443".parse().unwrap(),
                address.parse().unwrap()
            ])
            .is_err()
        );
    }
    assert!(public_addresses(Vec::new()).is_err());
    assert!(
        public_addresses(vec![
            "8.8.8.8:443".parse().unwrap(),
            "[2606:4700:4700::1111]:443".parse().unwrap()
        ])
        .is_ok()
    );
}

#[test]
fn filenames_reject_windows_aliases_on_every_platform() {
    for file in [
        "CON",
        "aux.json",
        "LPT1.safetensors",
        "weights.gguf.",
        "weights.gguf ",
        "COM9/config.json",
        "nested/../weights.gguf",
    ] {
        assert!(!llmup_runtime::acquire::safe_file(file), "{file}");
    }
    assert!(llmup_runtime::acquire::safe_file(
        "nested/model-00001.safetensors"
    ));
}

#[tokio::test]
async fn repository_rejects_case_aliases_and_file_directory_collisions_before_writing() {
    for names in [
        ["Weights.gguf", "weights.gguf"],
        ["weights", "weights/part.gguf"],
    ] {
        let root = tempfile::tempdir().unwrap();
        let acquire = Acquisition::new(root.path()).unwrap();
        let artifacts: Vec<_> = names
            .into_iter()
            .map(|name| {
                let mut request = artifact(b"verified");
                request.file = name.into();
                request
            })
            .collect();
        assert!(
            acquire
                .repository(
                    &artifacts,
                    &FakeTransport {
                        bytes: b"verified".to_vec()
                    },
                    &tokio_util::sync::CancellationToken::new()
                )
                .await
                .is_err()
        );
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
    }
}

#[test]
fn abandoned_partial_cleanup_preserves_live_unknown_and_unrelated_files() {
    let root = tempfile::tempdir().unwrap();
    for name in [
        ".llmup-download.123.abc.part",
        ".llmup-download.456.abc.part",
        ".llmup-download.unknown.abc.part",
        "user.part",
    ] {
        std::fs::write(root.path().join(name), b"partial").unwrap();
    }
    llmup_runtime::acquire::cleanup_partials(root.path(), |pid| pid != 123).unwrap();
    assert!(!root.path().join(".llmup-download.123.abc.part").exists());
    assert!(root.path().join(".llmup-download.456.abc.part").exists());
    assert!(
        root.path()
            .join(".llmup-download.unknown.abc.part")
            .exists()
    );
    assert!(root.path().join("user.part").exists());
}

#[cfg(unix)]
#[tokio::test]
async fn symlinked_cache_ancestor_cannot_create_directories_outside_root() {
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let acquire = Acquisition::new(root.path()).unwrap();
    std::fs::create_dir(outside.path().join("owner")).unwrap();
    std::os::unix::fs::symlink(outside.path(), root.path().join("llamacpp")).unwrap();
    assert!(
        acquire
            .acquire(
                &artifact(b"verified"),
                &FakeTransport {
                    bytes: b"verified".to_vec()
                },
                &tokio_util::sync::CancellationToken::new()
            )
            .await
            .is_err()
    );
    assert_eq!(
        std::fs::read_dir(outside.path().join("owner"))
            .unwrap()
            .count(),
        0
    );
}

#[tokio::test]
async fn reports_progress_without_changing_verified_bytes() {
    let root = tempfile::tempdir().unwrap();
    let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let recorded = events.clone();
    let acquire =
        Acquisition::new(root.path())
            .unwrap()
            .with_progress(move |completed, total, file| {
                recorded
                    .lock()
                    .unwrap()
                    .push((completed, total, file.to_owned()))
            });
    let request = artifact(b"verified");
    acquire
        .acquire(
            &request,
            &FakeTransport {
                bytes: b"verified".to_vec(),
            },
            &tokio_util::sync::CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(
        events.lock().unwrap().last(),
        Some(&(8, 8, "weights.gguf".into()))
    );
}

#[tokio::test]
async fn approximate_gguf_sizes_are_ceilings_without_weakening_digest_checks() {
    use llmup_runtime::acquire::SizePolicy;
    let root = tempfile::tempdir().unwrap();
    let acquire = Acquisition::new(root.path()).unwrap();
    let mut request = artifact(b"verified");
    request.bytes = 100;
    let transport = FakeTransport {
        bytes: b"verified".to_vec(),
    };
    let cancel = tokio_util::sync::CancellationToken::new();
    assert!(
        acquire
            .acquire(&request, &transport, &cancel)
            .await
            .is_err()
    );
    let actual = acquire
        .acquire_sized(&request, SizePolicy::Ceiling, &transport, &cancel)
        .await
        .unwrap();
    assert_eq!(actual.bytes, 8);
    assert!(
        acquire
            .acquire_sized(&request, SizePolicy::Ceiling, &transport, &cancel)
            .await
            .unwrap()
            .cached
    );
    request.sha256 = "b".repeat(64);
    assert!(
        acquire
            .acquire_sized(&request, SizePolicy::Ceiling, &transport, &cancel)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn streams_verified_bytes_and_reuses_only_verified_cache() {
    let root = tempfile::tempdir().unwrap();
    let bytes = b"verified weights";
    let acquire = Acquisition::new(root.path()).unwrap();
    let transport = FakeTransport {
        bytes: bytes.to_vec(),
    };
    let result = acquire
        .acquire(
            &artifact(bytes),
            &transport,
            &tokio_util::sync::CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(std::fs::read(&result.path).unwrap(), bytes);
    assert!(!result.cached);
    assert!(
        acquire
            .acquire(
                &artifact(bytes),
                &transport,
                &tokio_util::sync::CancellationToken::new()
            )
            .await
            .unwrap()
            .cached
    );
}
#[tokio::test]
async fn rejects_digest_mismatch_limits_traversal_and_cancellation() {
    let root = tempfile::tempdir().unwrap();
    let acquire = Acquisition::new(root.path()).unwrap();
    let transport = FakeTransport {
        bytes: b"wrong weights".to_vec(),
    };
    let cancel = tokio_util::sync::CancellationToken::new();
    assert!(
        acquire
            .acquire(&artifact(b"good weights"), &transport, &cancel)
            .await
            .is_err()
    );
    let mut bad = artifact(b"wrong weights");
    bad.file = "../escape".into();
    assert!(acquire.acquire(&bad, &transport, &cancel).await.is_err());
    cancel.cancel();
    assert!(
        acquire
            .acquire(&artifact(b"wrong weights"), &transport, &cancel)
            .await
            .is_err()
    );
}

struct ResponseTransport {
    bytes: Vec<u8>,
    commit: Option<String>,
    length: Option<u64>,
}

struct StalledTransport {
    started: std::sync::Arc<tokio::sync::Notify>,
}
struct StalledReader(std::sync::Arc<tokio::sync::Notify>);
impl tokio::io::AsyncRead for StalledReader {
    fn poll_read(
        self: Pin<&mut Self>,
        _context: &mut std::task::Context<'_>,
        _buffer: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        self.0.notify_one();
        std::task::Poll::Pending
    }
}
#[async_trait::async_trait]
impl DownloadTransport for StalledTransport {
    async fn get(&self, _url: &str) -> Result<DownloadResponse, String> {
        Ok(DownloadResponse {
            status: 200,
            commit: Some("a".repeat(40)),
            length: None,
            body: Box::pin(StalledReader(self.started.clone())),
        })
    }
}

#[tokio::test]
async fn cancellation_during_a_stalled_body_removes_partial_and_lock() {
    let root = tempfile::tempdir().unwrap();
    let acquire = Acquisition::new(root.path()).unwrap();
    let started = std::sync::Arc::new(tokio::sync::Notify::new());
    let transport = StalledTransport {
        started: started.clone(),
    };
    let cancel = tokio_util::sync::CancellationToken::new();
    let request = artifact(b"verified");
    let action = acquire.acquire(&request, &transport, &cancel);
    let abort = async {
        started.notified().await;
        cancel.cancel();
    };
    let (result, ()) = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        tokio::join!(action, abort)
    })
    .await
    .unwrap();
    assert_eq!(result.unwrap_err(), "cancelled");
    let directory = root
        .path()
        .join("llamacpp/owner")
        .join(format!("model@{}", request.revision));
    assert_eq!(std::fs::read_dir(directory).unwrap().count(), 0);
}
#[async_trait::async_trait]
impl DownloadTransport for ResponseTransport {
    async fn get(&self, _url: &str) -> Result<DownloadResponse, String> {
        Ok(DownloadResponse {
            status: 200,
            commit: self.commit.clone(),
            length: self.length,
            body: Box::pin(Cursor::new(self.bytes.clone())),
        })
    }
}

#[tokio::test]
async fn missing_commit_digest_mismatch_and_streamed_overflow_never_promote() {
    for (bytes, commit) in [
        (b"verified".to_vec(), None),
        (b"corrupt!".to_vec(), Some("a".repeat(40))),
        (b"verified plus overflow".to_vec(), Some("a".repeat(40))),
    ] {
        let root = tempfile::tempdir().unwrap();
        let acquire = Acquisition::new(root.path()).unwrap();
        let transport = ResponseTransport {
            bytes,
            commit,
            length: None,
        };
        let result = acquire
            .acquire(
                &artifact(b"verified"),
                &transport,
                &tokio_util::sync::CancellationToken::new(),
            )
            .await;
        assert!(result.is_err());
        let directory = root
            .path()
            .join("llamacpp/owner")
            .join(format!("model@{}", "a".repeat(40)));
        assert_eq!(
            std::fs::read_dir(directory).unwrap().count(),
            0,
            "failed acquisition left lock or partial"
        );
    }
}

#[tokio::test]
async fn failed_redownload_preserves_existing_bytes() {
    let root = tempfile::tempdir().unwrap();
    let acquire = Acquisition::new(root.path()).unwrap();
    let cancel = tokio_util::sync::CancellationToken::new();
    let acquired = acquire
        .acquire(
            &artifact(b"verified"),
            &FakeTransport {
                bytes: b"verified".to_vec(),
            },
            &cancel,
        )
        .await
        .unwrap();
    std::fs::write(&acquired.path, b"existing cache").unwrap();
    assert!(
        acquire
            .acquire(
                &artifact(b"verified"),
                &FakeTransport {
                    bytes: b"corrupt!".to_vec()
                },
                &cancel
            )
            .await
            .is_err()
    );
    assert_eq!(std::fs::read(&acquired.path).unwrap(), b"existing cache");
}

#[tokio::test]
async fn artifact_and_repository_locks_use_existing_cache_coordinates() {
    let root = tempfile::tempdir().unwrap();
    let acquire = Acquisition::new(root.path()).unwrap();
    let request = artifact(b"verified");
    let directory = root
        .path()
        .join("llamacpp/owner")
        .join(format!("model@{}", request.revision));
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::write(
        directory.join("weights.gguf.lock"),
        format!("{}", std::process::id()),
    )
    .unwrap();
    let transport = FakeTransport {
        bytes: b"verified".to_vec(),
    };
    let cancel = tokio_util::sync::CancellationToken::new();
    assert!(
        acquire
            .acquire(&request, &transport, &cancel)
            .await
            .is_err()
    );
    std::fs::remove_file(directory.join("weights.gguf.lock")).unwrap();
    std::fs::write(
        directory.with_file_name(format!("model@{}.repository.lock", request.revision)),
        format!("{}", std::process::id()),
    )
    .unwrap();
    assert!(
        acquire
            .acquire(&request, &transport, &cancel)
            .await
            .is_err(),
        "single-file acquisition bypassed repository lock"
    );
    assert!(
        acquire
            .repository(&[request], &transport, &cancel)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn mlx_repository_requires_complete_non_executable_manifest() {
    for files in [
        vec!["weights.safetensors"],
        vec![
            "config.json",
            "tokenizer_config.json",
            "weights.safetensors",
            "custom.py",
        ],
        vec!["config.json", "tokenizer_config.json", "notes.txt"],
    ] {
        let root = tempfile::tempdir().unwrap();
        let acquire = Acquisition::new(root.path()).unwrap();
        let artifacts: Vec<_> = files
            .into_iter()
            .map(|file| {
                let mut request = artifact(b"verified");
                request.backend = "mlx".into();
                request.file = file.into();
                request
            })
            .collect();
        assert!(
            acquire
                .repository(
                    &artifacts,
                    &FakeTransport {
                        bytes: b"verified".to_vec()
                    },
                    &tokio_util::sync::CancellationToken::new()
                )
                .await
                .is_err()
        );
        assert_eq!(
            std::fs::read_dir(root.path()).unwrap().count(),
            0,
            "invalid manifest wrote cache content"
        );
    }
}
