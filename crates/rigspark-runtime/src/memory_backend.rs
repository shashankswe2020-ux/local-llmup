use crate::{
    identity::ProcessProbe,
    lifecycle::Registry,
    memory::{Embedder, EmbeddingOutput, MemoryError},
    state::StateStore,
};
use tokio_util::sync::CancellationToken;

pub struct BackendEmbedder<'runtime> {
    pub state: &'runtime StateStore,
    pub registry: &'runtime Registry<'runtime>,
    pub probe: &'runtime dyn ProcessProbe,
    pub model: String,
}
#[async_trait::async_trait]
impl Embedder for BackendEmbedder<'_> {
    fn model(&self) -> &str {
        &self.model
    }
    async fn embed(
        &self,
        texts: &[String],
        cancel: &CancellationToken,
    ) -> Result<EmbeddingOutput, MemoryError> {
        let prior = self.state.read()?;
        let mut active = prior
            .active
            .clone()
            .ok_or_else(|| MemoryError("no active embedding backend".into()))?;
        let adapter = self
            .registry
            .get(&active.backend)
            .map_err(|_| MemoryError("embedding backend unavailable".into()))?;
        if !adapter.can_embed() {
            return Err(MemoryError("embedding backend unsupported".into()));
        }
        let listener = crate::process_control::listener(self.probe, &active.endpoint, cancel)
            .await
            .map_err(|_| MemoryError("embedding identity unavailable".into()))?;
        let live = crate::identity::capture(&active, &listener, adapter.trusts(&listener.identity))
            .map_err(|_| MemoryError("embedding identity changed".into()))?;
        active.pid = Some(live.expected.pid);
        active.process_executable = Some(live.expected.executable);
        active.process_started_at = Some(live.expected.started);
        let output = adapter
            .embed(&active, &self.model, texts, cancel)
            .await
            .map_err(|_| MemoryError("embedding request failed".into()))?;
        if self.state.read()? != prior {
            return Err(MemoryError("embedding backend changed".into()));
        }
        Ok(EmbeddingOutput {
            vectors: output.vectors,
            dimension: output.dimension,
        })
    }
}
