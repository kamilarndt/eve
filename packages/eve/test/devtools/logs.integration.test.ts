import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startDevToolsHost } from "../../src/internal/devtools/host.js";

describe("DevTools logs API", () => {
  let appRoot: string;

  beforeEach(async () => {
    appRoot = await mkdtemp(join(tmpdir(), "eve-devtools-logs-"));
  });

  afterEach(async () => {
    await rm(appRoot, { force: true, recursive: true });
  });

  it("indexes bounded logs and streams live log entries over SSE", async () => {
    const host = await startDevToolsHost({
      appRoot,
      getRuntimeState: () => ({
        runtimeInstanceId: "runtime-1",
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

      host.appendLog({
        fields: { request: { authorization: "Bearer secret", safe: true } },
        message: "booted",
        stream: "stdout",
      });

      const logs = await vi.waitFor(async () => {
        const response = await fetch(new URL("/api/v1/logs?cursor=0", host.url), { headers });
        expect(response.status).toBe(200);
        const body = (await response.json()) as { readonly entries: readonly unknown[] };
        expect(body.entries).toHaveLength(1);
        return body;
      });
      expect(logs).toMatchObject({
        entries: [
          {
            cursor: "1",
            fields: { request: { authorization: "[redacted]", safe: true } },
            message: "booted",
            stream: "stdout",
          },
        ],
        nextCursor: "1",
        schemaVersion: 1,
      });

      const sse = await fetch(new URL("/api/v1/events", host.url), { headers });
      expect(sse.status).toBe(200);
      const reader = sse.body!.getReader();
      host.appendLog({ message: "runtime warning", stream: "stderr" });

      const sseText = await readUntil(reader, "runtime warning");
      expect(sseText).toContain("event: log.entry");
      expect(sseText).toContain('"stream":"stderr"');
      await reader.cancel();
    } finally {
      await host.close();
    }
  });
});

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
