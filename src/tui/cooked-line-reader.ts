import { StringDecoder } from "node:string_decoder";
import { ValidationError } from "../errors.js";

export interface BoundedCookedLineReader {
  readLine(): Promise<string | null>;
  close(): void;
}

interface LineWaiter {
  readonly resolve: (line: string | null) => void;
}

const MAX_QUEUED_LINES = 200;
const MAX_QUEUED_BYTES = 50 * 1024;

/** Read submitted lines with incremental byte bounds and without touching terminal raw mode. */
export function createBoundedCookedLineReader(
  input: NodeJS.ReadStream,
  maxBytes: number,
): BoundedCookedLineReader {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 3 || maxBytes > 8 * 1024) {
    throw new ValidationError("cooked line limit must be a safe integer in 3..8192");
  }
  const decoder = new StringDecoder("utf8");
  const queued: string[] = [];
  const waiters: LineWaiter[] = [];
  let current = "";
  let currentBytes = 0;
  let truncated = false;
  let skipLf = false;
  let ended = false;
  let closed = false;
  let queuedBytes = 0;
  let pausedByUs = false;

  const deliver = (line: string): void => {
    const waiter = waiters.shift();
    if (waiter !== undefined) {
      waiter.resolve(line);
      return;
    }
    const bytes = Buffer.byteLength(line, "utf8");
    if (queued.length >= MAX_QUEUED_LINES || queuedBytes + bytes > MAX_QUEUED_BYTES) {
      if (!pausedByUs && !input.isPaused()) {
        input.pause();
        pausedByUs = true;
      }
      return;
    }
    queued.push(line);
    queuedBytes += bytes;
    if (
      !pausedByUs &&
      (queued.length === MAX_QUEUED_LINES || queuedBytes === MAX_QUEUED_BYTES) &&
      !input.isPaused()
    ) {
      input.pause();
      pausedByUs = true;
    }
  };

  const finishLine = (): void => {
    let line = current;
    if (truncated) {
      const points = [...line];
      while (Buffer.byteLength(points.join(""), "utf8") + 3 > maxBytes) points.pop();
      line = `${points.join("")}…`;
    }
    deliver(line);
    current = "";
    currentBytes = 0;
    truncated = false;
  };

  const consume = (text: string): void => {
    for (const point of text) {
      if (skipLf) {
        skipLf = false;
        if (point === "\n") continue;
      }
      if (point === "\r" || point === "\n") {
        finishLine();
        if (point === "\r") skipLf = true;
        continue;
      }
      if (truncated) continue;
      const bytes = Buffer.byteLength(point, "utf8");
      if (currentBytes + bytes > maxBytes) {
        truncated = true;
        continue;
      }
      current += point;
      currentBytes += bytes;
    }
  };

  const resolveEof = (): void => {
    if (ended) return;
    ended = true;
    const tail = decoder.end();
    if (tail.length > 0) consume(tail);
    if (current.length > 0 || truncated) finishLine();
    while (waiters.length > 0) waiters.shift()?.resolve(null);
  };

  const onData = (chunk: Buffer | string): void => {
    consume(typeof chunk === "string" ? chunk : decoder.write(chunk));
  };
  const onEnd = (): void => resolveEof();
  input.on("data", onData);
  input.on("end", onEnd);
  input.on("close", onEnd);

  return {
    readLine: async (): Promise<string | null> => {
      const line = queued.shift();
      if (line !== undefined) {
        queuedBytes -= Buffer.byteLength(line, "utf8");
        if (pausedByUs && queued.length < MAX_QUEUED_LINES / 2) {
          pausedByUs = false;
          input.resume();
        }
        return line;
      }
      if (ended || closed) return null;
      return await new Promise<string | null>((resolve) => waiters.push({ resolve }));
    },
    close: (): void => {
      if (closed) return;
      closed = true;
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      input.removeListener("close", onEnd);
      if (pausedByUs) {
        pausedByUs = false;
        input.resume();
      }
      while (waiters.length > 0) waiters.shift()?.resolve(null);
    },
  };
}
