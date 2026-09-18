use crate::hardware::command_output;
use llmup_core::{
    advice::{hardware_score, unified},
    catalog::{BACKENDS, Catalog},
    reports::{gib, strip_control, table},
    sizing::{Hardware, SizingRequest, evaluate},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackendInfo {
    pub name: String,
    pub installed: bool,
    pub version: Option<String>,
    pub is_default: bool,
    pub install_hint: String,
}

pub async fn probe_backends(hardware: &Hardware) -> Vec<BackendInfo> {
    let mut result = Vec::new();
    for name in BACKENDS {
        let (program, args): (&str, &[&str]) = match name {
            "ollama" => ("ollama", &["--version"]),
            "llamacpp" => ("llama-server", &["--version"]),
            "mlx" => (
                "python3",
                &[
                    "-c",
                    "import importlib.metadata; print(importlib.metadata.version('mlx-lm'))",
                ],
            ),
            _ => ("lms", &["--version"]),
        };
        let output = if name == "mlx" && !unified(hardware) {
            None
        } else {
            command_output(program, args).await.ok()
        };
        result.push(BackendInfo {
            name: name.into(),
            installed: output.is_some(),
            version: output.map(|text| strip_control(text.trim())),
            is_default: false,
            install_hint: match name {
                "ollama" => "https://ollama.com/download",
                "llamacpp" => "https://github.com/ggml-org/llama.cpp",
                "mlx" => "python3 -m pip install mlx-lm",
                _ => "https://lmstudio.ai/download",
            }
            .into(),
        });
    }
    let priority = if unified(hardware) {
        ["mlx", "ollama", "llamacpp", "lmstudio"]
    } else {
        ["ollama", "llamacpp", "lmstudio", "mlx"]
    };
    let selected = priority
        .iter()
        .find(|name| {
            result
                .iter()
                .any(|entry| entry.name == **name && entry.installed)
        })
        .copied();
    for entry in &mut result {
        entry.is_default = selected == Some(entry.name.as_str());
    }
    result
}

pub fn report(
    catalog: &Catalog,
    hardware: &Hardware,
    backends: &[BackendInfo],
    state_exists: bool,
) -> Value {
    let usable = catalog
        .models
        .first()
        .and_then(|model| {
            evaluate(&SizingRequest {
                model: model.sizing(),
                hardware: hardware.clone(),
                context: None,
            })
            .ok()
        })
        .map_or(0.0, |sizing| sizing.usable_bytes);
    let summary = format!(
        "{}/{}, {} usable memory, {} free disk",
        if hardware.arch == llmup_core::sizing::CpuArch::Arm64 {
            "arm64"
        } else {
            "x64"
        },
        match hardware.platform {
            llmup_core::sizing::Platform::Darwin => "darwin",
            llmup_core::sizing::Platform::Win32 => "win32",
            _ => "linux",
        },
        gib(usable),
        gib(hardware.free_disk_bytes)
    );
    let hardware_check = if usable < 1073741824.0 {
        json!({"name":"hardware","status":"fail","detail":format!("insufficient usable memory to run a model ({summary})")})
    } else {
        json!({"name":"hardware","status":"ok","detail":summary})
    };
    let backend = backends.first().map_or(json!({"name":"backend","status":"fail","detail":"no backend registered"}), |backend| json!({"name":"backend","status":if backend.installed { "ok" } else { "fail" },"detail":if backend.installed { format!("{} is installed",backend.name) } else { format!("{} is not installed — run: {}",backend.name,backend.install_hint) }}));
    let unverified: Vec<_> = catalog
        .models
        .iter()
        .flat_map(|model| {
            model
                .quantizations
                .iter()
                .filter(|quant| quant.digest_verified == Some(false))
                .map(|quant| {
                    format!(
                        "{} ({})",
                        strip_control(&model.id),
                        strip_control(&quant.name)
                    )
                })
        })
        .collect();
    let catalog_check = json!({"name":"catalog","status":if unverified.is_empty() { "ok" } else { "warn" },"detail":if unverified.is_empty() { format!("{} model(s), all digests verified",catalog.models.len()) } else { format!("{} quantization(s) have digestVerified:false — size-only verify: {}",unverified.len(),unverified.join(", ")) }});
    let state = if state_exists {
        json!({"name":"state","status":"warn","detail":"runtime state exists; active-server readiness not checked by the offline Rust doctor (Checkpoint 3)"})
    } else {
        json!({"name":"state","status":"ok","detail":"no active server recorded"})
    };
    let checks = vec![hardware_check, backend, catalog_check, state];
    json!({"ok":checks.iter().all(|check| check["status"] != "fail"),"checks":checks,"hardwareScore":hardware_score(hardware),"backends":backends})
}

pub fn format_report(report: &Value) -> String {
    let checks = report["checks"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|check| {
            vec![
                check["name"].as_str().unwrap_or("").into(),
                check["status"].as_str().unwrap_or("").to_uppercase(),
                check["detail"].as_str().unwrap_or("").into(),
            ]
        })
        .collect();
    let backends = report["backends"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|backend| {
            vec![
                backend["name"].as_str().unwrap_or("").into(),
                if backend["installed"] == true {
                    "yes".into()
                } else {
                    "no".into()
                },
                backend["version"].as_str().unwrap_or("unknown").into(),
                if backend["isDefault"] == true {
                    "yes".into()
                } else {
                    "".into()
                },
                if backend["installed"] == true {
                    "".into()
                } else {
                    format!(
                        "not installed — run: {}",
                        backend["installHint"].as_str().unwrap_or("")
                    )
                },
            ]
        })
        .collect();
    let bottleneck = match report["hardwareScore"]["bottleneck"].as_str().unwrap_or("") {
        "vram" => "VRAM",
        "ram" => "RAM",
        "compute" => "Compute",
        _ => "Storage",
    };
    format!(
        "{}\n\nBackends\n{}\n\nAI Hardware Score: {}/100\nPrimary bottleneck: {bottleneck}\n\n{}\n",
        table(
            &[("Check", false), ("Status", false), ("Detail", false)],
            checks
        ),
        table(
            &[
                ("Backend", false),
                ("Installed", false),
                ("Version", false),
                ("Default", false),
                ("Detail", false)
            ],
            backends
        ),
        report["hardwareScore"]["total"],
        if report["ok"] == true {
            "All checks passed."
        } else {
            "Problems found — see FAIL rows above."
        }
    )
}
