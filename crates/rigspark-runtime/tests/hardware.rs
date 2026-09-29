use rigspark_runtime::hardware::detect_with;
use rigspark_runtime::hardware::map_linux_drm;
use rigspark_runtime::hardware::{map_snapshot, parse_gpu_output};
use serde_json::json;

#[test]
fn maps_dedicated_gpus_and_root_disk_without_guessing() {
    let raw = json!({"arch":"amd64","platform":"win32","total":32000000000_u64,"available":16000000000_u64,"free":8000000000_u64,
        "controllers":[{"vendor":"Intel Corporation","vram":8192,"vramDynamic":true},{"vendor":"Intel Arc","vram":8192,"vramDynamic":false},{"vendor":"Unknown","vram":8192}],
        "disks":[{"mount":"D:\\games","available":100000000000_u64},{"mount":"C:\\","available":42000000000_u64}]});
    let result = map_snapshot(&raw).unwrap();
    assert_eq!(result.gpu[0].vram_bytes, 0.0);
    assert_eq!(result.gpu[1].vram_bytes, 8589934592.0);
    assert_eq!(result.gpu[2].vram_bytes, 0.0);
    assert_eq!(result.free_disk_bytes, 42000000000.0);
}

#[test]
fn parses_platform_gpu_evidence_and_rejects_malformed_results() {
    let linux = parse_gpu_output("linux", "NVIDIA RTX 4060, 8192\n").unwrap();
    assert_eq!(linux[0]["vram"], 8192.0);
    let mac = parse_gpu_output("darwin", r#"{"SPDisplaysDataType":[{"sppci_model":"Apple M3","spdisplays_vendor":"sppci_vendor_Apple"}]}"#).unwrap();
    assert_eq!(mac[0]["vram"], 0.0);
    let windows = parse_gpu_output(
        "win32",
        r#"[{"Name":"NVIDIA RTX","AdapterRAM":4294967296}]"#,
    )
    .unwrap();
    assert_eq!(windows[0]["vram"], 4096.0);
    assert!(parse_gpu_output("linux", "not a GPU reading").is_err());
    assert!(parse_gpu_output("darwin", "{}").is_err());
}

#[test]
fn unified_memory_is_detected_from_topology_not_only_apple_silicon() {
    let spark = parse_gpu_output("linux", "NVIDIA GB10, [N/A]\n").unwrap();
    assert_eq!(spark[0]["sharedMemory"], true);
    assert!(spark[0]["vram"].is_null());
    let snapshot = |arch: &str, controllers: serde_json::Value, unified: serde_json::Value| {
        json!({"arch":arch,"platform":"linux","total":128_u64 << 30,"free":100_u64 << 30,
            "controllers":controllers,"disks":[{"mount":"/","available":1_u64 << 40}],"unifiedMemory":unified})
    };
    let grace = map_snapshot(&snapshot("aarch64", json!(spark), json!(null))).unwrap();
    assert_eq!(grace.unified_memory, Some(true));
    assert_eq!(grace.gpu[0].vram_bytes, 0.0);
    assert!(grace.is_unified());
    let x86 = map_snapshot(&snapshot("x86_64", json!(spark), json!(null))).unwrap();
    assert_eq!(x86.unified_memory, None);
    assert!(!x86.is_unified());
    let apu = map_snapshot(&snapshot("x86_64", json!([]), json!(true))).unwrap();
    assert!(apu.is_unified());
    let discrete = map_snapshot(&snapshot(
        "x86_64",
        json!([{"vendor":"NVIDIA RTX 4090","vram":24564,"vramDynamic":false}]),
        json!(null),
    ))
    .unwrap();
    assert_eq!(discrete.unified_memory, None);
    assert_eq!(
        serde_json::to_value(&discrete)
            .unwrap()
            .get("unifiedMemory"),
        None
    );
    assert!(parse_gpu_output("linux", "NVIDIA RTX, lots\n").is_err());
}

#[test]
fn kfd_topology_marks_apus_that_share_cpu_memory() {
    use rigspark_runtime::hardware::kfd_apu;
    let cpu = "cpu_cores_count 16\nsimd_count 0\nmem_banks_count 1\n".to_owned();
    let discrete = "cpu_cores_count 0\nsimd_count 192\n".to_owned();
    let apu = "cpu_cores_count 16\nsimd_count 80\n".to_owned();
    assert!(!kfd_apu(&[cpu.clone(), discrete.clone()]));
    assert!(kfd_apu(&[cpu, apu]));
    assert!(!kfd_apu(&["cpu_cores_count x\nsimd_count 80\n".to_owned()]));
    assert!(!kfd_apu(&[]));
}

#[test]
fn rejects_invalid_memory_and_uses_free_when_available_is_absent() {
    let mut raw = json!({"arch":"aarch64","platform":"darwin","total":16000000000_u64,"available":0,"free":8000000000_u64,"controllers":[],"disks":[]});
    assert_eq!(map_snapshot(&raw).unwrap().free_ram_bytes, 8000000000.0);
    raw["total"] = json!(-1);
    assert!(map_snapshot(&raw).is_err());
}

#[test]
fn maps_linux_drm_memory_only_when_dedicated_bytes_are_present() {
    let entries = vec![
        json!({"vendor":"0x1002","bytes":"17179869184"}),
        json!({"vendor":"0x8086","bytes":null}),
        json!({"vendor":"0x8086","bytes":"8589934592"}),
        json!({"vendor":"0x1234","bytes":"8589934592"}),
    ];
    let controllers = map_linux_drm(&entries).unwrap();
    let hardware = map_snapshot(&json!({"arch":"x86_64","platform":"linux","total":32000000000_u64,"free":16000000000_u64,"controllers":controllers,"disks":[]})).unwrap();
    assert_eq!(hardware.gpu[0].vram_bytes, 17179869184.0);
    assert_eq!(hardware.gpu[1].vram_bytes, 0.0);
    assert_eq!(hardware.gpu[2].vram_bytes, 8589934592.0);
    assert_eq!(hardware.gpu[3].vram_bytes, 0.0);
    assert!(map_linux_drm(&[json!({"vendor":"0x1002","bytes":"invalid"})]).is_err());
}

#[test]
fn probe_failure_uses_explicit_fallback_memory_and_legacy_disk_sentinel() {
    let fallback = map_snapshot(&json!({"arch":"x64","platform":"linux","total":32000000000_u64,"free":16000000000_u64,"controllers":[],"disks":[]})).unwrap();
    let (hardware, warnings) = detect_with(|| Err("probe timeout".into()), &fallback).unwrap();
    assert_eq!(hardware.total_ram_bytes, fallback.total_ram_bytes);
    assert!(hardware.gpu.is_empty());
    assert_eq!(hardware.free_disk_bytes, 1099511627776.0);
    assert!(!warnings.is_empty());
    let (hardware, _) = detect_with(|| Ok(json!({"invalid":true})), &fallback).unwrap();
    assert!(hardware.gpu.is_empty());
}

#[test]
fn windows_prefers_nvidia_measurements_without_duplicate_cards() {
    let wmi = vec![
        json!({"vendor":"NVIDIA RTX","vram":4096}),
        json!({"vendor":"Intel","vram":0}),
    ];
    let precise = vec![json!({"vendor":"NVIDIA RTX","vram":24576,"vramDynamic":false})];
    let merged = rigspark_runtime::hardware::merge_nvidia(wmi, precise);
    assert_eq!(merged.len(), 2);
    assert_eq!(merged[1]["vram"], 24576);
}

#[cfg(unix)]
#[tokio::test]
async fn detection_stays_within_its_probe_budget_on_a_cold_process() {
    let started = std::time::Instant::now();
    let (hardware, _) = rigspark_runtime::hardware::detect().await.unwrap();
    assert!(
        started.elapsed() < std::time::Duration::from_secs(3),
        "{:?}",
        started.elapsed()
    );
    assert!(hardware.total_ram_bytes > 0.0);
    assert!(hardware.free_disk_bytes > 0.0);
}
