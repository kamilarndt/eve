import { readFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { basename, extname, join } from "node:path";

import { DevToolsApiError } from "./errors.js";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".woff2": "font/woff2",
};

export interface DevToolsAssetServer {
  isAssetPath(pathname: string): boolean;
  sendIndex(res: ServerResponse): Promise<void>;
  sendStaticAsset(res: ServerResponse, assetName: string): Promise<void>;
}

export function createDevToolsAssetServer(uiRoot: string): DevToolsAssetServer {
  return {
    isAssetPath(pathname) {
      return pathname === "/" || pathname === "/index.html" || /^\/assets\/[^/]+$/u.test(pathname);
    },
    async sendIndex(res) {
      await sendFile(res, join(uiRoot, "index.html"), { cacheControl: "no-store" });
    },
    async sendStaticAsset(res, assetName) {
      if (assetName !== basename(assetName) || assetName.startsWith(".")) {
        throw new DevToolsApiError(404, "asset_not_found", "DevTools asset was not found.");
      }
      await sendFile(res, join(uiRoot, "assets", assetName), {
        cacheControl: "public, max-age=31536000, immutable",
      });
    },
  };
}

async function sendFile(
  res: ServerResponse,
  path: string,
  input: { readonly cacheControl: string },
): Promise<void> {
  let content: Buffer;
  try {
    content = await readFile(path);
  } catch (error) {
    if (isMissingFileError(error)) {
      throw new DevToolsApiError(404, "asset_not_found", "DevTools asset was not found.");
    }
    throw error;
  }
  const contentType = CONTENT_TYPES[extname(path)];
  if (contentType === undefined) {
    throw new DevToolsApiError(404, "asset_not_found", "DevTools asset was not found.");
  }
  res.writeHead(200, {
    "cache-control": input.cacheControl,
    "content-length": content.byteLength,
    "content-type": contentType,
  });
  res.end(content);
}

function isMissingFileError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}
