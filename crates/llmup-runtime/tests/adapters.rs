use llmup_runtime::{
    adapters::{BackendKind, RuntimeAdapter, ServeRequest},
    http::{HttpError, Request, Response, Transport},
    identity::{Listener, ProcessIdentity, ProcessProbe},
    process_control::{ChildProcess, ProcessControl, SpawnSpec},
    state::StateError,
};
use serde_json::json;
use std::{path::PathBuf, sync::Mutex};
use tokio_util::sync::CancellationToken;
#[cfg(windows)]
const RUNTIME: &str = "C:/opt/runtime";
#[cfg(not(windows))]
const RUNTIME: &str = "/opt/runtime";
#[cfg(windows)]
const STUDIO: &str = "C:/trusted/studio";
#[cfg(not(windows))]
const STUDIO: &str = "/trusted/studio";
#[cfg(windows)]
const LMS: &str = "C:/opt/lms";
#[cfg(not(windows))]
const LMS: &str = "/opt/lms";
struct Probe {
    binary: String,
}
#[async_trait::async_trait]
impl ProcessProbe for Probe {
    async fn listener(&self, port: u16, host: &str) -> Result<Listener, StateError> {
        Ok(Listener {
            identity: ProcessIdentity {
                pid: 123,
                process: "runtime".into(),
                executable: self.binary.clone(),
                started: "instance".into(),
            },
            address: host.into(),
            port,
        })
    }
    async fn process(&self, _pid: u32) -> Result<ProcessIdentity, StateError> {
        Ok(self.listener(11435, "127.0.0.1").await?.identity)
    }
}
struct Control {
    signals: Mutex<Vec<u32>>,
}
#[async_trait::async_trait]
impl ProcessControl for Control {
    async fn occupied(&self, _endpoint: &str) -> Result<bool, String> {
        Ok(true)
    }
    async fn spawn(&self, _spec: &SpawnSpec) -> Result<Box<dyn ChildProcess>, String> {
        panic!("must not spawn on an occupied port")
    }
    async fn signal(&self, identity: &ProcessIdentity, _force: bool) -> Result<(), String> {
        self.signals.lock().unwrap().push(identity.pid);
        Ok(())
    }
    async fn alive(&self, _pid: u32) -> Result<bool, String> {
        Ok(false)
    }
}
struct Http;
struct ModelHttp {
    path: String,
    mlx: bool,
}
#[async_trait::async_trait]
impl Transport for ModelHttp {
    async fn send(&self, request: Request) -> Result<Response, HttpError> {
        let body = match request.url.path() {
            "/health" => json!({"status":"ok"}),
            "/props" => json!({"model_path":self.path,"model_alias":"test:latest"}),
            "/v1/models" => {
                json!({"data":[{"id":if self.mlx{self.path.as_str()}else{"test:latest"}}]})
            }
            "/v1/chat/completions" => {
                assert_eq!(request.body().unwrap()["model"], "default_model");
                json!({"choices":[{"message":{"content":"ready"}}]})
            }
            _ => panic!("unexpected model request"),
        };
        Ok(Response {
            status: 200,
            body: Box::pin(std::io::Cursor::new(body.to_string().into_bytes())),
        })
    }
}
#[tokio::test]
async fn llama_startup_uses_exact_artifact_and_alias() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("weights.gguf");
    std::fs::write(&path, b"verified").unwrap();
    let http = ModelHttp {
        path: path.to_string_lossy().into_owned(),
        mlx: false,
    };
    let probe = Probe {
        binary: RUNTIME.into(),
    };
    let control = SpawnControl {
        args: Mutex::new(Vec::new()),
        env: Mutex::new(Default::default()),
        cleaned: std::sync::Arc::new(Mutex::new(false)),
    };
    let adapter = RuntimeAdapter::new(
        BackendKind::LlamaCpp,
        PathBuf::from(RUNTIME),
        &http,
        &probe,
        &control,
    );
    let input = ServeRequest {
        model_id: "test:latest".into(),
        endpoint: "http://127.0.0.1:11435".into(),
        model_path: Some(path.clone()),
        context: None,
    };
    assert!(
        adapter
            .serve(&input, &CancellationToken::new())
            .await
            .unwrap()
            .owned_by_us
    );
    assert_eq!(
        *control.args.lock().unwrap(),
        vec![
            "-m",
            path.to_str().unwrap(),
            "--host",
            "127.0.0.1",
            "--port",
            "11435",
            "--alias",
            "test:latest"
        ]
    );
}
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
#[tokio::test]
async fn mlx_owned_startup_is_isolated_authenticated_and_bound_to_exact_model() {
    use llmup_runtime::{adapters::BackendAdapter, special_adapters::MlxAdapter};
    struct Version;
    #[async_trait::async_trait]
    impl llmup_runtime::command::CommandRunner for Version {
        async fn run(
            &self,
            _binary: &std::path::Path,
            args: &[String],
            _cancel: &CancellationToken,
            _timeout: std::time::Duration,
        ) -> Result<String, String> {
            assert_eq!(args[0], "-I");
            Ok("0.31.3\n".into())
        }
    }
    let root = tempfile::tempdir().unwrap();
    for file in [
        "config.json",
        "tokenizer_config.json",
        "weights.safetensors",
    ] {
        std::fs::write(root.path().join(file), b"{}").unwrap();
    }
    let http = ModelHttp {
        path: root.path().to_string_lossy().into_owned(),
        mlx: true,
    };
    let probe = Probe {
        binary: "/trusted/python".into(),
    };
    let control = SpawnControl {
        args: Mutex::new(Vec::new()),
        env: Mutex::new(Default::default()),
        cleaned: std::sync::Arc::new(Mutex::new(false)),
    };
    let adapter = MlxAdapter {
        binary: PathBuf::from("/trusted/python"),
        http: &http,
        probe: &probe,
        control: &control,
        commands: &Version,
        token: None,
    };
    let input = ServeRequest {
        model_id: "test:latest".into(),
        endpoint: "http://127.0.0.1:11435".into(),
        model_path: Some(root.path().to_owned()),
        context: None,
    };
    let active = adapter
        .serve(&input, &CancellationToken::new())
        .await
        .unwrap();
    assert!(active.owned_by_us);
    assert_eq!(active.auth_token.as_ref().unwrap().len(), 64);
    let args = control.args.lock().unwrap();
    assert_eq!(&args[..2], ["-I", "-c"]);
    assert!(args[2].contains("hmac.compare_digest"));
    assert!(args[2].contains("4194304"));
    assert_eq!(args[5], root.path().to_str().unwrap());
    assert_eq!(
        control.env.lock().unwrap()["LLMUP_MLX_AUTH_TOKEN"],
        *active.auth_token.as_ref().unwrap()
    );
}
#[tokio::test]
async fn attach_only_never_spawns_when_daemon_disappears() {
    use llmup_runtime::adapters::BackendAdapter;
    let control = SpawnControl {
        args: Mutex::new(Vec::new()),
        env: Mutex::new(Default::default()),
        cleaned: std::sync::Arc::new(Mutex::new(false)),
    };
    let probe = Probe {
        binary: RUNTIME.into(),
    };
    let adapter = RuntimeAdapter::new(
        BackendKind::Ollama,
        PathBuf::from(RUNTIME),
        &Http,
        &probe,
        &control,
    );
    let request = ServeRequest {
        model_id: "test:latest".into(),
        endpoint: "http://127.0.0.1:11435".into(),
        model_path: None,
        context: None,
    };
    assert!(
        adapter
            .attach_only(&request, &CancellationToken::new())
            .await
            .is_err()
    );
    assert!(control.args.lock().unwrap().is_empty());
}
struct Spawned {
    cleaned: std::sync::Arc<Mutex<bool>>,
}
#[async_trait::async_trait]
impl ChildProcess for Spawned {
    fn pid(&self) -> u32 {
        123
    }
    fn exited(&mut self) -> Result<bool, String> {
        Ok(false)
    }
    async fn terminate(&mut self) -> Result<(), String> {
        *self.cleaned.lock().unwrap() = true;
        Ok(())
    }
    fn detach(&mut self) {}
}
struct SpawnControl {
    args: Mutex<Vec<String>>,
    env: Mutex<std::collections::BTreeMap<String, String>>,
    cleaned: std::sync::Arc<Mutex<bool>>,
}
#[async_trait::async_trait]
impl ProcessControl for SpawnControl {
    async fn occupied(&self, _endpoint: &str) -> Result<bool, String> {
        Ok(false)
    }
    async fn spawn(&self, spec: &SpawnSpec) -> Result<Box<dyn ChildProcess>, String> {
        *self.args.lock().unwrap() = spec.args.clone();
        *self.env.lock().unwrap() = spec.env.clone();
        Ok(Box::new(Spawned {
            cleaned: self.cleaned.clone(),
        }))
    }
    async fn signal(&self, _process: &ProcessIdentity, _force: bool) -> Result<(), String> {
        Ok(())
    }
    async fn alive(&self, _pid: u32) -> Result<bool, String> {
        Ok(false)
    }
}
#[tokio::test]
async fn ollama_startup_binds_custom_loopback_port_and_cleans_untrusted_readiness() {
    for executable in [RUNTIME, "/tmp/untrusted"] {
        let cleaned = std::sync::Arc::new(Mutex::new(false));
        let control = SpawnControl {
            args: Mutex::new(Vec::new()),
            env: Mutex::new(Default::default()),
            cleaned: cleaned.clone(),
        };
        let probe = Probe {
            binary: executable.into(),
        };
        let adapter = RuntimeAdapter::new(
            BackendKind::Ollama,
            PathBuf::from(RUNTIME),
            &Http,
            &probe,
            &control,
        );
        let request = ServeRequest {
            model_id: "test:latest".into(),
            endpoint: "http://127.0.0.1:11435".into(),
            model_path: None,
            context: None,
        };
        let result = adapter.serve(&request, &CancellationToken::new()).await;
        assert_eq!(result.is_ok(), executable == RUNTIME);
        if let Ok(handle) = result {
            assert!(handle.owned_by_us);
        }
        assert_eq!(*cleaned.lock().unwrap(), executable != RUNTIME);
        assert_eq!(*control.args.lock().unwrap(), vec!["serve"]);
        assert_eq!(
            control.env.lock().unwrap()["OLLAMA_HOST"],
            "127.0.0.1:11435"
        );
    }
}
#[async_trait::async_trait]
impl Transport for Http {
    async fn send(&self, request: Request) -> Result<Response, HttpError> {
        let body = match request.url.path() {
            "/api/version" => json!({"version":"0.11.4"}),
            "/api/tags" => json!({"models":[]}),
            "/v1/models" => json!({"data":[{"id":"test:latest"}]}),
            "/health" => json!({"status":"ok"}),
            "/props" => json!({"model_path":"/verified/weights.gguf","model_alias":"test:latest"}),
            _ => panic!("unexpected request"),
        };
        Ok(Response {
            status: 200,
            body: Box::pin(std::io::Cursor::new(serde_json::to_vec(&body).unwrap())),
        })
    }
}
#[tokio::test]
async fn attach_preserves_foreign_ownership_and_stop_never_signals_it() {
    for kind in [BackendKind::Ollama, BackendKind::LlamaCpp] {
        let control = Control {
            signals: Mutex::new(Vec::new()),
        };
        let probe = Probe {
            binary: RUNTIME.into(),
        };
        let adapter = RuntimeAdapter::new(kind, PathBuf::from(RUNTIME), &Http, &probe, &control);
        let request = ServeRequest {
            model_id: "test:latest".into(),
            endpoint: "http://127.0.0.1:11435".into(),
            model_path: Some(PathBuf::from("/verified/weights.gguf")),
            context: None,
        };
        let handle = adapter
            .serve(&request, &CancellationToken::new())
            .await
            .unwrap();
        assert!(!handle.owned_by_us);
        assert_eq!(handle.pid, Some(123));
        adapter
            .stop(&handle, &CancellationToken::new())
            .await
            .unwrap();
        assert!(control.signals.lock().unwrap().is_empty());
    }
}
#[tokio::test]
async fn untrusted_listener_is_rejected_before_attachment() {
    let control = Control {
        signals: Mutex::new(Vec::new()),
    };
    let probe = Probe {
        binary: "/tmp/unknown".into(),
    };
    let adapter = RuntimeAdapter::new(
        BackendKind::Ollama,
        PathBuf::from(RUNTIME),
        &Http,
        &probe,
        &control,
    );
    let request = ServeRequest {
        model_id: "test:latest".into(),
        endpoint: "http://127.0.0.1:11435".into(),
        model_path: None,
        context: None,
    };
    assert!(
        adapter
            .serve(&request, &CancellationToken::new())
            .await
            .is_err()
    );
}

