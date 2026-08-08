import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, delimiter, isAbsolute, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { networkConnections, processes } from "systeminformation";
import { z } from "zod";

const NetworkConnectionSchema = z
  .object({
    protocol: z.string(),
    localAddress: z.string(),
    localPort: z.string(),
    peerAddress: z.string(),
    peerPort: z.string(),
    state: z.string(),
    pid: z.number().int().positive(),
    process: z.string().min(1),
  })
  .strict();

const ProcessSchema = z
  .object({
    pid: z.number().int().positive(),
    name: z.string().min(1),
    path: z.string(),
    started: z.string().min(1),
  })
  .passthrough();
const execFileAsync = promisify(execFile);

/** Process identity observed for a unique listening socket. */
export interface ListenerIdentity {
  readonly pid: number;
  readonly process: string;
  readonly executable: string;
  readonly started: string;
  readonly localAddress: string;
}

/** Process identity independent of listener ownership, used during shutdown. */
export interface ProcessIdentity {
  readonly pid: number;
  readonly process: string;
  readonly executable: string;
  readonly started: string;
}

/**
 * Return the unique process listening on `port`, or `null` when external probe
 * data is malformed, missing, or ambiguous. External systeminformation output
 * is validated with Zod before use so lifecycle decisions fail closed.
 */
export function findListenerIdentity(
  port: number,
  expectedHost: string,
  value: unknown,
): Omit<ListenerIdentity, "executable" | "started"> | null {
  if (!Array.isArray(value)) return null;
  const rows = value.flatMap((row) => {
    const parsed = NetworkConnectionSchema.safeParse(row);
    return parsed.success ? [parsed.data] : [];
  });
  const matches = rows.filter(
    (connection) =>
      Number(connection.localPort) === port &&
      connection.state.toUpperCase() === "LISTEN" &&
      addressesMatch(connection.localAddress, expectedHost),
  );
  if (matches.length !== 1) return null;
  const [match] = matches;
  return match === undefined
    ? null
    : { pid: match.pid, process: match.process, localAddress: match.localAddress };
}

/** Probe the operating system for the process owning a listening TCP port. */
export async function probeListenerIdentity(
  port: number,
  expectedHost: string,
): Promise<ListenerIdentity | null> {
  try {
    const [connections, processList] = await Promise.all([networkConnections(), processes()]);
    const listener = findListenerIdentity(port, expectedHost, connections);
    if (listener === null) return null;
    const processValue = processList.list.find((entry) => entry.pid === listener.pid);
    const processResult = ProcessSchema.safeParse(processValue);
    if (!processResult.success) return null;
    const executable = await processExecutable(
      listener.pid,
      processResult.data.path,
      processResult.data.name,
    );
    if (executable === null) return null;
    const started = await processStartedAt(listener.pid, processResult.data.started);
    if (started === null) return null;
    return {
      ...listener,
      process: processResult.data.name,
      executable,
      started,
    };
  } catch {
    return null;
  }
}

/** Probe a specific PID's canonical executable and start identity. */
export async function probeProcessIdentity(pid: number): Promise<ProcessIdentity | null> {
  try {
    const processList = await processes();
    const processValue = processList.list.find((entry) => entry.pid === pid);
    const processResult = ProcessSchema.safeParse(processValue);
    if (!processResult.success) return null;
    const executable = await processExecutable(
      pid,
      processResult.data.path,
      processResult.data.name,
    );
    if (executable === null) return null;
    const started = await processStartedAt(pid, processResult.data.started);
    if (started === null) return null;
    return {
      pid,
      process: processResult.data.name,
      executable,
      started,
    };
  } catch {
    return null;
  }
}

/** Require an exact canonical executable match (basename fallback only if PATH cannot resolve). */
export function matchesExpectedExecutable(identity: ListenerIdentity, binary: string): boolean {
  const expected = resolveExecutable(binary);
  if (expected !== null) return identity.executable === expected;
  return basename(identity.executable) === basename(binary) && identity.process === basename(binary);
}

export function sameListenerProcess(a: ListenerIdentity, b: ListenerIdentity): boolean {
  return a.pid === b.pid && a.executable === b.executable && a.started === b.started;
}

function addressesMatch(actual: string, expected: string): boolean {
  const normalize = (value: string): string =>
    value.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  const a = normalize(actual);
  const e = normalize(expected);
  if (e === "localhost") return a === "127.0.0.1" || a === "::1" || a === "localhost";
  return a === e;
}

function resolveExecutable(binary: string): string | null {
  if (isAbsolute(binary)) return canonicalPath(binary);
  for (const directory of (process.env["PATH"] ?? "").split(delimiter)) {
    if (directory.length === 0) continue;
    const candidate = join(directory, binary);
    if (existsSync(candidate)) return canonicalPath(candidate);
  }
  return null;
}

function canonicalPath(path: string): string | null {
  if (path.length === 0 || !existsSync(path)) return null;
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

async function processExecutable(
  pid: number,
  path: string,
  name: string,
): Promise<string | null> {
  if (process.platform === "linux") {
    const procPath = canonicalPath(`/proc/${pid}/exe`);
    if (procPath !== null) return procPath;
  }
  if (process.platform === "darwin") {
    try {
      const { stdout } = await execFileAsync(
        "/usr/sbin/lsof",
        ["-a", "-p", String(pid), "-d", "txt", "-Fn"],
        { timeout: 2_000, maxBuffer: 64 * 1024, encoding: "utf8" },
      );
      const executable = parseLsofTextExecutable(stdout);
      if (executable !== null) return canonicalPath(executable);
    } catch {
      return null;
    }
  }
  if (path.length === 0) return null;
  try {
    const candidate = statSync(path).isDirectory() ? join(path, name) : path;
    return canonicalPath(candidate);
  } catch {
    return null;
  }
}

async function processStartedAt(pid: number, fallback: string): Promise<string | null> {
  if (process.platform !== "darwin") return fallback;
  try {
    const { stdout } = await execFileAsync(
      "/bin/ps",
      ["-p", String(pid), "-o", "lstart="],
      { timeout: 2_000, maxBuffer: 4 * 1024, encoding: "utf8" },
    );
    return parsePsStartTime(stdout);
  } catch {
    return null;
  }
}

/** Parse the first text-executable path from `lsof -d txt -Fn` output. */
export function parseLsofTextExecutable(output: string): string | null {
  const lines = output.split("\n");
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (lines[index] !== "ftxt") continue;
    const pathLine = lines[index + 1];
    if (pathLine?.startsWith("n") && pathLine.length > 1) return pathLine.slice(1);
  }
  return null;
}

/** Normalize one macOS `ps -o lstart=` row into a stable process fingerprint. */
export function parsePsStartTime(output: string): string | null {
  const rows = output
    .split("\n")
    .map((row) => row.trim().replace(/\s+/g, " "))
    .filter((row) => row.length > 0);
  if (rows.length !== 1) return null;
  const match = rows[0]?.match(
    /^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2}) (\d{2}:\d{2}:\d{2}) (\d{4})$/,
  );
  if (match === null || match === undefined) return null;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const monthIndex = months.indexOf(match[1] ?? "");
  const day = Number(match[2]);
  if (monthIndex < 0 || !Number.isInteger(day) || day < 1 || day > 31) return null;
  return `${match[4]}-${String(monthIndex + 1).padStart(2, "0")}-${String(day).padStart(2, "0")} ${match[3]}`;
}
