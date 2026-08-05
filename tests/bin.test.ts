import { afterEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  runMock: vi.fn<(argv?: readonly string[]) => void>(),
}));

vi.mock("../src/cli.js", () => ({
  run: hoisted.runMock,
}));

describe("bin entrypoint", () => {
  afterEach(() => {
    hoisted.runMock.mockReset();
    vi.resetModules();
  });

  it("invokes run with process argv", async () => {
    await import("../src/bin.js");

    expect(hoisted.runMock).toHaveBeenCalledTimes(1);
    expect(hoisted.runMock).toHaveBeenCalledWith(process.argv);
  });
});
