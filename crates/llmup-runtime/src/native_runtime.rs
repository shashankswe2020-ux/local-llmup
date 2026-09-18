use crate::{
    adapters::{BackendKind, RuntimeAdapter},
    command::NativeCommandRunner,
    http::NativeTransport,
    identity::NativeProcessProbe,
    lifecycle::Registry,
    process_control::{NativeProcessControl, resolve_binary},
    special_adapters::{LmStudioAdapter, MlxAdapter},
    state::Config,
};
use std::path::PathBuf;

pub struct NativeRuntime {
    http: NativeTransport,
    pub probe: NativeProcessProbe,
    control: NativeProcessControl,
    commands: NativeCommandRunner,
    home: PathBuf,
    config: Config,
}
pub struct NativeAdapters<'runtime> {
    ollama: RuntimeAdapter<'runtime>,
    llama: RuntimeAdapter<'runtime>,
    mlx: MlxAdapter<'runtime>,
    studio: LmStudioAdapter<'runtime>,
}
impl NativeRuntime {
    pub fn new(config: Config) -> Result<Self, crate::harness::HarnessError> {
        let home = std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .map(PathBuf::from)
            .ok_or(crate::harness::HarnessError::Invalid)?;
        Ok(Self {
            http: NativeTransport::new().map_err(|_| crate::harness::HarnessError::Transport)?,
            probe: NativeProcessProbe,
            control: NativeProcessControl,
            commands: NativeCommandRunner,
            home,
            config,
        })
    }
    pub fn binary(&self, name: &str) -> PathBuf {
        resolve_binary(name).unwrap_or_else(|_| self.config.home.join(".unavailable").join(name))
    }
    pub fn adapters(&self) -> NativeAdapters<'_> {
        NativeAdapters {
            ollama: RuntimeAdapter::new(
                BackendKind::Ollama,
                self.binary("ollama"),
                &self.http,
                &self.probe,
                &self.control,
            ),
            llama: RuntimeAdapter::new(
                BackendKind::LlamaCpp,
                self.binary("llama-server"),
                &self.http,
                &self.probe,
                &self.control,
            ),
            mlx: MlxAdapter {
                binary: self.binary("python3"),
                http: &self.http,
                probe: &self.probe,
                control: &self.control,
                commands: &self.commands,
                token: None,
            },
            studio: LmStudioAdapter {
                binary: self.binary("lms"),
                trusted_executables: crate::application::studio_trust(&self.home),
                http: &self.http,
                probe: &self.probe,
                commands: &self.commands,
                token: std::env::var("LM_API_TOKEN").ok(),
            },
        }
    }
}
impl NativeAdapters<'_> {
    pub fn registry(&self) -> Registry<'_> {
        Registry::new(vec![&self.ollama, &self.llama, &self.mlx, &self.studio])
    }
}
