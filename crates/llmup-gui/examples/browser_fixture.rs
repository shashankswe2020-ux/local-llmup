use llmup_gui::{Host, engine::Engine};
use llmup_runtime::harness::{DeltaSink, HarnessError, HarnessRequest};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

struct Fixture;
#[async_trait::async_trait]
impl Engine for Fixture {
    async fn chat(
        &self,
        _: &str,
        request: &HarnessRequest,
        cancel: &CancellationToken,
        sink: &mut DeltaSink<'_>,
    ) -> Result<String, HarnessError> {
        let message = &request
            .messages
            .last()
            .ok_or(HarnessError::Invalid)?
            .content;
        if message == "cancel this response" {
            sink("Pending fixture response")?;
            cancel.cancelled().await;
            return Err(HarnessError::Cancelled);
        }
        let reply = format!("Native reply: {message}");
        for word in reply.split_inclusive(' ') {
            if cancel.is_cancelled() {
                return Err(HarnessError::Cancelled);
            }
            sink(word)?;
            tokio::task::yield_now().await;
        }
        Ok(reply)
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let home = tempfile::tempdir()?;
    let port = std::env::var("RUST_GUI_TEST_PORT")
        .unwrap_or_else(|_| "4322".into())
        .parse::<u16>()?;
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await?;
    let host = Host::with_engine(home.path(), port, Arc::new(Fixture))?;
    let shutdown = host.shutdown.clone();
    tokio::spawn(async move {
        let _ = tokio::signal::ctrl_c().await;
        shutdown.cancel();
    });
    llmup_gui::serve(listener, host).await?;
    Ok(())
}
