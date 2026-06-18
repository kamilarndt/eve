import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startDevToolsHost, type DevToolsRuntimeState } from "../../src/internal/devtools/host.js";

describe("DevTools agent and revisions API", () => {
  let appRoot: string;
  let failInfo = false;
  let runtime: { close(): Promise<void>; url: string };
  let runtimeState: DevToolsRuntimeState;

  beforeEach(async () => {
    appRoot = await mkdtemp(join(tmpdir(), "eve-devtools-agent-"));
    failInfo = false;
    runtime = await startFakeRuntime(() => failInfo);
    runtimeState = {
      revision: "rev-1",
      runtimeInstanceId: "runtime-1",
      runtimeUrl: runtime.url,
      status: "ready",
    };
  });

  afterEach(async () => {
    await runtime.close();
    await rm(appRoot, { force: true, recursive: true });
  });

  it("proxies runtime-owned agent info and preserves it across failed refresh", async () => {
    const host = await startDevToolsHost({
      appRoot,
      getRuntimeState: () => runtimeState,
    });

    try {
      const discovery = JSON.parse(
        await readFile(join(appRoot, ".eve", "devtools", "current.json"), "utf8"),
      ) as { browserCapability: string };
      const headers = {
        authorization: `Bearer ${discovery.browserCapability}`,
      };

      const bootstrap = await fetch(new URL("/api/v1/bootstrap", host.url), { headers });
      await expect(bootstrap.json()).resolves.toMatchObject({
        agent: {
          name: "Weather Agent",
          tools: [{ name: "get_weather" }],
        },
        runtime: {
          revision: "rev-1",
        },
      });

      runtimeState = { ...runtimeState, status: "paused" };
      const pausedBootstrap = await fetch(new URL("/api/v1/bootstrap", host.url), { headers });
      expect(pausedBootstrap.status).toBe(200);
      await expect(pausedBootstrap.json()).resolves.toMatchObject({
        agent: { name: "Weather Agent" },
        diagnostics: [{ message: "Runtime is paused; showing the last agent snapshot." }],
        runtime: { status: "paused" },
      });

      runtimeState = { ...runtimeState, revision: "rev-2", status: "ready" };
      failInfo = true;

      const agent = await fetch(new URL("/api/v1/agent", host.url), { headers });
      expect(agent.status).toBe(200);
      await expect(agent.json()).resolves.toMatchObject({
        agent: {
          name: "Weather Agent",
        },
        diagnostics: [
          {
            message: "runtime info unavailable",
          },
        ],
        runtime: {
          revision: "rev-2",
        },
      });
    } finally {
      await host.close();
    }
  });
});

async function startFakeRuntime(
  shouldFailInfo: () => boolean,
): Promise<{ close(): Promise<void>; url: string }> {
  const server = createServer((req, res) => {
    handleRuntimeRequest(req, res, shouldFailInfo);
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
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
    url: `http://127.0.0.1:${address.port}/`,
  };
}

function handleRuntimeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  shouldFailInfo: () => boolean,
): void {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/eve/v1/info") {
    if (shouldFailInfo()) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("runtime info unavailable");
      return;
    }

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ name: "Weather Agent", tools: [{ name: "get_weather" }] }));
    return;
  }

  res.writeHead(404);
  res.end();
}
