import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, type Config } from "../../src/config.js";
import { StateError } from "../../src/errors.js";
import {
  createEmptyState,
  readState,
  STATE_SCHEMA_VERSION,
  withLock,
  writeState,
  type RuntimeState,
} from "../../src/state/state.js";

let home: string;
let config: Config;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "llmup-state-"));
  config = loadConfig({ LOCAL_LLMUP_HOME: home });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const SERVER: RuntimeState = {
  schemaVersion: STATE_SCHEMA_VERSION,
  active: {
    modelId: "llama3.1:8b",
    endpoint: "http://localhost:11434",
    pid: 4242,
    port: 11434,
    ownedByUs: true,
  },
};

describe("readState", () => {
  it("returns a fresh empty state when the file is absent", () => {
    expect(readState(config)).toEqual(createEmptyState());
  });

  it("round-trips a written state", () => {
    writeState(config, SERVER);
    expect(readState(config)).toEqual(SERVER);
  });

  it("round-trips an attached server with an unknown pid", () => {
    const attached: RuntimeState = {
      schemaVersion: STATE_SCHEMA_VERSION,
      active: {
        modelId: "llama3.1:8b",
        endpoint: "http://localhost:11434",
        port: 11434,
        ownedByUs: false,
      },
    };
    writeState(config, attached);
    expect(readState(config)).toEqual(attached);
  });

  it("normalizes legacy attached states that used pid 0", () => {
    writeFileSync(
      config.stateFile,
      JSON.stringify({
        schemaVersion: STATE_SCHEMA_VERSION,
        active: {
          modelId: "llama3.1:8b",
          endpoint: "http://localhost:11434",
          pid: 0,
          port: 11434,
          ownedByUs: false,
        },
      }),
    );

    expect(readState(config)).toEqual({
      schemaVersion: STATE_SCHEMA_VERSION,
      active: {
        modelId: "llama3.1:8b",
        endpoint: "http://localhost:11434",
        port: 11434,
        ownedByUs: false,
      },
    });
  });

  it("rejects an owned server with a non-positive pid", () => {
    writeFileSync(
      config.stateFile,
      JSON.stringify({
        schemaVersion: STATE_SCHEMA_VERSION,
        active: {
          modelId: "llama3.1:8b",
          endpoint: "http://localhost:11434",
          pid: 0,
          port: 11434,
          ownedByUs: true,
        },
      }),
    );
    try {
      readState(config);
      expect.unreachable("expected StateError");
    } catch (error) {
      expect((error as StateError).kind).toBe("invalid");
    }
  });

  it("rejects an attached server that still carries a non-zero pid", () => {
    writeFileSync(
      config.stateFile,
      JSON.stringify({
        schemaVersion: STATE_SCHEMA_VERSION,
        active: {
          modelId: "llama3.1:8b",
          endpoint: "http://localhost:11434",
          pid: 42,
          port: 11434,
          ownedByUs: false,
        },
      }),
    );
    try {
      readState(config);
      expect.unreachable("expected StateError");
    } catch (error) {
      expect((error as StateError).kind).toBe("invalid");
    }
  });

  it("distinguishes a zero-byte file", () => {
    writeFileSync(config.stateFile, "");
    try {
      readState(config);
      expect.unreachable("expected StateError");
    } catch (error) {
      expect(error).toBeInstanceOf(StateError);
      expect((error as StateError).kind).toBe("empty");
    }
  });

  it("distinguishes an unparseable file", () => {
    writeFileSync(config.stateFile, "{ not json");
    try {
      readState(config);
      expect.unreachable("expected StateError");
    } catch (error) {
      expect((error as StateError).kind).toBe("unparseable");
    }
  });

  it("distinguishes a schema-invalid file", () => {
    writeFileSync(config.stateFile, JSON.stringify({ schemaVersion: 999, active: null }));
    try {
      readState(config);
      expect.unreachable("expected StateError");
    } catch (error) {
      expect((error as StateError).kind).toBe("invalid");
    }
  });
});

describe("writeState", () => {
  it("writes atomically leaving no temp files behind", () => {
    writeState(config, SERVER);
    expect(readdirSync(config.stagingDir)).toEqual([]);
  });

  it("restricts state file and directory permissions to the owner", () => {
    writeState(config, SERVER);
    expect(statSync(config.stateFile).mode & 0o777).toBe(0o600);
    expect(statSync(config.homeDir).mode & 0o777).toBe(0o700);
  });
});

describe("withLock", () => {
  it("serializes overlapping critical sections (barrier, not timing)", async () => {
    const order: string[] = [];
    const aAcquired = deferred();
    const release = deferred();

    const first = withLock(config, async () => {
      order.push("A-start");
      aAcquired.resolve();
      await release.promise;
      order.push("A-end");
    });

    await aAcquired.promise; // A definitely holds the lock now.
    const second = withLock(
      config,
      () => {
        order.push("B-run");
      },
      { pollIntervalMs: 5 },
    );

    // B cannot have run while A holds the lock — proven by the barrier, not a sleep.
    expect(order).toEqual(["A-start"]);
    release.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["A-start", "A-end", "B-run"]);
  });

  it("recovers a stale lock left by a dead process instead of deadlocking", async () => {
    writeFileSync(config.lockFile, "999999\n");
    let ran = false;
    await withLock(
      config,
      () => {
        ran = true;
      },
      { isProcessAlive: () => false, timeoutMs: 200, pollIntervalMs: 5 },
    );
    expect(ran).toBe(true);
  });

  it("does not clobber an empty (mid-creation) lock until the timeout elapses", async () => {
    // An empty lock file has no readable PID; it must be waited on, then
    // reclaimed once the timeout proves it was a crashed half-creation.
    writeFileSync(config.lockFile, "");
    let ran = false;
    await withLock(
      config,
      () => {
        ran = true;
      },
      { timeoutMs: 20, pollIntervalMs: 5 },
    );
    expect(ran).toBe(true);
  });

  it("times out when the lock is held by a live process", async () => {
    writeFileSync(config.lockFile, `${process.pid}\n`);
    await expect(
      withLock(config, () => undefined, {
        isProcessAlive: () => true,
        timeoutMs: 30,
        pollIntervalMs: 5,
      }),
    ).rejects.toMatchObject({ kind: "locked" });
  });

  it("releases the lock even when the critical section throws", async () => {
    await expect(
      withLock(config, () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // Lock is free again → a second acquisition succeeds immediately.
    let ran = false;
    await withLock(config, () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });
});
