use std::{collections::BTreeMap, path::Path, process::Stdio, time::Duration};
use tokio::io::AsyncReadExt;
use tokio_util::sync::CancellationToken;

pub struct OllamaCommandContext {
    environment: BTreeMap<String, String>,
}
impl OllamaCommandContext {
    pub fn new(endpoint: &str, models: &Path) -> Result<Self, String> {
        let endpoint = crate::state::loopback(endpoint).map_err(|error| error.to_string())?;
        if endpoint.path() != "/" || endpoint.query().is_some() || endpoint.fragment().is_some() {
            return Err("Ollama endpoint must be a loopback origin".into());
        }
        let models = models
            .to_str()
            .filter(|value| !value.is_empty() && !value.contains('\0'))
            .ok_or("invalid Ollama model store")?;
        if !Path::new(models).is_absolute() {
            return Err("Ollama model store must be absolute".into());
        }
        Ok(Self {
            environment: BTreeMap::from([
                ("OLLAMA_HOST".into(), endpoint.to_string()),
                ("OLLAMA_MODELS".into(), models.into()),
            ]),
        })
    }
    pub fn environment(&self) -> &BTreeMap<String, String> {
        &self.environment
    }
}

#[async_trait::async_trait]
pub trait CommandRunner: Send + Sync {
    async fn run(
        &self,
        binary: &Path,
        args: &[String],
        cancel: &CancellationToken,
        timeout: Duration,
    ) -> Result<String, String>;
    async fn run_ollama(
        &self,
        _binary: &Path,
        _args: &[String],
        _context: &OllamaCommandContext,
        _cancel: &CancellationToken,
        _timeout: Duration,
    ) -> Result<String, String> {
        Err("explicit Ollama command context is unsupported".into())
    }
}
pub struct NativeCommandRunner;
#[async_trait::async_trait]
impl CommandRunner for NativeCommandRunner {
    async fn run(
        &self,
        binary: &Path,
        args: &[String],
        cancel: &CancellationToken,
        timeout: Duration,
    ) -> Result<String, String> {
        run_command(binary, args, None, cancel, timeout).await
    }
    async fn run_ollama(
        &self,
        binary: &Path,
        args: &[String],
        context: &OllamaCommandContext,
        cancel: &CancellationToken,
        timeout: Duration,
    ) -> Result<String, String> {
        run_command(binary, args, Some(context), cancel, timeout).await
    }
}
async fn run_command(
    binary: &Path,
    args: &[String],
    context: Option<&OllamaCommandContext>,
    cancel: &CancellationToken,
    timeout: Duration,
) -> Result<String, String> {
    if cancel.is_cancelled() || timeout.is_zero() {
        return Err("command cancelled or deadline elapsed".into());
    }
    if !binary.is_absolute() || args.iter().any(|arg| arg.contains('\0')) {
        return Err("invalid command".into());
    }
    let mut environment = crate::process_control::minimal_env();
    if let Some(context) = context {
        environment.extend(context.environment().clone());
    }
    let mut child = tokio::process::Command::new(binary)
        .args(args)
        .env_clear()
        .envs(environment)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| "runtime command failed to start")?;
    let output = child.stdout.take().ok_or("missing command output")?;
    let operation = async {
        let mut bytes = Vec::new();
        output
            .take(1048577)
            .read_to_end(&mut bytes)
            .await
            .map_err(|_| "runtime command output failed")?;
        if bytes.len() > 1048576 {
            return Err("runtime command output exceeds limit".into());
        }
        if !child
            .wait()
            .await
            .map_err(|_| "runtime command wait failed")?
            .success()
        {
            return Err("runtime command failed".into());
        }
        String::from_utf8(bytes).map_err(|_| "runtime command output is not UTF-8".into())
    };
    let result = tokio::select! {biased;_=cancel.cancelled()=>Err("command cancelled".into()),result=tokio::time::timeout(timeout,operation)=>result.map_err(|_|"command timed out".to_owned()).and_then(|result|result)};
    if result.is_err() {
        let _ = tokio::time::timeout(Duration::from_secs(5), child.kill()).await;
    }
    result
}
