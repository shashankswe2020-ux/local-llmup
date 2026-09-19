use clap::Parser;
use llmup_core::{catalog::Catalog, reports::strip_control};
use llmup_runtime::{
    registry_collector::{ManifestTransport, NativeManifestTransport, RecordedTransport, refresh},
    secure_fs::Directory,
};
use std::{
    error::Error,
    io,
    path::{Path, PathBuf},
    process::ExitCode,
};
use tokio_util::sync::CancellationToken;

#[derive(Parser)]
#[command(
    about = "Refresh curated quant sizes and digests from the Ollama registry; never adds models"
)]
struct Args {
    #[arg(long, default_value = "data/models.json")]
    catalog_path: PathBuf,
    #[arg(long)]
    manifest_fixture: Option<PathBuf>,
    #[arg(long)]
    now: Option<String>,
    #[arg(long)]
    dry_run: bool,
}

fn read_file(path: &Path) -> io::Result<String> {
    let path = std::path::absolute(path)?;
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other("file parent required"))?
        .canonicalize()?;
    let name = Path::new(
        path.file_name()
            .ok_or_else(|| io::Error::other("filename required"))?,
    );
    String::from_utf8(Directory::open(&parent)?.read(name, 16 * 1024 * 1024, false)?)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

async fn run(args: Args) -> Result<u8, Box<dyn Error>> {
    let path = std::path::absolute(&args.catalog_path)?;
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other("catalog parent required"))?
        .canonicalize()?;
    let name = Path::new(
        path.file_name()
            .ok_or_else(|| io::Error::other("catalog filename required"))?,
    );
    let directory = Directory::open(&parent)?;
    let before = directory.read(name, 16 * 1024 * 1024, false)?;
    let catalog = Catalog::parse(std::str::from_utf8(&before)?)?;
    let transport: Box<dyn ManifestTransport> = match args.manifest_fixture {
        Some(path) => Box::new(RecordedTransport::parse(&read_file(&path)?)?),
        None => Box::new(NativeManifestTransport::new()?),
    };
    let now = args
        .now
        .map(Ok)
        .unwrap_or_else(llmup_runtime::native_chat::timestamp)?;
    let cancel = CancellationToken::new();
    let result = tokio::select! {
        biased;
        signal=tokio::signal::ctrl_c()=>{signal?;cancel.cancel();return Ok(130);},
        result=refresh(&catalog,transport.as_ref(),&now,&cancel)=>result?,
    };
    if directory.read(name, 16 * 1024 * 1024, false)? != before {
        return Err(io::Error::other("catalog changed during enrichment").into());
    }
    if !args.dry_run && !result.updated.is_empty() {
        let encoded = format!("{}\n", serde_json::to_string_pretty(&result.catalog)?);
        directory.write(name, encoded.as_bytes(), false, true)?;
    }
    eprintln!(
        "catalog-enrich{}: updated={}{}",
        if args.dry_run { " dry-run" } else { "" },
        result.updated.len(),
        if result.updated.is_empty() {
            String::new()
        } else {
            format!(
                " ({})",
                result
                    .updated
                    .iter()
                    .map(|id| strip_control(id))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        }
    );
    Ok(0)
}

#[tokio::main]
async fn main() -> ExitCode {
    match run(Args::parse()).await {
        Ok(code) => ExitCode::from(code),
        Err(error) => {
            eprintln!(
                "catalog-enrich failed: {}",
                strip_control(&error.to_string())
            );
            ExitCode::FAILURE
        }
    }
}
