use std::io::Write;
use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args == ["--version"] {
        println!(
            "llmup-fit-parity/{} experimental",
            env!("CARGO_PKG_VERSION")
        );
        return ExitCode::SUCCESS;
    }
    if args == ["--help"] {
        println!(
            "Experimental Rust sizing parity runner. Reads a JSON array from stdin (8 MiB / 4096 requests maximum). Not the production local-llmup CLI."
        );
        return ExitCode::SUCCESS;
    }
    if !args.is_empty() {
        eprintln!("Unknown arguments; use --help");
        return ExitCode::from(2);
    }
    match llmup_cli::run(std::io::stdin().lock(), std::io::stdout().lock()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            let mut stderr = std::io::stderr().lock();
            let _ = serde_json::to_writer(&mut stderr, &error);
            let _ = writeln!(stderr);
            ExitCode::from(1)
        }
    }
}
