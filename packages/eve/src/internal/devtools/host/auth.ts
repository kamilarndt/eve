import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);

export function createDevToolsCapability(): string {
  return randomBytes(32).toString("hex");
}

export function isDevToolsAuthorized(req: IncomingMessage, capability: string): boolean {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) {
    return false;
  }

  const tokenBytes = Buffer.from(header.slice("Bearer ".length).trim());
  const capabilityBytes = Buffer.from(capability);
  return (
    tokenBytes.length === capabilityBytes.length && timingSafeEqual(tokenBytes, capabilityBytes)
  );
}

export function isAllowedDevToolsRequest(req: IncomingMessage, expectedPort: number): boolean {
  if (!hasAllowedHost(req, expectedPort)) {
    return false;
  }

  const origin = req.headers.origin;
  if (origin === undefined) {
    return true;
  }
  if (typeof origin !== "string") {
    return false;
  }

  try {
    const parsed = new URL(origin);
    return (
      parsed.protocol === "http:" &&
      LOOPBACK_HOSTS.has(parsed.hostname) &&
      Number(parsed.port) === expectedPort
    );
  } catch {
    return false;
  }
}

export function setDevToolsSecurityHeaders(res: ServerResponse, expectedPort: number): void {
  res.setHeader("cache-control", "no-store");
  res.setHeader(
    "content-security-policy",
    [
      "default-src 'none'",
      "base-uri 'none'",
      `connect-src 'self' ws://127.0.0.1:${expectedPort} ws://localhost:${expectedPort}`,
      "font-src 'self'",
      "frame-ancestors 'none'",
      "script-src 'self'",
      "style-src 'self'",
      "style-src-attr 'unsafe-inline'",
    ].join("; "),
  );
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("x-content-type-options", "nosniff");
}

function hasAllowedHost(req: IncomingMessage, expectedPort: number): boolean {
  const host = req.headers.host;
  if (typeof host !== "string") {
    return false;
  }

  try {
    const parsed = new URL(`http://${host}`);
    return LOOPBACK_HOSTS.has(parsed.hostname) && Number(parsed.port) === expectedPort;
  } catch {
    return false;
  }
}
