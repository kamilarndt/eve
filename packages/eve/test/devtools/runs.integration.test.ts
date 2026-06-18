import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startDevToolsHost } from "../../src/internal/devtools/host.js";

describe("DevTools runs API", () => {
  let appRoot: string;
  let runtime: { close(): Promise<void>; releaseStream(): void; url: string };

  beforeEach(async () => {
    appRoot = await mkdtemp(join(tmpdir(), "eve-devtools-runs-"));
    runtime = await startFakeRuntime();
  });

  afterEach(async () => {
    await runtime.close();
    await rm(appRoot, { force: true, recursive: true });
  });

  it("creates a canonical session, indexes events, and replays them over SSE", async () => {
    const host = await startDevToolsHost({
      appRoot,
      getRuntimeState: () => ({
        runtimeInstanceId: "runtime-1",
        runtimeUrl: runtime.url,
        status: "ready",
      }),
    });

    try {
      const discovery = JSON.parse(
        await readFile(join(appRoot, ".eve", "devtools", "current.json"), "utf8"),
      ) as { browserCapability: string };
      const headers = {
        authorization: `Bearer ${discovery.browserCapability}`,
      };

      const sse = await fetch(new URL("/api/v1/events", host.url), { headers });
      expect(sse.status).toBe(200);
      const reader = sse.body!.getReader();

      const created = await fetch(new URL("/api/v1/runs", host.url), {
        body: JSON.stringify({ message: "hello" }),
        headers: {
          ...headers,
          "content-type": "application/json",
        },
        method: "POST",
      });
      expect(created.status).toBe(202);
      await expect(created.json()).resolves.toMatchObject({
        run: {
          sessionId: "session-1",
          status: "running",
        },
      });

      await waitFor(async () => {
        const events = await fetch(new URL("/api/v1/runs/session-1/events?cursor=0", host.url), {
          headers,
        });
        expect(events.status).toBe(200);
        await expect(events.json()).resolves.toMatchObject({
          events: [
            {
              cursor: expect.any(String),
              event: {
                type: "session.started",
              },
            },
            {
              cursor: expect.any(String),
              event: {
                type: "session.waiting",
              },
            },
          ],
          nextCursor: expect.any(String),
        });
      });

      const runs = await fetch(new URL("/api/v1/runs", host.url), { headers });
      await expect(runs.json()).resolves.toMatchObject({
        runs: [
          {
            sessionId: "session-1",
            status: "waiting",
          },
        ],
      });

      const sseText = await readUntil(reader, "session.waiting");
      expect(sseText).toContain("event: run.event");
      expect(sseText).toContain('"sessionId":"session-1"');
      expect(sseText).toContain('"type":"session.waiting"');
      await reader.cancel();
    } finally {
      await host.close();
    }
  });

  it("rejects a continuation until the canonical stream reaches a waiting boundary", async () => {
    await runtime.close();
    runtime = await startFakeRuntime({ holdStream: true });
    const host = await startDevToolsHost({
      appRoot,
      getRuntimeState: () => ({
        runtimeInstanceId: "runtime-1",
        runtimeUrl: runtime.url,
        status: "ready",
      }),
    });

    try {
      const discovery = JSON.parse(
        await readFile(join(appRoot, ".eve", "devtools", "current.json"), "utf8"),
      ) as { browserCapability: string };
      const headers = {
        authorization: `Bearer ${discovery.browserCapability}`,
        "content-type": "application/json",
      };
      const created = await fetch(new URL("/api/v1/runs", host.url), {
        body: JSON.stringify({ message: "first" }),
        headers,
        method: "POST",
      });
      expect(created.status).toBe(202);

      const continued = await fetch(new URL("/api/v1/runs/session-1/messages", host.url), {
        body: JSON.stringify({ message: "too soon" }),
        headers,
        method: "POST",
      });
      expect(continued.status).toBe(409);
      await expect(continued.json()).resolves.toMatchObject({ code: "run_not_waiting" });
    } finally {
      runtime.releaseStream();
      await host.close();
    }
  });
});

async function startFakeRuntime(
  options: { readonly holdStream?: boolean } = {},
): Promise<{ close(): Promise<void>; releaseStream(): void; url: string }> {
  let releaseStream = () => {};
  const streamGate =
    options.holdStream === true
      ? new Promise<void>((resolve) => {
          releaseStream = resolve;
        })
      : Promise.resolve();
  const server = createServer((req, res) => {
    void handleRuntimeRequest(req, res, streamGate);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("fake runtime did not bind");
  }

  return {
    async close() {
      releaseStream();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
    releaseStream,
    url: `http://127.0.0.1:${address.port}/`,
  };
}

async function handleRuntimeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  streamGate: Promise<void>,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (req.method === "POST" && url.pathname === "/eve/v1/session") {
    await readBody(req);
    res.writeHead(202, {
      "content-type": "application/json",
      "x-eve-session-id": "session-1",
    });
    res.end(JSON.stringify({ continuationToken: "continue-1", ok: true, sessionId: "session-1" }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/eve/v1/session/session-1/stream") {
    res.writeHead(200, {
      "content-type": "application/x-ndjson; charset=utf-8",
    });
    res.write(`${JSON.stringify({ data: {}, type: "session.started" })}\n`);
    await streamGate;
    res.write(
      `${JSON.stringify({ data: { wait: "next-user-message" }, type: "session.waiting" })}\n`,
    );
    res.end();
    return;
  }

  res.writeHead(404);
  res.end();
}

async function readBody(req: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of req) {
    body += String(chunk);
  }
  return body;
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  marker: string,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + 5_000;
  while (!text.includes(marker)) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${marker} in SSE:\n${text}`);
    }
    const chunk = await reader.read();
    if (chunk.done) {
      break;
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text;
}

async function waitFor(assertion: () => Promise<void>): Promise<void> {
  const deadline = Date.now() + 5_000;
  let lastError: unknown;
  while (Date.now() <= deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError;
}
