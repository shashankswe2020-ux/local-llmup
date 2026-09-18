use std::{path::Path, process::Stdio, time::Duration};
use tokio::io::AsyncReadExt;
use tokio_util::sync::CancellationToken;

#[async_trait::async_trait]
pub trait CommandRunner: Send + Sync {
    async fn run(
        &self,
        binary: &Path,
        args: &[String],
        cancel: &CancellationToken,
        timeout: Duration,
    ) -> Result<String, String>;
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
        if cancel.is_cancelled() || timeout.is_zero() {
            return Err("command cancelled or deadline elapsed".into());
        }
        if !binary.is_absolute() || args.iter().any(|arg| arg.contains('\0')) {
            return Err("invalid command".into());
        }
        let mut child = tokio::process::Command::new(binary)
            .args(args)
            .env_clear()
            .envs(crate::process_control::minimal_env())
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
}
