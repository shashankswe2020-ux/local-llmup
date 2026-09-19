use crate::memory::{MemoryError, owned_directory};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    time::Duration,
};
#[derive(Debug, Clone, Copy)]
pub enum Kind {
    Agent,
    Skill,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LibraryItem {
    pub id: String,
    pub name: String,
    pub description: String,
    pub enabled: bool,
    pub body: String,
    #[serde(default)]
    pub skills: Vec<String>,
}
#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LibraryUpdate {
    pub name: Option<String>,
    pub description: Option<String>,
    pub enabled: Option<bool>,
    pub body: Option<String>,
    pub skills: Option<Vec<String>>,
}
fn id_valid(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.as_bytes()[0].is_ascii_alphanumeric()
        && id
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}
impl LibraryItem {
    fn validate(&self) -> Result<(), MemoryError> {
        if !id_valid(&self.id)
            || self.name.is_empty()
            || self.name.encode_utf16().count() > 120
            || self.description.encode_utf16().count() > 500
            || self.body.encode_utf16().count() > 65536
            || self.skills.len() > 50
            || self.skills.iter().any(|id| !id_valid(id))
        {
            return Err(MemoryError("invalid library item".into()));
        }
        Ok(())
    }
}
pub fn parse_document(raw: &str) -> (BTreeMap<String, String>, String) {
    let raw = raw.strip_prefix('\u{feff}').unwrap_or(raw);
    let lines: Vec<_> = raw.split('\n').collect();
    if lines.first().is_none_or(|line| line.trim() != "---") {
        return (BTreeMap::new(), raw.into());
    }
    let Some(close) = lines
        .iter()
        .enumerate()
        .skip(1)
        .find(|(_, line)| line.trim() == "---")
        .map(|(index, _)| index)
    else {
        return (BTreeMap::new(), raw.into());
    };
    let mut fields = BTreeMap::new();
    for line in &lines[1..close] {
        if let Some((key, value)) = line.split_once(':') {
            if key.trim().is_empty()
                || key.starts_with(char::is_whitespace)
                || !key
                    .trim()
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
            {
                continue;
            }
            let value = value.trim();
            let decoded = if value.len() >= 2 && value.starts_with('"') && value.ends_with('"') {
                value[1..value.len() - 1]
                    .replace("\\\"", "\"")
                    .replace("\\\\", "\\")
            } else if value.len() >= 2 && value.starts_with('\'') && value.ends_with('\'') {
                value[1..value.len() - 1].into()
            } else {
                value.into()
            };
            fields.insert(key.trim().into(), decoded);
        }
    }
    (
        fields,
        lines[close + 1..]
            .join("\n")
            .trim_start_matches('\n')
            .trim_end()
            .into(),
    )
}
fn scalar(value: &str) -> String {
    if !value.is_empty()
        && value.trim() == value
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b" _.-/".contains(&byte))
    {
        value.into()
    } else {
        format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
    }
}
pub fn compose(agent: Option<&LibraryItem>, skills: &[LibraryItem]) -> Option<String> {
    let mut parts = Vec::new();
    if let Some(agent) = agent.filter(|agent| !agent.body.trim().is_empty()) {
        parts.push(agent.body.trim().to_owned());
    }
    let skills: Vec<_> = skills
        .iter()
        .filter(|skill| !skill.body.trim().is_empty())
        .map(|skill| format!("## {}\n{}", skill.name, skill.body.trim()))
        .collect();
    if !skills.is_empty() {
        parts.push(format!(
            "# Skills\nApply these skills when relevant:\n\n{}",
            skills.join("\n\n")
        ));
    }
    (!parts.is_empty()).then(|| parts.join("\n\n"))
}
pub struct Library {
    home: PathBuf,
}
impl Library {
    pub fn new(home: &Path) -> Self {
        Self { home: home.into() }
    }
    fn directory(&self, kind: Kind) -> PathBuf {
        self.home.join(match kind {
            Kind::Agent => "agents",
            Kind::Skill => "skills",
        })
    }
    fn path(&self, kind: Kind, id: &str) -> Result<PathBuf, MemoryError> {
        if !id_valid(id) {
            return Err(MemoryError("invalid library id".into()));
        }
        let directory = self.directory(kind);
        for path in [&self.home, &directory] {
            if let Ok(metadata) = fs::symlink_metadata(path)
                && (!metadata.is_dir() || metadata.file_type().is_symlink())
            {
                return Err(MemoryError("unsafe library directory".into()));
            }
        }
        match kind {
            Kind::Agent => Ok(directory.join(format!("{id}.md"))),
            Kind::Skill => {
                let parent = directory.join(id);
                if let Ok(metadata) = fs::symlink_metadata(&parent)
                    && (!metadata.is_dir() || metadata.file_type().is_symlink())
                {
                    return Err(MemoryError("unsafe skill directory".into()));
                }
                Ok(parent.join("SKILL.md"))
            }
        }
    }
    pub fn get(&self, kind: Kind, id: &str) -> Result<Option<LibraryItem>, MemoryError> {
        let path = self.path(kind, id)?;
        let read = (|| {
            let directory = crate::secure_fs::Directory::open(&self.home)?;
            directory.read(
                path.strip_prefix(&self.home)
                    .map_err(|_| std::io::Error::other("invalid library path"))?,
                69632,
                false,
            )
        })();
        let raw = match read {
            Ok(raw) => {
                String::from_utf8(raw).map_err(|_| MemoryError("library is not UTF-8".into()))?
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        let (fields, body) = parse_document(&raw);
        let cap = crate::sessions::cap;
        let item = LibraryItem {
            id: id.into(),
            name: cap(fields.get("name").map(String::as_str).unwrap_or(id), 120),
            description: cap(
                fields.get("description").map(String::as_str).unwrap_or(""),
                500,
            ),
            enabled: fields.get("enabled").is_none_or(|value| value != "false"),
            body: cap(&body, 65536),
            skills: fields
                .get("skills")
                .map(|value| {
                    value
                        .split(',')
                        .map(str::trim)
                        .filter(|id| id_valid(id))
                        .take(50)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default(),
        };
        item.validate()?;
        Ok(Some(item))
    }
    pub fn list(&self, kind: Kind) -> Result<Vec<LibraryItem>, MemoryError> {
        let directory = self.directory(kind);
        if !directory.try_exists()? {
            return Ok(Vec::new());
        }
        let mut items = Vec::new();
        let root = crate::secure_fs::Directory::open(&self.home)?;
        let directory = root.subdir(
            directory
                .strip_prefix(&self.home)
                .map_err(|_| MemoryError("invalid library directory".into()))?,
        )?;
        for (count, entry) in directory.entries()?.enumerate() {
            if count >= 10000 {
                return Err(MemoryError("library exceeds entry limit".into()));
            }
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let id = match kind {
                Kind::Agent => name.strip_suffix(".md"),
                Kind::Skill => Some(name.as_str()),
            };
            if let Some(id) = id
                && let Ok(Some(item)) = self.get(kind, id)
            {
                items.push(item);
            }
        }
        items.sort_by(|left, right| left.id.cmp(&right.id));
        Ok(items)
    }
    fn write_inner(&self, kind: Kind, item: &LibraryItem) -> Result<(), MemoryError> {
        item.validate()?;
        if item.name.contains(['\n', '\r']) || item.description.contains(['\n', '\r']) {
            return Err(MemoryError("multiline frontmatter scalar".into()));
        }
        let path = self.path(kind, &item.id)?;
        owned_directory(&self.home)?;
        let directory = crate::secure_fs::Directory::open(&self.home)?;
        let relative = path
            .strip_prefix(&self.home)
            .map_err(|_| MemoryError("invalid library path".into()))?;
        directory.ensure_dir(
            relative
                .parent()
                .ok_or_else(|| MemoryError("missing library parent".into()))?,
        )?;
        let mut header = format!("---\nname: {}\n", scalar(&item.name));
        if !item.description.is_empty() {
            header.push_str(&format!("description: {}\n", scalar(&item.description)));
        }
        header.push_str(&format!("enabled: {}\n", item.enabled));
        if !item.skills.is_empty() {
            header.push_str(&format!("skills: {}\n", scalar(&item.skills.join(", "))));
        }
        header.push_str(&format!("---\n\n{}\n", item.body.trim_end()));
        if header.len() > 69632 {
            return Err(MemoryError("library document exceeds limit".into()));
        }
        Ok(directory.write(relative, header.as_bytes(), false, false)?)
    }
    fn lock(&self) -> Result<crate::state::LockGuard, MemoryError> {
        Ok(
            crate::state::StateStore::new(crate::state::Config::from_home(&self.home)?)
                .lock(Duration::from_secs(10))?,
        )
    }
    pub fn write(&self, kind: Kind, item: &LibraryItem) -> Result<(), MemoryError> {
        let guard = self.lock()?;
        self.write_inner(kind, item)?;
        guard.release()?;
        Ok(())
    }
    pub fn create(&self, kind: Kind, mut item: LibraryItem) -> Result<LibraryItem, MemoryError> {
        let guard = self.lock()?;
        let mut base = String::new();
        for character in item.name.to_lowercase().chars() {
            if character.is_ascii_alphanumeric() {
                base.push(character);
            } else if !base.ends_with('-') {
                base.push('-');
            }
        }
        let base = base
            .trim_matches('-')
            .chars()
            .take(64)
            .collect::<String>()
            .trim_end_matches('-')
            .to_owned();
        let base = if base.is_empty() { "item".into() } else { base };
        let mut selected = None;
        for number in 1..1000 {
            let id = if number == 1 {
                base.clone()
            } else {
                format!("{}-{number}", &base[..base.len().min(59)])
            };
            if !self.path(kind, &id)?.try_exists()? {
                selected = Some(id);
                break;
            }
        }
        item.id = selected.ok_or_else(|| MemoryError("too many items with this name".into()))?;
        self.write_inner(kind, &item)?;
        guard.release()?;
        Ok(item)
    }
    pub fn update(
        &self,
        kind: Kind,
        id: &str,
        patch: LibraryUpdate,
    ) -> Result<LibraryItem, MemoryError> {
        let guard = self.lock()?;
        let mut item = self
            .get(kind, id)?
            .ok_or_else(|| MemoryError("library item not found".into()))?;
        if let Some(name) = patch.name {
            item.name = name;
        }
        if let Some(description) = patch.description {
            item.description = description;
        }
        if let Some(enabled) = patch.enabled {
            item.enabled = enabled;
        }
        if let Some(body) = patch.body {
            item.body = body;
        }
        if let Some(skills) = patch.skills {
            item.skills = skills.into_iter().filter(|id| id_valid(id)).collect();
        }
        self.write_inner(kind, &item)?;
        guard.release()?;
        Ok(item)
    }
    pub fn remove(&self, kind: Kind, id: &str) -> Result<(), MemoryError> {
        let guard = self.lock()?;
        let path = self.path(kind, id)?;
        if self.get(kind, id)?.is_none() {
            return Err(MemoryError("library item not found".into()));
        }
        let directory = crate::secure_fs::Directory::open(&self.home)?;
        let relative = path
            .strip_prefix(&self.home)
            .map_err(|_| MemoryError("invalid library path".into()))?;
        match kind {
            Kind::Agent => directory.remove(relative)?,
            Kind::Skill => directory.dir()?.remove_dir_all(
                relative
                    .parent()
                    .ok_or_else(|| MemoryError("missing skill parent".into()))?,
            )?,
        }
        guard.release()?;
        Ok(())
    }
    pub fn compose(
        &self,
        agent: Option<&str>,
        skills: &[String],
    ) -> Result<Option<String>, MemoryError> {
        if skills.len() > 50 {
            return Err(MemoryError("skill selection exceeds limit".into()));
        }
        let agent = agent
            .filter(|id| !id.is_empty())
            .map(|id| self.get(Kind::Agent, id))
            .transpose()?
            .flatten()
            .filter(|item| item.enabled);
        let mut selected = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for id in agent.iter().flat_map(|item| &item.skills).chain(skills) {
            if seen.insert(id)
                && let Some(skill) = self.get(Kind::Skill, id)?.filter(|skill| skill.enabled)
            {
                selected.push(skill);
            }
        }
        Ok(compose(agent.as_ref(), &selected))
    }
}
