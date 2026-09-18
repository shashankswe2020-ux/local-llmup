import { spawn, execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { promisify } from "node:util";
import { setTimeout, clearTimeout } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";

const execute = promisify(execFile);
const workspace = await mkdtemp(join(tmpdir(), "llmup-r22-workspace-"));
const home = await mkdtemp(join(tmpdir(), "llmup-r22-home-"));
const windows = process.platform === "win32";
if (!windows && process.platform !== "linux")
  throw new Error("Use native macOS Accessibility verification");
const binary = resolve(`apps/desktop/src-tauri/target/debug/llmup-desktop${windows ? ".exe" : ""}`);
const child = spawn(binary, ["--dialog-smoke-test"], {
  env: { ...process.env, LOCAL_LLMUP_HOME: home, LLMUP_DIALOG_SMOKE_PATH: workspace },
  stdio: ["ignore", "pipe", "inherit"],
});
let count = 0;
let passed = false;
let pending = "";
let failure;
let actions = Promise.resolve();
async function operate(index) {
  if (index > 2) throw new Error("Unexpected extra native dialog");
  if (windows) {
    await execute(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-File",
        resolve("scripts/rust-dialog-smoke.ps1"),
        "-DesktopPid",
        String(child.pid),
        "-Selection",
        workspace,
        "-Mode",
        index === 1 ? "cancel" : "select",
      ],
      { timeout: 25_000 },
    );
    return;
  }
  const { stdout } = await execute(
    "xdotool",
    ["search", "--sync", "--onlyvisible", "--name", "Choose workspace directory"],
    { timeout: 20_000 },
  );
  const windowId = stdout.trim().split(/\s+/)[0];
  await execute("xdotool", ["windowfocus", "--sync", windowId]);
  if (index === 1) {
    await execute("xdotool", ["key", "--clearmodifiers", "Escape"]);
  } else {
    await execute("xdotool", ["key", "--clearmodifiers", "ctrl+l"]);
    await execute("xdotool", ["type", "--clearmodifiers", "--", workspace]);
    await execute("xdotool", ["key", "--clearmodifiers", "Return"]);
    await delay(500);
    await execute("xdotool", ["key", "--clearmodifiers", "alt+s"]);
  }
}
child.stdout.on("data", (chunk) => {
  process.stdout.write(chunk);
  pending += chunk.toString();
  const lines = pending.split("\n");
  pending = lines.pop();
  for (const line of lines) {
    if (line.includes("smoke: passed")) passed = true;
    if (line.includes("R22 directory picker requested")) {
      const index = ++count;
      actions = actions
        .then(() => operate(index))
        .catch((error) => {
          failure = error;
          child.kill();
        });
    }
  }
});
const timer = setTimeout(() => child.kill(), 90_000);
try {
  const code = await new Promise((resolveExit, reject) => {
    child.on("error", reject);
    child.on("exit", resolveExit);
  });
  await actions;
  if (failure) throw failure;
  if (code !== 0 || count !== 2 || !passed)
    throw new Error(`Native dialog smoke failed: exit=${code}, dialogs=${count}`);
  console.log(
    "Actual native Cancel, folder selection, root registration, revocation and exit passed.",
  );
} finally {
  clearTimeout(timer);
  child.kill();
}
