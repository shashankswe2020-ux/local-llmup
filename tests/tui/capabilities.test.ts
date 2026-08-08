import { describe, expect, it } from "vitest";
import { ValidationError } from "../../src/errors.js";
import {
  captureTerminalCapabilities,
  detectCiEnvironment,
  detectNoColorEnvironment,
  resolveUiMode,
  resolveUiModeFromSources,
  type TerminalCapabilities,
  type UiModeOptions,
  type UiModeReason,
  UiModeValidationError,
} from "../../src/tui/capabilities.js";

function capabilities(overrides: Partial<TerminalCapabilities> = {}): TerminalCapabilities {
  return {
    stdinTty: true,
    stdoutTty: true,
    stderrTty: true,
    columns: 120,
    rows: 40,
    colorDepth: 24,
    unicode: true,
    ci: false,
    term: "xterm-256color",
    ...overrides,
  };
}

function select(options: UiModeOptions = {}, overrides: Partial<TerminalCapabilities> = {}) {
  return resolveUiMode(options, capabilities(overrides));
}

function expectReason(
  options: UiModeOptions,
  overrides: Partial<TerminalCapabilities>,
  reason: UiModeReason,
): void {
  expect(() => select(options, overrides)).toThrowError(
    expect.objectContaining({ reason, code: "VALIDATION" }),
  );
}

describe("resolveUiMode normative mode table", () => {
  it("selects JSON and rejects interactive conflicts before domain work", () => {
    expect(select({ json: true })).toMatchObject({
      mode: "json",
      explicit: true,
      color: false,
      unicode: false,
    });
    expectReason({ json: true, tui: true }, {}, "json_conflict");
    expectReason({ json: true, accessible: true }, {}, "json_conflict");
  });

  it("selects forced plain and rejects interactive conflicts", () => {
    expect(select({ noTui: true })).toMatchObject({ mode: "plain", explicit: true });
    expectReason({ noTui: true, tui: true }, {}, "mode_conflict");
    expectReason({ noTui: true, accessible: true }, {}, "mode_conflict");
  });

  it("selects accessible mode at its independent 40x10 threshold", () => {
    expect(select({ accessible: true }, { columns: 40, rows: 10 })).toMatchObject({
      mode: "accessible",
      explicit: true,
      color: false,
      unicode: false,
    });
    expect(select({ tui: true, accessible: true }, { columns: 50, rows: 12 }).mode).toBe(
      "accessible",
    );
  });

  it("selects visual TUI explicitly or automatically only at 60x16", () => {
    expect(select({ tui: true }, { columns: 60, rows: 16 })).toMatchObject({
      mode: "tui",
      explicit: true,
    });
    expect(select({}, { columns: 60, rows: 16 })).toMatchObject({
      mode: "tui",
      explicit: false,
    });
    expect(select({}, { columns: 59, rows: 16 })).toMatchObject({
      mode: "plain",
      explicit: false,
      reason: "terminal_width",
    });
  });

  it("fails explicit accessible or TUI requests but silently falls back in auto mode", () => {
    expectReason({ accessible: true }, { stdoutTty: false }, "stdout_not_tty");
    expectReason({ tui: true }, { ci: true }, "ci_environment");
    expect(select({}, { ci: true })).toMatchObject({
      mode: "plain",
      explicit: false,
      reason: "ci_environment",
    });
  });

  it("never lets explicit TUI override piped input", () => {
    expectReason({ tui: true, pipedInput: true }, {}, "piped_input");
    expect(select({ pipedInput: true })).toMatchObject({
      mode: "plain",
      reason: "piped_input",
    });
  });
});

