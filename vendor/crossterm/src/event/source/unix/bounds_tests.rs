use super::Parser;
use crate::event::{Event, InternalEvent, KeyCode};

#[test]
fn incomplete_csi_has_bounded_storage_and_discards_payload_until_final() {
    let mut parser = Parser::default();
    parser.advance(b"\x1b[", true);
    for _ in 0..1024 {
        parser.advance(&[b'1'; 1024], true);
        assert!(parser.buffer.len() <= 64);
    }
    parser.advance(b"q?", false);
    assert_eq!(
        parser.next(),
        Some(InternalEvent::Event(Event::Key(KeyCode::Char('?').into())))
    );
    assert!(parser.next().is_none());
}

#[test]
fn oversized_paste_is_discarded_through_fragmented_end_without_shortcuts() {
    let mut parser = Parser::default();
    parser.advance(b"\x1b[200~", true);
    for _ in 0..1026 {
        parser.advance(&[b'q'; 1024], true);
        assert!(parser.buffer.len() <= 1024 * 1024 + 12);
    }
    for byte in b"\x03\x1b[201~" {
        parser.advance(&[*byte], true);
    }
    parser.advance(b"?", false);
    assert_eq!(
        parser.next(),
        Some(InternalEvent::Event(Event::Key(KeyCode::Char('?').into())))
    );
    assert!(parser.next().is_none());
}

#[test]
fn ordinary_sequences_and_bounded_paste_still_decode() {
    let mut parser = Parser::default();
    parser.advance(b"\x1b[F", false);
    assert_eq!(
        parser.next(),
        Some(InternalEvent::Event(Event::Key(KeyCode::End.into())))
    );
    parser.advance(b"\x1b[200~q\x03\x1b[201~", false);
    assert_eq!(
        parser.next(),
        Some(InternalEvent::Event(Event::Paste("q\u{3}".into())))
    );
    assert!(parser.next().is_none());
}

#[test]
fn paste_payload_limit_is_inclusive_and_one_byte_over_is_discarded() {
    for length in [1024 * 1024, 1024 * 1024 + 1] {
        let mut parser = Parser::default();
        parser.advance(b"\x1b[200~", true);
        parser.advance(&vec![b'x'; length], true);
        parser.advance(b"\x1b[201~?", false);
        if length == 1024 * 1024 {
            assert!(
                matches!(parser.next(), Some(InternalEvent::Event(Event::Paste(value))) if value.len() == length)
            );
        }
        assert_eq!(
            parser.next(),
            Some(InternalEvent::Event(Event::Key(KeyCode::Char('?').into())))
        );
        assert!(parser.next().is_none());
    }
}

#[test]
fn standalone_escape_expires_but_fragmented_sequences_cancel_its_deadline() {
    let mut parser = Parser::default();
    parser.advance(b"\x1b", false);
    assert!(parser.next().is_none());
    assert!(parser.wait(None).unwrap() <= std::time::Duration::from_millis(50));
    parser.escape_deadline = Some(std::time::Instant::now());
    assert_eq!(
        parser.next(),
        Some(InternalEvent::Event(Event::Key(KeyCode::Esc.into())))
    );
    assert!(parser.next().is_none());
    parser.advance(b"\x1b", false);
    parser.advance(b"[200~q\x03\x1b[201~", false);
    assert_eq!(
        parser.next(),
        Some(InternalEvent::Event(Event::Paste("q\u{3}".into())))
    );
    assert!(parser.escape_deadline.is_none());
    assert!(parser.next().is_none());
}
