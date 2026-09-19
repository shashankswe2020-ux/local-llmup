use clap::Parser;
use llmup_cli::{
    distribution::checksum,
    performance::{Limits, Report, Sample, evaluate, peak_rss},
};
use serde::Serialize;
use std::{
    error::Error,
    path::{Path, PathBuf},
    process::{ExitCode, Stdio},
    time::{Duration, Instant},
};
use tokio::{io::AsyncReadExt, process::Command};

const HARDWARE: &str = r#"{"arch":"x64","platform":"linux","totalRamBytes":68719476736,"freeRamBytes":60000000000,"freeDiskBytes":500000000000,"gpu":[{"vendor":"nvidia","vramBytes":25769803776}]}"#;
const MAX_OUTPUT: u64 = 1024 * 1024;

#[derive(Parser)]
struct Args {
    #[arg(long)]
    executable: PathBuf,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Measurement {
    command: Vec<String>,
    output_sha256: String,
    report: Report,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Evidence {
    schema_version: u8,
    measured_at: String,
    platform: String,
    architecture: String,
    executable_sha256: String,
    hardware: serde_json::Value,
    warmup_runs: usize,
    measured_runs: usize,
    limits: Limits,
    measurements: Vec<Measurement>,
    passed: bool,
}

async fn probe(
    executable: &Path,
    args: &[&str],
    home: &Path,
) -> Result<(Sample, Vec<u8>), Box<dyn Error>> {
    let platform = std::env::consts::OS;
    let mut command = Command::new("/usr/bin/time");
    match platform {
        "macos" => {
            command.arg("-l");
        }
        "linux" => {
            command.args(["-f", "LLMUP_PEAK_RSS_KIB=%M"]);
        }
        _ => {
            return Err(
                "OS peak-RSS measurement is unsupported; performance gate remains unverified"
                    .into(),
            );
        }
    }
    command
        .arg(executable)
        .args(args)
        .current_dir(home)
        .env_clear()
        .env("PATH", "")
        .env("HOME", home)
        .env("LOCAL_LLMUP_HOME", home.join("state"))
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.as_std_mut().process_group(0);
    }
    let started = Instant::now();
    let mut child = command.spawn()?;
    let pid = child.id().ok_or("missing probe PID")?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or("missing stdout")?
        .take(MAX_OUTPUT + 1);
    let mut stderr = child
        .stderr
        .take()
        .ok_or("missing stderr")?
        .take(MAX_OUTPUT + 1);
    let mut out = Vec::new();
    let mut err = Vec::new();
    let read = tokio::time::timeout(Duration::from_secs(5), async {
        tokio::try_join!(
            stdout.read_to_end(&mut out),
            stderr.read_to_end(&mut err),
            child.wait()
        )
    })
    .await;
    if !matches!(read, Ok(Ok(_))) || out.len() as u64 > MAX_OUTPUT || err.len() as u64 > MAX_OUTPUT
    {
        #[cfg(unix)]
        {
            let _ = Command::new("/bin/kill")
                .args(["-KILL", "--", &format!("-{pid}")])
                .status()
                .await;
        }
        #[cfg(not(unix))]
        let _ = pid;
        let _ = child.kill().await;
        let _ = child.wait().await;
        return Err("probe exceeded its deadline or output bound".into());
    }
    let Ok(Ok((_, _, exit))) = read else {
        return Err("probe failed to complete".into());
    };
    if !exit.success() {
        return Err("advice probe failed".into());
    }
    if home.join("state").exists() {
        return Err("advice probe unexpectedly created runtime state".into());
    }
    let sample = Sample {
        elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
        peak_rss_bytes: peak_rss(platform, std::str::from_utf8(&err)?),
    };
    Ok((sample, out))
}

async fn run(args: Args) -> Result<bool, Box<dyn Error>> {
    use sha2::{Digest, Sha256};
    let executable = args.executable.canonicalize()?;
    let (bytes, sha256) = checksum(&executable)?;
    let home = tempfile::tempdir()?;
    let limits = Limits::default();
    let mut measurements = Vec::new();
    for args in [
        vec!["--version"],
        vec!["recommend", "--json", "--hardware-json", HARDWARE],
        vec![
            "can-run",
            "llama3.1:8b",
            "--json",
            "--hardware-json",
            HARDWARE,
        ],
        vec!["catalog", "--refresh", "--all", "--hardware-json", HARDWARE],
    ] {
        let (_, expected) = probe(&executable, &args, home.path()).await?;
        if args[0] == "--version" {
            if String::from_utf8_lossy(&expected).trim()
                != format!("llmup-native {}", env!("CARGO_PKG_VERSION"))
            {
                return Err("candidate is not the expected native CLI version".into());
            }
        } else if args.contains(&"--json") {
            serde_json::from_slice::<serde_json::Value>(&expected)?;
        } else if !expected.starts_with(b"Refresh (dry-run):") {
            return Err("catalog probe returned unexpected output".into());
        }
        for _ in 0..4 {
            let (_, output) = probe(&executable, &args, home.path()).await?;
            if output != expected {
                return Err("warmup output is nondeterministic".into());
            }
        }
        let mut samples = Vec::new();
        for _ in 0..20 {
            let (sample, output) = probe(&executable, &args, home.path()).await?;
            if output != expected {
                return Err("measured output is nondeterministic".into());
            }
            samples.push(sample);
        }
        let report = evaluate(&samples, bytes, &limits)?;
        eprintln!(
            "{}: median {:.2}ms, p90 {:.2}ms, peak RSS {:?} bytes; {}",
            args[0],
            report.median_ms,
            report.p90_ms,
            report.peak_rss_bytes,
            if report.failures.is_empty() {
                "PASS"
            } else {
                "FAIL"
            }
        );
        measurements.push(Measurement {
            command: args.iter().map(|value| (*value).into()).collect(),
            output_sha256: format!("{:x}", Sha256::digest(&expected)),
            report,
        });
    }
    if checksum(&executable)? != (bytes, sha256.clone()) {
        return Err("candidate executable changed during measurement".into());
    }
    let passed = measurements
        .iter()
        .all(|value| value.report.failures.is_empty());
    println!(
        "{}",
        serde_json::to_string_pretty(&Evidence {
            schema_version: 1,
            measured_at: llmup_runtime::native_chat::timestamp()?,
            platform: std::env::consts::OS.into(),
            architecture: std::env::consts::ARCH.into(),
            executable_sha256: sha256,
            hardware: serde_json::from_str(HARDWARE)?,
            warmup_runs: 5,
            measured_runs: 20,
            limits,
            measurements,
            passed,
        })?
    );
    Ok(passed)
}

#[tokio::main]
async fn main() -> ExitCode {
    match run(Args::parse()).await {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => ExitCode::FAILURE,
        Err(error) => {
            eprintln!("native-performance: {error}");
            ExitCode::FAILURE
        }
    }
}
