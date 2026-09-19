use llmup_cli::dialog_smoke::{Action, Progress};
use std::{
    error::Error,
    io,
    path::Path,
    process::{ExitCode, Stdio},
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, BufReader},
    process::{Child, Command},
};

async fn operate(
    root: &Path,
    workspace: &Path,
    pid: u32,
    action: Action,
) -> Result<(), Box<dyn Error>> {
    let (index, mode) = match action {
        Action::Cancel => (1, "cancel"),
        Action::Select => (2, "select"),
    };
    let title = format!("Choose workspace directory R22 {index}");
    let mut command = if cfg!(windows) {
        let mut command = Command::new("powershell.exe");
        command
            .args(["-NoProfile", "-NonInteractive", "-File"])
            .arg("scripts/rust-dialog-smoke.ps1")
            .args(["-DesktopPid", &pid.to_string(), "-Selection"])
            .arg(workspace)
            .args(["-DialogTitle", &title, "-Mode", mode]);
        command
    } else {
        let mut command = Command::new("/usr/bin/python3");
        command
            .arg(root.join("scripts/rust-dialog-smoke.py"))
            .args([&title, mode]);
        command
    };
    command
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .kill_on_drop(true);
    let mut child = command.spawn()?;
    let result = tokio::time::timeout(Duration::from_secs(25), child.wait()).await;
    match result {
        Ok(Ok(exit)) if exit.success() => Ok(()),
        _ => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            Err("native dialog automation failed or timed out".into())
        }
    }
}

async fn observe(child: &mut Child, root: &Path, workspace: &Path) -> Result<(), Box<dyn Error>> {
    let pid = child.id().ok_or("missing desktop PID")?;
    let stdout = child.stdout.take().ok_or("missing desktop stdout")?;
    let mut reader = BufReader::new(stdout.take(1024 * 1024 + 1));
    let mut progress = Progress::default();
    let mut total = 0;
    loop {
        let mut line = Vec::new();
        let bytes = (&mut reader)
            .take(4097)
            .read_until(b'\n', &mut line)
            .await?;
        if bytes == 0 {
            break;
        }
        total += bytes;
        if bytes > 4096 || total > 1024 * 1024 {
            return Err("desktop smoke output exceeds bound".into());
        }
        let line = std::str::from_utf8(&line)?;
        print!("{line}");
        if let Some(action) = progress.observe(line)? {
            operate(root, workspace, pid, action).await?;
        }
    }
    if !progress.complete(child.wait().await?.success()) {
        return Err("native dialog smoke exited without two dialogs and success".into());
    }
    Ok(())
}

async fn run() -> Result<(), Box<dyn Error>> {
    if !cfg!(any(windows, target_os = "linux")) {
        return Err("use native macOS Accessibility verification".into());
    }
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()?;
    let workspace = tempfile::tempdir()?;
    let home = tempfile::tempdir()?;
    let binary = root.join(if cfg!(windows) {
        "apps/desktop/src-tauri/target/debug/llmup-desktop.exe"
    } else {
        "apps/desktop/src-tauri/target/debug/llmup-desktop"
    });
    let mut child = Command::new(binary)
        .arg("--dialog-smoke-test")
        .env("LOCAL_LLMUP_HOME", home.path())
        .env("LLMUP_DIALOG_SMOKE_PATH", workspace.path())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()?;
    let result = match tokio::time::timeout(
        Duration::from_secs(90),
        observe(&mut child, &root, workspace.path()),
    )
    .await
    {
        Ok(result) => result,
        Err(_) => Err(Box::new(io::Error::new(
            io::ErrorKind::TimedOut,
            "desktop smoke timed out",
        )) as Box<dyn Error>),
    };
    if result.is_err() {
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
    result?;
    println!(
        "Actual native Cancel, folder selection, root registration, revocation and exit passed."
    );
    Ok(())
}

#[tokio::main]
async fn main() -> ExitCode {
    match run().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("dialog-smoke: {error}");
            ExitCode::FAILURE
        }
    }
}
