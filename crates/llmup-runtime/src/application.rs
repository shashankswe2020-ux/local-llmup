use crate::{
    acquire::{Acquisition, HfTransport},
    adapters::{BackendAdapter, BackendError, BackendKind, RuntimeAdapter, ServeRequest},
    command::{CommandRunner, NativeCommandRunner},
    http::{HttpError, NativeTransport, Request, Response, Transport},
    identity::{NativeProcessProbe, ProcessIdentity},
    lifecycle::{Activation, Lifecycle, Registry},
    ollama_installed::{InstalledModels, LocalVerifier, verify_manifest},
    process_control::{
        NativeProcessControl, ProcessControl, listener, resolve_binary, same_process,
    },
    pull::{PullRequest, PullService},
    special_adapters::{LmStudioAdapter, MlxAdapter},
    state::{Config, ServerState, StateStore},
};
use llmup_core::{
    catalog::{Catalog, CatalogModel, resolve},
    reports::strip_control,
    sizing::{Hardware, SizingRequest, evaluate},
};
use serde_json::{Value, json};
use std::{path::PathBuf, time::Duration};
use tokio_util::sync::CancellationToken;

pub struct LifecycleOptions {
    pub command: String,
    pub model: Option<String>,
    pub backend: Option<String>,
    pub port: Option<u16>,
    pub context: Option<u32>,
    pub installed: bool,
    pub bypass: bool,
}
impl LifecycleOptions {
    pub fn validate(&self) -> Result<(), BackendError> {
        if !["up", "switch", "down", "doctor"].contains(&self.command.as_str())
            || self.port == Some(0)
            || self
                .context
                .is_some_and(|value| !(1..=10000000).contains(&value))
            || self
                .backend
                .as_ref()
                .is_some_and(|value| !llmup_core::catalog::BACKENDS.contains(&value.as_str()))
        {
            return Err(BackendError("invalid lifecycle options".into()));
        }
        if self.command == "down" || self.command == "doctor" {
            if self.model.is_some()
                || self.backend.is_some()
                || self.port.is_some()
                || self.context.is_some()
                || self.installed
                || self.bypass
            {
                return Err(BackendError(
                    "down does not accept model or selection options".into(),
                ));
            }
        } else {
            let query = self
                .model
                .as_deref()
                .ok_or_else(|| BackendError("model is required".into()))?;
            if query.trim().is_empty() || query.len() > 8192 || query.chars().any(char::is_control)
            {
                return Err(BackendError("invalid model reference".into()));
            }
            if self.installed {
                crate::adapters::model_id(query)?;
            }
        }
        if self.installed
            && (!self.bypass
                || self
                    .backend
                    .as_ref()
                    .is_some_and(|backend| backend != "ollama"))
        {
            return Err(BackendError(
                "installed models require --bypass and Ollama".into(),
            ));
        }
        Ok(())
    }
}
struct CheckedHttp<'runtime> {
    inner: &'runtime dyn Transport,
    probe: &'runtime NativeProcessProbe,
    expected: ProcessIdentity,
}
#[async_trait::async_trait]
impl Transport for CheckedHttp<'_> {
    async fn send(&self, request: Request) -> Result<Response, HttpError> {
        let observed = listener(self.probe, request.url.as_str(), &CancellationToken::new())
            .await
            .map_err(|_| HttpError::Invalid)?;
        if !same_process(&observed.identity, &self.expected) {
            return Err(HttpError::Invalid);
        }
        self.inner.send(request).await
    }
}
struct ContextActivation<'runtime> {
    source: String,
    context: Option<u32>,
    installed: bool,
    expected_manifest: Option<String>,
    expected_sha: Option<String>,
    expected_bytes: Option<u64>,
    root: PathBuf,
    http: &'runtime NativeTransport,
    probe: &'runtime NativeProcessProbe,
}
#[async_trait::async_trait]
impl Activation for ContextActivation<'_> {
    async fn finalize(
        &self,
        handle: &ServerState,
        cancel: &CancellationToken,
    ) -> Result<ServerState, BackendError> {
        let observed = listener(self.probe, &handle.endpoint, cancel).await?;
        if handle.pid != Some(observed.identity.pid)
            || handle.process_executable.as_deref() != Some(&observed.identity.executable)
            || handle.process_started_at.as_deref() != Some(&observed.identity.started)
        {
            return Err(BackendError(
                "Ollama listener changed before activation".into(),
            ));
        }
        let http = CheckedHttp {
            inner: self.http,
            probe: self.probe,
            expected: observed.identity,
        };
        let verifier = LocalVerifier {
            root: self.root.clone(),
        };
        let support = InstalledModels::new(&http, &verifier);
        let model = support
            .inspect(&handle.endpoint, &self.source, cancel)
            .await
            .map_err(|error| BackendError(error.to_string()))?;
        if self
            .expected_manifest
            .as_ref()
            .is_some_and(|digest| digest != &model.digest)
        {
            return Err(BackendError("installed source changed; retry".into()));
        }
        verify_manifest(
            &self.root,
            &model.id,
            &model.digest,
            self.expected_sha.as_deref(),
            self.expected_bytes,
            cancel,
        )
        .await
        .map_err(|error| BackendError(error.to_string()))?;
        let runtime = support
            .activate(&handle.endpoint, &model, self.context, cancel)
            .await
            .map_err(|error| BackendError(error.to_string()))?;
        let final_model = support
            .inspect(&handle.endpoint, &self.source, cancel)
            .await
            .map_err(|error| BackendError(error.to_string()))?;
        if final_model.digest != model.digest {
            return Err(BackendError(
                "installed source changed before commit".into(),
            ));
        }
        let mut active = handle.clone();
        active.runtime_model_id = Some(runtime);
        active.context = self.context;
        if self.installed {
            active.integrity = Some("local-manifest".into());
            active.local_manifest_digest = Some(model.digest);
        }
        Ok(active)
    }
}
fn compatible(model: &CatalogModel, backend: &str) -> bool {
    match backend {
        "ollama" => model.source.ollama.is_some(),
        "llamacpp" => model.source.gguf.is_some(),
        "mlx" => model.source.mlx.is_some(),
        "lmstudio" => model.source.gguf.is_some() || model.source.mlx.is_some(),
        _ => false,
    }
}
pub fn validate_backend_platform(
    backend: &str,
    platform: llmup_core::sizing::Platform,
    arch: llmup_core::sizing::CpuArch,
) -> Result<(), BackendError> {
    if backend == "mlx"
        && !(platform == llmup_core::sizing::Platform::Darwin
            && arch == llmup_core::sizing::CpuArch::Arm64)
    {
        return Err(BackendError(
            "MLX requires Apple Silicon (darwin/arm64)".into(),
        ));
    }
    Ok(())
}
pub(crate) fn studio_trust(home: &std::path::Path) -> Vec<PathBuf> {
    let paths = if cfg!(target_os = "macos") {
        vec![
            PathBuf::from("/Applications/LM Studio.app/Contents/MacOS/LM Studio"),
            home.join("Applications/LM Studio.app/Contents/MacOS/LM Studio"),
        ]
    } else if cfg!(windows) {
        let mut paths = vec![
            PathBuf::from("C:\\Program Files\\LM Studio\\LM Studio.exe"),
            PathBuf::from("C:\\Program Files\\LM Studio\\llmster.exe"),
        ];
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            paths.extend([
                PathBuf::from(&local).join("Programs/LM Studio/LM Studio.exe"),
                PathBuf::from(local).join("Programs/LM Studio/llmster.exe"),
            ]);
        }
        paths
    } else {
        vec![
            PathBuf::from("/usr/bin/llmster"),
            PathBuf::from("/usr/local/bin/llmster"),
            PathBuf::from("/opt/lm-studio/bin/llmster"),
        ]
    };
    paths
        .into_iter()
        .map(|path| path.canonicalize().unwrap_or(path))
        .collect()
}
pub async fn run_native(
    options: &LifecycleOptions,
    catalog: &Catalog,
    hardware: Option<&Hardware>,
    cancel: &CancellationToken,
) -> Result<(Value, String), BackendError> {
    let config = Config::load().map_err(|error| BackendError(error.to_string()))?;
    run_native_with_config(options, catalog, hardware, cancel, config).await
}
pub async fn run_native_with_config(
    options: &LifecycleOptions,
    catalog: &Catalog,
    hardware: Option<&Hardware>,
    cancel: &CancellationToken,
    config: Config,
) -> Result<(Value, String), BackendError> {
    options.validate()?;
    let store = StateStore::new(config.clone());
    let prior = store
        .read()
        .map_err(|error| BackendError(error.to_string()))?;
    if options.command == "down" && prior.active.is_none() {
        return Ok((
            json!({"type":"no-active"}),
            "No active server to stop.\n".into(),
        ));
    }
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or_else(|| BackendError("home unavailable".into()))?;
    let paths = ["ollama", "llama-server", "python3", "lms"].map(|name| resolve_binary(name).ok());
    let binary = |index: usize| {
        paths[index]
            .clone()
            .unwrap_or_else(|| config.home.join(".unavailable").join(index.to_string()))
    };
    let http = NativeTransport::new().map_err(|error| BackendError(error.to_string()))?;
    let probe = NativeProcessProbe;
    let control = NativeProcessControl;
    let commands = NativeCommandRunner;
    let ollama_root = std::env::var_os("OLLAMA_MODELS")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".ollama/models"));
    let ollama = RuntimeAdapter::new(BackendKind::Ollama, binary(0), &http, &probe, &control)
        .with_ollama_models(ollama_root.clone())?;
    let llama = RuntimeAdapter::new(BackendKind::LlamaCpp, binary(1), &http, &probe, &control);
    let mlx = MlxAdapter {
        binary: binary(2),
        http: &http,
        probe: &probe,
        control: &control,
        commands: &commands,
        token: None,
    };
    let studio = LmStudioAdapter {
        binary: binary(3),
        trusted_executables: studio_trust(&home),
        http: &http,
        probe: &probe,
        commands: &commands,
        token: std::env::var("LM_API_TOKEN").ok(),
    };
    let registry = Registry::new(vec![&ollama, &llama, &mlx, &studio]);
    let lifecycle = Lifecycle {
        store: &store,
        registry: &registry,
        probe: &probe,
    };
    if options.command == "doctor" {
        let Some(active) = prior.active else {
            return Ok((
                json!({"name":"state","status":"ok","detail":"no active server recorded"}),
                String::new(),
            ));
        };
        let model = catalog
            .models
            .iter()
            .find(|model| model.id == active.model_id);
        let path = if active.backend == "mlx" {
            let source = model
                .and_then(|model| model.source.mlx.as_ref())
                .ok_or_else(|| BackendError("active MLX source unavailable".into()))?;
            let (owner, name) = source
                .repo
                .split_once('/')
                .ok_or_else(|| BackendError("invalid source".into()))?;
            Some(
                config
                    .home
                    .join("cache/mlx")
                    .join(owner)
                    .join(format!("{name}@{}", source.revision)),
            )
        } else if active.backend == "llamacpp" {
            let source = model
                .and_then(|model| model.source.gguf.as_ref())
                .ok_or_else(|| BackendError("active GGUF source unavailable".into()))?;
            let (owner, name) = source
                .repo
                .split_once('/')
                .ok_or_else(|| BackendError("invalid source".into()))?;
            Some(
                config
                    .home
                    .join("cache/llamacpp")
                    .join(owner)
                    .join(format!("{name}@{}", source.revision))
                    .join(&source.file),
            )
        } else {
            active.model_path.as_ref().map(PathBuf::from)
        };
        let request = ServeRequest {
            model_id: active.model_id.clone(),
            endpoint: active.endpoint.clone(),
            model_path: path,
            context: None,
        };
        lifecycle.health(&active, &request, cancel).await?;
        return Ok((
            json!({"name":"state","status":"ok","detail":format!("serving {} at {}",strip_control(&active.model_id),active.endpoint)}),
            String::new(),
        ));
    }
    if options.command == "down" {
        let stopped = lifecycle.down(cancel).await?;
        let active = stopped.ok_or_else(|| BackendError("active state disappeared".into()))?;
        return Ok((
            json!({"type":if active.owned_by_us{"stopped"}else{"detached"},"modelId":active.model_id,"endpoint":active.endpoint}),
            if active.owned_by_us {
                format!(
                    "Stopped {} ({}).\n",
                    strip_control(&active.model_id),
                    active.endpoint
                )
            } else {
                format!(
                    "Detached from {} ({}); it was not started by local-llmup and is still running.\n",
                    strip_control(&active.model_id),
                    active.endpoint
                )
            },
        ));
    }
    let query = options
        .model
        .as_deref()
        .ok_or_else(|| BackendError("model required".into()))?;
    if options.command == "switch" && prior.active.is_none() {
        return Err(BackendError(
            "no active server to switch; run up first".into(),
        ));
    }
    let installed_fallback = options.bypass
        && resolve(catalog, query).is_err_and(|error| error.code == "MODEL_RESOLUTION_ERROR");
    if options.installed || installed_fallback {
        eprintln!(
            "up: bypassing estimated fit; local content integrity is not catalog verification; throughput may be unknown"
        );
        if options
            .backend
            .as_ref()
            .is_some_and(|backend| backend != "ollama")
        {
            return Err(BackendError(
                "installed model bypass requires Ollama".into(),
            ));
        }
        let port = options
            .port
            .or_else(|| {
                prior
                    .active
                    .as_ref()
                    .filter(|active| active.backend == "ollama")
                    .map(|active| active.port)
            })
            .unwrap_or(11434);
        let endpoint = format!("http://127.0.0.1:{port}");
        let reviewed = lifecycle.review(query, cancel).await?;
        if !control.occupied(&endpoint).await? {
            return Err(BackendError(
                "installed activation requires an existing Ollama daemon".into(),
            ));
        }
        let observed = listener(&probe, &endpoint, cancel).await?;
        if !ollama.trusts(&observed.identity) {
            return Err(BackendError("untrusted Ollama daemon".into()));
        }
        let checked = CheckedHttp {
            inner: &http,
            probe: &probe,
            expected: observed.identity,
        };
        let verifier = LocalVerifier {
            root: ollama_root.clone(),
        };
        let support = InstalledModels::new(&checked, &verifier);
        let model = support
            .inspect(&endpoint, query, cancel)
            .await
            .map_err(|error| BackendError(error.to_string()))?;
        let catalog_quant = catalog
            .models
            .iter()
            .find(|entry| entry.source.ollama.as_deref() == Some(model.id.as_str()))
            .and_then(|entry| {
                entry
                    .quantizations
                    .iter()
                    .find(|quant| Some(&quant.name) == model.quant.as_ref())
                    .or_else(|| entry.quantizations.first())
            });
        let activation = ContextActivation {
            source: model.id.clone(),
            context: options.context,
            installed: true,
            expected_manifest: Some(model.digest),
            expected_sha: catalog_quant.and_then(|quant| quant.sha256.clone()),
            expected_bytes: catalog_quant.map(|quant| quant.disk_bytes as u64),
            root: ollama_root,
            http: &http,
            probe: &probe,
        };
        let request = ServeRequest {
            model_id: model.id,
            endpoint,
            model_path: None,
            context: options.context,
        };
        let active = lifecycle
            .attach_installed(&request, &reviewed, cancel, &activation)
            .await?;
        return Ok(up_output(&active, "local-manifest"));
    }
    let resolved = resolve(catalog, query).map_err(|error| BackendError(error.message))?;
    let model = resolved.model;
    if options.command == "switch"
        && prior
            .active
            .as_ref()
            .is_some_and(|active| active.model_id == model.id)
        && options.context.is_none()
        && !options.bypass
    {
        let active = prior
            .active
            .as_ref()
            .ok_or_else(|| BackendError("no active model".into()))?;
        return Ok((
            json!({"type":"already-active","modelId":model.id,"endpoint":active.endpoint}),
            format!("{} is already active.\n", model.id),
        ));
    }
    let hardware =
        hardware.ok_or_else(|| BackendError("hardware required for model selection".into()))?;
    let simple_switch = options.command == "switch" && options.context.is_none() && !options.bypass;
    let configured = options
        .backend
        .clone()
        .or_else(|| {
            std::env::var("LOCAL_LLMUP_BACKEND")
                .ok()
                .filter(|value| !value.trim().is_empty())
        })
        .or(config
            .user_backend()
            .map_err(|error| BackendError(error.to_string()))?);
    let backend = if options.command == "switch" {
        prior
            .active
            .as_ref()
            .ok_or_else(|| BackendError("no active model".into()))?
            .backend
            .clone()
    } else if let Some(backend) = configured {
        backend
    } else {
        let priority = if hardware.platform == llmup_core::sizing::Platform::Darwin
            && hardware.arch == llmup_core::sizing::CpuArch::Arm64
        {
            vec![("mlx", 2), ("ollama", 0), ("llamacpp", 1), ("lmstudio", 3)]
        } else {
            vec![("ollama", 0), ("llamacpp", 1), ("lmstudio", 3)]
        };
        let mut selected = None;
        for (name, index) in priority {
            if compatible(model, name) && paths[index].is_some() {
                let args = if name == "mlx" {
                    vec![
                        "-I".into(),
                        "-c".into(),
                        "import importlib.metadata; print(importlib.metadata.version('mlx-lm'))"
                            .into(),
                    ]
                } else {
                    vec!["--version".into()]
                };
                if let Ok(version) = commands
                    .run(&binary(index), &args, cancel, Duration::from_secs(5))
                    .await
                    && (name != "mlx" || version.trim() == "0.31.3")
                {
                    selected = Some(name.to_owned());
                    break;
                }
            }
        }
        selected.ok_or_else(|| BackendError("no installed backend supports this model".into()))?
    };
    let index = match backend.as_str() {
        "ollama" => 0,
        "llamacpp" => 1,
        "mlx" => 2,
        "lmstudio" => 3,
        _ => return Err(BackendError("invalid backend selection".into())),
    };
    validate_backend_platform(&backend, hardware.platform.clone(), hardware.arch.clone())?;
    if backend == "lmstudio" && model.source.gguf.is_none() && model.source.mlx.is_some() {
        validate_backend_platform("mlx", hardware.platform.clone(), hardware.arch.clone())?;
    }
    if paths[index].is_none() || !compatible(model, &backend) {
        return Err(BackendError(
            "backend is unavailable or model source is unsupported".into(),
        ));
    }
    if simple_switch && backend != "ollama" {
        return Err(BackendError(
            "single-model and delegated runtimes require up to replace models".into(),
        ));
    }
    if options.context.is_some() && backend != "ollama" {
        return Err(BackendError(
            "explicit runtime context currently requires Ollama".into(),
        ));
    }
    let mut sizing = model.sizing();
    if let Some(quant) = resolved.quant {
        sizing.quantizations = vec![quant.clone()];
    }
    let fit = evaluate(&SizingRequest {
        model: sizing,
        hardware: hardware.clone(),
        context: options.context.map(f64::from),
    })
    .map_err(|error| BackendError(error.to_string()))?;
    let quant = if simple_switch {
        resolved
            .quant
            .or_else(|| model.quantizations.first())
            .cloned()
    } else {
        resolved
            .quant
            .cloned()
            .or(fit.fit.quant.clone())
            .or_else(|| {
                if options.bypass {
                    model
                        .quantizations
                        .iter()
                        .min_by(|left, right| left.disk_bytes.total_cmp(&right.disk_bytes))
                        .cloned()
                } else {
                    None
                }
            })
    }
    .ok_or_else(|| {
        BackendError("model does not fit; use --bypass to override estimated fit".into())
    })?;
    if !simple_switch && backend != "lmstudio" && quant.disk_bytes > hardware.free_disk_bytes {
        return Err(BackendError("insufficient disk space".into()));
    }
    if !simple_switch
        && !fit.fit.fits
        && !options.bypass
        && (options.context.is_some() || resolved.quant.is_none())
    {
        return Err(BackendError(
            "model does not fit requested context; use --bypass".into(),
        ));
    }
    let reviewed = lifecycle.review(&model.id, cancel).await?;
    let pull_request = PullRequest {
        backend: backend.clone(),
        model_id: if backend == "ollama" {
            model
                .source
                .ollama
                .clone()
                .ok_or_else(|| BackendError("missing Ollama source".into()))?
        } else {
            model.id.clone()
        },
        expected_bytes: quant.disk_bytes as u64,
        expected_sha256: quant.sha256.clone(),
        gguf: model.source.gguf.clone(),
        mlx: model.source.mlx.clone(),
    };
    if !simple_switch && !fit.fit.fits {
        eprintln!(
            "up: requested quantization may not fit this hardware; continuing because it was explicitly requested"
        );
    }
    let acquisition =
        Acquisition::new(config.home.join("cache"))?.with_progress(|completed, total, file| {
            eprintln!("  {}: {completed}/{total} bytes", strip_control(file))
        });
    let download = HfTransport::new()?;
    let studio_root = home.join(".lmstudio/models");
    let pulls = PullService {
        acquisition: &acquisition,
        download: &download,
        commands: &commands,
        ollama_models: &ollama_root,
        studio_models: &studio_root,
    };
    let port = options
        .port
        .or_else(|| {
            if options.command == "switch" {
                prior.active.as_ref().map(|active| active.port)
            } else {
                None
            }
        })
        .unwrap_or(match backend.as_str() {
            "ollama" => 11434,
            "lmstudio" => 1234,
            _ => 8080,
        });
    let endpoint = format!("http://127.0.0.1:{port}");
    let pull_binary = binary(index);
    let pull = pulls.pull_at(&pull_request, &pull_binary, &endpoint, cancel);
    let prepared = if backend == "ollama" {
        crate::pull::with_ollama_daemon(&ollama, &endpoint, cancel, pull).await?
    } else {
        pull.await?
    };
    if !prepared.digest_verified {
        eprintln!("up: weights passed a size-floor check; no catalog SHA-256 was available");
    }
    if simple_switch {
        let active = lifecycle
            .switch_pointer(&model.id, &reviewed, cancel)
            .await?;
        return Ok((
            json!({"type":"switched","modelId":active.model_id,"endpoint":active.endpoint}),
            format!("Switched to {} ({}).\n", active.model_id, active.endpoint),
        ));
    }
    let request = ServeRequest {
        model_id: model.id.clone(),
        endpoint,
        model_path: prepared.model_path,
        context: options.context,
    };
    let active = if options.context.is_some() {
        let activation = ContextActivation {
            source: pull_request.model_id,
            context: options.context,
            installed: false,
            expected_manifest: prepared.local_manifest_digest,
            expected_sha: quant.sha256.clone(),
            expected_bytes: Some(quant.disk_bytes as u64),
            root: ollama_root,
            http: &http,
            probe: &probe,
        };
        lifecycle
            .replace_with(&backend, &request, &reviewed, cancel, &activation)
            .await?
    } else {
        lifecycle
            .replace(&backend, &request, &reviewed, cancel)
            .await?
    };
    Ok(up_output(
        &active,
        if prepared.digest_verified {
            "verified"
        } else {
            "size-only"
        },
    ))
}
fn up_output(active: &ServerState, integrity: &str) -> (Value, String) {
    let report = json!({"modelId":active.model_id,"backend":active.backend,"endpoint":active.endpoint,"ownership":if active.owned_by_us{"owned"}else{"attached"},"integrity":integrity});
    let mut text = format!(
        "{} ready at {}\n",
        strip_control(&active.model_id),
        active.endpoint
    );
    if let Some(runtime) = &active.runtime_model_id {
        text.push_str(&format!("Runtime model: {}", strip_control(runtime)));
        if let Some(context) = active.context {
            text.push_str(&format!(" (context {context})"));
        }
        text.push('\n');
    }
    (report, text)
}

