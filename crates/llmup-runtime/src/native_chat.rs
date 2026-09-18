use crate::{
    harness::{
        DeltaSink, HarnessError, HarnessMessage, HarnessRequest, LocalHarness,
        NativeRemoteTransport,
    },
    harness_registry::HarnessRegistry,
    library::Library,
    memory::{CaptureOptions, MemoryStore},
    memory_backend::BackendEmbedder,
    opencode::NativeOpenCodeRunner,
    process_control::minimal_env,
    state::{Config, StateStore},
};
use std::collections::BTreeMap;
use tokio_util::sync::CancellationToken;

pub struct NativeChatOptions {
    pub provider: String,
    pub model: Option<String>,
    pub message: String,
    pub agent: Option<String>,
    pub skills: Vec<String>,
    pub capture: bool,
}
pub fn timestamp() -> Result<String, HarnessError> {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .map_err(|_| HarnessError::Invalid)
}
pub async fn run(
    options: &NativeChatOptions,
    cancel: &CancellationToken,
    sink: &mut DeltaSink<'_>,
) -> Result<serde_json::Value, HarnessError> {
    if options.message.trim().is_empty() || options.message.len() > 1024 * 1024 {
        return Err(HarnessError::Invalid);
    }
    let config = Config::load().map_err(|_| HarnessError::Invalid)?;
    let state = StateStore::new(config.clone());
    let active = state.read().map_err(|_| HarnessError::Unavailable)?.active;
    let runtime = crate::native_runtime::NativeRuntime::new(config.clone())?;
    let adapters = runtime.adapters();
    let backends = adapters.registry();
    let probe = &runtime.probe;
    let remote = NativeRemoteTransport::new()?;
    let mut env: BTreeMap<String, String> = minimal_env().into_iter().collect();
    for name in [
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "OPENAI_COMPAT_BASE_URL",
        "OPENAI_COMPAT_API_KEY",
        "LOCAL_LLMUP_OPENCODE_UNRESTRICTED",
    ] {
        if let Ok(value) = std::env::var(name) {
            env.insert(name.into(), value);
        }
    }
    let opencode = NativeOpenCodeRunner {
        binary: runtime.binary("opencode"),
        env: env.clone(),
    };
    let registry = HarnessRegistry::builtins(
        LocalHarness {
            state: &state,
            registry: &backends,
            probe,
        },
        &remote,
        &opencode,
        &env,
    )?;
    let harness = registry.get(&options.provider)?;
    if !harness.available().await {
        return Err(HarnessError::Unavailable);
    }
    let model = options.model.clone().unwrap_or_else(|| {
        if options.provider == "local" {
            active
                .as_ref()
                .map(|active| {
                    active
                        .runtime_model_id
                        .clone()
                        .unwrap_or_else(|| active.model_id.clone())
                })
                .unwrap_or_default()
        } else {
            String::new()
        }
    });
    let mut messages = Vec::new();
    if let Some(prompt) = Library::new(&config.home)
        .compose(options.agent.as_deref(), &options.skills)
        .map_err(|_| HarnessError::Invalid)?
    {
        messages.push(HarnessMessage {
            role: "system".into(),
            content: prompt,
        });
    }
    let memory = if options.provider == "local" && options.capture {
        let owner = active
            .as_ref()
            .ok_or(HarnessError::Unavailable)?
            .model_id
            .clone();
        let memory = MemoryStore::open(&config.home, &owner, &timestamp()?)
            .map_err(|_| HarnessError::Invalid)?;
        let source = memory.load().map_err(|_| HarnessError::Invalid)?;
        if let Some(persona) = source.system_prompt {
            messages.push(HarnessMessage {
                role: "system".into(),
                content: persona,
            });
        }
        if source.facts_present {
            messages.push(HarnessMessage {
                role: "system".into(),
                content: source.facts_text,
            });
        }
        messages.extend(source.turns.into_iter().map(|turn| HarnessMessage {
            role: turn.role,
            content: turn.content,
        }));
        Some(memory)
    } else {
        None
    };
    messages.push(HarnessMessage {
        role: "user".into(),
        content: options.message.clone(),
    });
    let response = harness
        .chat(
            &HarnessRequest {
                model,
                messages,
                temperature: None,
            },
            cancel,
            sink,
        )
        .await?;
    let mut captured = None;
    if let Some(memory) = memory {
        let backend = active
            .as_ref()
            .ok_or(HarnessError::Unavailable)?
            .backend
            .as_str();
        let unsupported = !backends
            .get(backend)
            .map_err(|_| HarnessError::Unavailable)?
            .can_embed();
        let embedder = BackendEmbedder {
            state: &state,
            registry: &backends,
            probe,
            model: memory
                .read_meta()
                .map_err(|_| HarnessError::Invalid)?
                .embedding
                .map(|meta| meta.model)
                .unwrap_or_else(|| "nomic-embed-text".into()),
        };
        captured = Some(
            memory
                .capture(
                    &options.message,
                    &response,
                    CaptureOptions {
                        timestamp: &timestamp()?,
                        embedder: (!unsupported)
                            .then_some(&embedder as &dyn crate::memory::Embedder),
                        embedding_unsupported: unsupported,
                    },
                    cancel,
                )
                .await
                .is_ok(),
        );
    }
    Ok(serde_json::json!({"content":response,"harness":options.provider,"memoryCaptured":captured}))
}