struct Commands;
#[async_trait::async_trait]
impl llmup_runtime::command::CommandRunner for Commands {
    async fn run(
        &self,
        _binary: &std::path::Path,
        args: &[String],
        _cancel: &CancellationToken,
        _timeout: std::time::Duration,
    ) -> Result<String, String> {
        Ok(if args.first().map(String::as_str) == Some("server") {
            json!({"running":true,"port":11435})
        } else {
            json!([{"identifier":"test:latest","path":"owner/model/weights.gguf"}])
        }
        .to_string())
    }
}
struct StudioHttp;
#[async_trait::async_trait]
impl Transport for StudioHttp {
    async fn send(&self, request: Request) -> Result<Response, HttpError> {
        let body = match request.url.path() {
            "/lmstudio-greeting" => json!({"lmstudio":true}),
            "/v1/models" => json!({"data":[{"id":"test:latest"}]}),
            _ => panic!("unexpected Studio request"),
        };
        Ok(Response {
            status: 200,
            body: Box::pin(std::io::Cursor::new(body.to_string().into_bytes())),
        })
    }
}
#[tokio::test]
async fn studio_requires_exact_delegated_path_and_never_owns_listener() {
    use llmup_runtime::{adapters::BackendAdapter, special_adapters::LmStudioAdapter};
    let probe = Probe {
        binary: STUDIO.into(),
    };
    let adapter = LmStudioAdapter {
        binary: PathBuf::from(LMS),
        trusted_executables: vec![PathBuf::from(STUDIO)],
        http: &StudioHttp,
        probe: &probe,
        commands: &Commands,
        token: None,
    };
    let mut request = ServeRequest {
        model_id: "test:latest".into(),
        endpoint: "http://127.0.0.1:11435".into(),
        model_path: Some(PathBuf::from("owner/model/weights.gguf")),
        context: None,
    };
    let state = adapter
        .serve(&request, &CancellationToken::new())
        .await
        .unwrap();
    assert!(!state.owned_by_us);
    assert_eq!(
        state.model_path.as_deref(),
        Some("owner/model/weights.gguf")
    );
    request.model_path = Some(PathBuf::from("other/weights.gguf"));
    assert!(
        adapter
            .serve(&request, &CancellationToken::new())
            .await
            .is_err()
    );
}
#[tokio::test]
async fn mlx_never_attaches_to_an_existing_listener() {
    use llmup_runtime::{adapters::BackendAdapter, special_adapters::MlxAdapter};
    let probe = Probe {
        binary: "/trusted/python".into(),
    };
    let control = Control {
        signals: Mutex::new(Vec::new()),
    };
    let adapter = MlxAdapter {
        binary: PathBuf::from("/trusted/python"),
        http: &Http,
        probe: &probe,
        control: &control,
        commands: &Commands,
        token: None,
    };
    let request = ServeRequest {
        model_id: "test:latest".into(),
        endpoint: "http://127.0.0.1:11435".into(),
        model_path: Some(PathBuf::from("/verified/model")),
        context: None,
    };
    assert!(
        adapter
            .serve(&request, &CancellationToken::new())
            .await
            .is_err()
    );
}
