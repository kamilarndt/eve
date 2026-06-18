import type { IncomingMessage, ServerResponse } from "node:http";

import { DevToolsApiError } from "./errors.js";

const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

export interface DevToolsRouteContext {
  readonly params: Readonly<Record<string, string>>;
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly url: URL;
}

type DevToolsRouteHandler = (context: DevToolsRouteContext) => Promise<void> | void;

interface Route {
  readonly handler: DevToolsRouteHandler;
  readonly method: string;
  readonly pattern: RegExp;
  readonly parameterNames: readonly string[];
}

export interface DevToolsRouter {
  add(method: string, path: string, handler: DevToolsRouteHandler): void;
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
}

export function createDevToolsRouter(): DevToolsRouter {
  const routes: Route[] = [];
  return {
    add(method, path, handler) {
      const compiled = compilePath(path);
      routes.push({ handler, method, ...compiled });
    },
    async handle(req, res) {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      for (const route of routes) {
        if (req.method !== route.method) continue;
        const match = route.pattern.exec(url.pathname);
        if (match === null) continue;
        const params = Object.fromEntries(
          route.parameterNames.map((name, index) => [name, decodeURIComponent(match[index + 1]!)]),
        );
        await route.handler({ params, req, res, url });
        return true;
      }
      return false;
    },
  };
}

export async function readDevToolsJsonBody(req: IncomingMessage): Promise<unknown> {
  const contentType = req.headers["content-type"];
  if (typeof contentType !== "string" || !contentType.startsWith("application/json")) {
    throw new DevToolsApiError(415, "unsupported_media_type", "Expected application/json.");
  }

  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > MAX_REQUEST_BODY_BYTES) {
      throw new DevToolsApiError(413, "request_too_large", "Request body is too large.");
    }
    chunks.push(buffer);
  }

  const body = Buffer.concat(chunks).toString("utf8");
  if (body.trim() === "") {
    return undefined;
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new DevToolsApiError(400, "invalid_json", "Request body is not valid JSON.");
  }
}

export function sendDevToolsJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(`${JSON.stringify(body)}\n`);
}

function compilePath(path: string): {
  readonly parameterNames: string[];
  readonly pattern: RegExp;
} {
  const parameterNames: string[] = [];
  const source = path
    .split("/")
    .map((part) => {
      if (part.startsWith(":")) {
        parameterNames.push(part.slice(1));
        return "([^/]+)";
      }
      return part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    })
    .join("/");
  return { parameterNames, pattern: new RegExp(`^${source}$`, "u") };
}