describe("terminal eligibility", () => {
  it("uses the conservative all-three-TTY predicate for all eight combinations", () => {
    for (const stdinTty of [false, true]) {
      for (const stdoutTty of [false, true]) {
        for (const stderrTty of [false, true]) {
          const result = select({}, { stdinTty, stdoutTty, stderrTty });
          expect(result.mode).toBe(stdinTty && stdoutTty && stderrTty ? "tui" : "plain");
        }
      }
    }
  });

  it.each([
    [{ pipedInput: true }, {}, "piped_input"],
    [{}, { stdinTty: false }, "stdin_not_tty"],
    [{}, { stdoutTty: false }, "stdout_not_tty"],
    [{}, { stderrTty: false }, "stderr_not_tty"],
    [{}, { term: null }, "term_missing"],
    [{}, { term: "dumb " }, "term_invalid"],
    [{}, { term: "dumb" }, "term_dumb"],
    [{}, { ci: true }, "ci_environment"],
    [{}, { columns: 59 }, "terminal_width"],
    [{}, { rows: 15 }, "terminal_height"],
  ] as const)("returns stable reason %s", (options, overrides, reason) => {
    expect(select(options, overrides).reason).toBe(reason);
    expectReason({ ...options, tui: true }, overrides, reason);
  });

  it("uses the accessible minimums and reports their same stable size reasons", () => {
    expectReason({ accessible: true }, { columns: 39 }, "terminal_width");
    expectReason({ accessible: true }, { rows: 9 }, "terminal_height");
  });

  it.each([" ", "\tdumb", "dumb\n", "xterm\u001b[2J", "xterm/../../tty"])(
    "rejects malformed TERM value %j",
    (term) => {
      expect(select({}, { term })).toMatchObject({ mode: "plain", reason: "term_invalid" });
      expectReason({ tui: true }, { term }, "term_invalid");
    },
  );

  it.each([129, 256, 257])("reports captured TERM length %i as invalid, not missing", (length) => {
    const result = resolveUiModeFromSources(
      {},
      {
        stdin: { isTTY: true },
        stdout: { isTTY: true, columns: 80, rows: 24 },
        stderr: { isTTY: true },
        env: { TERM: "x".repeat(length), LANG: "en_US.UTF-8" },
        platform: "linux",
      },
    );
    expect(result).toMatchObject({ mode: "plain", reason: "term_invalid" });
  });
});

describe("CI and color policy", () => {
  it.each([
    [{ CI: "true" }],
    [{ GITHUB_ACTIONS: "true" }],
    [{ GITLAB_CI: "true" }],
    [{ TF_BUILD: "True" }],
    [{ BUILDKITE: "true" }],
    [{ JENKINS_URL: "" }],
  ])("recognizes the fixed CI allowlist", (env) => {
    expect(detectCiEnvironment(env)).toBe(true);
  });

  it("ignores undocumented CI values", () => {
    expect(detectCiEnvironment({ CI: "1", TF_BUILD: "true" })).toBe(false);
  });

  it("detects NO_COLOR by presence and never treats FORCE_COLOR as TUI eligibility", () => {
    expect(detectNoColorEnvironment({ NO_COLOR: "" })).toBe(true);
    expect(detectNoColorEnvironment({})).toBe(false);
    expect(select({ forceColor: true }, { stdinTty: false }).mode).toBe("plain");
  });

  it("NO_COLOR and --no-color disable styling without changing visual mode", () => {
    expect(select({ environmentNoColor: true })).toMatchObject({ mode: "tui", color: false });
    expect(select({ noColor: true })).toMatchObject({ mode: "tui", color: false });
    expect(select({ forceColor: true })).toMatchObject({ mode: "tui", color: true });
  });

  it("captures NO_COLOR atomically when resolving from process-like sources", () => {
    const result = resolveUiModeFromSources(
      {},
      {
        stdin: { isTTY: true },
        stdout: { isTTY: true, columns: 80, rows: 24, getColorDepth: () => 24 },
        stderr: { isTTY: true },
        env: { TERM: "xterm-256color", LANG: "en_US.UTF-8", NO_COLOR: "" },
        platform: "linux",
      },
    );
    expect(result).toMatchObject({ mode: "tui", color: false });
  });

  it("exposes typed validation errors", () => {
    try {
      select({ tui: true }, { term: null });
      throw new Error("expected mode validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect(error).toBeInstanceOf(UiModeValidationError);
      expect(error).toMatchObject({ reason: "term_missing" });
    }
  });
});

describe("captureTerminalCapabilities", () => {
  it("captures streams, dimensions, color, CI, TERM, and Unicode conservatively", () => {
    const captured = captureTerminalCapabilities({
      stdin: { isTTY: true },
      stdout: { isTTY: true, columns: 100, rows: 30, getColorDepth: () => 24 },
      stderr: { isTTY: true },
      env: { TERM: "xterm-256color", LANG: "en_US.UTF-8", GITHUB_ACTIONS: "true" },
      platform: "linux",
    });
    expect(captured).toEqual({
      stdinTty: true,
      stdoutTty: true,
      stderrTty: true,
      columns: 100,
      rows: 30,
      colorDepth: 24,
      unicode: true,
      ci: true,
      term: "xterm-256color",
    });
  });

  it("uses safe zero-size, monochrome, ASCII defaults for missing/unsafe capabilities", () => {
    expect(
      captureTerminalCapabilities({
        stdin: {},
        stdout: { columns: Number.NaN, rows: -1, getColorDepth: () => 3 },
        stderr: {},
        env: {},
        platform: "win32",
      }),
    ).toEqual({
      stdinTty: false,
      stdoutTty: false,
      stderrTty: false,
      columns: 0,
      rows: 0,
      colorDepth: 1,
      unicode: false,
      ci: false,
      term: null,
    });
  });
});
