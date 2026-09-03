import { describe, expect, it, vi } from "vitest";
import { compareReleaseVersions, getUpdateStatus } from "../../src/gui/update.js";

describe("compareReleaseVersions", () => {
  it("detects a strictly newer stable release", () => {
    expect(compareReleaseVersions("0.11.2", "v0.12.0")).toBe("update-available");
    expect(compareReleaseVersions("0.11.2", "v0.11.2")).toBe("current");
    expect(compareReleaseVersions("0.11.2", "v0.10.9")).toBe("current");
  });

  it.each(["latest", "v0.12", "v0.12.0-beta.1", "1.2.3.4"])(
    "returns unknown for malformed or non-stable tag %s",
    (tag) => {
      expect(compareReleaseVersions("0.11.2", tag)).toBe("unknown");
    },
  );
});

describe("getUpdateStatus", () => {
  it("returns the fixed release page when a newer release exists", async () => {
    const fetchLatest = vi.fn(async () =>
      new Response(JSON.stringify({ tag_name: "v0.12.0" }), { status: 200 }),
    );

    await expect(getUpdateStatus({ currentVersion: "0.11.2", fetchLatest })).resolves.toEqual({
      currentVersion: "0.11.2",
      latestVersion: "0.12.0",
      state: "update-available",
      releaseUrl: "https://github.com/shashankswe2020-ux/local-llmup/releases",
    });
    expect(fetchLatest).toHaveBeenCalledOnce();
  });

  it("returns unknown when the installed version is unavailable", async () => {
    const fetchLatest = vi.fn(async () =>
      new Response(JSON.stringify({ tag_name: "v0.12.0" }), { status: 200 }),
    );

    await expect(getUpdateStatus({ currentVersion: "unknown", fetchLatest })).resolves.toMatchObject({
      currentVersion: "unknown",
      latestVersion: null,
      state: "unknown",
      releaseUrl: null,
    });
  });

  it.each([
    ["an unavailable API", async () => new Response(null, { status: 503 })],
    ["a malformed response", async () => new Response(JSON.stringify({ tag_name: "latest" }))],
    ["a network error", async () => Promise.reject(new Error("offline"))],
  ])("returns unknown for %s", async (_case, fetchLatest) => {
    await expect(
      getUpdateStatus({ currentVersion: "0.11.2", fetchLatest }),
    ).resolves.toEqual({
      currentVersion: "0.11.2",
      latestVersion: null,
      state: "unknown",
      releaseUrl: null,
    });
  });
});