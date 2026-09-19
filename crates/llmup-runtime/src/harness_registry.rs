use crate::harness::{
    ChatHarness, DeltaSink, HarnessError, HarnessRequest, LocalHarness, Provider, RemoteHarness,
    RemoteTransport, Secret,
};
use crate::opencode::{OpenCodeHarness, OpenCodeRunner};
use std::collections::{BTreeMap, HashSet};
use tokio_util::sync::CancellationToken;

pub struct HarnessRegistry<'runtime> {
    harnesses: Vec<Box<dyn ChatHarness + 'runtime>>,
}
impl<'runtime> HarnessRegistry<'runtime> {
    pub fn new(harnesses: Vec<Box<dyn ChatHarness + 'runtime>>) -> Result<Self, HarnessError> {
        let mut names = HashSet::new();
        if harnesses.len() > 32
            || harnesses
                .iter()
                .any(|harness| !names.insert(harness.name()))
        {
            return Err(HarnessError::Invalid);
        }
        Ok(Self { harnesses })
    }
    pub fn all(&self) -> Vec<&str> {
        self.harnesses
            .iter()
            .map(|harness| harness.name())
            .collect()
    }
    pub fn get(&self, name: &str) -> Result<&dyn ChatHarness, HarnessError> {
        self.harnesses
            .iter()
            .find(|harness| harness.name() == name)
            .map(|harness| harness.as_ref())
            .ok_or(HarnessError::Invalid)
    }
    pub async fn available(&self) -> Vec<&str> {
        let probes = self.harnesses.iter().map(|harness| async move {
            tokio::time::timeout(std::time::Duration::from_secs(2), harness.available())
                .await
                .unwrap_or(false)
                .then_some(harness.name())
        });
        futures_util::future::join_all(probes)
            .await
            .into_iter()
            .flatten()
            .collect()
    }
    pub fn builtins(
        local: LocalHarness<'runtime>,
        transport: &'runtime dyn RemoteTransport,
        opencode: &'runtime dyn OpenCodeRunner,
        env: &BTreeMap<String, String>,
    ) -> Result<Self, HarnessError> {
        let mut harnesses: Vec<Box<dyn ChatHarness + 'runtime>> = vec![Box::new(local)];
        for (provider, name, key_name, endpoint) in [
            (
                Provider::Claude,
                "claude",
                "ANTHROPIC_API_KEY",
                Some("https://api.anthropic.com/v1/messages"),
            ),
            (
                Provider::OpenAi,
                "openai",
                "OPENAI_API_KEY",
                Some("https://api.openai.com/v1/chat/completions"),
            ),
            (
                Provider::Compatible,
                "openai-compatible",
                "OPENAI_COMPAT_API_KEY",
                env.get("OPENAI_COMPAT_BASE_URL").map(String::as_str),
            ),
        ] {
            let key = env
                .get(key_name)
                .map(|value| Secret::new(value))
                .transpose();
            let harness = match (endpoint, key) {
                (Some(endpoint), Ok(key)) if provider == Provider::Compatible || key.is_some() => {
                    RemoteHarness::new(provider, endpoint, key, transport).ok()
                }
                _ => None,
            };
            harnesses.push(match harness {
                Some(harness) => Box::new(harness),
                None => Box::new(Unavailable(name)),
            });
        }
        let unrestricted = env
            .get("LOCAL_LLMUP_OPENCODE_UNRESTRICTED")
            .is_some_and(|value| {
                ["1", "true", "yes", "on"].contains(&value.to_ascii_lowercase().as_str())
            });
        harnesses.push(Box::new(OpenCodeHarness {
            runner: opencode,
            unrestricted,
        }));
        Self::new(harnesses)
    }
}
struct Unavailable(&'static str);
#[async_trait::async_trait]
impl ChatHarness for Unavailable {
    fn name(&self) -> &'static str {
        self.0
    }
    async fn available(&self) -> bool {
        false
    }
    async fn chat(
        &self,
        _: &HarnessRequest,
        _: &CancellationToken,
        _: &mut DeltaSink<'_>,
    ) -> Result<String, HarnessError> {
        Err(HarnessError::Unavailable)
    }
}
