use crate::{
    adapters::{BackendAdapter, BackendError, ServeRequest, model_id},
    command::CommandRunner,
    http::{Request, Transport, read_json},
    identity::{Listener, ProcessIdentity, ProcessProbe},
    process_control::{
        ProcessControl, SpawnSpec, listener, minimal_env, same_process, stop_owned,
        wait_owned_with_timeout,
    },
    state::{RuntimeState, ServerState, secure_read},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use tokio_util::sync::CancellationToken;

async fn request(
    http: &dyn Transport,
    endpoint: &str,
    path: &str,
    body: Option<Value>,
    token: Option<&str>,
    cancel: &CancellationToken,
) -> Result<Value, BackendError> {
    let request = Request::new(endpoint, path, body, token.map(str::to_owned))
        .map_err(|error| BackendError(error.to_string()))?;
    tokio::time::timeout(
        Duration::from_secs(5),
        read_json(http, request, cancel, 2 * 1024 * 1024),
    )
    .await
    .map_err(|_| BackendError("runtime request timed out".into()))?
    .map_err(|error| BackendError(error.to_string()))
}
fn state(
    name: &str,
    request: &ServeRequest,
    observed: Listener,
    owned: bool,
    token: Option<String>,
) -> Result<ServerState, BackendError> {
    let mut value = json!({"backend":name,"modelId":request.model_id,"endpoint":request.endpoint,"port":observed.port,"ownedByUs":owned,"pid":observed.identity.pid,"processExecutable":observed.identity.executable,"processStartedAt":observed.identity.started});
    if name == "lmstudio" {
        value["modelPath"] = json!(
            request
                .model_path
                .as_ref()
                .ok_or_else(|| BackendError("missing delegated path".into()))?
                .to_string_lossy()
        );
    }
    if let Some(token) = token {
        value["authToken"] = json!(token);
    }
    RuntimeState::parse(&json!({"schemaVersion":2,"active":value}).to_string())
        .map_err(|error| BackendError(error.to_string()))?
        .active
        .ok_or_else(|| BackendError("missing runtime state".into()))
}
fn ids(value: Value) -> Result<Vec<String>, BackendError> {
    #[derive(Deserialize)]
    struct Model {
        id: String,
    }
    #[derive(Deserialize)]
    struct Models {
        data: Vec<Model>,
    }
    let models: Models =
        serde_json::from_value(value).map_err(|_| BackendError("invalid runtime models".into()))?;
    if models.data.len() > 10000
        || models
            .data
            .iter()
            .any(|model| model.id.is_empty() || model.id.len() > 4096)
    {
        return Err(BackendError("invalid runtime model identifiers".into()));
    }
    Ok(models.data.into_iter().map(|model| model.id).collect())
}
fn validate(request: &ServeRequest) -> Result<url::Url, BackendError> {
    model_id(&request.model_id)?;
    if request.context.is_some() {
        return Err(BackendError(
            "explicit context currently requires Ollama or llama.cpp".into(),
        ));
    }
    crate::state::loopback(&request.endpoint).map_err(|error| BackendError(error.to_string()))
}
pub struct LmStudioAdapter<'runtime> {
    pub binary: PathBuf,
    pub trusted_executables: Vec<PathBuf>,
    pub http: &'runtime dyn Transport,
    pub probe: &'runtime dyn ProcessProbe,
    pub commands: &'runtime dyn CommandRunner,
    pub token: Option<String>,
}
impl LmStudioAdapter<'_> {
    async fn checked(
        &self,
        input: &ServeRequest,
        cancel: &CancellationToken,
    ) -> Result<Listener, BackendError> {
        let url = validate(input)?;
        let path = input
            .model_path
            .as_ref()
            .and_then(|path| path.to_str())
            .filter(|path| {
                !path.is_empty() && path.len() <= 4096 && !path.chars().any(char::is_control)
            })
            .ok_or_else(|| BackendError("exact delegated path required".into()))?;
        let before = listener(self.probe, &input.endpoint, cancel).await?;
        if !self
            .trusted_executables
            .iter()
            .any(|path| path.is_absolute() && path.to_str() == Some(&before.identity.executable))
        {
            return Err(BackendError("untrusted LM Studio executable".into()));
        }
        let greeting = request(
            self.http,
            &input.endpoint,
            "/lmstudio-greeting",
            None,
            self.token.as_deref(),
            cancel,
        )
        .await?;
        if greeting.get("lmstudio") != Some(&Value::Bool(true)) {
            return Err(BackendError("listener is not LM Studio".into()));
        }
        let status = self
            .commands
            .run(
                &self.binary,
                &[
                    "server".into(),
                    "status".into(),
                    "--json".into(),
                    "--quiet".into(),
                ],
                cancel,
                Duration::from_secs(5),
            )
            .await?;
        #[derive(Deserialize)]
        struct Status {
            running: bool,
            port: u16,
        }
        let status: Status = serde_json::from_str(&status)
            .map_err(|_| BackendError("invalid LM Studio server status".into()))?;
        if !status.running || Some(status.port) != url.port_or_known_default() {
            return Err(BackendError("LM Studio server port mismatch".into()));
        }
        if !ids(request(
            self.http,
            &input.endpoint,
            "/v1/models",
            None,
            self.token.as_deref(),
            cancel,
        )
        .await?)?
        .iter()
        .any(|id| id == &input.model_id)
        {
            return Err(BackendError("LM Studio model not loaded".into()));
        }
        let loaded = self
            .commands
            .run(
                &self.binary,
                &["ps".into(), "--json".into(), "--quiet".into()],
                cancel,
                Duration::from_secs(5),
            )
            .await?;
        #[derive(Deserialize)]
        struct Loaded {
            identifier: String,
            path: String,
        }
        let loaded: Vec<Loaded> = serde_json::from_str(&loaded)
            .map_err(|_| BackendError("invalid LM Studio loaded models".into()))?;
        if loaded.len() > 1024
            || loaded.iter().any(|entry| {
                entry.identifier.is_empty()
                    || entry.identifier.len() > 1024
                    || entry.path.is_empty()
                    || entry.path.len() > 4096
            })
            || loaded
                .iter()
                .filter(|entry| {
                    entry.identifier == input.model_id
                        && entry.path.replace('\\', "/") == path.replace('\\', "/")
                })
                .count()
                != 1
        {
            return Err(BackendError(
                "LM Studio exact delegated path not loaded".into(),
            ));
        }
        let after = listener(self.probe, &input.endpoint, cancel).await?;
        if !same_process(&before.identity, &after.identity) {
            return Err(BackendError("LM Studio listener changed".into()));
        }
        Ok(after)
    }
}
#[async_trait::async_trait]
impl BackendAdapter for LmStudioAdapter<'_> {
    async fn chat(
        &self,
        handle: &ServerState,
        input: &crate::ollama_inference::ChatInput,
        cancel: &CancellationToken,
    ) -> Result<crate::ollama_inference::ChatResult, BackendError> {
        crate::openai::OpenAiInference {
            http: self.http,
            probe: self.probe,
            adapter: self,
            token: self.token.as_deref(),
        }
        .chat(handle, input, cancel)
        .await
    }
    async fn embed(
        &self,
        handle: &ServerState,
        model: &str,
        inputs: &[String],
        cancel: &CancellationToken,
    ) -> Result<crate::ollama_inference::EmbedResult, BackendError> {
        crate::openai::OpenAiInference {
            http: self.http,
            probe: self.probe,
            adapter: self,
            token: self.token.as_deref(),
        }
        .embed(handle, model, inputs, cancel)
        .await
    }
    fn name(&self) -> &'static str {
        "lmstudio"
    }
    fn trusts(&self, identity: &ProcessIdentity) -> bool {
        self.trusted_executables
            .iter()
            .any(|path| path.is_absolute() && path.to_str() == Some(identity.executable.as_str()))
    }
    async fn serve(
        &self,
        input: &ServeRequest,
        cancel: &CancellationToken,
    ) -> Result<ServerState, BackendError> {
        state(
            self.name(),
            input,
            self.checked(input, cancel).await?,
            false,
            None,
        )
    }
    async fn ready(
        &self,
        input: &ServeRequest,
        cancel: &CancellationToken,
    ) -> Result<(), BackendError> {
        self.checked(input, cancel).await.map(|_| ())
    }
    async fn stop(
        &self,
        handle: &ServerState,
        _cancel: &CancellationToken,
    ) -> Result<(), BackendError> {
        handle
            .validate()
            .map_err(|error| BackendError(error.to_string()))?;
        if handle.backend != "lmstudio" || handle.owned_by_us {
            return Err(BackendError("invalid LM Studio handle".into()));
        }
        Ok(())
    }
}

