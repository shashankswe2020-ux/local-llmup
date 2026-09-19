use clap::Parser;
use llmup_core::{
    catalog::Catalog,
    enrich::{Mode, enrich, parse_candidates},
    reports::strip_control,
};
use llmup_runtime::secure_fs::Directory;
use std::{
    error::Error,
    io,
    path::{Path, PathBuf},
    process::ExitCode,
};

#[derive(Parser)]
#[command(about = "Incrementally refresh a catalog from the offline registry snapshot")]
struct Args {
    #[arg(long, default_value = "data/models.json")]
    catalog_path: PathBuf,
    #[arg(long)]
    now: Option<String>,
}

fn run(args: Args) -> Result<(), Box<dyn Error>> {
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
    let original = directory.read(name, 16 * 1024 * 1024, false)?;
    let catalog = Catalog::parse(std::str::from_utf8(&original)?)?;
    let candidates = parse_candidates(include_str!(
        "../../llmup-core/fixtures/registry-snapshot.json"
    ))?;
    let now = args
        .now
        .map(Ok)
        .unwrap_or_else(llmup_runtime::native_chat::timestamp)?;
    let result = enrich(&catalog, &candidates, Mode::Incremental, &now, None)?;
    if serde_json::to_value(&catalog)? != serde_json::to_value(&result.catalog)? {
        let encoded = format!("{}\n", serde_json::to_string_pretty(&result.catalog)?);
        Catalog::parse(&encoded)?;
        if directory.read(name, 16 * 1024 * 1024, false)? != original {
            return Err(
                io::Error::other("catalog changed while refresh was being prepared").into(),
            );
        }
        directory.write(name, encoded.as_bytes(), false, true)?;
    }
    let diff = result.diff;
    eprintln!(
        "catalog-refresh: added={} updated={} removed={} skipped={} capped={}",
        diff.added.len(),
        diff.updated.len(),
        diff.removed.len(),
        diff.skipped.len(),
        diff.capped.len()
    );
    Ok(())
}

fn main() -> ExitCode {
    match run(Args::parse()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("catalog-refresh: {}", strip_control(&error.to_string()));
            ExitCode::FAILURE
        }
    }
}
