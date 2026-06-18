import { createHash } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { connect } from "node:net";
import type { Duplex } from "node:stream";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startDevToolsHost, type DevToolsRuntimeState } from "../../src/internal/devtools/host.js";

describe("DevTools sources and debugger relay", () => {
  let appRoot: string;
  let inspector: {
    broadcast(message: unknown): void;
    close(): Promise<void>;
    connectionCount: number;
    received: string[];
    url: string;
  };

  beforeEach(async () => {
    appRoot = await mkdtemp(join(tmpdir(), "eve-devtools-debugger-"));
    await mkdir(join(appRoot, "agent", "tools"), { recursive: true });
    await writeFile(
      join(appRoot, "agent", "tools", "weather.ts"),
      "export const city = 'Berlin';\n",
    );
    await writeFile(join(appRoot, ".secret"), "nope\n");
    inspector = await startFakeInspector(`file://${join(appRoot, "agent", "tools", "weather.ts")}`);
  });

  afterEach(async () => {
    await inspector.close();
    await rm(appRoot, { force: true, recursive: true });
  });

  it("lists authored sources and relays CDP over a debugger ticket", async () => {
    let runtimeState: DevToolsRuntimeState = {
      inspectorUrl: inspector.url,
      runtimeInstanceId: "runtime-1",
      runtimeUrl: "http://127.0.0.1:42001/",
      status: "ready",
    };
    const host = await startDevToolsHost({
      appRoot,
      getRuntimeState: () => runtimeState,
      updateRuntimeState: (patch) => {
        runtimeState = { ...runtimeState, ...patch };
      },
    });

    try {
      const discovery = JSON.parse(
        await readFile(join(appRoot, ".eve", "devtools", "current.json"), "utf8"),
      ) as { browserCapability: string };
      const headers = { authorization: `Bearer ${discovery.browserCapability}` };

      const sources = await fetch(new URL("/api/v1/sources", host.url), { headers });
      expect(sources.status).toBe(200);
      await expect(sources.json()).resolves.toMatchObject({
        sources: [
          {
            kind: "authored",
            path: "agent/tools/weather.ts",
          },
        ],
      });
      const source = await fetch(
        new URL(`/api/v1/sources/${encodeURIComponent("agent/tools/weather.ts")}`, host.url),
        { headers },
      );
      expect(source.status).toBe(200);
      await expect(source.json()).resolves.toMatchObject({
        content: "export const city = 'Berlin';\n",
        source: { id: "agent/tools/weather.ts" },
      });
      await waitFor(async () => {
        const response = await fetch(new URL("/api/v1/sources", host.url), { headers });
        await expect(response.json()).resolves.toMatchObject({
          sources: [{ loaded: true, scripts: [{ scriptId: "authored-1" }] }],
        });
      });

      const ticketResponse = await fetch(new URL("/api/v1/debugger/tickets", host.url), {
        headers,
        method: "POST",
      });
      expect(ticketResponse.status).toBe(200);
      const { ticket } = (await ticketResponse.json()) as { ticket: string };

      const socket = await withTimeout(
        openRawWebSocket(new URL(`/api/v1/debugger?ticket=${ticket}`, host.url)),
        "debugger websocket open",
      );
      const reply = await withInspectorDiagnostics(
        withTimeout(
          socket.sendAndRead(JSON.stringify({ id: 1, method: "Runtime.enable" })),
          "debugger relay reply",
        ),
        inspector,
      );

      expect(JSON.parse(reply)).toEqual({ id: 1, result: { ok: true } });
      expect(inspector.received).toContain(JSON.stringify({ id: 1, method: "Runtime.enable" }));
      inspector.broadcast({
        method: "Runtime.consoleAPICalled",
        params: {
          args: [{ type: "string", value: "from authored tool" }],
          type: "log",
        },
      });
      inspector.broadcast({
        method: "Debugger.paused",
        params: { callFrames: [{ callFrameId: "frame-1" }], reason: "other" },
      });
      await waitFor(async () => {
        const state = await fetch(new URL("/api/v1/debugger/state", host.url), { headers });
        await expect(state.json()).resolves.toMatchObject({
          debugger: { pause: { reason: "other" } },
        });
        const health = await fetch(new URL("/api/v1/health", host.url));
        await expect(health.json()).resolves.toMatchObject({ runtime: { status: "paused" } });
        const logs = await fetch(new URL("/api/v1/logs", host.url), { headers });
        await expect(logs.json()).resolves.toMatchObject({
          entries: [{ message: "from authored tool", stream: "console" }],
        });
      });
      inspector.broadcast({ method: "Debugger.resumed", params: {} });

      const conflictTicketResponse = await fetch(new URL("/api/v1/debugger/tickets", host.url), {
        headers,
        method: "POST",
      });
      const { ticket: conflictTicket } = (await conflictTicketResponse.json()) as {
        ticket: string;
      };
      await expect(
        readRejectedUpgrade(new URL(`/api/v1/debugger?ticket=${conflictTicket}`, host.url)),
      ).resolves.toMatch(/^HTTP\/1\.1 409 Conflict/u);

      socket.close();
      await new Promise((resolve) => setTimeout(resolve, 25));

      const secondTicketResponse = await fetch(new URL("/api/v1/debugger/tickets", host.url), {
        headers,
        method: "POST",
      });
      const { ticket: secondTicket } = (await secondTicketResponse.json()) as { ticket: string };
      const secondSocket = await withTimeout(
        openRawWebSocket(new URL(`/api/v1/debugger?ticket=${secondTicket}`, host.url)),
        "second debugger websocket open",
      );
      secondSocket.close();

      await expect(
        withTimeout(
          readRejectedUpgrade(new URL(`/api/v1/debugger?ticket=bad`, host.url)),
          "rejected debugger upgrade",
        ),
      ).resolves.toMatch(/^HTTP\/1\.1 401 Unauthorized/u);
    } finally {
      await host.close();
    }
  });
});

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out`)), 2_000);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

async function withInspectorDiagnostics<T>(
  promise: Promise<T>,
  inspector: { readonly connectionCount: number; readonly received: readonly string[] },
): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${message}; inspector connections ${inspector.connectionCount}; received ${JSON.stringify(inspector.received)}`,
    );
  }
}

