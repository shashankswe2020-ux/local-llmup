use crate::memory::MemoryError;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};
#[derive(Debug, thiserror::Error)]
pub enum SessionError {
    #[error("invalid session data")]
    Invalid,
    #[error("session was modified by another writer")]
    Conflict,
    #[error("session storage failed")]
    Storage,
}
impl From<MemoryError> for SessionError {
    fn from(_: MemoryError) -> Self {
        Self::Storage
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub hash: String,
    pub size: u64,
    pub truncated: bool,
    pub included: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub range: Option<crate::workspace::LineRange>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredMessage {
    pub role: String,
    pub content: String,
    pub at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<Attachment>>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDoc {
    pub schema_version: u8,
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    pub revision: u64,
    pub archived: bool,
    pub messages: Vec<StoredMessage>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    pub revision: u64,
    pub archived: bool,
    pub message_count: usize,
}
fn chars(text: &str) -> usize {
    text.encode_utf16().count()
}
pub(crate) fn cap(text: &str, maximum: usize) -> String {
    let mut count = 0;
    text.chars()
        .take_while(|character| {
            count += character.len_utf16();
            count <= maximum
        })
        .collect()
}
pub fn gui_text(text: &str) -> String {
    let mut output = String::new();
    for part in text.split_inclusive(['\n', '\t']) {
        let end = part.chars().last();
        output.push_str(&llmup_core::reports::strip_control(part));
        if matches!(end, Some('\n' | '\t')) {
            output.push(end.unwrap_or('\n'));
        }
    }
    output
}
fn title(text: &str) -> String {
    cap(
        &llmup_core::reports::strip_control(text)
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" "),
        200,
    )
}
fn timestamp(value: &str) -> bool {
    !value.is_empty() && value.len() <= 40
}
impl SessionDoc {
    pub fn validate(&self) -> Result<(), SessionError> {
        if self.schema_version != 1
            || uuid::Uuid::parse_str(&self.id).is_err()
            || self.id.len() != 36
            || self.id != self.id.to_lowercase()
            || chars(&self.title) > 200
            || !timestamp(&self.created_at)
            || !timestamp(&self.updated_at)
            || self.revision > 9007199254740991
            || self.messages.len() > 2000
        {
            return Err(SessionError::Invalid);
        }
        for message in &self.messages {
            if !["user", "assistant", "system"].contains(&message.role.as_str())
                || chars(&message.content) > 32768
                || !timestamp(&message.at)
            {
                return Err(SessionError::Invalid);
            }
            if let Some(attachments) = &message.attachments {
                if attachments.len() > 20 {
                    return Err(SessionError::Invalid);
                }
                for attachment in attachments {
                    if attachment.kind.as_ref().is_some_and(|kind| {
                        !["file", "terminal", "diagnostics", "git"].contains(&kind.as_str())
                    }) || attachment.hash.is_empty()
                        || chars(&attachment.hash) > 128
                        || attachment.size > 9007199254740991
                        || attachment
                            .label
                            .as_ref()
                            .is_some_and(|value| value.is_empty() || chars(value) > 200)
                        || attachment
                            .path
                            .as_ref()
                            .is_some_and(|value| value.is_empty() || chars(value) > 1024)
                        || attachment
                            .range
                            .as_ref()
                            .is_some_and(|range| range.start_line == 0 || range.end_line == 0)
                    {
                        return Err(SessionError::Invalid);
                    }
                }
            }
        }
        Ok(())
    }
    pub fn summary(&self) -> SessionSummary {
        SessionSummary {
            id: self.id.clone(),
            title: self.title.clone(),
            created_at: self.created_at.clone(),
            updated_at: self.updated_at.clone(),
            revision: self.revision,
            archived: self.archived,
            message_count: self.messages.len(),
        }
    }
}
pub struct SessionRepository {
    home: PathBuf,
    pub runs: crate::runs::RunCoordinator,
}
impl SessionRepository {
    pub fn new(home: &Path) -> Self {
        Self {
            home: home.into(),
            runs: crate::runs::RunCoordinator::default(),
        }
    }
    fn path(&self, id: &str) -> Result<PathBuf, SessionError> {
        self.check_home()?;
        if uuid::Uuid::parse_str(id).is_err() || id.len() != 36 || id != id.to_lowercase() {
            return Err(SessionError::Invalid);
        }
        let directory = self.home.join("gui-sessions");
        if let Ok(metadata) = fs::symlink_metadata(&directory)
            && (!metadata.is_dir() || metadata.file_type().is_symlink())
        {
            return Err(SessionError::Storage);
        }
        Ok(directory.join(format!("{id}.json")))
    }
    fn lock(&self) -> Result<crate::state::LockGuard, SessionError> {
        crate::state::StateStore::new(
            crate::state::Config::from_home(&self.home).map_err(|_| SessionError::Storage)?,
        )
        .lock(Duration::from_secs(10))
        .map_err(|_| SessionError::Storage)
    }
    fn ids(&self) -> Result<Vec<String>, SessionError> {
        self.check_home()?;
        let directory = self.home.join("gui-sessions");
        if !directory.try_exists().map_err(|_| SessionError::Storage)? {
            return Ok(Vec::new());
        }
        if fs::symlink_metadata(&directory)
            .map_err(|_| SessionError::Storage)?
            .file_type()
            .is_symlink()
        {
            return Err(SessionError::Storage);
        }
        let mut ids = Vec::new();
        for (index, entry) in fs::read_dir(directory)
            .map_err(|_| SessionError::Storage)?
            .enumerate()
        {
            if index > 10000 {
                return Err(SessionError::Storage);
            }
            let entry = entry.map_err(|_| SessionError::Storage)?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if let Some(id) = name.strip_suffix(".json")
                && self.path(id).is_ok()
            {
                ids.push(id.into());
            }
        }
        Ok(ids)
    }
    fn check_home(&self) -> Result<(), SessionError> {
        match fs::symlink_metadata(&self.home) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            _ => Err(SessionError::Storage),
        }
    }
    pub fn get(&self, id: &str) -> Result<Option<SessionDoc>, SessionError> {
        let path = self.path(id)?;
        let read = (|| {
            let directory = crate::secure_fs::Directory::open(&self.home)?;
            directory.read(
                path.strip_prefix(&self.home)
                    .map_err(|_| std::io::Error::other("invalid session path"))?,
                8 * 1024 * 1024,
                true,
            )
        })();
        let raw = match read {
            Ok(raw) => String::from_utf8(raw).map_err(|_| SessionError::Invalid)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(SessionError::Storage),
        };
        let doc: SessionDoc = serde_json::from_str(&raw).map_err(|_| SessionError::Invalid)?;
        doc.validate()?;
        if doc.id != id {
            return Err(SessionError::Invalid);
        }
        Ok(Some(doc))
    }
    fn write(&self, doc: &SessionDoc) -> Result<(), SessionError> {
        doc.validate()?;
        let bytes = format!(
            "{}\n",
            serde_json::to_string_pretty(doc).map_err(|_| SessionError::Invalid)?
        );
        if bytes.len() > 8 * 1024 * 1024 {
            return Err(SessionError::Invalid);
        }
        let directory =
            crate::secure_fs::Directory::open(&self.home).map_err(|_| SessionError::Storage)?;
        directory
            .ensure_dir(Path::new("gui-sessions"))
            .map_err(|_| SessionError::Storage)?;
        let path = self.path(&doc.id)?;
        directory
            .write(
                path.strip_prefix(&self.home)
                    .map_err(|_| SessionError::Storage)?,
                bytes.as_bytes(),
                false,
                false,
            )
            .map_err(|_| SessionError::Storage)?;
        Ok(())
    }
    pub fn create(&self, name: &str, at: &str) -> Result<SessionDoc, SessionError> {
        let guard = self.lock()?;
        if self.ids()?.len() >= 500 {
            return Err(SessionError::Invalid);
        }
        let name = title(name);
        let doc = SessionDoc {
            schema_version: 1,
            id: uuid::Uuid::new_v4().to_string(),
            title: if name.is_empty() {
                "New chat".into()
            } else {
                name
            },
            created_at: at.into(),
            updated_at: at.into(),
            revision: 0,
            archived: false,
            messages: Vec::new(),
        };
        self.write(&doc)?;
        guard.release().map_err(|_| SessionError::Storage)?;
        Ok(doc)
    }
    fn mutate(
        &self,
        id: &str,
        expected: Option<u64>,
        at: &str,
        change: impl FnOnce(&mut SessionDoc),
    ) -> Result<SessionDoc, SessionError> {
        let guard = self.lock()?;
        let mut doc = self.get(id)?.ok_or(SessionError::Invalid)?;
        if expected.is_some_and(|revision| revision != doc.revision) {
            return Err(SessionError::Conflict);
        }
        change(&mut doc);
        doc.revision = doc.revision.checked_add(1).ok_or(SessionError::Invalid)?;
        doc.updated_at = at.into();
        self.write(&doc)?;
        guard.release().map_err(|_| SessionError::Storage)?;
        Ok(doc)
    }
    pub fn append(
        &self,
        id: &str,
        mut message: StoredMessage,
        expected: Option<u64>,
    ) -> Result<SessionDoc, SessionError> {
        message.content = cap(&gui_text(&message.content), 32768);
        if let Some(attachments) = &mut message.attachments {
            attachments.truncate(20);
        }
        let at = message.at.clone();
        self.mutate(id, expected, &at, |doc| {
            if doc.title == "New chat"
                && message.role == "user"
                && !message.content.trim().is_empty()
            {
                doc.title = title(&cap(&message.content, 60));
            }
            doc.messages.push(message);
            if doc.messages.len() > 2000 {
                doc.messages.drain(..doc.messages.len() - 2000);
            }
        })
    }
    pub fn append_exchange(
        &self,
        id: &str,
        mut user: StoredMessage,
        mut assistant: StoredMessage,
        expected: u64,
    ) -> Result<SessionDoc, SessionError> {
        if user.role != "user" || assistant.role != "assistant" {
            return Err(SessionError::Invalid);
        }
        for message in [&mut user, &mut assistant] {
            message.content = cap(&gui_text(&message.content), 32768);
            if let Some(attachments) = &mut message.attachments {
                attachments.truncate(20);
            }
        }
        let at = assistant.at.clone();
        self.mutate(id, Some(expected), &at, |doc| {
            if doc.title == "New chat" && !user.content.trim().is_empty() {
                doc.title = title(&cap(&user.content, 60));
            }
            doc.messages.extend([user, assistant]);
            if doc.messages.len() > 2000 {
                doc.messages.drain(..doc.messages.len() - 2000);
            }
        })
    }
    pub fn rename(
        &self,
        id: &str,
        name: &str,
        expected: Option<u64>,
        at: &str,
    ) -> Result<SessionDoc, SessionError> {
        let name = title(name);
        if name.is_empty() {
            return Err(SessionError::Invalid);
        }
        self.mutate(id, expected, at, |doc| doc.title = name)
    }
    pub fn archive(
        &self,
        id: &str,
        archived: bool,
        expected: Option<u64>,
        at: &str,
    ) -> Result<SessionDoc, SessionError> {
        self.mutate(id, expected, at, |doc| doc.archived = archived)
    }
    pub fn remove(&self, id: &str) -> Result<(), SessionError> {
        let guard = self.lock()?;
        let directory =
            crate::secure_fs::Directory::open(&self.home).map_err(|_| SessionError::Storage)?;
        match directory.remove(
            self.path(id)?
                .strip_prefix(&self.home)
                .map_err(|_| SessionError::Storage)?,
        ) {
            Ok(()) => (),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(_) => return Err(SessionError::Storage),
        }
        guard.release().map_err(|_| SessionError::Storage)
    }
    pub fn list(
        &self,
        archived: bool,
        offset: usize,
        limit: usize,
    ) -> Result<(Vec<SessionSummary>, Option<String>), SessionError> {
        let mut docs: Vec<_> = self
            .ids()?
            .iter()
            .filter_map(|id| self.get(id).ok().flatten())
            .filter(|doc| archived || !doc.archived)
            .collect();
        docs.sort_by(|left, right| {
            right
                .updated_at
                .cmp(&left.updated_at)
                .then(right.id.cmp(&left.id))
        });
        let limit = limit.clamp(1, 200);
        let next = (offset.saturating_add(limit) < docs.len())
            .then(|| offset.saturating_add(limit).to_string());
        Ok((
            docs.into_iter()
                .skip(offset)
                .take(limit)
                .map(|doc| doc.summary())
                .collect(),
            next,
        ))
    }
    pub fn messages(
        &self,
        id: &str,
        offset: usize,
        limit: usize,
    ) -> Result<(Vec<StoredMessage>, Option<String>), SessionError> {
        let doc = self.get(id)?.ok_or(SessionError::Invalid)?;
        let limit = limit.clamp(1, 500);
        let next = (offset.saturating_add(limit) < doc.messages.len())
            .then(|| offset.saturating_add(limit).to_string());
        Ok((
            doc.messages.into_iter().skip(offset).take(limit).collect(),
            next,
        ))
    }
    pub fn search(
        &self,
        query: &str,
        archived: bool,
    ) -> Result<Vec<(SessionSummary, String)>, SessionError> {
        let query = llmup_core::reports::strip_control(query)
            .trim()
            .to_lowercase();
        if query.is_empty() {
            return Ok(Vec::new());
        }
        let mut matches = Vec::new();
        for id in self.ids()? {
            if let Ok(Some(doc)) = self.get(&id) {
                if doc.archived && !archived {
                    continue;
                }
                if doc.title.to_lowercase().contains(&query) {
                    matches.push((doc.summary(), doc.title.clone()));
                } else if let Some(message) = doc
                    .messages
                    .iter()
                    .find(|message| message.content.to_lowercase().contains(&query))
                {
                    let lower = message.content.to_lowercase();
                    let index = lower.find(&query).unwrap_or(0);
                    let start = lower[..index].encode_utf16().count().saturating_sub(24);
                    let snippet = String::from_utf16_lossy(
                        &message
                            .content
                            .encode_utf16()
                            .skip(start)
                            .take(80)
                            .collect::<Vec<_>>(),
                    );
                    matches.push((doc.summary(), snippet));
                }
            }
        }
        matches.sort_by(|left, right| right.0.updated_at.cmp(&left.0.updated_at));
        matches.truncate(50);
        Ok(matches)
    }
}
