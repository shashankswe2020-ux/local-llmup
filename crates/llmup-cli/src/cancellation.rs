use serde::Serialize;
use std::fmt;

pub const CLEANUP_TIMEOUT_MS: u64 = 30_000;
pub const LOCK_TIMEOUT_MS: u64 = 10_000;

pub fn exit_code_for_signal(signal: Option<&str>) -> Option<u8> {
    match signal {
        Some("SIGHUP") => Some(129),
        Some("SIGINT") => Some(130),
        Some("SIGTERM") => Some(143),
        _ => None,
    }
}
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Effect {
    Unchanged,
    ArtifactCachedStateUnchanged,
    SpawnedProcessCleaned,
    PriorServerStoppedReplacementNotStarted,
    StateRollbackAttempted,
    StateCommitted,
    TargetCommittedSourceRetained,
    FullyCompleted,
}
impl fmt::Display for Effect {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Unchanged => "unchanged",
            Self::ArtifactCachedStateUnchanged => "artifact_cached_state_unchanged",
            Self::SpawnedProcessCleaned => "spawned_process_cleaned",
            Self::PriorServerStoppedReplacementNotStarted => {
                "prior_server_stopped_replacement_not_started"
            }
            Self::StateRollbackAttempted => "state_rollback_attempted",
            Self::StateCommitted => "state_committed",
            Self::TargetCommittedSourceRetained => "target_committed_source_retained",
            Self::FullyCompleted => "fully_completed",
        })
    }
}
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Termination<'phase> {
    Success {
        phase: &'phase str,
        effect: Effect,
    },
    Cancelled {
        phase: &'phase str,
        effect: Effect,
    },
    Partial {
        phase: &'phase str,
        effect: Effect,
        remediation: String,
    },
    Failed {
        phase: &'phase str,
        effect: Effect,
        code: String,
    },
}
impl fmt::Display for Termination<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Success { phase, .. } => {
                write!(formatter, "Completed successfully at phase: {phase}")
            }
            Self::Cancelled { phase, effect } => {
                write!(formatter, "Cancelled at phase: {phase} (effect: {effect})")
            }
            Self::Partial {
                phase, remediation, ..
            } => write!(
                formatter,
                "Partial completion at phase: {phase} \u{2014} {remediation}"
            ),
            Self::Failed {
                phase,
                effect,
                code,
            } => write!(
                formatter,
                "Failed at phase: {phase} ({code}; effect: {effect})"
            ),
        }
    }
}
pub fn remediation_prior_stopped(model: &str) -> String {
    format!(
        "The prior server was stopped but its replacement failed to start. Run `local-llmup up {model}` to restore service."
    )
}
pub fn remediation_rollback(model: &str) -> String {
    format!(
        "State was cleared but stopping {model} failed; state was restored. Inspect the process manually or retry `local-llmup down`."
    )
}
pub fn remediation_source_retained() -> &'static str {
    "Migration target is valid; source was retained. Re-run `local-llmup migrate --move` to complete source deletion."
}
pub fn classify_up(phase: &str, prior_stopped: bool, spawned: bool) -> Termination<'_> {
    if phase == "state-commit" {
        return Termination::Success {
            phase,
            effect: Effect::StateCommitted,
        };
    }
    if prior_stopped && !spawned {
        return Termination::Partial {
            phase,
            effect: Effect::PriorServerStoppedReplacementNotStarted,
            remediation: remediation_prior_stopped("the target model"),
        };
    }
    let effect = if spawned {
        Effect::SpawnedProcessCleaned
    } else if ["acquire", "verify"].contains(&phase) {
        Effect::ArtifactCachedStateUnchanged
    } else {
        Effect::Unchanged
    };
    Termination::Cancelled { phase, effect }
}
pub fn classify_down(phase: &str, rollback: bool) -> Termination<'_> {
    if rollback {
        return Termination::Partial {
            phase,
            effect: Effect::StateRollbackAttempted,
            remediation: remediation_rollback("the active model"),
        };
    }
    if phase == "stop-detach" {
        Termination::Success {
            phase,
            effect: Effect::StateCommitted,
        }
    } else {
        Termination::Cancelled {
            phase,
            effect: Effect::Unchanged,
        }
    }
}
pub fn classify_switch(phase: &str) -> Termination<'_> {
    if phase == "state-commit" {
        return Termination::Success {
            phase,
            effect: Effect::StateCommitted,
        };
    }
    let effect = if ["prepare", "readiness"].contains(&phase) {
        Effect::ArtifactCachedStateUnchanged
    } else {
        Effect::Unchanged
    };
    Termination::Cancelled { phase, effect }
}
