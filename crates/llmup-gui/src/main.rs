#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let port = match args.next().as_deref() {
        None => 0,
        Some("--port") => args.next().ok_or("missing port")?.parse::<u16>()?,
        _ => return Err("usage: llmup-gui [--port PORT]".into()),
    };
    if args.next().is_some() {
        return Err("unexpected argument".into());
    }
    let config = llmup_runtime::state::Config::load()?;
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await?;
    let host = llmup_gui::Host::new(&config.home, listener.local_addr()?.port())?;
    println!("{}", host.origin());
    let shutdown = host.shutdown.clone();
    tokio::spawn(async move {
        let _ = tokio::signal::ctrl_c().await;
        shutdown.cancel();
    });
    llmup_gui::serve(listener, host).await?;
    Ok(())
}
