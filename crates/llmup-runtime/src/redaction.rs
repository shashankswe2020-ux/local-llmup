pub(crate) struct StreamRedactor {
    secrets: Vec<String>,
    pending: String,
}
impl StreamRedactor {
    pub(crate) fn new(secrets: impl IntoIterator<Item = String>) -> Self {
        let mut secrets: Vec<_> = secrets
            .into_iter()
            .filter(|secret| !secret.is_empty())
            .collect();
        secrets.sort_by_key(|secret| std::cmp::Reverse(secret.len()));
        secrets.dedup();
        Self {
            secrets,
            pending: String::new(),
        }
    }
    pub(crate) fn push(&mut self, text: &str) -> String {
        self.pending.push_str(text);
        let mut safe = String::new();
        while let Some((index, length)) = self
            .secrets
            .iter()
            .filter_map(|secret| self.pending.find(secret).map(|index| (index, secret.len())))
            .min_by_key(|(index, length)| (*index, std::cmp::Reverse(*length)))
        {
            safe.push_str(&self.pending[..index]);
            safe.push_str("[REDACTED]");
            self.pending.drain(..index + length);
        }
        let retained = self
            .secrets
            .iter()
            .map(|secret| {
                (1..secret.len().min(self.pending.len() + 1))
                    .rev()
                    .find(|length| {
                        self.pending
                            .as_bytes()
                            .ends_with(&secret.as_bytes()[..*length])
                    })
                    .unwrap_or(0)
            })
            .max()
            .unwrap_or(0);
        let ready = self.pending.len() - retained;
        safe.push_str(&self.pending[..ready]);
        self.pending.drain(..ready);
        safe
    }
    pub(crate) fn finish(&mut self) -> String {
        std::mem::take(&mut self.pending)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn split_multiple_credentials_are_redacted_before_emission() {
        let mut redactor = StreamRedactor::new(["secret-key".into(), "another-token".into()]);
        let mut output = String::new();
        for chunk in ["safe sec", "ret-key ano", "ther-token tail"] {
            output.push_str(&redactor.push(chunk));
        }
        output.push_str(&redactor.finish());
        assert_eq!(output, "safe [REDACTED] [REDACTED] tail");
    }
}
