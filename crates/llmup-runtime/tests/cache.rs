use llmup_core::sizing::KvCacheType::{self, F16, Q4_0, Q8_0};
use llmup_runtime::cache::{
    CacheError, CacheProfile, FlashAttention, PromptReuse, SpawnDelta, provider,
};
use std::collections::BTreeMap;

fn profile(kv_k: KvCacheType, kv_v: KvCacheType, flash: FlashAttention) -> CacheProfile {
    CacheProfile {
        kv_k,
        kv_v,
        flash_attention: flash,
        prompt_reuse: PromptReuse::Off,
    }
}

fn apply(profile: &CacheProfile, backend: &str, owned: bool) -> Result<SpawnDelta, CacheError> {
    provider("native").unwrap().apply(profile, backend, owned)
}

fn args(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| value.to_string()).collect()
}

fn env(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs
        .iter()
        .map(|(key, value)| (key.to_string(), value.to_string()))
        .collect()
}

#[test]
fn the_default_profile_changes_nothing_on_any_backend() {
    for backend in ["ollama", "llamacpp", "mlx", "lmstudio"] {
        for owned in [true, false] {
            assert_eq!(
                apply(&CacheProfile::default(), backend, owned).unwrap(),
                SpawnDelta::default(),
                "{backend} owned={owned}"
            );
        }
    }
}

#[test]
fn llama_cpp_receives_exact_cache_flags() {
    let cases = [
        (
            profile(Q8_0, Q8_0, FlashAttention::Auto),
            args(&[
                "--cache-type-k",
                "q8_0",
                "--cache-type-v",
                "q8_0",
                "--flash-attn",
                "on",
            ]),
        ),
        (
            profile(Q4_0, F16, FlashAttention::Auto),
            args(&["--cache-type-k", "q4_0"]),
        ),
        (
            profile(F16, Q4_0, FlashAttention::On),
            args(&["--cache-type-v", "q4_0", "--flash-attn", "on"]),
        ),
        (
            profile(F16, F16, FlashAttention::Off),
            args(&["--flash-attn", "off"]),
        ),
    ];
    for (profile, expected) in cases {
        let delta = apply(&profile, "llamacpp", true).unwrap();
        assert_eq!(delta.args, expected, "{profile:?}");
        assert!(delta.env.is_empty());
    }
    let reuse = CacheProfile {
        prompt_reuse: PromptReuse::Reuse,
        ..CacheProfile::default()
    };
    assert_eq!(
        apply(&reuse, "llamacpp", true).unwrap().args,
        args(&["--cache-reuse", "256"])
    );
}

#[test]
fn a_quantized_v_cache_without_flash_attention_is_rejected() {
    for backend in ["llamacpp", "ollama"] {
        for kind in [Q8_0, Q4_0] {
            assert!(
                matches!(
                    apply(&profile(kind, kind, FlashAttention::Off), backend, true),
                    Err(CacheError::Invalid(_))
                ),
                "{backend} {kind:?}"
            );
        }
    }
    assert!(apply(&profile(Q8_0, F16, FlashAttention::Off), "llamacpp", true).is_ok());
}

#[test]
fn owned_ollama_daemons_receive_cache_environment() {
    assert_eq!(
        apply(&profile(Q8_0, Q8_0, FlashAttention::Auto), "ollama", true).unwrap(),
        SpawnDelta {
            args: vec![],
            env: env(&[
                ("OLLAMA_FLASH_ATTENTION", "1"),
                ("OLLAMA_KV_CACHE_TYPE", "q8_0")
            ]),
        }
    );
    assert_eq!(
        apply(&profile(F16, F16, FlashAttention::Off), "ollama", true)
            .unwrap()
            .env,
        env(&[("OLLAMA_FLASH_ATTENTION", "0")])
    );
    let reuse = CacheProfile {
        prompt_reuse: PromptReuse::Reuse,
        ..CacheProfile::default()
    };
    assert_eq!(
        apply(&reuse, "ollama", false).unwrap(),
        SpawnDelta::default(),
        "Ollama reuses cached prompt prefixes by default"
    );
}

#[test]
fn ollama_refuses_settings_it_cannot_apply() {
    assert!(matches!(
        apply(&profile(Q8_0, Q8_0, FlashAttention::Auto), "ollama", false),
        Err(CacheError::Unsupported {
            backend: "ollama",
            ..
        })
    ));
    assert!(matches!(
        apply(&profile(F16, F16, FlashAttention::On), "ollama", false),
        Err(CacheError::Unsupported {
            backend: "ollama",
            ..
        })
    ));
    assert!(matches!(
        apply(&profile(Q8_0, F16, FlashAttention::Auto), "ollama", true),
        Err(CacheError::Unsupported {
            backend: "ollama",
            ..
        })
    ));
}

#[test]
fn unverified_and_attach_only_backends_fail_closed() {
    let quantized = profile(Q8_0, Q8_0, FlashAttention::Auto);
    assert!(matches!(
        apply(&quantized, "mlx", true),
        Err(CacheError::Unverified { backend: "mlx" })
    ));
    assert!(matches!(
        apply(&quantized, "lmstudio", false),
        Err(CacheError::Unsupported {
            backend: "lmstudio",
            ..
        })
    ));
    assert!(matches!(
        apply(&CacheProfile::default(), "vllm", true),
        Err(CacheError::Invalid(_))
    ));
}

#[test]
fn providers_are_selected_by_name_from_a_fixed_registry() {
    assert_eq!(provider("native").unwrap().name(), "native");
    for name in ["", "Native", "lmcache", "custom", "../native"] {
        assert!(provider(name).is_none(), "{name:?}");
    }
}

#[test]
fn profiles_serialize_with_stable_names_and_reject_unknown_fields() {
    let value = serde_json::to_value(profile(Q8_0, Q4_0, FlashAttention::On)).unwrap();
    assert_eq!(
        value,
        serde_json::json!({"kvK":"q8_0","kvV":"q4_0","flashAttention":"on","promptReuse":"off"})
    );
    let parsed: CacheProfile = serde_json::from_value(value).unwrap();
    assert_eq!(parsed, profile(Q8_0, Q4_0, FlashAttention::On));
    assert_eq!(
        serde_json::from_value::<CacheProfile>(serde_json::json!({})).unwrap(),
        CacheProfile::default()
    );
    assert!(
        serde_json::from_value::<CacheProfile>(serde_json::json!({"kvK":"q8_0","args":"--x"}))
            .is_err()
    );
}
