/**
 * Narrow, sandbox-safe preload bridge for the local-llmup desktop shell.
 *
 * This is the ENTIRE native surface exposed to the renderer: a single function
 * that opens the OS directory chooser and returns the selected path (or null on
 * cancel). No Node, filesystem, process, shell, or arbitrary IPC is exposed —
 * all workspace file access still happens server-side in the loopback host.
 * Sandboxed preloads must be CommonJS, so this file is authored as `.cjs`.
 */
"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("llmupDesktop", {
  selectWorkspaceDirectory: () => ipcRenderer.invoke("llmup:select-workspace-directory"),
});
