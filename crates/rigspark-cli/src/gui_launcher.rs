use std::{
    fmt,
    future::{Future, pending, ready},
    io::{self, Write},
    path::{Path, PathBuf},
    process::{ExitStatus, Stdio},
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::{Child, Command},
    time::timeout,
};

const STARTUP_TIMEOUT: Duration = Duration::from_secs(10);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(3);
const PRESENTATION_TIMEOUT: Duration = Duration::from_secs(5);
const READINESS_LIMIT: usize = 128;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GuiOptions {
    port: u16,
    no_open: bool,
    harness: Option<String>,
    json: bool,
}

impl GuiOptions {
    pub fn new(port: Option<&str>, no_open: bool) -> Result<Self, GuiLaunchError> {
        let port = port.unwrap_or("4000");
        if port.is_empty() || !port.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(GuiLaunchError::InvalidPort);
        }
        let port = port
            .parse::<u16>()
            .ok()
            .filter(|port| *port != 0)
            .ok_or(GuiLaunchError::InvalidPort)?;
        Ok(Self {
            port,
            no_open,
            harness: None,
            json: false,
        })
    }

    pub fn with_harness(mut self, harness: Option<&str>) -> Result<Self, GuiLaunchError> {
        self.harness = harness
            .map(|name| {
                let name = name.trim();
                if !valid_harness(name) {
                    return Err(GuiLaunchError::InvalidHarness);
                }
                Ok(name.to_owned())
            })
            .transpose()?;
        Ok(self)
    }

    pub fn with_json(mut self, json: bool) -> Self {
        self.json = json;
        self
    }
}

fn valid_harness(name: &str) -> bool {
    ["local", "claude", "openai", "openai-compatible", "opencode"].contains(&name)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LaunchSpec {
    executable: PathBuf,
    args: Vec<String>,
    origin: String,
    port: u16,
    harness: Option<String>,
    open_browser: bool,
}

impl LaunchSpec {
    pub fn new(current_exe: &Path, options: GuiOptions) -> Result<Self, GuiLaunchError> {
        let parent = current_exe
            .parent()
            .filter(|_| current_exe.is_absolute() && current_exe.file_name().is_some())
            .ok_or(GuiLaunchError::ExecutableLocation)?;
        let mut args = vec![
            "--port".into(),
            options.port.to_string(),
            "--startup-json".into(),
        ];
        if let Some(harness) = &options.harness {
            args.extend(["--harness".into(), harness.clone()]);
        }
        Ok(Self {
            executable: parent.join(if cfg!(windows) {
                "rigspark-gui.exe"
            } else {
                "rigspark-gui"
            }),
            args,
            origin: format!("http://127.0.0.1:{}", options.port),
            port: options.port,
            harness: options.harness,
            open_browser: !options.no_open && !options.json,
        })
    }

    pub fn executable(&self) -> &Path {
        &self.executable
    }
    pub fn args(&self) -> &[String] {
        &self.args
    }
    pub fn origin(&self) -> &str {
        &self.origin
    }
    pub fn open_browser(&self) -> bool {
        self.open_browser
    }
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub struct GuiReady {
    url: String,
    harness: String,
    port: u16,
}

impl GuiReady {
    pub fn url(&self) -> &str {
        &self.url
    }

    pub fn write_startup(&self, writer: &mut impl Write, json: bool) -> io::Result<()> {
        if json {
            serde_json::to_writer(&mut *writer, self)?;
            writeln!(writer)?;
        } else {
            writeln!(writer, "rigspark GUI listening at {}", self.url)?;
        }
        writer.flush()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GuiLaunchError {
    InvalidPort,
    InvalidHarness,
    ExecutableLocation,
    MissingExecutable,
    Spawn,
    Wait,
    Shutdown,
    Signals,
    StartupTimeout,
    ExitedBeforeReady,
    InvalidReadiness,
    Presentation,
}

impl GuiLaunchError {
    pub fn message(&self) -> &'static str {
        match self {
            Self::InvalidPort => "invalid --port (expected an integer in 1..65535)",
            Self::InvalidHarness => {
                "invalid --harness (expected local, claude, openai, openai-compatible, or opencode)"
            }
            Self::ExecutableLocation => "cannot locate the installed CLI executable",
            Self::MissingExecutable => {
                "installed rigspark-gui executable is missing; reinstall the complete native distribution"
            }
            Self::Spawn => {
                "cannot execute the installed rigspark-gui binary; check the native installation and executable permissions"
            }
            Self::Wait => "cannot observe the GUI process",
            Self::Shutdown => "GUI shutdown failed or timed out",
            Self::Signals => "cannot monitor shutdown signals",
            Self::StartupTimeout => "GUI startup timed out",
            Self::ExitedBeforeReady => "GUI exited before reporting readiness",
            Self::InvalidReadiness => "GUI reported an invalid startup record",
            Self::Presentation => "cannot present the GUI address",
        }
    }
}

impl fmt::Display for GuiLaunchError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "gui: {}", self.message())
    }
}