pub async fn installed_inventory(
    hardware: &Hardware,
    model: Option<&str>,
    port: u16,
    context: Option<u32>,
    fits_only: bool,
    cancel: &CancellationToken,
) -> Result<(Value, String, u8), BackendError> {
    if port == 0 || context.is_some_and(|context| !(1..=10000000).contains(&context)) {
        return Err(BackendError("invalid installed comparison options".into()));
    }
    let binary = resolve_binary("ollama")?;
    let endpoint = format!("http://127.0.0.1:{port}");
    let http = NativeTransport::new().map_err(|error| BackendError(error.to_string()))?;
    let probe = NativeProcessProbe;
    let before = listener(&probe, &endpoint, cancel).await?;
    if binary.to_str() != Some(before.identity.executable.as_str()) {
        return Err(BackendError(
            "untrusted installed inventory listener".into(),
        ));
    }
    let checked = CheckedHttp {
        inner: &http,
        probe: &probe,
        expected: before.identity.clone(),
    };
    let root = std::env::var_os("OLLAMA_MODELS")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            std::env::var_os("HOME")
                .or_else(|| std::env::var_os("USERPROFILE"))
                .map(PathBuf::from)
                .unwrap_or_default()
                .join(".ollama/models")
        });
    let verifier = LocalVerifier { root };
    let support = InstalledModels::new(&checked, &verifier);
    let models = if let Some(model) = model {
        vec![
            support
                .inspect(&endpoint, model, cancel)
                .await
                .map_err(|error| BackendError(error.to_string()))?,
        ]
    } else {
        let mut models = Vec::new();
        for entry in support
            .list(&endpoint, cancel)
            .await
            .map_err(|error| BackendError(error.to_string()))?
        {
            models.push(
                support
                    .inspect(&endpoint, &entry.id, cancel)
                    .await
                    .map_err(|error| BackendError(error.to_string()))?,
            );
        }
        models
    };
    let mut results = Vec::new();
    let mut lines = Vec::new();
    for entry in models {
        let sized = crate::ollama_installed::size_installed(&entry, hardware, context)
            .map_err(|error| BackendError(error.to_string()))?;
        if fits_only && sized["fit"] != "yes" {
            continue;
        }
        lines.push(format!(
            "{}: context {}; estimated {} fit {}; weights {:.2} GiB ({}); throughput unknown",
            strip_control(&entry.id),
            context
                .map(|value| value.to_string())
                .unwrap_or_else(|| "default".into()),
            sized["memoryKind"].as_str().unwrap_or("ram"),
            sized["fit"].as_str().unwrap_or("unknown"),
            entry.size_bytes as f64 / 1073741824.0,
            if sized["weightsFit"] == true {
                "fit"
            } else {
                "over budget"
            }
        ));
        results.push(sized);
    }
    let after = listener(&probe, &endpoint, cancel).await?;
    if !same_process(&before.identity, &after.identity) {
        return Err(BackendError("inventory listener changed".into()));
    }
    let exit =
        u8::from(model.is_some() && results.first().is_some_and(|result| result["fit"] == "no"));
    Ok((
        json!({"source":"local-runtime-metadata","models":results}),
        format!(
            "{}\n",
            if lines.is_empty() {
                "No installed models match.".into()
            } else {
                lines.join("\n")
            }
        ),
        exit,
    ))
}
