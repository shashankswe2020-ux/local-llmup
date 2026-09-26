const PASTE_START: &[u8] = b"\x1b[200~";
const PASTE_END: &[u8] = b"\x1b[201~";
const MAX_SEQUENCE: usize = 64;
const MAX_PASTE: usize = 1024 * 1024;

#[derive(Default, Debug)]
pub(super) struct InputBound {
    discard: Option<Discard>,
}

#[derive(Debug)]
enum Discard {
    Sequence,
    Paste(usize),
}

impl InputBound {
    pub(super) fn advance(&mut self, buffer: &mut Vec<u8>, byte: u8) -> bool {
        match &mut self.discard {
            Some(Discard::Sequence) => {
                if (b'@'..=b'~').contains(&byte) {
                    self.discard = None;
                }
                return false;
            }
            Some(Discard::Paste(matched)) => {
                *matched = if byte == PASTE_END[*matched] {
                    *matched + 1
                } else {
                    usize::from(byte == PASTE_END[0])
                };
                if *matched == PASTE_END.len() {
                    self.discard = None;
                }
                return false;
            }
            None => (),
        }
        buffer.push(byte);
        if buffer.starts_with(PASTE_START) {
            let complete = buffer.ends_with(PASTE_END);
            let payload = buffer.len() - PASTE_START.len();
            if complete && payload <= MAX_PASTE + PASTE_END.len() {
                return true;
            }
            if payload > MAX_PASTE + PASTE_END.len() {
                if !complete {
                    let matched = (1..PASTE_END.len())
                        .rev()
                        .find(|length| buffer.ends_with(&PASTE_END[..*length]))
                        .unwrap_or(0);
                    self.discard = Some(Discard::Paste(matched));
                }
                buffer.clear();
            }
            return false;
        }
        if buffer.len() > MAX_SEQUENCE {
            buffer.clear();
            if !(b'@'..=b'~').contains(&byte) {
                self.discard = Some(Discard::Sequence);
            }
            return false;
        }
        true
    }
}
