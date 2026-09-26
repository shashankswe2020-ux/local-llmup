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

#[derive(Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum Runnable {
    Yes,
    Slow,
    No,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Throughput {
    known: bool,
    low_tok_per_sec: f64,
    high_tok_per_sec: f64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ThroughputEvidence {
    source: String,
    unknown_reason: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CanRunEvidence {
    model_id: String,
    runnable: Runnable,
    throughput: Throughput,
    quant: Option<String>,
    reason: Option<String>,
    backends: Vec<String>,
    throughput_backend: String,
    required_bytes: Option<f64>,
    usable_bytes: f64,
    throughput_evidence: ThroughputEvidence,
    context: Option<f64>,
    context_fit_known: Option<bool>,
}

pub fn can_run_screen(report: &Value) -> io::Result<String> {
    if report["backends"]
        .as_array()
        .is_some_and(|values| values.len() > 1000)
    {
        return Err(io::Error::other("backend list exceeds 1000 entries"));
    }
    let report: CanRunEvidence =
        serde_json::from_value(report.clone()).map_err(io::Error::other)?;
    let valid_bytes = |value: f64| {
        value.is_finite()
            && (0.0..=9_007_199_254_740_991.0).contains(&value)
            && value.fract() == 0.0
    };
    let unknown_reason = if report.runnable == Runnable::No {
        "not-evaluated-model-does-not-fit"
    } else {
        "no-sourced-performance-profile"
    };
    let throughput = &report.throughput;
    let valid_throughput = throughput.low_tok_per_sec.is_finite()
        && throughput.high_tok_per_sec.is_finite()
        && throughput.low_tok_per_sec >= 0.0
        && throughput.high_tok_per_sec >= throughput.low_tok_per_sec
        && if throughput.known {
            report.throughput_evidence.unknown_reason.is_none()
        } else {
            throughput.low_tok_per_sec == 0.0
                && throughput.high_tok_per_sec == 0.0
                && report.throughput_evidence.unknown_reason.as_deref() == Some(unknown_reason)
        };
    if !valid_bytes(report.usable_bytes)
        || report
            .required_bytes
            .is_some_and(|value| !valid_bytes(value))
        || !valid_throughput
        || report.throughput_evidence.source != "offline-estimate"
        || !llmup_core::catalog::BACKENDS.contains(&report.throughput_backend.as_str())
        || report.context.is_some_and(|value| {
            !value.is_finite() || value.fract() != 0.0 || !(1.0..=10_000_000.0).contains(&value)
        })
        || report.context.is_some() != report.context_fit_known.is_some()
        || (report.runnable == Runnable::Yes && !throughput.known)
        || (report.runnable == Runnable::No
            && (throughput.known
                || report.quant.is_some()
                || !report.reason.as_deref().is_some_and(|reason| {
                    ["ram-bound", "vram-bound", "disk-bound", "context-bound"].contains(&reason)
                })))
        || (report.runnable != Runnable::No
            && (report.required_bytes.is_none()
                || report.quant.as_ref().is_none_or(|quant| quant.is_empty())
                || report.reason.is_some()))
    {
        return Err(io::Error::other("invalid or inconsistent can-run evidence"));
    }
    let verdict = match report.runnable {
        Runnable::Yes => "yes",
        Runnable::Slow => "slow",
        Runnable::No => "no",
    };
    let fit = match report.required_bytes {
        Some(required) => format!("{required} of {} usable bytes", report.usable_bytes),
        None => format!(
            "does not fit: {}",
            report.reason.as_deref().unwrap_or("unknown")
        ),
    };
    let (label, source, unknown) = if throughput.known {
        (
            format!(
                "{}\u{2013}{} tok/s",
                throughput.low_tok_per_sec, throughput.high_tok_per_sec
            ),
            "offline-estimate".into(),
            String::new(),
        )
    } else {
        (
            "unknown".into(),
            format!("offline-estimate; {unknown_reason}"),
            format!("\nUnknown reason: {unknown_reason}"),
        )
    };
    let mut backends = report
        .backends
        .iter()
        .take(10)
        .map(|backend| line(backend))
        .collect::<io::Result<Vec<_>>>()?
        .join(", ");
    if backends.is_empty() {
        backends = "none".into();
    }
    if report.backends.len() > 10 {
        backends.push_str(&format!(" (+{} more)", report.backends.len() - 10));
    }
    let safe_id = !report.model_id.is_empty()
        && !report.model_id.starts_with('-')
        && report.model_id.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"._:/-".contains(&byte)
        })
        && !report.model_id.split('/').any(|part| part == "..");
    let next = if report.runnable != Runnable::No && safe_id {
        format!("\nNext: local-llmup up {}", report.model_id)
    } else {
        String::new()
    };
    let context_warning = if report.context_fit_known == Some(false) {
        "\nRequested context fit unknown: attention geometry unavailable"
    } else {
        ""
    };
    Ok(bounded_document(format!(
        "local-llmup / Can Run / Accessible\n1. Target\n{}\n2. Verdict\n{verdict}; quant {}; reason {}; {}{context_warning}\n3. Throughput\n{}; source {}; backend {}{unknown}\n4. Backends\n{backends}{next}\n5. Controls\nCommands: ? help; q quit\n",
        identifier(&report.model_id)?,
        line(report.quant.as_deref().unwrap_or("unknown"))?,
        line(report.reason.as_deref().unwrap_or("none"))?,
        line(&fit)?,
        line(&label)?,
        line(&source)?,
        line(&report.throughput_backend)?
    )))
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
