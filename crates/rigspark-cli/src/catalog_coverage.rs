use clap::Parser;
use rigspark_core::{
    catalog::Catalog,
    coverage::{
        Coverage, INVENTORY_URL, MAX_INVENTORY_BYTES, evaluate, monitored, parse_inventory,
    },
    reports::strip_control,
};
use rigspark_runtime::secure_fs::Directory;
use serde::Serialize;
use std::{
    error::Error,
    fs, io,
    path::{Path, PathBuf},
    process::ExitCode,
};
use tokio_util::sync::CancellationToken;

#[derive(Parser)]
#[command(about = "Report monitored upstream Ollama repositories missing from the curated catalog")]
struct Args {
    #[arg(long, default_value = "crates/rigspark-core/data/models.json")]
    catalog_path: PathBuf,
    #[arg(long)]
    inventory_path: Option<PathBuf>,
    #[arg(long, default_value = "catalog-coverage.json")]
    out: PathBuf,
    #[arg(long)]
    json: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Report {
    source: &'static str,
    checked_at: String,
    inventory_count: usize,
    #[serde(flatten)]
    coverage: Coverage,
}

fn checked_path(path: &Path) -> io::Result<PathBuf> {
    let absolute = std::path::absolute(path)?;
    let parent = absolute
        .parent()
        .ok_or_else(|| io::Error::other("file parent required"))?
        .canonicalize()?;
    let name = absolute
        .file_name()
        .ok_or_else(|| io::Error::other("filename required"))?;
    let path = parent.join(name);
    match fs::symlink_metadata(&path) {
        Ok(metadata) if !metadata.is_file() || metadata.file_type().is_symlink() => Err(
            io::Error::other("coverage paths must be regular non-symlink files"),
        ),
        Ok(_) => Ok(path),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(path),
        Err(error) => Err(error),
    }
}
fn read(path: &Path, maximum: u64) -> io::Result<String> {
    let directory = Directory::open(
        path.parent()
            .ok_or_else(|| io::Error::other("missing parent"))?,
    )?;
    let name = Path::new(
        path.file_name()
            .ok_or_else(|| io::Error::other("missing filename"))?,
    );
    String::from_utf8(directory.read(name, maximum, false)?)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}
fn write(path: &Path, text: &str) -> io::Result<()> {
    let directory = Directory::open(
        path.parent()
            .ok_or_else(|| io::Error::other("missing parent"))?,
    )?;
    let name = Path::new(
        path.file_name()
            .ok_or_else(|| io::Error::other("missing filename"))?,
    );
    let exists = path.try_exists()?;
    directory.write(name, text.as_bytes(), !exists, exists)
}

async fn run(args: Args) -> Result<(), Box<dyn Error>> {
    let catalog_path = checked_path(&args.catalog_path)?;
    let inventory_path = args
        .inventory_path
        .as_deref()
        .map(checked_path)
        .transpose()?;
    let out = checked_path(&args.out)?;
    let summary = std::env::var_os("GITHUB_STEP_SUMMARY")
        .filter(|value| !value.is_empty())
        .map(|value| checked_path(Path::new(&value)))
        .transpose()?;
    let mut paths = vec![&catalog_path, &out];
    paths.extend(inventory_path.iter());
    paths.extend(summary.iter());
    for (index, path) in paths.iter().enumerate() {
        if paths[index + 1..].contains(path) {
            return Err(
                io::Error::other("coverage input and output paths must be distinct").into(),
            );
        }
    }
    let catalog = Catalog::parse(&read(&catalog_path, 16 * 1024 * 1024)?)?;
    let cancel = CancellationToken::new();
    let upstream = if let Some(path) = inventory_path {
        parse_inventory(&read(&path, MAX_INVENTORY_BYTES as u64)?)?
    } else {
        tokio::select! {
            signal=tokio::signal::ctrl_c()=>{signal?;cancel.cancel();return Err(io::Error::new(io::ErrorKind::Interrupted,"coverage cancelled").into());},
            result=rigspark_runtime::coverage::fetch_inventory(&cancel)=>result?,
        }
    };
    let monitored = monitored(&catalog, &upstream)?;
    let coverage = evaluate(&catalog, &monitored)?;
    let human = format!(
        "Catalog coverage\n  upstream: {}\n  covered:  {}\n  missing:  {}",
        coverage.upstream_count,
        coverage.covered_count,
        coverage.missing.len()
    );
    let report = Report {
        source: INVENTORY_URL,
        checked_at: rigspark_runtime::native_chat::timestamp()?,
        inventory_count: upstream.len(),
        coverage,
    };
    let json = format!("{}\n", serde_json::to_string(&report)?);
    let summary_text = summary
        .as_ref()
        .map(|path| -> io::Result<String> {
            let previous = if path.try_exists()? {
                read(path, 1024 * 1024)?
            } else {
                String::new()
            };
            Ok(format!(
                "{previous}### Catalog coverage\n\n```\n{human}\n```\n"
            ))
        })
        .transpose()?;
    write(&out, &json)?;
    if let (Some(path), Some(text)) = (summary, summary_text) {
        write(&path, &text)?;
    }
    eprintln!("{human}");
    if args.json {
        print!("{json}");
    }
    Ok(())
}

#[tokio::main]
async fn main() -> ExitCode {
    match run(Args::parse()).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!(
                "catalog-coverage failed: {}",
                strip_control(&error.to_string())
            );
            ExitCode::FAILURE
        }
    }
}
