use std::{io::Write, process::ExitCode};

fn write_advice(
    result: Result<rigspark_gui::models::AdviceResponse, rigspark_gui::models::AdviceError>,
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
                .map_err(|_| rigspark_gui::options::StartupError::Arguments)
        })
        .collect::<Result<Vec<_>, _>>();
    let options = match args.and_then(rigspark_gui::options::StartupOptions::parse) {
        Ok(options) => options,
        Err(_) if advice_requested => {
            return Ok(write_advice(Err(
                rigspark_gui::models::AdviceError::InvalidArguments,
            )));
        }
        Err(error) => return Err(error.into()),
    };
    if options.advice_json() {
        return Ok(write_advice(rigspark_gui::models::advice_json(
            std::io::stdin().lock(),
        )));
    }
    if options.version() {
        println!("rigspark-gui {}", env!("CARGO_PKG_VERSION"));
        return Ok(ExitCode::SUCCESS);
    }
    let environment_harness = if options.needs_environment_harness() {
        std::env::var_os("RIGSPARK_HARNESS")
            .map(|name| {
                name.into_string()
                    .map_err(|_| "invalid GUI harness encoding")
            })
            .transpose()?
    } else {
        None
    };
    let config = rigspark_runtime::state::Config::load()?;
    // Handlers must exist before readiness is announced, or an early signal kills the host uncleanly.
    #[cfg(unix)]
    let (mut interrupt, mut terminate, mut hangup) = {
        use tokio::signal::unix::{SignalKind, signal};
        (
            signal(SignalKind::interrupt())?,
            signal(SignalKind::terminate())?,
            signal(SignalKind::hangup())?,
        )
    };
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
        #[cfg(unix)]
        tokio::select! {
            _ = interrupt.recv() => {},
            _ = terminate.recv() => {},
            _ = hangup.recv() => {},
        }
        #[cfg(not(unix))]
        let _ = tokio::signal::ctrl_c().await;
        shutdown.cancel();
    });
    rigspark_gui::serve(listener, host).await?;
    Ok(ExitCode::SUCCESS)
}
