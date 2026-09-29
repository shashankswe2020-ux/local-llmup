# Crossterm 0.29.0 Local Patch

Source: the crates.io 0.29.0 release, upstream commit
`36d95b26a26e64b0f8c12edfe11f410a6d56a812`.
The initial local copy was byte-compared with the cached release before editing.
The upstream MIT license is retained in LICENSE.

Approved on 2026-09-23 for rigspark terminal input safety. Since 1.0.0 it is
published as the `rigspark-crossterm` crate (library name `crossterm`) because
crates.io ignores `[patch]`; rigspark-cli depends on it by package rename. Ratatui
keeps upstream crossterm for rendering only, and rigspark-cli never asks Ratatui
for the cursor position (no inline viewport, no `Terminal::clear`), so all
terminal input is parsed by this fork (`tests/crossterm_boundary.rs`). The
application still forbids
unsafe code; this excluded third-party crate retains its upstream implementation.

Local changes:
- Both Unix event sources bound finite sequences to 64 bytes and bracketed paste
  payloads to 1 MiB. Oversized input is discarded through its final byte/end marker
  without exposing payload characters as shortcuts. Paste is parsed only when its
  terminator arrives, avoiding repeated scans of growing payloads.
- Lone Escape is held for 50 ms so fragmented paste/navigation sequences can be
  assembled. Poll waits respect that deadline; standalone Escape remains usable.
  After a short (draining) TTY read both sources return to poll instead of
  reading again, because the Unix TTY descriptor may block and would otherwise
  prevent the Escape deadline from expiring (regression-tested by the PTY suite).
- Shared parser regressions cover bounds, recovery, ordinary events, and Escape.
- An upstream redundant-parentheses warning is removed for current Rust tooling.
- Registry cache markers and upstream CI configuration are omitted. Upstream
  source, examples, documentation and license remain; local test lockfile is kept.

Run from the repository root:

```sh
cargo test --locked --manifest-path vendor/crossterm/Cargo.toml --lib event::
cargo test --locked --manifest-path vendor/crossterm/Cargo.toml --lib --features use-dev-tty event::
cargo test --locked -p rigspark-cli --test tui_pty -- --test-threads=2
```

The application additionally filters decoded terminal-string payloads before
dispatch. Windows console-event decoding is unchanged; Unix source tests have
been run on macOS, not certified on Linux/Windows. Review this patch against each
upstream update; do not silently replace it or assume an upstream fix exists.
Native archives and Docker include the license and this notice. Publication and
platform certification remain gated separately.