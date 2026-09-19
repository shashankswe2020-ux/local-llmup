use std::io;

#[derive(Debug, PartialEq, Eq)]
pub enum Action {
    Cancel,
    Select,
}

#[derive(Default)]
pub struct Progress {
    dialogs: usize,
    passed: bool,
}

impl Progress {
    pub fn observe(&mut self, line: &str) -> io::Result<Option<Action>> {
        if line.len() > 4096 {
            return Err(io::Error::other("desktop smoke line exceeds bound"));
        }
        if line.contains("R22 directory picker requested") {
            if self.passed || self.dialogs >= 2 {
                return Err(io::Error::other("unexpected extra native dialog"));
            }
            self.dialogs += 1;
            return Ok(Some(if self.dialogs == 1 {
                Action::Cancel
            } else {
                Action::Select
            }));
        }
        if line.contains("smoke: passed") {
            if self.dialogs != 2 || self.passed {
                return Err(io::Error::other("unexpected desktop success marker"));
            }
            self.passed = true;
        }
        Ok(None)
    }

    pub fn complete(&self, success: bool) -> bool {
        success && self.dialogs == 2 && self.passed
    }
}
