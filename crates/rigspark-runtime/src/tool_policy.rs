use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ToolRisk {
    ReadOnly,
    ProcessNetwork,
    WorkspaceMutation,
    Unknown,
}

pub fn classify(name: &str, description: &str) -> ToolRisk {
    let mut expanded = String::new();
    let mut lower = false;
    for character in format!("{name} {description}").chars() {
        if lower && character.is_ascii_uppercase() {
            expanded.push(' ');
        }
        lower = character.is_ascii_lowercase();
        expanded.push(character.to_ascii_lowercase());
    }
    let tokens: HashSet<_> = expanded
        .split(|character: char| !character.is_ascii_alphanumeric())
        .collect();
    for (risk, words) in [
        (
            ToolRisk::WorkspaceMutation,
            "write create delete remove edit apply patch move rename mkdir rmdir chmod put update insert drop",
        ),
        (
            ToolRisk::ProcessNetwork,
            "exec execute run shell command spawn fetch http https request curl wget download upload network socket ssh",
        ),
        (
            ToolRisk::ReadOnly,
            "read get list search find show view cat status diff log query describe inspect lookup",
        ),
    ] {
        if words.split(' ').any(|word| tokens.contains(word)) {
            return risk;
        }
    }
    ToolRisk::Unknown
}
pub fn redact_arguments(value: &Value) -> Value {
    fn redact(value: &Value, depth: usize) -> Value {
        if depth > 4 {
            return Value::String("[...]".into());
        }
        match value {
            Value::String(text) if text.encode_utf16().count() > 256 => Value::String(format!(
                "{}... [{} chars]",
                text.chars().take(64).collect::<String>(),
                text.encode_utf16().count()
            )),
            Value::Array(values) => Value::Array(
                values
                    .iter()
                    .take(20)
                    .map(|value| redact(value, depth + 1))
                    .collect(),
            ),
            Value::Object(values) => Value::Object(
                values
                    .iter()
                    .take(128)
                    .map(|(key, value)| {
                        let lower = key.to_lowercase();
                        let secret = [
                            "token",
                            "secret",
                            "key",
                            "password",
                            "passwd",
                            "pwd",
                            "auth",
                            "credential",
                            "cookie",
                            "session",
                            "bearer",
                        ]
                        .iter()
                        .any(|word| lower.contains(word));
                        (
                            key.clone(),
                            if secret {
                                Value::String("[redacted]".into())
                            } else {
                                redact(value, depth + 1)
                            },
                        )
                    })
                    .collect(),
            ),
            _ => value.clone(),
        }
    }
    redact(value, 0)
}
pub(crate) fn serialize_arguments<Serializer: serde::Serializer>(
    value: &Value,
    serializer: Serializer,
) -> Result<Serializer::Ok, Serializer::Error> {
    redact_arguments(value).serialize(serializer)
}
#[derive(Debug, Serialize)]
pub struct ResultPreview {
    pub text: String,
    pub truncated: bool,
}
pub fn redact_result(text: &str) -> ResultPreview {
    let mut masked = String::new();
    for part in text.split_inclusive(|character: char| {
        !character.is_ascii_alphanumeric() && !['_', '-'].contains(&character)
    }) {
        let token = part.trim_end_matches(|character: char| {
            !character.is_ascii_alphanumeric() && !['_', '-'].contains(&character)
        });
        if token.len() >= 24
            && token.bytes().any(|byte| byte.is_ascii_alphabetic())
            && token.bytes().any(|byte| byte.is_ascii_digit())
        {
            masked.push_str("[redacted]");
            masked.push_str(&part[token.len()..]);
        } else {
            masked.push_str(part);
        }
        if masked.encode_utf16().count() > 2048 {
            return ResultPreview {
                text: format!("{}...", crate::sessions::cap(&masked, 2048)),
                truncated: true,
            };
        }
    }
    ResultPreview {
        text: masked,
        truncated: false,
    }
}

#[derive(Default)]
pub struct SessionGrants {
    session: String,
    workspace: Option<String>,
    grants: HashSet<String>,
}
impl SessionGrants {
    pub fn select(&mut self, session: &str, workspace: Option<&str>) {
        if self.session != session || self.workspace.as_deref() != workspace {
            self.grants.clear();
            self.session = session.into();
            self.workspace = workspace.map(str::to_owned);
        }
    }
    pub fn clear(&mut self) {
        self.grants.clear();
    }
    pub(crate) fn grant(&mut self, key: String) -> bool {
        if self.session.is_empty() || self.grants.len() >= 1024 {
            return false;
        }
        self.grants.insert(key);
        true
    }
    pub(crate) fn allows(&self, key: &str) -> bool {
        !self.session.is_empty() && self.grants.contains(key)
    }
}
