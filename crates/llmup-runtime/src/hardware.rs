use llmup_core::{
    catalog::require,
    sizing::{CpuArch, Gpu, GpuVendor, Hardware, Platform, ValidationError},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{process::Stdio, time::Duration};
use tokio::{io::AsyncReadExt, process::Command};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Controller {
    vendor: String,
    vram: Option<f64>,
    vram_dynamic: Option<bool>,
}
#[derive(Debug, Deserialize)]
struct Disk {
    mount: String,
    available: f64,
}
#[derive(Debug, Deserialize)]
struct Snapshot {
    arch: String,
    platform: String,
    total: f64,
    available: Option<f64>,
    free: f64,
    #[serde(default)]
    controllers: Vec<Controller>,
    #[serde(default)]
    disks: Vec<Disk>,
}

fn vendor(value: &str) -> GpuVendor {
    let value = value.to_lowercase();
    let words: Vec<&str> = value.split(|ch: char| !ch.is_alphanumeric()).collect();
    if value.contains("nvidia") {
        GpuVendor::Nvidia
    } else if value.contains("apple") {
        GpuVendor::Apple
    } else if value.contains("amd")
        || value.contains("advanced micro")
        || value.contains("radeon")
        || words.contains(&"ati")
    {
        GpuVendor::Amd
    } else if value.contains("intel") || words.contains(&"arc") {
        GpuVendor::Intel
    } else {
        GpuVendor::None
    }
}
pub fn validate_hardware(hardware: &Hardware) -> Result<(), ValidationError> {
    let safe = |value: f64, min: f64| {
        value.is_finite() && value >= min && value <= 9007199254740991.0 && value.fract() == 0.0
    };
    require(
        safe(hardware.total_ram_bytes, 1.0)
            && safe(hardware.free_ram_bytes, 1.0)
            && safe(hardware.free_disk_bytes, 0.0)
            && hardware.gpu.iter().all(|gpu| safe(gpu.vram_bytes, 0.0)),
        "invalid hardware measurements",
    )
}
pub fn map_snapshot(value: &Value) -> Result<Hardware, ValidationError> {
    let raw: Snapshot = serde_json::from_value(value.clone())
        .map_err(|error| ValidationError(error.to_string()))?;
    let arch = match raw.arch.to_lowercase().as_str() {
        "x64" | "x86_64" | "amd64" => CpuArch::X64,
        "arm64" | "aarch64" => CpuArch::Arm64,
        _ => return Err(ValidationError("unsupported CPU architecture".into())),
    };
    let platform = match raw.platform.as_str() {
        "darwin" => Platform::Darwin,
        "linux" => Platform::Linux,
        "win32" => Platform::Win32,
        _ => return Err(ValidationError("unsupported platform".into())),
    };
    let disks: Vec<_> = raw
        .disks
        .iter()
        .filter(|disk| disk.available.is_finite() && disk.available >= 0.0)
        .collect();
    let root = disks.iter().find(|disk| {
        disk.mount == "/"
            || (disk.mount.len() >= 2
                && disk.mount.len() <= 3
                && disk.mount.as_bytes()[0].is_ascii_alphabetic()
                && disk.mount.as_bytes()[1] == b':'
                && (disk.mount.len() == 2 || disk.mount.ends_with('\\')))
    });
    let free_disk = root.map_or_else(
        || {
            disks
                .iter()
                .map(|disk| disk.available.round())
                .fold(0.0_f64, f64::max)
        },
        |disk| disk.available.round(),
    );
    let gpu = raw
        .controllers
        .iter()
        .map(|controller| {
            let vendor = vendor(&controller.vendor);
            let mib = controller
                .vram
                .filter(|value| value.is_finite() && *value > 0.0)
                .unwrap_or(0.0);
            let bytes = if vendor == GpuVendor::None
                || (vendor == GpuVendor::Intel && controller.vram_dynamic != Some(false))
            {
                0.0
            } else {
                (mib * 1048576.0).round()
            };
            Gpu {
                vendor,
                vram_bytes: bytes,
            }
        })
        .collect();
    let hardware = Hardware {
        arch,
        platform,
        total_ram_bytes: raw.total.round(),
        free_ram_bytes: raw
            .available
            .filter(|value| value.is_finite() && *value > 0.0)
            .unwrap_or(raw.free)
            .round(),
        gpu,
        free_disk_bytes: free_disk,
    };
    validate_hardware(&hardware)?;
    Ok(hardware)
}

pub fn detect_with(
    probe: impl FnOnce() -> Result<Value, String>,
    fallback: &Hardware,
) -> Result<(Hardware, Vec<String>), ValidationError> {
    match probe()
        .map_err(ValidationError)
        .and_then(|value| map_snapshot(&value))
    {
        Ok(hardware) => Ok((hardware, vec![])),
        Err(error) => {
            let mut hardware = fallback.clone();
            hardware.gpu.clear();
            hardware.free_disk_bytes = 1099511627776.0;
            validate_hardware(&hardware)?;
            Ok((
                hardware,
                vec![format!(
                    "hardware detection fallback: {error}; disk availability uses the legacy sentinel, not a measurement"
                )],
            ))
        }
    }
}

pub fn parse_gpu_output(platform: &str, raw: &str) -> Result<Vec<Value>, ValidationError> {
    if platform == "linux" {
        return raw
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| {
                let (name, memory) = line
                    .rsplit_once(',')
                    .ok_or_else(|| ValidationError("invalid NVIDIA memory reading".into()))?;
                let mib = memory
                    .trim()
                    .parse::<f64>()
                    .map_err(|_| ValidationError("invalid NVIDIA VRAM".into()))?;
                require(mib.is_finite() && mib > 0.0, "invalid NVIDIA VRAM")?;
                Ok(json!({"vendor":name.trim(),"vram":mib,"vramDynamic":false}))
            })
            .collect();
    }
    let value: Value =
        serde_json::from_str(raw).map_err(|error| ValidationError(error.to_string()))?;
    let entries = if platform == "darwin" {
        value["SPDisplaysDataType"]
            .as_array()
            .cloned()
            .ok_or_else(|| ValidationError("missing display controllers".into()))?
    } else if let Some(entries) = value.as_array() {
        entries.clone()
    } else if value.is_object() {
        vec![value]
    } else {
        return Err(ValidationError("invalid GPU response".into()));
    };
    entries.iter().map(|entry| {
        let name = entry[if platform == "darwin" { "sppci_model" } else { "Name" }].as_str().ok_or_else(|| ValidationError("missing GPU name".into()))?;
        let mib = if platform == "darwin" {
            let memory = entry["spdisplays_vram"].as_str().or(entry["spdisplays_vram_shared"].as_str());
            memory.and_then(|text| { let mut parts = text.split_whitespace(); let number = parts.next()?.parse::<f64>().ok()?; let unit = parts.next()?; match unit { "GB" => Some(number * 1024.0), "MB" => Some(number), _ => None } }).unwrap_or(0.0)
        } else { entry["AdapterRAM"].as_f64().unwrap_or(0.0) / 1048576.0 };
        Ok(json!({"vendor":name,"vram":mib,"vramDynamic": if vendor(name) == GpuVendor::Intel { Value::Null } else { json!(false) }}))
    }).collect()
}

