use serde::Deserialize;
use serde_json::{Value, json};
fn version(raw: &str) -> Option<[u64; 3]> {
    let parts: Vec<_> = raw.strip_prefix('v').unwrap_or(raw).split('.').collect();
    if parts.len() != 3 {
        return None;
    }
    let mut result = [0; 3];
    for (index, part) in parts.iter().enumerate() {
        if part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        result[index] = part.parse().ok()?;
        if result[index] > 9007199254740991 {
            return None;
        }
    }
    Some(result)
}
pub fn status(current: &str, tag: Option<&str>) -> Value {
    let unknown = || json!({"currentVersion":current,"latestVersion":null,"state":"unknown","releaseUrl":null});
    let Some((installed, latest)) = version(current).zip(tag.and_then(version)) else {
        return unknown();
    };
    let newer = latest > installed;
    json!({"currentVersion":current,"latestVersion":tag.unwrap_or("").trim_start_matches('v'),"state":if newer{"update-available"}else{"current"},"releaseUrl":if newer{Some("https://github.com/shashankswe2020-ux/local-llmup/releases")}else{None}})
}
pub async fn fetch() -> Value {
    let current = env!("CARGO_PKG_VERSION");
    let operation = async {
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(3))
            .build()
            .ok()?;
        let mut response = client
            .get("https://api.github.com/repos/shashankswe2020-ux/local-llmup/releases/latest")
            .header("accept", "application/vnd.github+json")
            .header("user-agent", "local-llmup-native")
            .send()
            .await
            .ok()?;
        if !response.status().is_success() {
            return None;
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.ok()? {
            if bytes.len() + chunk.len() > 65536 {
                return None;
            }
            bytes.extend_from_slice(&chunk);
        }
        #[derive(Deserialize)]
        struct Release {
            tag_name: String,
        }
        serde_json::from_slice::<Release>(&bytes)
            .ok()
            .map(|release| release.tag_name)
    };
    let tag = tokio::time::timeout(std::time::Duration::from_secs(3), operation)
        .await
        .ok()
        .flatten();
    status(current, tag.as_deref())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn release_comparison_is_bounded_and_honest() {
        assert_eq!(
            status("0.11.4", Some("v0.12.0"))["state"],
            "update-available"
        );
        assert_eq!(status("0.11.4", Some("0.11.3"))["state"], "current");
        assert_eq!(status("0.11.4", Some("0.12.0-beta"))["state"], "unknown");
        assert_eq!(status("0.11.4", None)["releaseUrl"], Value::Null);
    }
}
