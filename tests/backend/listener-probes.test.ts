import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ connections: vi.fn(), processes: vi.fn(), exists: vi.fn(), realpath: vi.fn(), stat: vi.fn(), exec: vi.fn() }));
vi.mock("systeminformation", () => ({ networkConnections: mocks.connections, processes: mocks.processes }));
vi.mock("node:fs", () => ({ existsSync: mocks.exists, realpathSync: mocks.realpath, statSync: mocks.stat }));
vi.mock("node:child_process", () => {
  Object.defineProperty(mocks.exec, Symbol.for("nodejs.util.promisify.custom"), {
    value: (...args: unknown[]) => new Promise((resolve, reject) => {
      mocks.exec(...args, (error: Error | null, stdout: string) => error ? reject(error) : resolve({ stdout }));
    }),
  });
  return { execFile: mocks.exec };
});
import { findListenerIdentity, isPythonInterpreter, matchesExpectedExecutable, parseLsofTextExecutable, parsePsStartTime, probeListenerIdentity, probeProcessIdentity } from "../../src/backend/listener.js";

const row = { protocol: "tcp", localAddress: "127.0.0.1", localPort: "11434", peerAddress: "", peerPort: "", state: "LISTEN", pid: 42, process: "ollama" };
const processRow = { pid: 42, name: "ollama", path: "/bin/ollama", started: "start" };
beforeEach(() => {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  mocks.connections.mockResolvedValue([row]);
  mocks.processes.mockResolvedValue({ list: [processRow] });
  mocks.exists.mockReturnValue(true);
  mocks.realpath.mockImplementation((path: string) => path);
  mocks.stat.mockReturnValue({ isDirectory: () => false });
});
afterEach(() => vi.unstubAllEnvs());

describe("OS identity probe failures", () => {
  it("resolves Linux proc identities and falls back to process paths", async () => {
    await expect(probeListenerIdentity(11434, "localhost")).resolves.toMatchObject({ executable: "/proc/42/exe" });
    mocks.exists.mockImplementation((path: string) => !path.startsWith("/proc"));
    await expect(probeProcessIdentity(42)).resolves.toMatchObject({ executable: "/bin/ollama" });
    mocks.stat.mockReturnValue({ isDirectory: () => true });
    await expect(probeProcessIdentity(42)).resolves.toMatchObject({ executable: "/bin/ollama/ollama" });
  });
  it.each(["missing", "malformed", "no-path", "stat-error", "realpath-error", "process-error", "connection-error"])("fails closed for %s", async (failure) => {
    mocks.exists.mockImplementation((path: string) => !path.startsWith("/proc"));
    if (failure === "missing") mocks.processes.mockResolvedValue({ list: [] });
    if (failure === "malformed") mocks.processes.mockResolvedValue({ list: [{ ...processRow, started: "" }] });
    if (failure === "no-path") mocks.processes.mockResolvedValue({ list: [{ ...processRow, path: "" }] });
    if (failure === "stat-error") mocks.stat.mockImplementation(() => { throw Error("unavailable"); });
    if (failure === "realpath-error") mocks.realpath.mockImplementation(() => { throw Error("unavailable"); });
    if (failure === "process-error") mocks.processes.mockRejectedValue(Error("unavailable"));
    if (failure === "connection-error") mocks.connections.mockRejectedValue(Error("unavailable"));
    await expect(probeListenerIdentity(11434, "127.0.0.1")).resolves.toBeNull();
    if (failure !== "connection-error") await expect(probeProcessIdentity(42)).resolves.toBeNull();
  });
  it.each(["valid", "lsof-error", "lsof-empty", "ps-error", "ps-empty"])("handles macOS command result %s", async (scenario) => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    mocks.exec.mockImplementation((command: string, _args: unknown, _options: unknown, callback: (error: Error | null, stdout: string) => void) => {
      const lsof = command.includes("lsof");
      if ((lsof && scenario === "lsof-error") || (!lsof && scenario === "ps-error")) callback(Error("unavailable"), "");
      else callback(null, lsof ? scenario === "lsof-empty" ? "" : "ftxt\nn/bin/ollama" : scenario === "ps-empty" ? "" : "Thu Sep 17 12:00:00 2026");
    });
    const result = await probeListenerIdentity(11434, "127.0.0.1");
    const processResult = await probeProcessIdentity(42);
    if (["valid", "lsof-empty"].includes(scenario)) {
      expect(result).toMatchObject({ executable: "/bin/ollama", started: "2026-09-17 12:00:00" });
      expect(processResult).toMatchObject({ pid: 42 });
    } else { expect(result).toBeNull(); expect(processResult).toBeNull(); }
  });
  it("rejects malformed socket input and normalizes loopback addresses", () => {
    expect(findListenerIdentity(11434, "localhost", null)).toBeNull();
    for (const host of ["::1", "localhost"]) expect(findListenerIdentity(11434, "localhost", [{ ...row, localAddress: host }])).toMatchObject({ pid: 42 });
    expect(findListenerIdentity(11434, "localhost", [{ ...row, localAddress: "0.0.0.0" }])).toBeNull();
    expect(parseLsofTextExecutable("ftxt\nxwrong\nftxt\nn")).toBeNull();
    expect(parsePsStartTime("invalid")).toBeNull();
    expect(parsePsStartTime("Thu Sep 32 12:00:00 2026")).toBeNull();
  });
  it("recognizes Python layouts without accepting unrelated executables", () => {
    mocks.exists.mockReturnValue(false);
    vi.stubEnv("PATH", "");
    const identity = { pid: 42, process: "other", executable: "/bin/other", started: "start", localAddress: "127.0.0.1" };
    expect(isPythonInterpreter(identity)).toBe(false);
    expect(isPythonInterpreter({ ...identity, process: "python3.12" })).toBe(true);
    expect(isPythonInterpreter({ ...identity, executable: "/Frameworks/Python.framework/Versions/3.12/bin/other" })).toBe(true);
    expect(isPythonInterpreter({ ...identity, executable: "/bin/python3.12" })).toBe(true);
    expect(matchesExpectedExecutable(identity, "other")).toBe(true);
    vi.stubEnv("PATH", "/bin");
    mocks.exists.mockReturnValue(true);
    expect(matchesExpectedExecutable(identity, "other")).toBe(true);
  });
});