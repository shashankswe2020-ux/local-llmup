use futures_util::stream::BoxStream;
use http::{HeaderName, HeaderValue};
use rmcp::{
    model::ClientJsonRpcMessage,
    transport::streamable_http_client::{
        SseError, StreamableHttpClient, StreamableHttpError, StreamableHttpPostResponse,
    },
};
use std::{collections::HashMap, sync::Arc};

#[derive(Clone)]
pub(crate) struct BoundedHttp(pub reqwest_mcp::Client);
type Error = StreamableHttpError<std::io::Error>;
fn invalid() -> Error {
    Error::Io(std::io::Error::other("invalid MCP HTTP response"))
}
impl BoundedHttp {
    fn request(
        &self,
        method: http::Method,
        uri: &str,
        session: Option<&str>,
        auth: Option<String>,
        headers: HashMap<HeaderName, HeaderValue>,
    ) -> Result<reqwest_mcp::RequestBuilder, Error> {
        crate::mcp::loopback_url(uri).map_err(|_| invalid())?;
        if auth.is_some()
            || headers.len() > 67
            || headers
                .iter()
                .map(|(name, value)| name.as_str().len() + value.as_bytes().len())
                .sum::<usize>()
                > 16384
            || headers.iter().any(|(name, value)| {
                (!matches!(
                    name.as_str(),
                    "mcp-protocol-version" | "mcp-method" | "mcp-name"
                ) && !name.as_str().starts_with("mcp-param-"))
                    || name.as_str().len() > 256
                    || value.as_bytes().len() > 4096
            })
        {
            return Err(invalid());
        }
        let mut request = self
            .0
            .request(method, uri)
            .header("accept", "application/json, text/event-stream");
        for (name, mut value) in headers {
            value.set_sensitive(true);
            request = request.header(name, value);
        }
        if let Some(session) = session {
            if session.is_empty()
                || session.len() > 4096
                || !session.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
            {
                return Err(invalid());
            }
            request = request.header("mcp-session-id", session);
        }
        Ok(request)
    }
}
impl StreamableHttpClient for BoundedHttp {
    type Error = std::io::Error;
    async fn post_message(
        &self,
        uri: Arc<str>,
        message: ClientJsonRpcMessage,
        session: Option<Arc<str>>,
        auth: Option<String>,
        headers: HashMap<HeaderName, HeaderValue>,
    ) -> Result<StreamableHttpPostResponse, Error> {
        let body = serde_json::to_vec(&message).map_err(|_| invalid())?;
        if body.len() > 1048576 {
            return Err(invalid());
        }
        let response = self
            .request(http::Method::POST, &uri, session.as_deref(), auth, headers)?
            .header("content-type", "application/json")
            .body(body)
            .send()
            .await
            .map_err(|_| invalid())?;
        if [202, 204].contains(&response.status().as_u16()) {
            return Ok(StreamableHttpPostResponse::Accepted);
        }
        if response.status().as_u16() == 404 && session.is_some() {
            return Err(Error::SessionExpired);
        }
        if !response.status().is_success() {
            return Err(invalid());
        }
        let session = response
            .headers()
            .get("mcp-session-id")
            .map(|value| value.to_str().map(str::to_owned))
            .transpose()
            .map_err(|_| invalid())?;
        if session.as_ref().is_some_and(|value| {
            value.is_empty()
                || value.len() > 4096
                || !value.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
        }) {
            return Err(invalid());
        }
        let kind = response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .split(';')
            .next()
            .unwrap_or("")
            .trim();
        if kind == "text/event-stream" {
            return Ok(StreamableHttpPostResponse::Sse(
                crate::mcp_framing::events(response.bytes_stream()),
                session,
            ));
        }
        if kind != "application/json" {
            return Err(invalid());
        }
        let bytes = crate::mcp_framing::json_body(response.bytes_stream())
            .await
            .map_err(Error::Io)?;
        let message = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
        Ok(StreamableHttpPostResponse::Json(message, session))
    }
    async fn delete_session(
        &self,
        uri: Arc<str>,
        session: Arc<str>,
        auth: Option<String>,
        headers: HashMap<HeaderName, HeaderValue>,
    ) -> Result<(), Error> {
        let response = self
            .request(http::Method::DELETE, &uri, Some(&session), auth, headers)?
            .send()
            .await
            .map_err(|_| invalid())?;
        if response.status().is_success() || matches!(response.status().as_u16(), 404 | 405) {
            Ok(())
        } else {
            Err(invalid())
        }
    }
    async fn get_stream(
        &self,
        uri: Arc<str>,
        session: Option<Arc<str>>,
        last: Option<String>,
        auth: Option<String>,
        headers: HashMap<HeaderName, HeaderValue>,
    ) -> Result<BoxStream<'static, Result<sse_stream::Sse, SseError>>, Error> {
        let mut request =
            self.request(http::Method::GET, &uri, session.as_deref(), auth, headers)?;
        if let Some(last) = last {
            if last.len() > 4096 {
                return Err(invalid());
            }
            request = request.header("last-event-id", last);
        }
        let response = request.send().await.map_err(|_| invalid())?;
        if response.status().as_u16() == 405 {
            return Err(Error::ServerDoesNotSupportSse);
        }
        if response.status().as_u16() == 404 && session.is_some() {
            return Err(Error::SessionExpired);
        }
        if !response.status().is_success()
            || response
                .headers()
                .get("content-type")
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.split(';').next())
                .is_none_or(|value| value.trim() != "text/event-stream")
        {
            return Err(invalid());
        }
        Ok(crate::mcp_framing::events(response.bytes_stream()))
    }
}

#[cfg(test)]
mod header_tests {
    use super::*;
    #[test]
    fn standard_sdk_headers_are_allowed_but_routing_and_credentials_are_not() {
        let client = BoundedHttp(reqwest_mcp::Client::builder().no_proxy().build().unwrap());
        let headers = [
            "mcp-protocol-version",
            "mcp-method",
            "mcp-name",
            "mcp-param-region",
        ]
        .into_iter()
        .map(|name| {
            (
                HeaderName::from_static(name),
                HeaderValue::from_static("fixture"),
            )
        })
        .collect();
        assert!(
            client
                .request(
                    http::Method::POST,
                    "http://127.0.0.1:3000/mcp",
                    None,
                    None,
                    headers
                )
                .is_ok()
        );
        for name in ["host", "authorization", "cookie", "x-forwarded-host"] {
            let headers = [(
                HeaderName::from_static(name),
                HeaderValue::from_static("fixture"),
            )]
            .into();
            assert!(
                client
                    .request(
                        http::Method::POST,
                        "http://127.0.0.1:3000/mcp",
                        None,
                        None,
                        headers
                    )
                    .is_err()
            );
        }
    }
}