pub struct MlxAdapter<'runtime> {
    pub binary: PathBuf,
    pub http: &'runtime dyn Transport,
    pub probe: &'runtime dyn ProcessProbe,
    pub control: &'runtime dyn ProcessControl,
    pub commands: &'runtime dyn CommandRunner,
    pub token: Option<String>,
}
pub fn validate_mlx_directory(root: &Path) -> Result<(), BackendError> {
    if !root.is_absolute()
        || !root.is_dir()
        || std::fs::symlink_metadata(root)
            .map_err(|_| BackendError("model root unavailable".into()))?
            .file_type()
            .is_symlink()
    {
        return Err(BackendError(
            "verified absolute MLX directory required".into(),
        ));
    }
    fn scan(path: &Path, count: &mut usize, weights: &mut bool) -> Result<(), BackendError> {
        for entry in std::fs::read_dir(path)
            .map_err(|_| BackendError("cannot inspect model directory".into()))?
        {
            let entry = entry.map_err(|_| BackendError("cannot inspect model entry".into()))?;
            *count += 1;
            if *count > 1024 {
                return Err(BackendError("model directory exceeds entry limit".into()));
            }
            let kind = entry
                .file_type()
                .map_err(|_| BackendError("cannot inspect model entry type".into()))?;
            if kind.is_dir() {
                scan(&entry.path(), count, weights)?;
            } else if kind.is_file() {
                let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
                if ["py", "pyc", "pyo", "so", "dylib", "dll", "bundle"]
                    .iter()
                    .any(|extension| name.ends_with(&format!(".{extension}")))
                {
                    return Err(BackendError("executable MLX artifact forbidden".into()));
                }
                *weights |= name.ends_with(".safetensors");
            } else {
                return Err(BackendError(
                    "symlink or special MLX artifact forbidden".into(),
                ));
            }
        }
        Ok(())
    }
    let mut count = 0;
    let mut weights = false;
    scan(root, &mut count, &mut weights)?;
    if !weights {
        return Err(BackendError("MLX weights absent".into()));
    }
    for file in ["config.json", "tokenizer_config.json"] {
        let raw = secure_read(&root.join(file), 1048576, false)
            .map_err(|_| BackendError("MLX config unavailable".into()))?;
        let value: Value =
            serde_json::from_str(&raw).map_err(|_| BackendError("invalid MLX config".into()))?;
        if !value.is_object()
            || value.get("auto_map").is_some_and(|value| !value.is_null())
            || value.get("trust_remote_code") == Some(&Value::Bool(true))
        {
            return Err(BackendError("MLX remote code config forbidden".into()));
        }
    }
    Ok(())
}
impl MlxAdapter<'_> {
    async fn ready_once(
        &self,
        input: &ServeRequest,
        cancel: &CancellationToken,
    ) -> Result<(), BackendError> {
        let token = self
            .token
            .as_deref()
            .filter(|value| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
            .ok_or_else(|| BackendError("MLX session token required".into()))?;
        let health = request(
            self.http,
            &input.endpoint,
            "/health",
            None,
            Some(token),
            cancel,
        )
        .await?;
        if health.get("status").and_then(Value::as_str) != Some("ok") {
            return Err(BackendError("MLX health not ready".into()));
        }
        let path = input
            .model_path
            .as_ref()
            .and_then(|path| path.to_str())
            .ok_or_else(|| BackendError("MLX model path required".into()))?;
        if !ids(request(
            self.http,
            &input.endpoint,
            "/v1/models",
            None,
            Some(token),
            cancel,
        )
        .await?)?
        .iter()
        .any(|id| id == path)
        {
            return Err(BackendError("MLX loaded path mismatch".into()));
        }
        let completion=request(self.http,&input.endpoint,"/v1/chat/completions",Some(json!({"model":"default_model","messages":[{"role":"user","content":"Reply briefly."}],"max_tokens":1,"stream":false})),Some(token),cancel).await?;
        if !completion
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|choices| choices.first())
            .and_then(|choice| choice.get("message"))
            .and_then(|message| message.get("content"))
            .is_some_and(Value::is_string)
        {
            return Err(BackendError("MLX identity completion failed".into()));
        }
        Ok(())
    }
}
#[async_trait::async_trait]
impl BackendAdapter for MlxAdapter<'_> {
    async fn chat(
        &self,
        handle: &ServerState,
        input: &crate::ollama_inference::ChatInput,
        cancel: &CancellationToken,
    ) -> Result<crate::ollama_inference::ChatResult, BackendError> {
        crate::openai::OpenAiInference {
            http: self.http,
            probe: self.probe,
            adapter: self,
            token: None,
        }
        .chat(handle, input, cancel)
        .await
    }
    fn name(&self) -> &'static str {
        "mlx"
    }
    fn trusts(&self, identity: &ProcessIdentity) -> bool {
        self.binary.to_str() == Some(identity.executable.as_str())
    }
    async fn ready_handle(
        &self,
        input: &ServeRequest,
        handle: &ServerState,
        cancel: &CancellationToken,
    ) -> Result<(), BackendError> {
        let session = MlxAdapter {
            binary: self.binary.clone(),
            http: self.http,
            probe: self.probe,
            control: self.control,
            commands: self.commands,
            token: handle.auth_token.clone(),
        };
        session.ready(input, cancel).await
    }
    async fn serve(
        &self,
        input: &ServeRequest,
        cancel: &CancellationToken,
    ) -> Result<ServerState, BackendError> {
        if !cfg!(all(target_os = "macos", target_arch = "aarch64")) {
            return Err(BackendError("MLX requires Apple Silicon".into()));
        }
        let url = validate(input)?;
        if cancel.is_cancelled() {
            return Err(BackendError("cancelled".into()));
        }
        if self.control.occupied(&input.endpoint).await? {
            return Err(BackendError(
                "MLX never attaches to occupied endpoints".into(),
            ));
        }
        let path = input
            .model_path
            .as_ref()
            .ok_or_else(|| BackendError("MLX model path required".into()))?;
        validate_mlx_directory(path)?;
        let version=self.commands.run(&self.binary,&["-I".into(),"-c".into(),"import importlib.metadata as m; from mlx_lm import server as s; assert hasattr(s, '_run_http_server') and hasattr(s, 'APIHandler'); print(m.version('mlx-lm'))".into()],cancel,Duration::from_secs(5)).await?;
        if version.trim() != "0.31.3" {
            return Err(BackendError("MLX requires audited mlx-lm 0.31.3".into()));
        }
        let token = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        let mut env = minimal_env();
        env.insert("LLMUP_MLX_AUTH_TOKEN".into(), token.clone());
        let args = vec![
            "-I".into(),
            "-c".into(),
            MLX_WRAPPER.into(),
            "mlx_lm.server".into(),
            "--model".into(),
            path.to_string_lossy().into_owned(),
            "--host".into(),
            url.host_str()
                .ok_or_else(|| BackendError("missing MLX host".into()))?
                .trim_matches(['[', ']'])
                .into(),
            "--port".into(),
            url.port_or_known_default()
                .ok_or_else(|| BackendError("missing MLX port".into()))?
                .to_string(),
            "--allowed-origins".into(),
            String::new(),
            "--log-level".into(),
            "ERROR".into(),
        ];
        if cancel.is_cancelled() {
            return Err(BackendError("cancelled".into()));
        }
        let child = self
            .control
            .spawn(&SpawnSpec {
                binary: self.binary.clone(),
                args,
                env,
            })
            .await?;
        let session = MlxAdapter {
            binary: self.binary.clone(),
            http: self.http,
            probe: self.probe,
            control: self.control,
            commands: self.commands,
            token: Some(token.clone()),
        };
        let observed = wait_owned_with_timeout(
            child,
            &input.endpoint,
            self.binary
                .to_str()
                .ok_or_else(|| BackendError("invalid interpreter path".into()))?,
            self.probe,
            cancel,
            Duration::from_secs(300),
            || async { session.ready(input, cancel).await.map_err(|error| error.0) },
        )
        .await?;
        state(self.name(), input, observed, true, Some(token))
    }
    async fn ready(
        &self,
        input: &ServeRequest,
        cancel: &CancellationToken,
    ) -> Result<(), BackendError> {
        validate(input)?;
        let operation = async {
            for _ in 0..150 {
                if self.ready_once(input, cancel).await.is_ok() {
                    return Ok(());
                }
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
            Err(BackendError("MLX readiness exhausted".into()))
        };
        tokio::select! {biased;_=cancel.cancelled()=>Err(BackendError("cancelled".into())),result=tokio::time::timeout(Duration::from_secs(300),operation)=>result.map_err(|_|BackendError("MLX readiness timed out".into()))?}
    }
    async fn stop(
        &self,
        handle: &ServerState,
        cancel: &CancellationToken,
    ) -> Result<(), BackendError> {
        handle
            .validate()
            .map_err(|error| BackendError(error.to_string()))?;
        if handle.backend != "mlx" || !handle.owned_by_us {
            return Err(BackendError("invalid owned MLX handle".into()));
        }
        let expected = ProcessIdentity {
            pid: handle
                .pid
                .ok_or_else(|| BackendError("missing MLX PID".into()))?,
            process: String::new(),
            executable: handle
                .process_executable
                .clone()
                .ok_or_else(|| BackendError("missing MLX executable".into()))?,
            started: handle
                .process_started_at
                .clone()
                .ok_or_else(|| BackendError("missing MLX start identity".into()))?,
        };
        stop_owned(
            &handle.endpoint,
            &expected,
            self.probe,
            self.control,
            cancel,
        )
        .await
        .map_err(BackendError)
    }
}
const MLX_WRAPPER: &str = r#"
import hmac, io, json, os, sys
from mlx_lm import server as _server
_original_run = _server._run_http_server
class GuardedHandler(_server.APIHandler):
  def _reject(self, status):
    self.send_response(status)
    self.send_header("Content-Length", "0")
    self.end_headers()
  def do_OPTIONS(self):
    self._reject(403)
  def _authenticated(self):
    return hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + os.environ["LLMUP_MLX_AUTH_TOKEN"])
  def do_GET(self):
    if not self._authenticated():
      self._reject(401)
      return
    super().do_GET()
  def do_POST(self):
    if self.headers.get("Origin") not in (None, "http://127.0.0.1", "http://localhost"):
      self._reject(403)
      return
    if not self._authenticated():
      self._reject(401)
      return
    if self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json":
      self._reject(415)
      return
    try:
      length = int(self.headers.get("Content-Length", ""))
    except ValueError:
      self._reject(411)
      return
    if length < 0 or length > 4194304:
      self._reject(413)
      return
    raw = self.rfile.read(length)
    try:
      body = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
      self._reject(400)
      return
    if not isinstance(body, dict) or body.get("model", "default_model") != "default_model":
      self._reject(400)
      return
    maximum = body.get("max_completion_tokens", body.get("max_tokens", 512))
    if not isinstance(maximum, int) or isinstance(maximum, bool) or not 0 <= maximum <= 4096:
      self._reject(400)
      return
    self.rfile = io.BytesIO(raw)
    super().do_POST()
def _guarded_run(host, port, response_generator, server_class=_server.ThreadingHTTPServer, handler_class=GuardedHandler):
  return _original_run(host, port, response_generator, server_class, GuardedHandler)
_server._run_http_server = _guarded_run
sys.argv.pop(1)
_server.main()
"#;
