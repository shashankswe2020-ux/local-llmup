use clap::Parser;
use llmup_core::{
    catalog::Catalog,
    enrich::{Mode, enrich, parse_candidates},
    freshness::{STALE_AFTER_DAYS, evaluate, format_report},
    reports::strip_control,
};
use llmup_runtime::secure_fs::Directory;
use std::{
    error::Error,
    fs, io,
    path::{Path, PathBuf},
    process::ExitCode,
};

#[derive(Parser)]
#[command(about = "Report catalog age and offline registry drift without changing the catalog")]
struct Args {
    #[arg(long, default_value = "data/models.json")]
    catalog_path: PathBuf,
    #[arg(long, default_value = "catalog-freshness.json")]
    out: PathBuf,
    #[arg(long)]
    json: bool,
    #[arg(long)]
    now: Option<String>,
}

fn checked_path(path: &Path) -> io::Result<PathBuf> {
    let absolute = std::path::absolute(path)?;
    let parent = absolute
        .parent()
        .ok_or_else(|| io::Error::other("file parent required"))?;
    let name = absolute
        .file_name()
        .ok_or_else(|| io::Error::other("file name required"))?;
    let path = parent.canonicalize()?.join(name);
    match fs::symlink_metadata(&path) {
        Ok(metadata) if !metadata.is_file() || metadata.file_type().is_symlink() => Err(
            io::Error::other("report and catalog paths must be regular files"),
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
            .ok_or_else(|| io::Error::other("missing name"))?,
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
            .ok_or_else(|| io::Error::other("missing name"))?,
    );
    let exists = path.try_exists()?;
    directory.write(name, text.as_bytes(), !exists, exists)
}

fn run(args: Args) -> Result<(), Box<dyn Error>> {
    let catalog_path = checked_path(&args.catalog_path)?;
    let out = checked_path(&args.out)?;
    let summary = std::env::var_os("GITHUB_STEP_SUMMARY")
        .filter(|value| !value.is_empty())
        .map(|value| checked_path(Path::new(&value)))
        .transpose()?;
    if out == catalog_path
        || summary
            .as_ref()
            .is_some_and(|path| path == &catalog_path || path == &out)
    {
        return Err(io::Error::other("catalog, report, and summary paths must be distinct").into());
    }
    let catalog = Catalog::parse(&read(&catalog_path, 16 * 1024 * 1024)?)?;
    let candidates = parse_candidates(include_str!(
        "../../llmup-core/fixtures/registry-snapshot.json"
    ))?;
    let now = args
        .now
        .map(Ok)
        .unwrap_or_else(llmup_runtime::native_chat::timestamp)?;
    let refreshed = enrich(&catalog, &candidates, Mode::Incremental, &now, None)?;
    let report = evaluate(
        &catalog.generated_at,
        &refreshed.diff,
        &now,
        STALE_AFTER_DAYS,
    )?;
    let human = format_report(&report);
    let summary_text = summary
        .as_ref()
        .map(|path| -> io::Result<String> {
            let previous = if path.try_exists()? {
                read(path, 1024 * 1024)?
            } else {
                String::new()
            };
            Ok(format!(
                "{previous}### Catalog freshness\n\n```\n{human}\n```\n"
            ))
        })
        .transpose()?;
    let json = format!("{}\n", serde_json::to_string(&report)?);
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

fn main() -> ExitCode {
    match run(Args::parse()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{}", strip_control(&error.to_string()));
            ExitCode::FAILURE
        }
    }
}
