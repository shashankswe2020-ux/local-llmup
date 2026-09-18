import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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
    backend: "ollama",
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

  it("round-trips an owned MLX session token", () => {
    const mlx: RuntimeState = {
      schemaVersion: STATE_SCHEMA_VERSION,
      active: {
        backend: "mlx",
        modelId: "smollm2-360m",
        endpoint: "http://127.0.0.1:18082",
        pid: 4243,
        port: 18082,
        ownedByUs: true,
        processExecutable: "/usr/bin/python3",
        processStartedAt: "2026-08-08T00:00:00Z",
        authToken: "a".repeat(64),
      },
    };
    writeState(config, mlx);
    expect(readState(config)).toEqual(mlx);
  });

  it("rejects incomplete, attached, or token-bearing non-MLX runtime state", () => {
    const base = {
      schemaVersion: STATE_SCHEMA_VERSION,
    } as const;
    expect(() =>
      writeState(config, {
        ...base,
        active: {
          backend: "mlx",
          modelId: "m",
          endpoint: "http://127.0.0.1:8080",
          pid: 1,
          port: 8080,
          ownedByUs: true,
        },
      }),
    ).toThrow(StateError);
    expect(() =>
      writeState(config, {
        ...base,
        active: {
          backend: "mlx",
          modelId: "m",
          endpoint: "http://127.0.0.1:8080",
          port: 8080,
          ownedByUs: false,
        },
      }),
    ).toThrow(StateError);
    expect(() =>
      writeState(config, {
        ...SERVER,
        active: { ...SERVER.active!, authToken: "a".repeat(64) },
      }),
    ).toThrow(StateError);
  });

  it("rejects owned state for attach-only LM Studio", () => {
    expect(() =>
      writeState(config, {
        schemaVersion: STATE_SCHEMA_VERSION,
        active: {
          backend: "lmstudio",
          modelId: "qwen3:14b",
          endpoint: "http://127.0.0.1:1234",
          pid: 42,
          port: 1234,
          ownedByUs: true,
        },
      }),
    ).toThrow(StateError);
  });

  it("round-trips an attached server with an unknown pid", () => {
    const attached: RuntimeState = {
      schemaVersion: STATE_SCHEMA_VERSION,
      active: {
        backend: "ollama",
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
          backend: "ollama",
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
        backend: "ollama",
        modelId: "llama3.1:8b",
        endpoint: "http://localhost:11434",
        port: 11434,
        ownedByUs: false,
      },
    });
  });

  it("migrates a v1 owned server to v2 defaulting backend to ollama", () => {
    writeFileSync(
      config.stateFile,
      JSON.stringify({
        schemaVersion: 1,
        active: {
          modelId: "llama3.1:8b",
          endpoint: "http://localhost:11434",
          pid: 4242,
          port: 11434,
          ownedByUs: true,
        },
      }),
    );

    expect(readState(config)).toEqual({
      schemaVersion: STATE_SCHEMA_VERSION,
      active: {
        backend: "ollama",
        modelId: "llama3.1:8b",
        endpoint: "http://localhost:11434",
        pid: 4242,
        port: 11434,
        ownedByUs: true,
      },
    });
  });

  it("migrates a v1 attached server to v2 without inventing a pid", () => {
    writeFileSync(
      config.stateFile,
      JSON.stringify({
        schemaVersion: 1,
        active: {
          modelId: "llama3.1:8b",
          endpoint: "http://localhost:11434",
          port: 11434,
          ownedByUs: false,
        },
      }),
    );

    expect(readState(config)).toEqual({
      schemaVersion: STATE_SCHEMA_VERSION,
      active: {
        backend: "ollama",
        modelId: "llama3.1:8b",
        endpoint: "http://localhost:11434",
        port: 11434,
        ownedByUs: false,
      },
    });
  });

  it("migrates a v1 idle state (active: null) to v2", () => {
    writeFileSync(config.stateFile, JSON.stringify({ schemaVersion: 1, active: null }));
    expect(readState(config)).toEqual({ schemaVersion: STATE_SCHEMA_VERSION, active: null });
  });

  it("migrates a v1 attached server that used the legacy pid 0 sentinel", () => {
    writeFileSync(
      config.stateFile,
      JSON.stringify({
        schemaVersion: 1,
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
        backend: "ollama",
        modelId: "llama3.1:8b",
        endpoint: "http://localhost:11434",
        port: 11434,
        ownedByUs: false,
      },
    });
  });

  it("rewrites a migrated v1 file as v2 on the next mutation", () => {
    writeFileSync(
      config.stateFile,
      JSON.stringify({
        schemaVersion: 1,
        active: {
          modelId: "llama3.1:8b",
          endpoint: "http://localhost:11434",
          pid: 4242,
          port: 11434,
          ownedByUs: true,
        },
      }),
    );

    const migrated = readState(config);
    writeState(config, migrated);
    const onDisk = JSON.parse(readFileSync(config.stateFile, "utf8")) as {
      schemaVersion: number;
      active: { backend: string } | null;
    };
    expect(onDisk.schemaVersion).toBe(STATE_SCHEMA_VERSION);
    expect(onDisk.active?.backend).toBe("ollama");
  });

  it("rejects a v2 active server that is missing a backend", () => {
    writeFileSync(
      config.stateFile,
      JSON.stringify({
        schemaVersion: STATE_SCHEMA_VERSION,
        active: {
          modelId: "llama3.1:8b",
          endpoint: "http://localhost:11434",
          pid: 4242,
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

  it("rejects an owned server with a non-positive pid", () => {
    writeFileSync(
      config.stateFile,
      JSON.stringify({
        schemaVersion: STATE_SCHEMA_VERSION,
        active: {
          backend: "ollama",
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
          backend: "ollama",
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

  it("rejects a non-loopback active endpoint", () => {
    writeFileSync(
      config.stateFile,
      JSON.stringify({
        schemaVersion: STATE_SCHEMA_VERSION,
        active: {
          backend: "ollama",
          modelId: "llama3.1:8b",
          endpoint: "http://example.com:11434",
          pid: 4242,
          port: 11434,
          ownedByUs: true,
        },
      }),
    );
    expect(() => readState(config)).toThrow(StateError);
  });

  it("rejects state whose endpoint port differs from its recorded port", () => {
    writeFileSync(
      config.stateFile,
      JSON.stringify({
        schemaVersion: STATE_SCHEMA_VERSION,
        active: {
          backend: "ollama",
          modelId: "llama3.1:8b",
          endpoint: "http://127.0.0.1:12000",
          pid: 4242,
          port: 11434,
          ownedByUs: true,
        },
      }),
    );
    expect(() => readState(config)).toThrow(StateError);
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
  it("does not delete a replacement lock when the original holder exits", async () => {
    await expect(
      withLock(config, () => {
        renameSync(config.lockFile, `${config.lockFile}.original`);
        writeFileSync(config.lockFile, "123456\n");
      }),
    ).rejects.toMatchObject({ kind: "locked" });
    expect(readFileSync(config.lockFile, "utf8")).toBe("123456\n");
  });
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

  it("does not reclaim an empty lock whose ownership cannot be proven", async () => {
    // A timeout does not establish ownership or prove that an unknown owner died.
    writeFileSync(config.lockFile, "");
    let ran = false;
    await expect(
      withLock(
        config,
        () => {
          ran = true;
        },
        { timeoutMs: 20, pollIntervalMs: 5 },
      ),
    ).rejects.toMatchObject({ kind: "locked" });
    expect(ran).toBe(false);
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

  it.each(["1e3", "0x123", "000123", "2147483648", "9".repeat(100)])(
    "does not reclaim malformed PID %s",
    async (contents) => {
      writeFileSync(config.lockFile, contents);
      await expect(
        withLock(config, () => undefined, {
          timeoutMs: 10,
          pollIntervalMs: 2,
          isProcessAlive: () => {
            throw new Error("must not probe invalid PID");
          },
        }),
      ).rejects.toMatchObject({ kind: "locked" });
      expect(readFileSync(config.lockFile, "utf8")).toBe(contents);
    },
  );

  it.skipIf(process.platform === "win32")(
    "refuses symlinked locks without probing their target",
    async () => {
      const target = join(home, "target");
      writeFileSync(target, "12345\n");
      symlinkSync(target, config.lockFile);
      await expect(
        withLock(config, () => undefined, {
          timeoutMs: 10,
          pollIntervalMs: 2,
          isProcessAlive: () => {
            throw new Error("must not probe symlink target");
          },
        }),
      ).rejects.toMatchObject({ kind: "locked" });
      expect(readFileSync(target, "utf8")).toBe("12345\n");
    },
  );

  it("reports missing lock ownership on release", async () => {
    await expect(withLock(config, () => unlinkSync(config.lockFile))).rejects.toMatchObject({
      kind: "locked",
    });
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
