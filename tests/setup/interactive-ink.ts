// Ink (via is-in-ci) suppresses interactive frame rendering when it detects a CI
// environment, so TUI screens only emit their final frame on unmount. The TUI
// tests assert on intermediate frames, so force interactive rendering here —
// this must run before Ink is imported. Nothing in this codebase reads `CI`.
process.env.CI = "false";
