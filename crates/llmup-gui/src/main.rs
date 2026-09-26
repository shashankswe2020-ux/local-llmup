use std::{io::Write, process::ExitCode};

fn write_advice(
    result: Result<llmup_gui::models::AdviceResponse, llmup_gui::models::AdviceError>,
) -> ExitCode {
    let success = result.is_ok();
    let response = match result {
        Ok(response) => serde_json::to_vec(&response),
        Err(error) => serde_json::to_vec(&serde_json::json!({"error":{"code":error}})),
    };
    let Ok(mut response) = response else {
        return ExitCode::FAILURE;
    };
    response.push(b'\n');
    let mut stdout = std::io::stdout().lock();
    if stdout
        .write_all(&response)
        .and_then(|()| stdout.flush())
        .is_err()
        || !success
    {
        return ExitCode::FAILURE;
    }
    ExitCode::SUCCESS
}

#[tokio::main]
async fn main() -> Result<ExitCode, Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    let advice_requested = args.iter().any(|arg| {
        arg.to_str()
            .is_some_and(|arg| arg == "--advice-json" || arg.starts_with("--advice-json="))
    });
    let args = args
        .into_iter()
        .map(|arg| {
            arg.into_string()
                .map_err(|_| llmup_gui::options::StartupError::Arguments)
        })
        .collect::<Result<Vec<_>, _>>();
    let options = match args.and_then(llmup_gui::options::StartupOptions::parse) {
        Ok(options) => options,
        Err(_) if advice_requested => {
            return Ok(write_advice(Err(
                llmup_gui::models::AdviceError::InvalidArguments,
            )));
        }
        Err(error) => return Err(error.into()),
    };
    if options.advice_json() {
        return Ok(write_advice(llmup_gui::models::advice_json(
            std::io::stdin().lock(),
        )));
    }
    if options.version() {
        println!("llmup-gui {}", env!("CARGO_PKG_VERSION"));
        return Ok(ExitCode::SUCCESS);
    }
    let environment_harness = if options.needs_environment_harness() {
        std::env::var_os("LOCAL_LLMUP_HARNESS")
            .map(|name| {
                name.into_string()
                    .map_err(|_| "invalid GUI harness encoding")
            })
            .transpose()?
    } else {
        None
    };
    let config = llmup_runtime::state::Config::load()?;
    let listener =
        tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, options.port())).await?;
    let host = options
        .create_host(
            &config.home,
            listener.local_addr()?.port(),
            environment_harness.as_deref(),
        )
        .await?;
    writeln!(std::io::stdout(), "{}", options.readiness(&host).await?)?;
    std::io::stdout().flush()?;
    let shutdown = host.shutdown.clone();
    tokio::spawn(async move {
        let _ = tokio::signal::ctrl_c().await;
        shutdown.cancel();
    });
    llmup_gui::serve(listener, host).await?;
    Ok(ExitCode::SUCCESS)
}
