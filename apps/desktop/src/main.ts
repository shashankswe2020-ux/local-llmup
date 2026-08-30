/**
 * Electron main process for the local-llmup desktop app.
 *
 * Architecture (mirrors Apache Maka's "one Runtime Host, thin surfaces" model):
 * the heavy lifting lives in the shared loopback GUI server that the `llmup gui`
 * CLI command already serves. This shell does not reimplement any of it — it
 * boots that same server in-process via `runGui` and renders it in a hardened
 * BrowserWindow. The renderer talks to the server over 127.0.0.1 with fetch/SSE,
 * so it needs zero Node integration and no preload bridge.
 */
import { createServer as createNetServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, nativeImage, shell } from "electron";
import { runGui, type GuiDeps } from "local-llmup/dist/commands/gui.js";
import { createDefaultRegistry } from "local-llmup/dist/harness/registry.js";

const WINDOW_BACKGROUND = "#050506";

/** Neobrutalist brand icon, bundled under `build/icon.png` next to `dist/`. */
const APP_ICON_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "build", "icon.png");

/** The only native bridge exposed to the renderer (see `preload.cjs`). */
const PRELOAD_PATH = join(dirname(fileURLToPath(import.meta.url)), "preload.cjs");

/** Fixed IPC channel for the directory chooser; nothing else is exposed. */
const SELECT_DIRECTORY_CHANNEL = "llmup:select-workspace-directory";

/**
 * Interpret a native open-dialog result into a single directory path, or null.
 * Cancelling — or an empty selection — grants nothing.
 */
export function resolveSelectedDirectory(result: {
  readonly canceled: boolean;
  readonly filePaths: readonly string[];
}): string | null {
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  const [first] = result.filePaths;
  return typeof first === "string" && first.length > 0 ? first : null;
}

let mainWindow: BrowserWindow | null = null;
let serverUrl: string | null = null;
/** Resolved when the app is quitting, so `runGui` can stop the server. */
let releaseRuntimeHost: (() => void) | null = null;

function isLoopbackUrl(target: string): boolean {
  try {
    const url = new URL(target);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost")
    );
  } catch {
    return false;
  }
}

/** Ask the OS to assign a free loopback port so we never collide with a user's server. */
async function findFreeLoopbackPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close((error) => {
        if (error !== undefined && error !== null) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

function createWindow(url: string): void {
  serverUrl = url;
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 940,
    minHeight: 620,
    backgroundColor: WINDOW_BACKGROUND,
    title: "local-llmup",
    icon: APP_ICON_PATH,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: PRELOAD_PATH,
    },
  });

  // Loopback-only: block any attempt to navigate the window away from the local
  // Runtime Host, and route genuine external links to the OS browser instead.
  window.webContents.on("will-navigate", (event, target) => {
    if (!isLoopbackUrl(target)) {
      event.preventDefault();
    }
  });
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    if (isLoopbackUrl(target)) {
      return { action: "allow" };
    }
    void shell.openExternal(target);
    return { action: "deny" };
  });

  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    mainWindow = null;
  });

  void window.loadURL(url);
  mainWindow = window;
}

async function bootRuntimeHost(): Promise<void> {
  const port = await findFreeLoopbackPort();
  const deps: GuiDeps = {
    registry: createDefaultRegistry(),
    createServer: () => createNetServer(),
    // `runGui` invokes this once the server is listening — our cue to render it.
    openUrl: (url) => {
      createWindow(url);
    },
    // Keep the server alive until the app actually quits.
    waitForShutdown: () =>
      new Promise<void>((resolve) => {
        releaseRuntimeHost = resolve;
      }),
    write: (text) => process.stdout.write(text),
    log: (text) => process.stderr.write(text),
    env: process.env,
  };

  await runGui({ port, harness: "local" }, deps);
}

app.whenReady().then(
  () => {
    // The single native bridge: open the OS directory chooser on request. The
    // renderer only ever receives a path string (or null); it never touches the
    // filesystem itself — the loopback server canonicalizes and policy-checks it.
    ipcMain.handle(SELECT_DIRECTORY_CHANNEL, async () => {
      const window = mainWindow;
      const result =
        window !== null
          ? await dialog.showOpenDialog(window, {
              title: "Choose workspace folder",
              properties: ["openDirectory"],
            })
          : await dialog.showOpenDialog({
              title: "Choose workspace folder",
              properties: ["openDirectory"],
            });
      return resolveSelectedDirectory(result);
    });

    // On macOS the Dock icon comes from the app bundle when packaged, but in dev
    // (`npm start`) there is no bundle — set it explicitly so the Dock matches.
    if (process.platform === "darwin" && app.dock !== undefined) {
      const dockIcon = nativeImage.createFromPath(APP_ICON_PATH);
      if (!dockIcon.isEmpty()) {
        app.dock.setIcon(dockIcon);
      }
    }

    bootRuntimeHost().catch((error: unknown) => {
      console.error("[local-llmup] failed to start Runtime Host:", error);
      app.quit();
    });

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0 && serverUrl !== null) {
        createWindow(serverUrl);
      }
    });
  },
  (error: unknown) => {
    console.error("[local-llmup] Electron failed to become ready:", error);
    app.quit();
  },
);

app.on("window-all-closed", () => {
  // On macOS apps stay resident until Cmd+Q; elsewhere closing the window quits.
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  if (releaseRuntimeHost !== null) {
    releaseRuntimeHost();
    releaseRuntimeHost = null;
  }
});
