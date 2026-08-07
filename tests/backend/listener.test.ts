import { describe, expect, it } from "vitest";
import {
  findListenerIdentity,
  parseLsofTextExecutable,
} from "../../src/backend/listener.js";

describe("parseLsofTextExecutable", () => {
  it("returns the first txt mapping without comparing the process display name", () => {
    expect(
      parseLsofTextExecutable(
        [
          "p34739",
          "ftxt",
          "n/opt/homebrew/Cellar/ollama/0.32.5/libexec/ollama",
          "ftxt",
          "n/usr/lib/dyld",
        ].join("\n"),
      ),
    ).toBe("/opt/homebrew/Cellar/ollama/0.32.5/libexec/ollama");
  });

  it("returns null when no txt executable mapping is present", () => {
    expect(parseLsofTextExecutable("p1\nfmem\nn/tmp/file")).toBeNull();
  });
});

describe("findListenerIdentity", () => {
  it("returns the unique listening process for the requested port", () => {
    expect(
      findListenerIdentity(18080, "127.0.0.1", [
        {
          protocol: "tcp4",
          localAddress: "127.0.0.1",
          localPort: "18080",
          peerAddress: "",
          peerPort: "",
          state: "LISTEN",
          pid: 4242,
          process: "llama-server",
        },
      ]),
    ).toEqual({ pid: 4242, process: "llama-server", localAddress: "127.0.0.1" });
  });

  it("fails closed on duplicate, missing, non-listening, or malformed rows", () => {
    const row = {
      protocol: "tcp4",
      localAddress: "127.0.0.1",
      localPort: "11434",
      peerAddress: "",
      peerPort: "",
      state: "LISTEN",
      pid: 7,
      process: "ollama",
    };
    expect(findListenerIdentity(11434, "127.0.0.1", [])).toBeNull();
    expect(
      findListenerIdentity(11434, "127.0.0.1", [{ ...row, state: "ESTABLISHED" }]),
    ).toBeNull();
    expect(findListenerIdentity(11434, "127.0.0.1", [row, { ...row }])).toBeNull();
    expect(findListenerIdentity(11434, "127.0.0.1", [{ ...row, pid: 0 }])).toBeNull();
    expect(findListenerIdentity(11434, "127.0.0.1", [{ rogue: true }])).toBeNull();
  });

  it("ignores malformed unrelated rows but rejects wildcard or wrong-address listeners", () => {
    const row = {
      protocol: "tcp4",
      localAddress: "127.0.0.1",
      localPort: "11434",
      peerAddress: "",
      peerPort: "",
      state: "LISTEN",
      pid: 7,
      process: "ollama",
    };
    expect(findListenerIdentity(11434, "127.0.0.1", [{ rogue: true }, row])).toMatchObject({
      pid: 7,
    });
    expect(
      findListenerIdentity(11434, "127.0.0.1", [{ ...row, localAddress: "0.0.0.0" }]),
    ).toBeNull();
    expect(
      findListenerIdentity(11434, "127.0.0.1", [{ ...row, localAddress: "192.168.1.4" }]),
    ).toBeNull();
  });
});
