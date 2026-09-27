use llmup_core::sizing::KvCacheType;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FlashAttention {
    #[default]
    Auto,
    On,
    Off,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PromptReuse {
    #[default]
    Off,
    Reuse,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct CacheProfile {
    pub kv_k: KvCacheType,
    pub kv_v: KvCacheType,
    pub flash_attention: FlashAttention,
    pub prompt_reuse: PromptReuse,
}

/// Arguments and environment a cache provider adds to a backend launch.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SpawnDelta {
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CacheError {
    #[error("invalid cache profile: {0}")]
    Invalid(&'static str),
    #[error("{backend} cannot apply this cache profile: {reason}")]
    Unsupported {
        backend: &'static str,
        reason: &'static str,
    },
    #[error("{backend} cache settings are not verified yet; use the default cache profile")]
    Unverified { backend: &'static str },
}

pub trait CacheProvider: Send + Sync {
    fn name(&self) -> &'static str;
    fn apply(
        &self,
        profile: &CacheProfile,
        backend: &str,
        owned: bool,
    ) -> Result<SpawnDelta, CacheError>;
}

/// Providers are compiled in; names never load code or pass raw arguments through.
pub fn provider(name: &str) -> Option<&'static dyn CacheProvider> {
    match name {
        "native" => Some(&NativeCacheProvider),
        _ => None,
    }
}

/// Cache settings each backend already exposes (verified: llama.cpp b10090, Ollama 0.32.5).
pub struct NativeCacheProvider;

impl CacheProvider for NativeCacheProvider {
    fn name(&self) -> &'static str {
        "native"
    }
    fn apply(
        &self,
        profile: &CacheProfile,
        backend: &str,
        owned: bool,
    ) -> Result<SpawnDelta, CacheError> {
        if !llmup_core::catalog::BACKENDS.contains(&backend) {
            return Err(CacheError::Invalid("unknown backend"));
        }
        if profile.kv_v != KvCacheType::F16 && profile.flash_attention == FlashAttention::Off {
            return Err(CacheError::Invalid(
                "a quantized V cache requires flash attention",
            ));
        }
        if *profile == CacheProfile::default() {
            return Ok(SpawnDelta::default());
        }
        match backend {
            "llamacpp" => Ok(llama_cpp(profile)),
            "ollama" => ollama(profile, owned),
            "mlx" => Err(CacheError::Unverified { backend: "mlx" }),
            _ => Err(CacheError::Unsupported {
                backend: "lmstudio",
                reason: "LM Studio is attach-only; change its cache settings in LM Studio",
            }),
        }
    }
}

fn flash_enabled(profile: &CacheProfile) -> Option<bool> {
    match profile.flash_attention {
        FlashAttention::On => Some(true),
        FlashAttention::Off => Some(false),
        FlashAttention::Auto => (profile.kv_v != KvCacheType::F16).then_some(true),
    }
}

fn llama_cpp(profile: &CacheProfile) -> SpawnDelta {
    let mut args = Vec::new();
    for (flag, kind) in [
        ("--cache-type-k", profile.kv_k),
        ("--cache-type-v", profile.kv_v),
    ] {
        if kind != KvCacheType::F16 {
            args.extend([flag.to_string(), kind.name().to_string()]);
        }
    }
    if let Some(enabled) = flash_enabled(profile) {
        args.extend([
            "--flash-attn".into(),
            if enabled { "on" } else { "off" }.into(),
        ]);
    }
    if profile.prompt_reuse == PromptReuse::Reuse {
        args.extend(["--cache-reuse".into(), "256".into()]);
    }
    SpawnDelta {
        args,
        env: BTreeMap::new(),
    }
}

fn ollama(profile: &CacheProfile, owned: bool) -> Result<SpawnDelta, CacheError> {
    let unsupported = |reason| CacheError::Unsupported {
        backend: "ollama",
        reason,
    };
    if profile.kv_k != profile.kv_v {
        return Err(unsupported("Ollama uses one cache type for both K and V"));
    }
    let mut env = BTreeMap::new();
    if let Some(enabled) = flash_enabled(profile) {
        env.insert(
            "OLLAMA_FLASH_ATTENTION".into(),
            if enabled { "1" } else { "0" }.into(),
        );
    }
    if profile.kv_k != KvCacheType::F16 {
        env.insert("OLLAMA_KV_CACHE_TYPE".into(), profile.kv_k.name().into());
    }
    // Prompt-prefix reuse is Ollama's default behaviour and needs no setting.
    if !env.is_empty() && !owned {
        return Err(unsupported(
            "cache settings are daemon-wide and apply only to an Ollama daemon local-llmup starts",
        ));
    }
    Ok(SpawnDelta {
        args: Vec::new(),
        env,
    })
}
