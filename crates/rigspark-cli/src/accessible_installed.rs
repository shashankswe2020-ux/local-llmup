use crate::accessible_text::{identifier, single_line};
use serde::Deserialize;
use serde_json::Value;
use std::io::{self, Write};
use tokio::sync::mpsc::Receiver;
use tokio_util::sync::CancellationToken;

pub const MAX_ROWS: usize = 20;
pub const MAX_ITEMS: usize = 1_000;
pub const MAX_TEXT_BYTES: usize = 1024 * 1024;
pub const MAX_INPUT_BYTES: usize = 4096;
pub const MAX_DOCUMENT_BYTES: usize = 64 * 1024;
const MAX_TOTAL_TEXT_BYTES: usize = 4 * MAX_TEXT_BYTES;
const MAX_NODES: usize = 100_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstalledCommand {
    Recommend,
    CanRun,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstalledOutcome {
    Exited,
    Cancelled,
}

#[derive(Debug)]
pub struct InstalledView {
    command: InstalledCommand,
    source: String,
    rows: Vec<Row>,
}

#[derive(Debug)]
struct Row {
    id: String,
    search: String,
    fit: String,
    details: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Fit {
    Yes,
    No,
    Unknown,
}

impl Fit {
    fn label(&self) -> &'static str {
        match self {
            Self::Yes => "yes",
            Self::No => "no",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum MemoryKind {
    Ram,
    Vram,
}

#[derive(Deserialize)]
struct Report<'report> {
    source: Option<&'report str>,
    #[serde(borrow)]
    models: Vec<Model<'report>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Model<'report> {
    id: &'report str,
    digest: Option<&'report str>,
    size_bytes: Option<u64>,
    quant: Option<&'report str>,
    context_length: Option<u32>,
    kv_bytes_per_token: Option<u64>,
    #[serde(borrow)]
    capabilities: Option<Vec<&'report str>>,
    context: Option<u32>,
    fit: Option<Fit>,
    weights_fit: Option<bool>,
    required_bytes: Option<f64>,
    usable_bytes: Option<f64>,
    memory_kind: Option<MemoryKind>,
    evidence: Option<&'report str>,
    throughput: Option<&'report str>,
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

fn check_bounds(
    value: &Value,
    depth: usize,
    nodes: &mut usize,
    bytes: &mut usize,
) -> io::Result<()> {
    *nodes += 1;
    if depth > 16 || *nodes > MAX_NODES {
        return Err(invalid("installed report structure limit exceeded"));
    }
    let mut check_text = |text: &str| -> io::Result<()> {
        if text.len() > MAX_TEXT_BYTES {
            return Err(invalid("installed report text limit exceeded"));
        }
        *bytes += text.len();
        if *bytes > MAX_TOTAL_TEXT_BYTES {
            return Err(invalid("installed report total text limit exceeded"));
        }
        Ok(())
    };
    match value {
        Value::String(text) => check_text(text)?,
        Value::Array(values) => {
            if values.len() > MAX_ITEMS {
                return Err(invalid("installed report collection limit exceeded"));
            }
            for value in values {
                check_bounds(value, depth + 1, nodes, bytes)?;
            }
        }
        Value::Object(values) => {
            if values.len() > MAX_ITEMS {
                return Err(invalid("installed report collection limit exceeded"));
            }
            for key in values.keys() {
                check_text(key)?;
            }
            for value in values.values() {
                check_bounds(value, depth + 1, nodes, bytes)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn number(value: Option<impl ToString>, unit: &str) -> String {
    value.map_or_else(
        || "unknown".into(),
        |value| format!("{}{unit}", value.to_string()),
    )
}

fn safe(value: Option<&str>) -> io::Result<String> {
    single_line(value.filter(|value| !value.is_empty()).unwrap_or("unknown"))
}

fn build_row(model: Model<'_>) -> io::Result<Row> {
    if model.id.trim().is_empty()
        || model
            .context
            .is_some_and(|context| !(1..=10_000_000).contains(&context))
        || [model.required_bytes, model.usable_bytes]
            .into_iter()
            .flatten()
            .any(|value| !value.is_finite() || value < 0.0)
    {
        return Err(invalid("invalid installed model evidence"));
    }
    let id = identifier(model.id)?;
    let fit = model.fit.as_ref().map_or("unknown", Fit::label).to_owned();
    let capabilities = model.capabilities.unwrap_or_default();
    let mut capability_text = capabilities
        .iter()
        .take(MAX_ROWS)
        .map(|value| single_line(value))
        .collect::<io::Result<Vec<_>>>()?
        .join(", ");
    if capability_text.is_empty() {
        capability_text = "unknown".into();
    }
    if capabilities.len() > MAX_ROWS {
        capability_text.push_str(&format!(
            "; +{} more capabilities",
            capabilities.len() - MAX_ROWS
        ));
    }
    let quant = safe(model.quant)?;
    let context = model.context.map_or_else(
        || "unknown (no explicit token count reported)".into(),
        |context| format!("{context} tokens"),
    );
    let details = format!(
        "Details: {id}\nFit: {fit}\nWeights: {}; fit {}\nRequired memory: {}\nUsable memory: {}\nMemory kind: {}\nContext: {context}\nModel context limit: {}\nKV cache: {}\nQuantization: {quant}\nCapabilities: {capability_text}\nDigest (reported, not verified): {}\nEvidence: {}\nThroughput: {}\n",
        number(model.size_bytes, " bytes"),
        model
            .weights_fit
            .map_or("unknown", |fits| if fits { "yes" } else { "no" }),
        number(model.required_bytes, " bytes"),
        number(model.usable_bytes, " bytes"),
        match model.memory_kind {
            Some(MemoryKind::Ram) => "ram",
            Some(MemoryKind::Vram) => "vram",
            None => "unknown",
        },
        number(model.context_length, " tokens"),
        number(model.kv_bytes_per_token, " bytes/token"),
        safe(model.digest)?,
        safe(model.evidence)?,
        safe(model.throughput)?,
    );
    let search = format!(
        "{} {id} {quant} {fit} {capability_text}",
        single_line(model.id)?
    )
    .to_lowercase();
    Ok(Row {
        id,
        search,
        fit,
        details,
    })
}

pub fn build_installed(report: &Value, command: InstalledCommand) -> io::Result<InstalledView> {
    check_bounds(report, 0, &mut 0, &mut 0)?;
    let report =
        Report::deserialize(report).map_err(|_| invalid("invalid installed inventory report"))?;
    if command == InstalledCommand::CanRun && report.models.len() > 1 {
        return Err(invalid(
            "can-run installed report must contain at most one model",
        ));
    }
    Ok(InstalledView {
        command,
        source: safe(report.source)?,
        rows: report
            .models
            .into_iter()
            .map(build_row)
            .collect::<io::Result<_>>()?,
    })
}

fn bounded_document(text: String) -> String {
    const NOTICE: &str = "[output bounded; refine search]\n";
    let mut output = String::new();
    for line in text.split_inclusive('\n') {
        if output.len() + line.len() > MAX_DOCUMENT_BYTES - NOTICE.len() {
            output.push_str(NOTICE);
            return output;
        }
        output.push_str(line);
    }
    output
}

impl InstalledView {
    pub(crate) fn command(&self) -> InstalledCommand {
        self.command
    }

    pub(crate) fn visual_overview(&self) -> Vec<String> {
        let mut lines = vec![
            format!("Source: {}", self.source),
            "Installed metadata only; digests reported, not verified".into(),
        ];
        if self.rows.is_empty() {
            lines.push("No results: No installed models match.".into());
        }
        lines
    }

    pub(crate) fn visual_rows(&self) -> impl ExactSizeIterator<Item = (&str, &str, &str, &str)> {
        self.rows.iter().map(|row| {
            (
                row.id.as_str(),
                row.fit.as_str(),
                row.search.as_str(),
                row.details.as_str(),
            )
        })
    }

    fn help(&self) -> &'static str {
        match self.command {
            InstalledCommand::Recommend => {
                "Commands: /text search; number details; ? help; q quit\n"
            }
            InstalledCommand::CanRun => "Commands: ? help; q quit\n",
        }
    }

    fn filtered<'view>(&'view self, query: &str) -> Vec<&'view Row> {
        let query = query.to_lowercase();
        self.rows
            .iter()
            .filter(|row| row.search.contains(&query))
            .collect()
    }

    fn list(&self, query: &str) -> String {
        let rows = self.filtered(query);
        let mut output = String::new();
        if rows.is_empty() {
            output.push_str("No results\n");
        }
        for (index, row) in rows.iter().take(MAX_ROWS).enumerate() {
            output.push_str(&format!("{}. {}; fit {}\n", index + 1, row.id, row.fit));
        }
        if rows.len() > MAX_ROWS {
            output.push_str(&format!(
                "Showing first {MAX_ROWS} of {}; use /text to refine.\n",
                rows.len()
            ));
        }
        output
    }

    pub fn format(&self) -> String {
        let title = match self.command {
            InstalledCommand::Recommend => "Recommend",
            InstalledCommand::CanRun => "Can Run",
        };
        let mut output = format!(
            "rigspark / {title} / Installed / Accessible\nSource: {}\n",
            self.source
        );
        if self.rows.is_empty() {
            output.push_str("No installed models match.\n");
        } else {
            match self.command {
                InstalledCommand::Recommend => output.push_str(&self.list("")),
                InstalledCommand::CanRun => output.push_str(&self.rows[0].details),
            }
        }
        output.push_str(self.help());
        bounded_document(output)
    }

    fn response(&self, line: &str, query: &mut String) -> String {
        if line == "?" {
            return self.help().into();
        }
        if self.command == InstalledCommand::Recommend {
            if let Some(filter) = line.strip_prefix('/') {
                *query = filter.trim().into();
                return bounded_document(format!(
                    "Filter: {}\n{}",
                    if query.is_empty() {
                        "off"
                    } else {
                        query.as_str()
                    },
                    self.list(query)
                ));
            }
            if !line.is_empty()
                && line.len() <= 4
                && !line.starts_with('0')
                && line.bytes().all(|byte| byte.is_ascii_digit())
            {
                let index = line.parse::<usize>().unwrap_or(0);
                return if (1..=MAX_ROWS).contains(&index) {
                    self.filtered(query).get(index - 1).map_or_else(
                        || "No such result.\n".into(),
                        |row| bounded_document(row.details.clone()),
                    )
                } else {
                    "No such result.\n".into()
                };
            }
        }
        "Unknown command. Enter ? for help.\n".into()
    }
}

fn write_frame(output: &mut impl Write, frame: &str) -> io::Result<()> {
    output.write_all(frame.as_bytes())?;
    output.flush()
}

pub async fn run_installed(
    view: &InstalledView,
    input: &mut Receiver<io::Result<String>>,
    output: &mut impl Write,
    cancellation: &CancellationToken,
) -> io::Result<InstalledOutcome> {
    if cancellation.is_cancelled() {
        return Ok(InstalledOutcome::Cancelled);
    }
    write_frame(output, &view.format())?;
    let mut query = String::new();
    loop {
        let raw = tokio::select! {
            biased;
            () = cancellation.cancelled() => return Ok(InstalledOutcome::Cancelled),
            line = input.recv() => match line {
                Some(line) => line?,
                None => return Ok(InstalledOutcome::Exited),
            }
        };
        if raw.len() > MAX_INPUT_BYTES {
            return Err(invalid("installed command input limit exceeded"));
        }
        let line = single_line(raw.trim())?;
        if line == "q" {
            return Ok(InstalledOutcome::Exited);
        }
        write_frame(output, &view.response(&line, &mut query))?;
        tokio::task::yield_now().await;
    }
}