impl std::error::Error for GuiLaunchError {}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GuiSignal {
    Interrupt,
    Terminate,
    Hangup,
}

impl GuiSignal {
    pub fn exit_code(self) -> i32 {
        match self {
            Self::Interrupt => 130,
            Self::Terminate => 143,
            Self::Hangup => 129,
        }
    }
}

pub async fn run_gui(options: GuiOptions) -> Result<i32, GuiLaunchError> {
    #[cfg(unix)]
    let shutdown = {
        use tokio::signal::unix::{SignalKind, signal};
        let mut interrupt = signal(SignalKind::interrupt()).map_err(|_| GuiLaunchError::Signals)?;
        let mut terminate = signal(SignalKind::terminate()).map_err(|_| GuiLaunchError::Signals)?;
        let mut hangup = signal(SignalKind::hangup()).map_err(|_| GuiLaunchError::Signals)?;
        async move {
            let signal = tokio::select! {
                event = interrupt.recv() => event.map(|()| GuiSignal::Interrupt),
                event = terminate.recv() => event.map(|()| GuiSignal::Terminate),
                event = hangup.recv() => event.map(|()| GuiSignal::Hangup),
            };
            signal.ok_or_else(|| io::Error::other("signal stream closed"))
        }
    };
    #[cfg(not(unix))]
    let shutdown = async {
        tokio::signal::ctrl_c().await?;
        Ok(GuiSignal::Interrupt)
    };
    let executable = std::env::current_exe().map_err(|_| GuiLaunchError::ExecutableLocation)?;
    let json = options.json;
    let spec = LaunchSpec::new(&executable, options)?;
    let mut presented = false;
    let code = launch_with(&spec, shutdown, |ready, open| {
        let ready = ready.clone();
        let presented = &mut presented;
        async move {
            ready.write_startup(&mut io::stdout(), json)?;
            *presented = true;
            if open && !open_browser(ready.url()).await {
                let _ = writeln!(
                    io::stderr(),
                    "gui: could not open the browser automatically"
                );
            }
            Ok(())
        }
    })
    .await?;
    if !presented && ![0, 129, 130, 143].contains(&code) {
        writeln!(io::stderr(), "{}", GuiLaunchError::ExitedBeforeReady)
            .map_err(|_| GuiLaunchError::Presentation)?;
    }
    if presented && [0, 130, 143].contains(&code) {
        writeln!(io::stdout(), "Stopped.").map_err(|_| GuiLaunchError::Presentation)?;
    }
    Ok(code)
}

pub async fn launch_with<Shutdown, Present, Presentation>(
    spec: &LaunchSpec,
    shutdown: Shutdown,
    present: Present,
) -> Result<i32, GuiLaunchError>
where
    Shutdown: Future<Output = io::Result<GuiSignal>>,
    Present: FnOnce(&GuiReady, bool) -> Presentation,
    Presentation: Future<Output = io::Result<()>>,
{
    tokio::pin!(shutdown);
    tokio::select! {
        biased;
        signal = &mut shutdown => return signal.map(GuiSignal::exit_code).map_err(|_| GuiLaunchError::Signals),
        () = ready(()) => (),
    }
    let metadata = tokio::fs::symlink_metadata(spec.executable())
        .await
        .map_err(|error| {
            if error.kind() == io::ErrorKind::NotFound {
                GuiLaunchError::MissingExecutable
            } else {
                GuiLaunchError::Spawn
            }
        })?;
    if !metadata.is_file() {
        return Err(GuiLaunchError::Spawn);
    }
    let mut command = Command::new(spec.executable());
    command
        .args(spec.args())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command.spawn().map_err(|_| GuiLaunchError::Spawn)?;
    let stdout = child.stdout.take().ok_or(GuiLaunchError::Wait)?;
    let result = tokio::select! {
        biased;
        signal = &mut shutdown => signal.map(GuiSignal::exit_code).map_err(|_| GuiLaunchError::Signals),
        result = supervise(&mut child, stdout, spec, present) => result,
    };
    stop(&mut child).await?;
    result
}

