use serde::Serialize;
use std::{
    path::{Path, PathBuf},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    sampled_at: u64,
    cpu_percent: Option<f32>,
    memory_used_bytes: Option<u64>,
    memory_total_bytes: Option<u64>,
    disk_used_bytes: Option<u64>,
    disk_total_bytes: Option<u64>,
}
pub struct Telemetry {
    home: PathBuf,
    system: sysinfo::System,
    disks: sysinfo::Disks,
    previous: Option<(Instant, Sample)>,
}
fn usage(total: u64, available: u64) -> (Option<u64>, Option<u64>) {
    if total == 0 || available > total {
        (None, None)
    } else {
        (Some(total - available), Some(total))
    }
}
impl Telemetry {
    pub fn new(home: &Path) -> Self {
        Self {
            home: home.canonicalize().unwrap_or_else(|_| home.into()),
            system: sysinfo::System::new(),
            disks: sysinfo::Disks::new(),
            previous: None,
        }
    }
    pub fn sample(&mut self) -> Sample {
        if let Some((when, sample)) = &self.previous
            && when.elapsed() < Duration::from_millis(1500)
        {
            return sample.clone();
        }
        self.system.refresh_cpu_usage();
        self.system.refresh_memory();
        self.disks.refresh(true);
        let cpu = self.system.global_cpu_usage();
        let cpu_percent = (self.previous.is_some()
            && !self.system.cpus().is_empty()
            && cpu.is_finite()
            && (0.0..=100.0).contains(&cpu))
        .then_some(cpu);
        let (memory_used_bytes, memory_total_bytes) =
            usage(self.system.total_memory(), self.system.available_memory());
        let disk = self
            .disks
            .iter()
            .filter(|disk| self.home.starts_with(disk.mount_point()))
            .max_by_key(|disk| disk.mount_point().components().count());
        let (disk_used_bytes, disk_total_bytes) = disk
            .map(|disk| usage(disk.total_space(), disk.available_space()))
            .unwrap_or((None, None));
        let sample = Sample {
            sampled_at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
                .min(u64::MAX as u128) as u64,
            cpu_percent,
            memory_used_bytes,
            memory_total_bytes,
            disk_used_bytes,
            disk_total_bytes,
        };
        self.previous = Some((Instant::now(), sample.clone()));
        sample
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn invalid_usage_is_unknown_not_an_invented_zero() {
        assert_eq!(usage(16000, 6000), (Some(10000), Some(16000)));
        assert_eq!(usage(0, 0), (None, None));
        assert_eq!(usage(100, 200), (None, None));
    }
}
