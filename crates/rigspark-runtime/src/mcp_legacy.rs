use crate::mcp::{McpError, loopback_url};
use futures_util::{StreamExt, stream::BoxStream};
use rmcp::{
    RoleClient,
    model::{ClientJsonRpcMessage, ServerJsonRpcMessage},
    transport::Transport,
};
use tokio_util::sync::CancellationToken;

pub(crate) struct LegacySse {
    client: reqwest_mcp::Client,
    endpoint: url::Url,
    events: Option<BoxStream<'static, Result<sse_stream::Sse, sse_stream::Error>>>,
    cancel: CancellationToken,
}

fn endpoint(base: &url::Url, target: &str) -> Result<url::Url, McpError> {
    if target.len() > 2048 || target.chars().any(char::is_control) {
        return Err(McpError::Invalid);
    }
    let endpoint = base.join(target).map_err(|_| McpError::Invalid)?;
    loopback_url(endpoint.as_str())?;
    if endpoint.origin() != base.origin() || endpoint.fragment().is_some() {
        return Err(McpError::Invalid);
    }
    Ok(endpoint)
}

impl LegacySse {
    pub(crate) async fn open(
        client: reqwest_mcp::Client,
        url: url::Url,
        cancel: &CancellationToken,
    ) -> Result<Self, McpError> {
        loopback_url(url.as_str())?;
        let response = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(McpError::Cancelled),
            response = client.get(url.clone()).header("accept", "text/event-stream").send() => response.map_err(|_| McpError::Transport)?,
        };
        if !response.status().is_success()
            || response
                .headers()
                .get("content-type")
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.split(';').next())
                .is_none_or(|value| value.trim() != "text/event-stream")
        {
            return Err(McpError::Transport);
        }
        let mut events = crate::mcp_framing::events(response.bytes_stream());
        for _ in 0..32 {
            let event = tokio::select! {
                biased;
                _ = cancel.cancelled() => return Err(McpError::Cancelled),
                event = events.next() => event.ok_or(McpError::Transport)?.map_err(|_| McpError::Transport)?,
            };
            if event.event.as_deref() == Some("endpoint") {
                let endpoint = endpoint(&url, event.data.as_deref().ok_or(McpError::Invalid)?)?;
                return Ok(Self {
                    client,
                    endpoint,
                    events: Some(events),
                    cancel: cancel.child_token(),
                });
            }
        }
        Err(McpError::Limit)
    }
}

impl Drop for LegacySse {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}

impl Transport<RoleClient> for LegacySse {
    type Error = McpError;
    fn send(
        &mut self,
        message: ClientJsonRpcMessage,
    ) -> impl Future<Output = Result<(), McpError>> + Send + 'static {
        let client = self.client.clone();
        let endpoint = self.endpoint.clone();
        let cancel = self.cancel.clone();
        async move {
            let body = serde_json::to_vec(&message).map_err(|_| McpError::Invalid)?;
            if body.len() > 1048576 {
                return Err(McpError::Limit);
            }
            let response = tokio::select! {
                biased;
                _ = cancel.cancelled() => return Err(McpError::Cancelled),
                response = client.post(endpoint).header("content-type", "application/json").body(body).send() => response.map_err(|_| McpError::Transport)?,
            };
            if response.status().is_success() {
                Ok(())
            } else {
                Err(McpError::Transport)
            }
        }
    }
    async fn receive(&mut self) -> Option<ServerJsonRpcMessage> {
        let events = self.events.as_mut()?;
        loop {
            let event = tokio::select! {
                biased;
                _ = self.cancel.cancelled() => return None,
                event = events.next() => event?.ok()?,
            };
            if event.event.as_deref().is_none_or(|kind| kind == "message") {
                return serde_json::from_str(event.data.as_deref()?).ok();
            }
        }
    }
    async fn close(&mut self) -> Result<(), McpError> {
        self.cancel.cancel();
        self.events.take();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_endpoint_cannot_change_origin() {
        let base = loopback_url("http://127.0.0.1:3000/sse").unwrap();
        assert_eq!(
            endpoint(&base, "/messages?session=x").unwrap().path(),
            "/messages"
        );
        for target in [
            "http://127.0.0.1:4000/messages",
            "https://example.com/messages",
            "http://localhost:3000/messages",
            "//127.0.0.1:4000/messages",
            "/messages#fragment",
            "http://user@127.0.0.1:3000/messages",
        ] {
            assert!(endpoint(&base, target).is_err(), "{target}");
        }
    }
}
