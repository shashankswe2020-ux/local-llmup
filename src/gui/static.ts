/** Safe static-file serving for the browser GUI. */
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ValidationError } from "../errors.js";

const ALLOWED_EXTENSIONS = new Set([".html", ".css", ".js", ".map"]);
const require = createRequire(import.meta.url);
const VENDOR_ASSETS: Readonly<Record<string, string>> = {
  "/vendor/marked.min.js": require.resolve("marked/marked.min.js"),
  "/vendor/dompurify.min.js": require.resolve("dompurify/purify.min.js"),
};

export function resolveStaticPath(rootDir: URL | string, requestPath: string): string {
  const baseDir =
    rootDir instanceof URL ? path.resolve(fileURLToPath(rootDir)) : path.resolve(rootDir);
  const cleaned = requestPath.replace(/^\/static\//u, "").replace(/^\/+|\\+/gu, "");
  const candidate = path.resolve(baseDir, cleaned);
  const relative = path.relative(baseDir, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ValidationError(`path traversal refused: ${cleaned}`);
  }

  const extension = path.extname(candidate).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw new ValidationError(`unknown extension: ${extension}`);
  }

  return candidate;
}

export async function readStaticAsset(rootDir: URL | string, requestPath: string): Promise<{
  readonly content: Buffer;
  readonly contentType: string;
}> {
  const resolved = resolveStaticPath(rootDir, requestPath);
  const content = await readFile(resolved);
  const extension = path.extname(resolved).toLowerCase();
  const contentType =
    extension === ".html"
      ? "text/html; charset=utf-8"
      : extension === ".css"
        ? "text/css; charset=utf-8"
        : extension === ".js"
          ? "application/javascript; charset=utf-8"
          : "application/octet-stream";
  return { content, contentType };
}

/** Read one explicitly approved browser bundle; arbitrary package paths fail closed. */
export async function readVendorAsset(requestPath: string): Promise<{
  readonly content: Buffer;
  readonly contentType: string;
}> {
  const resolved = VENDOR_ASSETS[requestPath];
  if (resolved === undefined) {
    throw new ValidationError(`unknown vendor asset: ${requestPath}`);
  }
  return {
    content: await readFile(resolved),
    contentType: "application/javascript; charset=utf-8",
  };
}
