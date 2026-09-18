use crate::{
    sessions::Attachment,
    workspace::{LineRange, WorkspaceError, WorkspaceService},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, path::Path};
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum ContextRef {
    File {
        #[serde(rename = "workspaceId")]
        workspace_id: String,
        path: String,
        range: Option<LineRange>,
    },
    Terminal {
        label: Option<String>,
        content: String,
    },
    Diagnostics {
        label: Option<String>,
        content: String,
    },
    Git {
        #[serde(rename = "workspaceId")]
        workspace_id: String,
        mode: String,
    },
}
#[derive(Debug, Serialize)]
pub struct ContextBundle {
    pub text: String,
    pub manifest: Vec<Attachment>,
}
fn digest(content: &str) -> String {
    format!("{:x}", Sha256::digest(content.as_bytes()))
}
impl ContextBundle {
    pub fn resolve(
        workspace: &WorkspaceService,
        refs: &[ContextRef],
    ) -> Result<Self, WorkspaceError> {
        if refs.len() > 20
            || refs
                .iter()
                .filter(|reference| matches!(reference, ContextRef::File { .. }))
                .count()
                > 10
            || refs
                .iter()
                .filter(|reference| !matches!(reference, ContextRef::File { .. }))
                .count()
                > 10
        {
            return Err(WorkspaceError("context source limit".into()));
        }
        let mut blocks = Vec::new();
        let mut manifest = Vec::new();
        let mut used = 0;
        for reference in refs {
            let (kind, label, path, content, hash, range, truncated, block) = match reference {
                ContextRef::File {
                    workspace_id,
                    path,
                    range,
                } => {
                    let snapshot = match workspace.read(workspace_id, path, range.clone()) {
                        Ok(snapshot) => snapshot,
                        Err(_) => continue,
                    };
                    let block = if let Some(range) = &snapshot.range {
                        format!(
                            "FILE: {} (lines {}-{})",
                            snapshot.path, range.start_line, range.end_line
                        )
                    } else {
                        format!("FILE: {}", snapshot.path)
                    };
                    (
                        "file",
                        snapshot.path.clone(),
                        Some(snapshot.path),
                        snapshot.content,
                        snapshot.hash,
                        snapshot.range,
                        snapshot.truncated,
                        block,
                    )
                }
                ContextRef::Terminal { label, content }
                | ContextRef::Diagnostics { label, content } => {
                    if content.len() > 65536 {
                        return Err(WorkspaceError("pasted context exceeds limit".into()));
                    }
                    let content = crate::sessions::gui_text(content);
                    if content.trim().is_empty() {
                        continue;
                    }
                    let terminal = matches!(reference, ContextRef::Terminal { .. });
                    let kind = if terminal { "terminal" } else { "diagnostics" };
                    let label = label
                        .as_ref()
                        .filter(|label| !label.trim().is_empty())
                        .map(|label| {
                            llmup_core::reports::strip_control(label)
                                .chars()
                                .take(120)
                                .collect::<String>()
                        })
                        .unwrap_or_else(|| {
                            if terminal {
                                "Terminal output".into()
                            } else {
                                "Diagnostics".into()
                            }
                        });
                    let hash = digest(&content);
                    let block = format!("{}: {label}", kind.to_uppercase());
                    (kind, label, None, content, hash, None, false, block)
                }
                ContextRef::Git { workspace_id, mode } => {
                    let snapshot = match workspace.git_context(workspace_id, mode) {
                        Ok(snapshot) => snapshot,
                        Err(_) => continue,
                    };
                    if snapshot["available"] != true {
                        continue;
                    }
                    let content = snapshot["content"].as_str().unwrap_or("").to_owned();
                    let hash = digest(&content);
                    (
                        "git",
                        format!("git {mode}"),
                        None,
                        content,
                        hash,
                        None,
                        snapshot["truncated"] == true,
                        format!("GIT {}", mode.to_uppercase()),
                    )
                }
            };
            let size = content.len();
            let included = used + size <= 256 * 1024;
            manifest.push(Attachment {
                kind: Some(kind.into()),
                label: Some(label),
                path,
                hash,
                size: size as u64,
                truncated,
                included,
                range,
            });
            if included {
                used += size;
                blocks.push(format!("--- {block} ---\n{content}"));
            }
        }
        Ok(Self {
            text: if blocks.is_empty() {
                String::new()
            } else {
                format!(
                    "The user attached the following read-only context. Use it to inform your answer; do not assume any other files or state.\n\n{}",
                    blocks.join("\n\n")
                )
            },
            manifest,
        })
    }
}
#[derive(Default, Clone)]
pub struct DisclosureStore {
    approved: HashSet<String>,
}
impl DisclosureStore {
    fn key(session: &str, provider: &str, bundle: &ContextBundle) -> String {
        digest(
            &serde_json::json!([session, provider, bundle.manifest, digest(&bundle.text)])
                .to_string(),
        )
    }
    pub fn allowed(&self, session: &str, provider: &str, bundle: &ContextBundle) -> bool {
        provider == "local"
            || bundle.manifest.is_empty()
            || self
                .approved
                .contains(&Self::key(session, provider, bundle))
    }
    pub fn approve(&mut self, session: &str, provider: &str, bundle: &ContextBundle) {
        if self.approved.len() >= 10000 {
            self.approved.clear();
        }
        self.approved.insert(Self::key(session, provider, bundle));
    }
    pub fn clear(&mut self) {
        self.approved.clear();
    }
}
pub struct ArtifactImage {
    pub content: Vec<u8>,
    pub content_type: &'static str,
}
pub fn read_artifact(root: &Path, name: &str) -> Result<ArtifactImage, WorkspaceError> {
    if name.len() > 3072 {
        return Err(WorkspaceError("invalid artifact basename".into()));
    }
    let decoded = percent_encoding::percent_decode_str(name)
        .decode_utf8()
        .map_err(|_| WorkspaceError("invalid artifact encoding".into()))?;
    let name = decoded.as_ref();
    if name.len() > 1024
        || !name
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
    {
        return Err(WorkspaceError("invalid artifact basename".into()));
    }
    let extension = Path::new(name)
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("")
        .to_lowercase();
    let content_type = match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        _ => return Err(WorkspaceError("unsupported artifact type".into())),
    };
    let directory = crate::secure_fs::Directory::open(root)?;
    let content = directory.read(Path::new(name), 12 * 1024 * 1024, false)?;
    Ok(ArtifactImage {
        content,
        content_type,
    })
}
