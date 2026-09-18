use crate::workspace::WorkspaceError;
use std::{path::Path, process::Stdio, time::Duration};
use tokio::io::AsyncReadExt;

pub struct GitOutput {
    pub success: bool,
    pub bytes: Vec<u8>,
}
pub trait GitRunner {
    fn output(&self, root: &Path, mode: &str) -> Result<GitOutput, WorkspaceError>;
}
pub struct NativeGitRunner;
impl GitRunner for NativeGitRunner {
    fn output(&self, root: &Path, mode: &str) -> Result<GitOutput, WorkspaceError> {
        if !["status", "diff"].contains(&mode) {
            return Err(WorkspaceError("invalid git context mode".into()));
        }
        let root = root.to_owned();
        let mode = mode.to_owned();
        std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()?;
            runtime.block_on(async {
                let binary = crate::process_control::resolve_binary("git")
                    .map_err(|_| WorkspaceError("git unavailable".into()))?;
                let mut command = tokio::process::Command::new(binary);
                command.arg("-C").arg(&root).args([
                    "--no-pager",
                    "-c",
                    "core.hooksPath=/dev/null",
                    "-c",
                    "core.fsmonitor=false",
                ]);
                if mode == "status" {
                    command.args([
                        "status",
                        "--porcelain=v1",
                        "--untracked-files=all",
                        "--no-renames",
                    ]);
                } else {
                    command.args(["diff", "--no-color", "--no-ext-diff", "--no-textconv"]);
                }
                let mut child = command
                    .env_clear()
                    .envs(crate::process_control::minimal_env())
                    .env("GIT_TERMINAL_PROMPT", "0")
                    .env("GIT_CONFIG_NOSYSTEM", "1")
                    .env(
                        "GIT_CONFIG_GLOBAL",
                        if cfg!(windows) { "NUL" } else { "/dev/null" },
                    )
                    .stdin(Stdio::null())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::null())
                    .kill_on_drop(true)
                    .spawn()?;
                let stdout = child
                    .stdout
                    .take()
                    .ok_or_else(|| WorkspaceError("missing git output".into()))?;
                let operation = async {
                    let mut bytes = Vec::new();
                    stdout.take(409601).read_to_end(&mut bytes).await?;
                    if bytes.len() > 409600 {
                        let _ = child.start_kill();
                    }
                    let status = child.wait().await?;
                    Ok::<_, WorkspaceError>(GitOutput {
                        success: status.success(),
                        bytes,
                    })
                };
                match tokio::time::timeout(Duration::from_secs(5), operation).await {
                    Ok(result) => result,
                    Err(_) => {
                        let _ = child.start_kill();
                        let _ = tokio::time::timeout(Duration::from_secs(1), child.wait()).await;
                        Err(WorkspaceError("git context timed out".into()))
                    }
                }
            })
        })
        .join()
        .map_err(|_| WorkspaceError("git context task failed".into()))?
    }
}
