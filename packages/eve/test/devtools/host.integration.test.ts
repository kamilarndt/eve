import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startDevToolsHost } from "../../src/internal/devtools/host.js";

describe("DevTools host and discovery", () => {
  let appRoot: string;

  beforeEach(async () => {
    appRoot = await mkdtemp(join(tmpdir(), "eve-devtools-host-"));
  });

  afterEach(async () => {
    await rm(appRoot, { force: true, recursive: true });
  });

  it("writes owner-readable discovery metadata and protects bootstrap", async () => {
    const host = await startDevToolsHost({
      appRoot,
      getRuntimeState: () => ({
        inspectorUrl: "ws://127.0.0.1:49111/session",
        revision: "rev-1",
        runtimeInstanceId: "runtime-1",
        runtimePid: 12345,
        runtimeUrl: "http://127.0.0.1:42001/",
        status: "ready",
      }),
    });

    try {
      expect(new URL(host.url).hostname).toBe("127.0.0.1");

      const discoveryPath = join(appRoot, ".eve", "devtools", "current.json");
      const discovery = JSON.parse(await readFile(discoveryPath, "utf8")) as {
        browserCapability: string;
        devtoolsUrl: string;
        runtimeInstanceId: string;
      };
      expect(discovery).toMatchObject({
        devtoolsUrl: `${host.url}#token=${discovery.browserCapability}`,
        runtimeInstanceId: "runtime-1",
      });
      expect(discovery.browserCapability).toHaveLength(64);
      expect((await stat(discoveryPath)).mode & 0o777).toBe(0o600);

      const app = await fetch(host.url);
      expect(app.status).toBe(200);
      expect(app.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(app.headers.get("content-security-policy")).toContain("script-src 'self'");
      const appHtml = await app.text();
      const assetPath = appHtml.match(/src="([^"]+\.js)"/u)?.[1];
      if (assetPath === undefined) throw new Error("DevTools app did not reference its JS asset.");
      const asset = await fetch(new URL(assetPath, host.url));
      expect(asset.status).toBe(200);
      expect(asset.headers.get("content-type")).toBe("text/javascript; charset=utf-8");

      const unauthorized = await fetch(new URL("/api/v1/bootstrap", host.url));
      expect(unauthorized.status).toBe(401);
      expect(unauthorized.headers.get("content-security-policy")).toContain("default-src 'none'");

      const rejectedOrigin = await fetch(new URL("/api/v1/bootstrap", host.url), {
        headers: {
          authorization: `Bearer ${discovery.browserCapability}`,
          origin: "https://example.com",
        },
      });
      expect(rejectedOrigin.status).toBe(403);

      const health = await fetch(new URL("/api/v1/health", host.url));
      expect(await health.json()).toEqual({
        ok: true,
        runtime: { status: "ready" },
        schemaVersion: 1,
      });

      const authorized = await fetch(new URL("/api/v1/bootstrap", host.url), {
        headers: {
          authorization: `Bearer ${discovery.browserCapability}`,
        },
      });
      expect(authorized.status).toBe(200);
      const authorizedBody = (await authorized.json()) as { runtime: Record<string, unknown> };
      expect(authorizedBody).toMatchObject({
        runtime: {
          revision: "rev-1",
          runtimeInstanceId: "runtime-1",
          runtimePid: 12345,
          runtimeUrl: "http://127.0.0.1:42001/",
          status: "ready",
        },
        schemaVersion: 1,
      });
      expect(authorizedBody.runtime).not.toHaveProperty("inspectorUrl");
    } finally {
      await host.close();
    }

    await expect(readFile(join(appRoot, ".eve", "devtools", "current.json"))).rejects.toMatchObject(
      { code: "ENOENT" },
    );
  });

  it("isolates discovery and capabilities for concurrent app roots", async () => {
    const otherAppRoot = await mkdtemp(join(tmpdir(), "eve-devtools-host-other-"));
    const first = await startDevToolsHost({
      appRoot,
      getRuntimeState: () => ({
        runtimeInstanceId: "runtime-1",
        status: "ready",
      }),
    });
    const second = await startDevToolsHost({
      appRoot: otherAppRoot,
      getRuntimeState: () => ({
        runtimeInstanceId: "runtime-2",
        status: "ready",
      }),
    });

    try {
      const firstDiscovery = JSON.parse(
        await readFile(join(appRoot, ".eve", "devtools", "current.json"), "utf8"),
      ) as { browserCapability: string; devtoolsUrl: string; runtimeInstanceId: string };
      const secondDiscovery = JSON.parse(
        await readFile(join(otherAppRoot, ".eve", "devtools", "current.json"), "utf8"),
      ) as { browserCapability: string; devtoolsUrl: string; runtimeInstanceId: string };

      expect(first.url).not.toBe(second.url);
      expect(firstDiscovery.browserCapability).not.toBe(secondDiscovery.browserCapability);
      expect(firstDiscovery.devtoolsUrl).toBe(
        `${first.url}#token=${firstDiscovery.browserCapability}`,
      );
      expect(secondDiscovery.devtoolsUrl).toBe(
        `${second.url}#token=${secondDiscovery.browserCapability}`,
      );
      expect(firstDiscovery.runtimeInstanceId).toBe("runtime-1");
      expect(secondDiscovery.runtimeInstanceId).toBe("runtime-2");
    } finally {
      await first.close();
      await second.close();
      await rm(otherAppRoot, { force: true, recursive: true });
    }
  });

  it("publishes runtime observations over authenticated SSE", async () => {
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
      const events = await fetch(new URL("/api/v1/events", host.url), {
        headers: {
          authorization: `Bearer ${discovery.browserCapability}`,
        },
      });
      expect(events.status).toBe(200);
      const reader = events.body?.getReader();
      expect(reader).toBeDefined();

      host.appendObservation({
        at: "2026-06-20T00:00:00.000Z",
        data: { ok: true },
        recordId: "record-1",
        runtimeInstanceId: "runtime-1",
        schemaVersion: 1,
        sequence: 0,
        type: "runtime.child.started",
      });

      const text = await readUntil(reader!, "observation.record");
      expect(text).toContain("event: observation.record");
      expect(text).toContain('"type":"runtime.child.started"');
      await reader?.cancel();
    } finally {
      await host.close();
    }
  });

  it("replays retained SSE events without treating stream backpressure as a disconnect", async () => {
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
      for (let index = 0; index < 200; index += 1) {
        host.appendObservation({
          at: "2026-06-20T00:00:00.000Z",
          data: { payload: "x".repeat(128) },
          recordId: `record-${index}`,
          runtimeInstanceId: "runtime-1",
          schemaVersion: 1,
          sequence: index,
          type: "runtime.child.stdout",
        });
      }

      const events = await fetch(new URL("/api/v1/events", host.url), {
        headers: {
          authorization: `Bearer ${discovery.browserCapability}`,
        },
      });
      expect(events.status).toBe(200);
      const reader = events.body?.getReader();
      expect(reader).toBeDefined();

      const text = await readUntil(reader!, '"recordId":"record-199"');
      expect(text).toContain('"recordId":"record-199"');
      await reader?.cancel();
    } finally {
      await host.close();
    }
  });
});

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  pattern: string,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for (let index = 0; index < 100; index += 1) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
    if (text.includes(pattern)) {
      return text;
    }
  }
  return text;
}