async fn supervise<Present, Presentation>(
    child: &mut Child,
    mut stdout: tokio::process::ChildStdout,
    spec: &LaunchSpec,
    present: Present,
) -> Result<i32, GuiLaunchError>
where
    Present: FnOnce(&GuiReady, bool) -> Presentation,
    Presentation: Future<Output = io::Result<()>>,
{
    let readiness = tokio::select! {
        biased;
        status = child.wait() => return before_ready(status),
        result = timeout(STARTUP_TIMEOUT, read_readiness(&mut stdout, spec)) => result.map_err(|_| GuiLaunchError::StartupTimeout)?,
    };
    if readiness == Err(GuiLaunchError::ExitedBeforeReady) {
        return before_ready(
            timeout(STARTUP_TIMEOUT, child.wait())
                .await
                .map_err(|_| GuiLaunchError::StartupTimeout)?,
        );
    }
    let readiness = readiness?;
    let output = async {
        timeout(
            PRESENTATION_TIMEOUT,
            present(&readiness, spec.open_browser()),
        )
        .await
        .map_err(|_| GuiLaunchError::Presentation)?
        .map_err(|_| GuiLaunchError::Presentation)?;
        tokio::io::copy(&mut stdout, &mut tokio::io::sink())
            .await
            .map_err(|_| GuiLaunchError::Wait)?;
        pending::<Result<i32, GuiLaunchError>>().await
    };
    tokio::select! {
        result = output => result,
        status = child.wait() => status.map(exit_code).map_err(|_| GuiLaunchError::Wait),
    }
}

async fn read_readiness(
    reader: &mut (impl AsyncRead + Unpin),
    spec: &LaunchSpec,
) -> Result<GuiReady, GuiLaunchError> {
    let mut line = Vec::with_capacity(READINESS_LIMIT);
    for _ in 0..READINESS_LIMIT {
        let mut byte = [0];
        if reader
            .read(&mut byte)
            .await
            .map_err(|_| GuiLaunchError::Wait)?
            == 0
        {
            return Err(if line.is_empty() {
                GuiLaunchError::ExitedBeforeReady
            } else {
                GuiLaunchError::InvalidReadiness
            });
        }
        if byte[0] == b'\n' {
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            let ready: GuiReady =
                serde_json::from_slice(&line).map_err(|_| GuiLaunchError::InvalidReadiness)?;
            if ready.url != spec.origin()
                || ready.port != spec.port
                || !valid_harness(&ready.harness)
                || spec
                    .harness
                    .as_ref()
                    .is_some_and(|harness| harness != &ready.harness)
            {
                return Err(GuiLaunchError::InvalidReadiness);
            }
            return Ok(ready);
        }
        line.push(byte[0]);
    }
    Err(GuiLaunchError::InvalidReadiness)
}

fn before_ready(status: io::Result<ExitStatus>) -> Result<i32, GuiLaunchError> {
    let code = status.map(exit_code).map_err(|_| GuiLaunchError::Wait)?;
    if code == 0 {
        Err(GuiLaunchError::ExitedBeforeReady)
    } else {
        Ok(code)
    }
}

fn exit_code(status: ExitStatus) -> i32 {
    if let Some(code) = status.code() {
        return code;
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(signal) = status.signal() {
            return 128 + signal;
        }
    }
    1
}

async fn stop(child: &mut Child) -> Result<(), GuiLaunchError> {
    if child
        .try_wait()
        .map_err(|_| GuiLaunchError::Shutdown)?
        .is_some()
    {
        return Ok(());
    }
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        let mut signal = Command::new("/bin/kill");
        signal
            .args(["-s", "INT", &pid.to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        if matches!(timeout(Duration::from_secs(1), signal.status()).await, Ok(Ok(status)) if status.success())
            && let Ok(result) = timeout(SHUTDOWN_TIMEOUT, child.wait()).await
        {
            return result.map(|_| ()).map_err(|_| GuiLaunchError::Shutdown);
        }
    }
    child.start_kill().map_err(|_| GuiLaunchError::Shutdown)?;
    timeout(SHUTDOWN_TIMEOUT, child.wait())
        .await
        .map_err(|_| GuiLaunchError::Shutdown)?
        .map(|_| ())
        .map_err(|_| GuiLaunchError::Shutdown)
}

async fn open_browser(origin: &str) -> bool {
    #[cfg(target_os = "macos")]
    let mut command = Command::new("/usr/bin/open");
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = Command::new("/usr/bin/xdg-open");
    #[cfg(windows)]
    let mut command = {
        let Some(root) = std::env::var_os("SystemRoot")
            .map(PathBuf::from)
            .filter(|root| root.is_absolute())
        else {
            return false;
        };
        let mut command = Command::new(root.join("System32/rundll32.exe"));
        command.arg("url.dll,FileProtocolHandler");
        command
    };
    #[cfg(not(any(unix, windows)))]
    {
        let _ = origin;
        false
    }
    #[cfg(any(unix, windows))]
    {
        let Ok(mut child) = command
            .arg(origin)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
        else {
            return false;
        };
        match timeout(Duration::from_secs(2), child.wait()).await {
            Ok(Ok(status)) => status.success(),
            _ => {
                let _ = child.start_kill();
                let _ = timeout(Duration::from_secs(1), child.wait()).await;
                false
            }
        }
    }
}
