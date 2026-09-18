use llmup_runtime::application::LifecycleOptions;
#[test]
fn lifecycle_options_reject_invalid_or_unsupported_combinations() {
    let mut options = LifecycleOptions {
        command: "up".into(),
        model: Some("test:latest".into()),
        backend: Some("ollama".into()),
        port: Some(11435),
        context: Some(8192),
        installed: false,
        bypass: false,
    };
    options.validate().unwrap();
    options.port = Some(0);
    assert!(options.validate().is_err());
    options.port = Some(11435);
    options.context = Some(0);
    assert!(options.validate().is_err());
    options.context = None;
    options.installed = true;
    assert!(options.validate().is_err());
    options.bypass = true;
    options.validate().unwrap();
    options.backend = Some("unknown".into());
    assert!(options.validate().is_err());
}

#[test]
fn mlx_platform_gate_is_applied_before_preparation() {
    use llmup_core::sizing::{CpuArch, Platform};
    assert!(
        llmup_runtime::application::validate_backend_platform("mlx", Platform::Linux, CpuArch::X64)
            .is_err()
    );
    assert!(
        llmup_runtime::application::validate_backend_platform(
            "mlx",
            Platform::Darwin,
            CpuArch::X64
        )
        .is_err()
    );
    llmup_runtime::application::validate_backend_platform("mlx", Platform::Darwin, CpuArch::Arm64)
        .unwrap();
    llmup_runtime::application::validate_backend_platform("ollama", Platform::Linux, CpuArch::X64)
        .unwrap();
}

#[test]
fn catalog_quantization_suffixes_reach_the_resolver() {
    let options = LifecycleOptions {
        command: "up".into(),
        model: Some("llama3.1:8b-Q4_K_M".into()),
        backend: Some("ollama".into()),
        port: None,
        context: None,
        installed: false,
        bypass: false,
    };
    options.validate().unwrap();
}
