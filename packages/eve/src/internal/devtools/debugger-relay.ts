import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";

import { isAllowedDevToolsRequest } from "#internal/devtools/host/auth.js";

const MAX_WEBSOCKET_BUFFER_BYTES = 8 * 1024 * 1024;

export const DEBUGGER_TICKET_TTL_MS = 30_000;

export function consumeDebuggerTicket(tickets: Map<string, number>, ticket: string): boolean {
  const expiresAt = tickets.get(ticket);
  tickets.delete(ticket);
  return expiresAt !== undefined && expiresAt >= Date.now();
}

export function handleDebuggerUpgrade(input: {
  readonly debuggerTickets: Map<string, number>;
  readonly getDebuggerOwned: () => boolean;
  readonly inspectorUrl?: string;
  readonly expectedPort: number;
  readonly req: IncomingMessage;
  readonly setDebuggerOwned: (owned: boolean) => void;
  readonly socket: Duplex;
}): boolean {
  const url = new URL(input.req.url ?? "/", "http://127.0.0.1");
  if (url.pathname !== "/api/v1/debugger") {
    rejectUpgrade(input.socket, 404, "Not Found");
    return false;
  }

  if (!isAllowedDevToolsRequest(input.req, input.expectedPort)) {
    rejectUpgrade(input.socket, 403, "Forbidden");
    return false;
  }

  const ticket = url.searchParams.get("ticket");
  if (ticket === null || !consumeDebuggerTicket(input.debuggerTickets, ticket)) {
    rejectUpgrade(input.socket, 401, "Unauthorized");
    return false;
  }

  if (input.getDebuggerOwned()) {
    rejectUpgrade(input.socket, 409, "Conflict");
    return false;
  }

  if (input.inspectorUrl === undefined) {
    rejectUpgrade(input.socket, 503, "Service Unavailable");
    return false;
  }

  if (!acceptWebSocket(input.req, input.socket)) {
    return false;
  }

  input.setDebuggerOwned(true);
  relayDebuggerWebSocket({
    inspectorUrl: input.inspectorUrl,
    setDebuggerOwned: input.setDebuggerOwned,
    socket: input.socket,
  });
  return true;
}