async function readRejectedUpgrade(url: URL): Promise<string> {
  const socket = connect(Number(url.port), url.hostname);
  socket.setEncoding("utf8");
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });

  let response = "";
  socket.on("data", (chunk: string) => {
    response += chunk;
  });
  const responseComplete = new Promise<string>((resolve) => {
    const finish = () => {
      resolve(response);
    };
    socket.once("end", finish);
    socket.once("close", finish);
    socket.once("error", finish);
  });
  socket.write(
    [
      `GET ${url.pathname}${url.search} HTTP/1.1`,
      `Host: ${url.host}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      "Sec-WebSocket-Version: 13",
      "",
      "",
    ].join("\r\n"),
  );

  return await responseComplete;
}

async function openRawWebSocket(url: URL): Promise<{
  close(): void;
  sendAndRead(message: string): Promise<string>;
}> {
  const socket = connect(Number(url.port), url.hostname);
  let buffered = Buffer.alloc(0);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });

  socket.write(
    [
      `GET ${url.pathname}${url.search} HTTP/1.1`,
      `Host: ${url.host}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      "Sec-WebSocket-Version: 13",
      "",
      "",
    ].join("\r\n"),
  );

  await new Promise<void>((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const headerEnd = buffered.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        return;
      }

      const header = buffered.subarray(0, headerEnd).toString("utf8");
      buffered = buffered.subarray(headerEnd + 4);
      socket.off("data", onData);
      socket.off("error", reject);
      if (/^HTTP\/1\.1 101(?:\s|$)/u.test(header)) {
        resolve();
      } else {
        reject(new Error(`Unexpected WebSocket response: ${header}`));
      }
    };
    socket.on("data", onData);
    socket.once("error", reject);
  });

  return {
    close() {
      socket.write(Buffer.from([0x88, 0x80, 1, 2, 3, 4]));
      socket.end();
    },
    async sendAndRead(message: string) {
      socket.write(encodeMaskedTextFrame(message));
      if (buffered.length > 0) {
        const message = decodeTextFrame(buffered);
        if (message !== undefined) {
          buffered = Buffer.alloc(0);
          return message;
        }
      }

      return await new Promise<string>((resolve, reject) => {
        const onData = (chunk: Buffer) => {
          const message = decodeTextFrame(chunk);
          if (message === undefined) {
            return;
          }
          socket.off("data", onData);
          socket.off("error", reject);
          resolve(message);
        };
        socket.on("data", onData);
        socket.once("error", reject);
      });
    },
  };
}

