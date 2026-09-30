use clap::Parser;
use rigspark_runtime::{
    catalog_proposals::{NativeProposalTransport, ProposalTransport, RecordedProposals, collect},
    secure_fs::Directory,
};
use std::{
    error::Error,
    path::{Path, PathBuf},
    process::ExitCode,
};
use tokio_util::sync::CancellationToken;

#[derive(Parser)]
#[command(
    about = "Collect unverified catalog candidates from official registry metadata for review"
)]
struct Args {
    #[arg(long, default_value = "crates/rigspark-core/data/models.json")]
    catalog_path: PathBuf,
    #[arg(long, default_value = "catalog-proposals.json")]
    out: PathBuf,
    #[arg(long, default_value_t = 10, value_parser = clap::value_parser!(u8).range(1..=10))]
    limit: u8,
    #[arg(long)]
    fixture: Option<PathBuf>,
    #[arg(long)]
    now: Option<String>,
}

fn path(raw: &Path) -> Result<PathBuf, Box<dyn Error>> {
    let absolute = std::path::absolute(raw)?;
    Ok(absolute
        .parent()
        .ok_or("parent required")?
        .canonicalize()?
        .join(absolute.file_name().ok_or("filename required")?))
}

fn read(raw: &Path) -> Result<String, Box<dyn Error>> {
    let path = path(raw)?;
    Ok(String::from_utf8(
        Directory::open(path.parent().ok_or("parent required")?)?.read(
            Path::new(path.file_name().ok_or("filename required")?),
            16 * 1024 * 1024,
            false,
        )?,
    )?)
}

async fn run(args: Args) -> Result<(), Box<dyn Error>> {
    let output = path(&args.out)?;
    if output == path(&args.catalog_path)?
        || args
            .fixture
            .as_ref()
            .map(|fixture| path(fixture))
            .transpose()?
            .as_ref()
            == Some(&output)
    {
        return Err("output must not replace inputs".into());
    }
    let catalog = rigspark_core::catalog::Catalog::parse(&read(&args.catalog_path)?)?;
    let cancel = CancellationToken::new();
    let (inventory, transport): (_, Box<dyn ProposalTransport>) = match args.fixture {
        Some(fixture) => {
            let recorded: RecordedProposals =
                rigspark_core::catalog::parse_document(&read(&fixture)?)?;
            (recorded.inventory.clone(), Box::new(recorded))
        }
        None => {
            let transport = NativeProposalTransport::new(
                std::env::var("OPENAI_API_KEY").ok(),
                std::env::var("OPENAI_CATALOG_MODEL").ok(),
            )?;
            (
                rigspark_runtime::coverage::fetch_inventory(&cancel).await?,
                Box::new(transport),
            )
        }
    };
    let now = args
        .now
        .map(Ok)
        .unwrap_or_else(rigspark_runtime::native_chat::timestamp)?;
    let report = collect(
        &catalog,
        &inventory,
        usize::from(args.limit),
        &now,
        transport.as_ref(),
    )
    .await?;
    let bytes = serde_json::to_vec_pretty(&report)?;
    if bytes.len() > 16 * 1024 * 1024 {
        return Err("proposal report exceeds limit".into());
    }
    let directory = Directory::open(output.parent().ok_or("parent required")?)?;
    let exists = output.try_exists()?;
    directory.write(
        Path::new(output.file_name().ok_or("filename required")?),
        &bytes,
        !exists,
        exists,
    )?;
    eprintln!(
        "catalog-propose: {} candidates; review required; inventory incomplete",
        report.proposals.len()
    );
    Ok(())
}

#[tokio::main]
async fn main() -> ExitCode {
    match run(Args::parse()).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(_) => {
            eprintln!(
                "catalog-propose: failed; check inputs, output path, and upstream availability (details redacted)"
            );
            ExitCode::FAILURE
        }
    }
}