function acceptWebSocket(req: IncomingMessage, socket: Duplex): boolean {
  const key = req.headers["sec-websocket-key"];
  if (typeof key !== "string" || key.length === 0) {
    rejectUpgrade(socket, 400, "Bad Request");
    return false;
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
  return true;
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  if (socket.destroyed || socket.writableEnded) {
    return;
  }

  socket.once("error", () => {
    // The browser side may close before the rejection response is flushed.
  });
  socket.end(
    [`HTTP/1.1 ${status} ${message}`, "Connection: close", "Content-Length: 0", "", ""].join(
      "\r\n",
    ),
  );
}

function relayDebuggerWebSocket(input: {
  readonly inspectorUrl: string;
  readonly setDebuggerOwned: (owned: boolean) => void;
  readonly socket: Duplex;
}): void {
  let closed = false;
  let inspectorOpen = false;
  let browserBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  const queuedMessages: string[] = [];
  let inspector: InspectorRelaySocket | undefined;

  const closeBoth = () => {
    if (closed) {
      return;
    }
    closed = true;
    input.setDebuggerOwned(false);
    input.socket.destroy();
    inspector?.close();
  };

  try {
    inspector = connectInspectorWebSocket(input.inspectorUrl, {
      onClose: closeBoth,
      onMessage(message) {
        if (!closed) {
          input.socket.write(encodeWebSocketTextFrame(message));
        }
      },
      onOpen() {
        inspectorOpen = true;
        for (const message of queuedMessages.splice(0)) {
          inspector?.send(message);
        }
      },
    });
  } catch {
    closeBoth();
    return;
  }

  input.socket.on("data", (chunk) => {
    browserBuffer = Buffer.concat([browserBuffer, toBuffer(chunk)]);
    if (browserBuffer.length > MAX_WEBSOCKET_BUFFER_BYTES) {
      closeBoth();
      return;
    }
    const decoded = decodeWebSocketFrames(browserBuffer);
    browserBuffer = decoded.remaining;
    for (const frame of decoded.frames) {
      if (frame.opcode === 0x8) {
        closeBoth();
        return;
      }

      if (frame.opcode !== 0x1) {
        continue;
      }

      const message = frame.payload.toString("utf8");
      if (inspectorOpen) {
        inspector?.send(message);
      } else {
        queuedMessages.push(message);
      }
    }
  });
  input.socket.once("close", closeBoth);
  input.socket.once("end", closeBoth);
  input.socket.once("error", closeBoth);
  input.socket.resume();
}

export interface InspectorRelaySocket {
  close(): void;
  send(message: string): void;
}

export function connectInspectorWebSocket(
  inspectorUrl: string,
  hooks: {
    readonly onClose: () => void;
    readonly onMessage: (message: string) => void;
    readonly onOpen: () => void;
  },
): InspectorRelaySocket {
  const parsed = new URL(inspectorUrl);
  if (parsed.protocol !== "ws:") {
    throw new Error("DevTools inspector relay only supports ws:// inspector URLs.");
  }

  const path = `${parsed.pathname}${parsed.search}`;
  const socket = connect(Number(parsed.port || 80), parsed.hostname);
  const key = randomBytes(16).toString("base64");
  let closed = false;
  let frameBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let handshakeBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let opened = false;

  const close = () => {
    if (closed) {
      return;
    }
    closed = true;
    socket.destroy();
    hooks.onClose();
  };

  const readFrames = (chunk: Buffer<ArrayBufferLike>) => {
    frameBuffer = Buffer.concat([frameBuffer, chunk]);
    if (frameBuffer.length > MAX_WEBSOCKET_BUFFER_BYTES) {
      close();
      return;
    }
    const decoded = decodeWebSocketFrames(frameBuffer);
    frameBuffer = decoded.remaining;
    for (const frame of decoded.frames) {
      if (frame.opcode === 0x8) {
        close();
        return;
      }

      if (frame.opcode === 0x1) {
        hooks.onMessage(frame.payload.toString("utf8"));
      }
    }
  };

  socket.once("connect", () => {
    socket.write(
      [
        `GET ${path || "/"} HTTP/1.1`,
        `Host: ${parsed.host}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        "",
        "",
      ].join("\r\n"),
    );
  });
  socket.on("data", (chunk) => {
    if (opened) {
      readFrames(toBuffer(chunk));
      return;
    }

    handshakeBuffer = Buffer.concat([handshakeBuffer, toBuffer(chunk)]);
    const headerEnd = handshakeBuffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) {
      return;
    }

    const header = handshakeBuffer.subarray(0, headerEnd).toString("utf8");
    if (!/^HTTP\/1\.1 101(?:\s|$)/u.test(header)) {
      close();
      return;
    }

    opened = true;
    hooks.onOpen();
    const remaining = handshakeBuffer.subarray(headerEnd + 4);
    handshakeBuffer = Buffer.alloc(0);
    if (remaining.length > 0) {
      readFrames(remaining);
    }
  });
  socket.once("close", close);
  socket.once("error", close);

  return {
    close,
    send(message) {
      if (!closed && opened) {
        socket.write(encodeWebSocketTextFrame(message, { masked: true }));
      }
    },
  };
}

function toBuffer(chunk: string | Uint8Array): Buffer<ArrayBufferLike> {
  return typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
}

function decodeWebSocketFrames(chunk: Buffer<ArrayBufferLike>): {
  readonly frames: readonly {
    readonly opcode: number;
    readonly payload: Buffer<ArrayBufferLike>;
  }[];
  readonly remaining: Buffer<ArrayBufferLike>;
} {
  const frames: { opcode: number; payload: Buffer<ArrayBufferLike> }[] = [];
  let offset = 0;

  while (offset + 2 <= chunk.length) {
    const opcode = chunk[offset]! & 0x0f;
    const masked = (chunk[offset + 1]! & 0x80) !== 0;
    let length = chunk[offset + 1]! & 0x7f;
    let headerLength = 2;

    if (length === 126) {
      if (offset + headerLength + 2 > chunk.length) {
        break;
      }
      length = chunk.readUInt16BE(offset + headerLength);
      headerLength += 2;
    } else if (length === 127) {
      if (offset + headerLength + 8 > chunk.length) {
        break;
      }
      const bigLength = chunk.readBigUInt64BE(offset + headerLength);
      if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
        break;
      }
      length = Number(bigLength);
      headerLength += 8;
    }

    const maskOffset = offset + headerLength;
    const payloadOffset = maskOffset + (masked ? 4 : 0);
    const frameEnd = payloadOffset + length;
    if (frameEnd > chunk.length) {
      break;
    }

    const payload = Buffer.from(chunk.subarray(payloadOffset, frameEnd));
    if (masked) {
      const mask = chunk.subarray(maskOffset, maskOffset + 4);
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] = payload[index]! ^ mask[index % 4]!;
      }
    }

    frames.push({ opcode, payload });
    offset = frameEnd;
  }

  return {
    frames,
    remaining: chunk.subarray(offset),
  };
}

function encodeWebSocketTextFrame(
  message: string,
  options: { readonly masked?: boolean } = {},
): Buffer<ArrayBufferLike> {
  const payload = Buffer.from(message);
  const mask = options.masked === true ? randomBytes(4) : undefined;
  const maskLength = mask === undefined ? 0 : 4;
  const lengthByteMask = mask === undefined ? 0 : 0x80;
  const encodedPayload = mask === undefined ? payload : Buffer.from(payload);
  if (mask !== undefined) {
    for (let index = 0; index < encodedPayload.length; index += 1) {
      encodedPayload[index] = encodedPayload[index]! ^ mask[index % 4]!;
    }
  }

  if (payload.length < 126) {
    const parts: Uint8Array[] = [Buffer.from([0x81, lengthByteMask | payload.length])];
    if (mask !== undefined) {
      parts.push(mask);
    }
    parts.push(encodedPayload);
    return Buffer.concat(parts);
  }

  if (payload.length <= 0xffff) {
    const header = Buffer.alloc(4 + maskLength);
    header[0] = 0x81;
    header[1] = lengthByteMask | 126;
    header.writeUInt16BE(payload.length, 2);
    if (mask !== undefined) {
      mask.copy(header, 4);
    }
    return Buffer.concat([header, encodedPayload]);
  }

  const header = Buffer.alloc(10 + maskLength);
  header[0] = 0x81;
  header[1] = lengthByteMask | 127;
  header.writeBigUInt64BE(BigInt(payload.length), 2);
  if (mask !== undefined) {
    mask.copy(header, 10);
  }
  return Buffer.concat([header, encodedPayload]);
}
