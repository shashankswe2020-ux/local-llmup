use crate::accessible_text::{identifier, single_line};
use serde::Deserialize;
use serde_json::Value;
use std::io::{self, Write};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

#[derive(Deserialize)]
#[serde(
    tag = "type",
    rename_all = "lowercase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum ActiveReport {
    Empty {},
    Active {
        model_id: String,
        backend: String,
        endpoint: String,
        port: u16,
        owned_by_us: bool,
        runtime_model_id: Option<String>,
        context: Option<u32>,
    },
}

fn line(value: &str) -> io::Result<String> {
    single_line(value)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Check {
    name: String,
    status: CheckStatus,
    detail: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum CheckStatus {
    Ok,
    Warn,
    Fail,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ScoreParts {
    vram: f64,
    ram: f64,
    compute: f64,
    storage: f64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Score {
    total: f64,
    sub: ScoreParts,
    bottleneck: Bottleneck,
}
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Bottleneck {
    Vram,
    Ram,
    Compute,
    Storage,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DoctorReport {
    ok: bool,
    checks: Vec<Check>,
    backends: Vec<llmup_runtime::diagnostics::BackendInfo>,
    hardware_score: Option<Score>,
}

fn bounded_document(document: String) -> String {
    const NOTICE: &str =
        "[output bounded; refine the search or inspect a numbered item for more]\n";
    let budget = 32768 - NOTICE.len();
    let mut output = String::new();
    for line in document.split_inclusive('\n') {
        if output.len() + line.len() > budget {
            output.push_str(NOTICE);
            return output;
        }
        output.push_str(line);
    }
    output
}

pub fn doctor_screen(report: &Value) -> io::Result<String> {
    if report["checks"]
        .as_array()
        .is_some_and(|values| values.len() > 1000)
        || report["backends"]
            .as_array()
            .is_some_and(|values| values.len() > 1000)
    {
        return Err(io::Error::other("diagnostic collection exceeds 1000 items"));
    }
    let report: DoctorReport = serde_json::from_value(report.clone()).map_err(io::Error::other)?;
    if report.ok
        != report
            .checks
            .iter()
            .all(|check| !matches!(check.status, CheckStatus::Fail))
    {
        return Err(io::Error::other("inconsistent diagnostic status"));
    }
    let mut checks = Vec::new();
    for (index, check) in report.checks.iter().take(20).enumerate() {
        let status = match check.status {
            CheckStatus::Ok => "OK",
            CheckStatus::Warn => "WARN",
            CheckStatus::Fail => "FAIL",
        };
        checks.push(format!(
            "{}. {status} {}: {}",
            index + 1,
            line(&check.name)?,
            line(&check.detail)?
        ));
    }
    if report.checks.len() > 20 {
        checks.push(format!("+{} more checks", report.checks.len() - 20));
    }
    let mut backends = Vec::new();
    for (index, backend) in report.backends.iter().take(20).enumerate() {
        backends.push(format!(
            "{}. {}; {}; version {}; {}; {}",
            index + 1,
            line(&backend.name)?,
            if backend.installed {
                "installed"
            } else {
                "not installed"
            },
            line(backend.version.as_deref().unwrap_or("unknown"))?,
            if backend.is_default {
                "default"
            } else {
                "not default"
            },
            line(&backend.install_hint)?
        ));
    }
    if report.backends.len() > 20 {
        backends.push(format!("+{} more backends", report.backends.len() - 20));
    }
    let score = match report.hardware_score {
        None => "Unknown (not sourced)".into(),
        Some(score) => {
            if [
                score.total,
                score.sub.vram,
                score.sub.ram,
                score.sub.compute,
                score.sub.storage,
            ]
            .iter()
            .any(|value| !value.is_finite() || !(0.0..=100.0).contains(value))
            {
                return Err(io::Error::other("invalid hardware score"));
            }
            let bottleneck = match score.bottleneck {
                Bottleneck::Vram => "VRAM",
                Bottleneck::Ram => "RAM",
                Bottleneck::Compute => "Compute",
                Bottleneck::Storage => "Storage",
            };
            format!(
                "{}/100; bottleneck {bottleneck}; VRAM {}; RAM {}; Compute {}; Storage {}",
                score.total, score.sub.vram, score.sub.ram, score.sub.compute, score.sub.storage
            )
        }
    };
    Ok(bounded_document(format!(
        "local-llmup / Doctor / Accessible\n1. Diagnostics\n{}\n2. Backends\n{}\n3. Hardware score\n{score}\n4. Controls\nCommands: ? help; q quit. Suggested commands are text only.\n",
        checks.join("\n"),
        backends.join("\n")
    )))
}

pub fn active_server_screen(report: &Value) -> io::Result<String> {
    let report: ActiveReport = serde_json::from_value(report.clone()).map_err(io::Error::other)?;
    match report {
        ActiveReport::Empty {}=>Ok("local-llmup / Active Server / Accessible\n1. Status\nNo active model.\n2. Next\nlocal-llmup up <model>\n".into()),
        ActiveReport::Active {model_id,backend,endpoint,port,owned_by_us,runtime_model_id,context}=>{
            if port==0 || !llmup_core::catalog::BACKENDS.contains(&backend.as_str())
                || context.is_some_and(|value|value==0 || value>10_000_000)
                || runtime_model_id.as_ref().is_some_and(|value|value.len()>8192) {
                return Err(io::Error::other("invalid active-server report"));
            }
            llmup_runtime::state::loopback(&endpoint).map_err(io::Error::other)?;
            Ok(format!("local-llmup / Active Server / Accessible\n1. Model\n{}\n2. Runtime\nBackend: {}\nEndpoint: {}\nPort: {port}\nOwnership: {}\n",identifier(&model_id)?,line(&backend)?,line(&endpoint)?,if owned_by_us {"owned"} else {"attached"}))
        }
    }
}

pub async fn run_screen(
    screen: &str,
    input: &mut mpsc::Receiver<io::Result<String>>,
    output: &mut impl Write,
    cancel: &CancellationToken,
) -> io::Result<()> {
    if screen.len() > 32768 {
        return Err(io::Error::other("accessible screen exceeds 32 KiB"));
    }
    if cancel.is_cancelled() {
        return Err(io::Error::new(
            io::ErrorKind::Interrupted,
            "interactive input cancelled",
        ));
    }
    output.write_all(screen.as_bytes())?;
    loop {
        output.flush()?;
        let Some(raw) = crate::accessible::answer(input, cancel).await? else {
            return Ok(());
        };
        let sanitized = single_line(&raw)?;
        let command = sanitized.trim();
        match command {
            "q" => return Ok(()),
            "?" => writeln!(output, "Commands: ? help; q quit")?,
            value if value.starts_with('/') => {
                writeln!(output, "Search is available on model-list screens only.")?
            }
            value
                if value.len() <= 3
                    && value
                        .as_bytes()
                        .first()
                        .is_some_and(|byte| (b'1'..=b'9').contains(byte))
                    && value.bytes().all(|byte| byte.is_ascii_digit()) =>
            {
                writeln!(
                    output,
                    "Numbered details are available on model-list screens only."
                )?
            }
            _ => writeln!(output, "Unknown command. Enter ? for help.")?,
        }
    }
}