pub async fn command_output(program: &str, args: &[&str]) -> Result<String, ValidationError> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| ValidationError(error.to_string()))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| ValidationError("missing probe output".into()))?;
    let operation = async {
        let mut bytes = Vec::new();
        stdout
            .take(1048577)
            .read_to_end(&mut bytes)
            .await
            .map_err(|error| ValidationError(error.to_string()))?;
        require(
            bytes.len() <= 1048576,
            "hardware probe output exceeds 1 MiB",
        )?;
        let status = child
            .wait()
            .await
            .map_err(|error| ValidationError(error.to_string()))?;
        require(status.success(), "hardware probe command failed")?;
        String::from_utf8(bytes).map_err(|_| ValidationError("probe output is not UTF-8".into()))
    };
    tokio::time::timeout(Duration::from_secs(3), operation)
        .await
        .map_err(|_| ValidationError("hardware probe timed out".into()))?
}

pub async fn detect() -> Result<(Hardware, Vec<String>), ValidationError> {
    let platform = match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        "linux" => "linux",
        _ => return Err(ValidationError("unsupported platform".into())),
    };
    let mut warnings = Vec::new();
    let gpu = match platform {
        "darwin" => command_output("/usr/sbin/system_profiler", &["SPDisplaysDataType", "-json"]).await,
        "win32" => command_output("powershell.exe", &["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM | ConvertTo-Json -Compress"]).await,
        _ => command_output("nvidia-smi", &["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"]).await,
    };
    let mut controllers = match gpu.and_then(|text| parse_gpu_output(platform, &text)) {
        Ok(gpus) => gpus,
        Err(error) => {
            warnings.push(format!(
                "GPU probe unavailable: {error}; dedicated VRAM unknown"
            ));
            vec![]
        }
    };
    if platform == "win32" {
        match command_output("nvidia-smi", &["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"]).await.and_then(|raw| parse_gpu_output("linux", &raw)) {
            Ok(precise) if !precise.is_empty() => controllers = merge_nvidia(controllers, precise),
            _ => warnings.push("Windows GPU memory uses WMI fallback; large dedicated VRAM values may be truncated".into()),
        }
    }
    if platform == "linux" {
        match linux_drm().and_then(|entries| map_linux_drm(&entries)) {
            Ok(entries) => controllers.extend(entries),
            Err(error) => warnings.push(format!("DRM GPU probe unavailable: {error}")),
        }
    }
    let measurements = tokio::task::spawn_blocking(|| {
        let mut system = sysinfo::System::new();
        system.refresh_memory();
        let disks = sysinfo::Disks::new_with_refreshed_list();
        (system.total_memory(), system.available_memory(), system.free_memory(), disks.iter().map(|disk| json!({"mount":disk.mount_point().to_string_lossy(),"available":disk.available_space()})).collect::<Vec<_>>())
    });
    let (total, available, free, disks) =
        tokio::time::timeout(Duration::from_secs(3), measurements)
            .await
            .map_err(|_| ValidationError("RAM/disk probe timed out".into()))?
            .map_err(|error| ValidationError(error.to_string()))?;
    let snapshot = json!({"arch":std::env::consts::ARCH,"platform":platform,"total":total,"available":available,"free":free,"controllers":controllers,"disks":disks});
    let fallback = map_snapshot(
        &json!({"arch":std::env::consts::ARCH,"platform":platform,"total":total,"free":free.max(1),"controllers":[],"disks":[]}),
    )?;
    let (hardware, fallback_warnings) = detect_with(|| Ok(snapshot), &fallback)?;
    warnings.extend(fallback_warnings);
    Ok((hardware, warnings))
}