async function startFakeInspector(sourceUrl: string): Promise<{
  broadcast(message: unknown): void;
  close(): Promise<void>;
  connectionCount: number;
  received: string[];
  url: string;
}> {
  const received: string[] = [];
  const sockets = new Set<Duplex>();
  let connectionCount = 0;
  const server = createServer();

  server.on("upgrade", (req, socket) => {
    connectionCount += 1;
    sockets.add(socket);
    socket.on("error", () => {
      sockets.delete(socket);
    });
    acceptWebSocket(req, socket);
    socket.on("data", (chunk) => {
      for (const message of decodeTextFrames(chunk)) {
        received.push(message);
        const parsed = JSON.parse(message) as { id?: number; method?: string };
        socket.write(encodeTextFrame(JSON.stringify({ id: parsed.id, result: { ok: true } })));
        if (parsed.method === "Debugger.enable") {
          socket.write(
            encodeTextFrame(
              JSON.stringify({
                method: "Debugger.scriptParsed",
                params: {
                  scriptId: "authored-1",
                  sourceMapURL: "",
                  url: sourceUrl,
                },
              }),
            ),
          );
        }
      }
    });
    socket.once("close", () => {
      sockets.delete(socket);
    });
    socket.resume();
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("fake inspector did not bind");
  }

  return {
    broadcast(message) {
      const frame = encodeTextFrame(JSON.stringify(message));
      for (const socket of sockets) socket.write(frame);
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
    received,
    get connectionCount() {
      return connectionCount;
    },
    url: `ws://127.0.0.1:${address.port}/inspector`,
  };
}

async function waitFor(assertion: () => Promise<void>): Promise<void> {
  const deadline = Date.now() + 2_000;
  let lastError: unknown;
  while (Date.now() <= deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw lastError;
}

function acceptWebSocket(req: IncomingMessage, socket: Duplex): void {
  const key = req.headers["sec-websocket-key"];
  if (typeof key !== "string") {
    socket.destroy();
    return;
  }
  const accept = createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      "",
    ].join("\r\n"),
  );
}

function decodeTextFrame(chunk: Buffer): string | undefined {
  if (chunk.length < 2) return undefined;
  const masked = (chunk[1]! & 0x80) !== 0;
  let length = chunk[1]! & 0x7f;
  let offset = 2;
  if (length === 126) {
    length = chunk.readUInt16BE(offset);
    offset += 2;
  }
  let mask: Buffer | undefined;
  if (masked) {
    mask = chunk.subarray(offset, offset + 4);
    offset += 4;
  }
  const payload = Buffer.from(chunk.subarray(offset, offset + length));
  if (mask !== undefined) {
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] = payload[index]! ^ mask[index % 4]!;
    }
  }
  return payload.toString("utf8");
}

function decodeTextFrames(chunk: Buffer): string[] {
  const messages: string[] = [];
  let remaining = chunk;
  while (remaining.length >= 2) {
    const masked = (remaining[1]! & 0x80) !== 0;
    let length = remaining[1]! & 0x7f;
    let headerLength = 2;
    if (length === 126) {
      if (remaining.length < 4) break;
      length = remaining.readUInt16BE(2);
      headerLength = 4;
    }
    const frameLength = headerLength + (masked ? 4 : 0) + length;
    if (remaining.length < frameLength) break;
    const message = decodeTextFrame(remaining.subarray(0, frameLength));
    if (message !== undefined) messages.push(message);
    remaining = remaining.subarray(frameLength);
  }
  return messages;
}

function encodeTextFrame(message: string): Buffer {
  const payload = Buffer.from(message);
  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  }
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

function encodeMaskedTextFrame(message: string): Buffer {
  const payload = Buffer.from(message);
  const mask = Buffer.from([1, 2, 3, 4]);
  const maskedPayload = Buffer.from(payload);
  for (let index = 0; index < maskedPayload.length; index += 1) {
    maskedPayload[index] = maskedPayload[index]! ^ mask[index % 4]!;
  }
  return Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, maskedPayload]);
}