pub fn merge_nvidia(mut controllers: Vec<Value>, precise: Vec<Value>) -> Vec<Value> {
    controllers.retain(|entry| vendor(entry["vendor"].as_str().unwrap_or("")) != GpuVendor::Nvidia);
    controllers.extend(precise);
    controllers
}

pub fn map_linux_drm(entries: &[Value]) -> Result<Vec<Value>, ValidationError> {
    entries
        .iter()
        .map(|entry| {
            let id = entry["vendor"]
                .as_str()
                .ok_or_else(|| ValidationError("missing DRM vendor".into()))?;
            let vendor = match id.trim() {
                "0x1002" => "AMD",
                "0x8086" => "Intel",
                "0x10de" => "NVIDIA",
                _ => "unknown",
            };
            let bytes = match entry["bytes"].as_str() {
                Some(raw) => raw
                    .trim()
                    .parse::<u64>()
                    .map_err(|_| ValidationError("invalid DRM memory bytes".into()))?,
                None if entry["bytes"].is_null() => 0,
                _ => return Err(ValidationError("invalid DRM memory measurement".into())),
            };
            require(bytes <= 9007199254740991, "DRM memory exceeds safe range")?;
            Ok(json!({"vendor":vendor,"vram":bytes as f64 / 1048576.0,"vramDynamic":bytes == 0}))
        })
        .collect()
}

fn linux_drm() -> Result<Vec<Value>, ValidationError> {
    use std::io::Read;
    let read = |path: &std::path::Path| -> Option<String> {
        let mut text = String::new();
        std::fs::File::open(path)
            .ok()?
            .take(4097)
            .read_to_string(&mut text)
            .ok()?;
        (text.len() <= 4096).then_some(text)
    };
    let directories =
        std::fs::read_dir("/sys/class/drm").map_err(|error| ValidationError(error.to_string()))?;
    let mut entries = Vec::new();
    for entry in directories.take(256) {
        let entry = entry.map_err(|error| ValidationError(error.to_string()))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.strip_prefix("card").is_some_and(|suffix| {
            !suffix.is_empty() && suffix.bytes().all(|byte| byte.is_ascii_digit())
        }) {
            continue;
        }
        let device = entry.path().join("device");
        let Some(vendor) = read(&device.join("vendor")) else {
            continue;
        };
        if vendor.trim() == "0x10de" {
            continue;
        }
        let bytes = read(&device.join("mem_info_vram_total"))
            .or_else(|| read(&device.join("lmem_total_bytes")));
        entries.push(json!({"vendor":vendor,"bytes":bytes}));
    }
    Ok(entries)
}
