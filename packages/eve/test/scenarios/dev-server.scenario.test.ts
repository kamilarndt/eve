import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { join } from "node:path";
import type { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { Client } from "../../src/client/index.js";
import type { HandleMessageStreamEvent } from "../../src/protocol/message.js";
import {
  EVE_HEALTH_ROUTE_PATH,
  createEveMessageStreamRoutePath,
} from "../../src/protocol/routes.js";
import { IDLE_STREAM_REPRO_DESCRIPTOR } from "../../src/internal/testing/scenario-apps/idle-stream-repro.js";
import { WEATHER_AGENT_DESCRIPTOR } from "../../src/internal/testing/scenario-apps/weather-agent.js";
import {
  type ScenarioAppDescriptor,
  useScenarioApp,
} from "../../src/internal/testing/scenario-app.js";
import { sendDevelopmentMessage } from "../dev-client-harness/send-message.js";
import { createDevelopmentSessionState } from "../dev-client-harness/session.js";
import { readMessageStreamEvents } from "../dev-client-harness/stream.js";

// Keep the dev TUI's glyph set deterministic across CI hosts so the
// screen assertions below remain stable.
process.env.EVE_TUI_UNICODE = "1";

const scenarioApp = useScenarioApp();
const DEV_SERVER_SCENARIO_TIMEOUT_MS = 360_000;
const DEV_SERVER_AGENT_DESCRIPTOR: ScenarioAppDescriptor = {
  ...WEATHER_AGENT_DESCRIPTOR,
  files: Object.fromEntries(
    Object.entries(WEATHER_AGENT_DESCRIPTOR.files).filter(
      ([path]) => !path.startsWith("agent/channels/"),
    ),
  ),
};

interface RunningEveDev {
  readonly stderr: () => string;
  readonly stdout: () => string;
  readonly url: string;
  stop(): Promise<void>;
}

function stripAnsi(text: string): string {
  return text
    .split("\u001b[")
    .map((segment, index) => {
      if (index === 0) {
        return segment;
      }

      return segment.replace(/^[0-9;]*m/, "");
    })
    .join("");
}

function hasUnsupportedWindowsEsmImport(text: string): boolean {
  return (
    text.includes("ERR_UNSUPPORTED_ESM_URL_SCHEME") ||
    text.includes("Received protocol 'g:'") ||
    text.includes('Received protocol "g:"')
  );
}

function hasKnownDevBundlingFailure(text: string): boolean {
  return (
    hasUnsupportedWindowsEsmImport(text) ||
    (text.includes("ERR_MODULE_NOT_FOUND") && text.includes("authored-module-map-loader"))
  );
}

function parseServerUrl(stdout: string): string | undefined {
  const match = /server listening at (https?:\/\/\S+)/.exec(stripAnsi(stdout));

  return match?.[1];
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForServerUrl(input: {
  readonly child: ChildProcessByStdio<null, Readable, Readable>;
  readonly getOutput: () => {
    readonly stderr: string;
    readonly stdout: string;
  };
}): Promise<string> {
  return await new Promise((resolve, reject) => {
    let settled = false;

    const timeout = setTimeout(() => {
      settleReject(
        new Error(
          [
            "Timed out waiting for eve dev to print its server URL.",
            `stdout:\n${input.getOutput().stdout}`,
            `stderr:\n${input.getOutput().stderr}`,
          ].join("\n\n"),
        ),
      );
    }, 120_000);

    const cleanup = () => {
      clearTimeout(timeout);
      input.child.stdout.off("data", handleOutput);
      input.child.stderr.off("data", handleOutput);
      input.child.off("error", settleReject);
      input.child.off("exit", handleExit);
    };

    const settleResolve = (url: string) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      resolve(url);
    };

    function settleReject(error: unknown) {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(error);
    }

    function handleOutput() {
      const output = input.getOutput();
      const combinedOutput = `${output.stdout}\n${output.stderr}`;

      if (hasKnownDevBundlingFailure(combinedOutput)) {
        settleReject(
          new Error(
            [
              "eve dev emitted a known generated dev bundle import failure.",
              `stdout:\n${output.stdout}`,
              `stderr:\n${output.stderr}`,
            ].join("\n\n"),
          ),
        );
        return;
      }

      const url = parseServerUrl(output.stdout);

      if (url !== undefined) {
        settleResolve(url);
      }
    }

    function handleExit(code: number | null, signal: NodeJS.Signals | null) {
      const output = input.getOutput();

      settleReject(
        new Error(
          [
            `eve dev exited before printing its server URL (code ${String(code)}, signal ${String(signal)}).`,
            `stdout:\n${output.stdout}`,
            `stderr:\n${output.stderr}`,
          ].join("\n\n"),
        ),
      );
    }

    input.child.stdout.on("data", handleOutput);
    input.child.stderr.on("data", handleOutput);
    input.child.once("error", settleReject);
    input.child.once("exit", handleExit);
    handleOutput();
  });
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  reject(error: unknown): void;
  resolve(value: T): void;
}

interface ProxySocketHangUp {
  readonly events: readonly HandleMessageStreamEvent[];
  readonly logLine: string;
  readonly streamUrl: string;
}

interface RunningSocketHangUpProxy {
  readonly logs: () => readonly string[];
  readonly url: string;
  stop(): Promise<void>;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return {
    promise,
    reject,
    resolve,
  };
}

function isSessionStreamUrl(url: URL): boolean {
  return /\/eve\/v1\/session\/[^/]+\/stream$/u.test(url.pathname);
}

async function startSocketHangUpProxy(input: {
  readonly idleAfterActionsRequestedMs: number;
  readonly onProxyError: (error: unknown) => void;
  readonly onSocketHangUp: (failure: ProxySocketHangUp) => void;
  readonly targetUrl: string;
}): Promise<RunningSocketHangUpProxy> {
  const logs: string[] = [];
  const sockets = new Set<Socket>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let interceptedStream = false;
  const server = createServer((clientRequest, clientResponse) => {
    proxyRequest({
      clientRequest,
      clientResponse,
      idleAfterActionsRequestedMs: input.idleAfterActionsRequestedMs,
      interceptStream: !interceptedStream,
      logs,
      onIntercepted: () => {
        interceptedStream = true;
      },
      onProxyError: input.onProxyError,
      onSocketHangUp: input.onSocketHangUp,
      targetUrl: input.targetUrl,
      timers,
    });
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;

  return {
    logs: () => logs,
    async stop() {
      for (const timer of timers) {
        clearTimeout(timer);
      }
      timers.clear();

      for (const socket of sockets) {
        socket.destroy();
      }

      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
    url: `http://127.0.0.1:${address.port}`,
  };
}

function proxyRequest(input: {
  readonly clientRequest: IncomingMessage;
  readonly clientResponse: ServerResponse;
  readonly idleAfterActionsRequestedMs: number;
  readonly interceptStream: boolean;
  readonly logs: string[];
  readonly onIntercepted: () => void;
  readonly onProxyError: (error: unknown) => void;
  readonly onSocketHangUp: (failure: ProxySocketHangUp) => void;
  readonly targetUrl: string;
  readonly timers: Set<ReturnType<typeof setTimeout>>;
}): void {
  const targetUrl = new URL(input.clientRequest.url ?? "/", input.targetUrl);
  const shouldIntercept = input.interceptStream && isSessionStreamUrl(targetUrl);
  const upstreamRequest = httpRequest(
    targetUrl,
    {
      headers: {
        ...input.clientRequest.headers,
        host: targetUrl.host,
      },
      method: input.clientRequest.method,
    },
    (upstreamResponse) => {
      if (!shouldIntercept) {
        writeProxyResponseHead(input.clientResponse, upstreamResponse);
        upstreamResponse.pipe(input.clientResponse);
        return;
      }

      input.onIntercepted();
      proxyStreamUntilSocketHangUp({
        clientResponse: input.clientResponse,
        idleAfterActionsRequestedMs: input.idleAfterActionsRequestedMs,
        logs: input.logs,
        onProxyError: input.onProxyError,
        onSocketHangUp: input.onSocketHangUp,
        targetUrl,
        timers: input.timers,
        upstreamRequest,
        upstreamResponse,
      });
    },
  );

  upstreamRequest.on("error", (error) => {
    if (shouldIntercept && input.clientResponse.headersSent && !input.clientResponse.writableEnded) {
      return;
    }

    input.onProxyError(error);
    if (!input.clientResponse.headersSent) {
      input.clientResponse.writeHead(502);
    }
    input.clientResponse.end(String(error));
  });

  input.clientRequest.pipe(upstreamRequest);
}

function writeProxyResponseHead(
  clientResponse: ServerResponse,
  upstreamResponse: IncomingMessage,
): void {
  clientResponse.writeHead(
    upstreamResponse.statusCode ?? 502,
    upstreamResponse.statusMessage,
    upstreamResponse.headers,
  );
}

function proxyStreamUntilSocketHangUp(input: {
  readonly clientResponse: ServerResponse;
  readonly idleAfterActionsRequestedMs: number;
  readonly logs: string[];
  readonly onProxyError: (error: unknown) => void;
  readonly onSocketHangUp: (failure: ProxySocketHangUp) => void;
  readonly targetUrl: URL;
  readonly timers: Set<ReturnType<typeof setTimeout>>;
  readonly upstreamRequest: ReturnType<typeof httpRequest>;
  readonly upstreamResponse: IncomingMessage;
}): void {
  writeProxyResponseHead(input.clientResponse, input.upstreamResponse);

  const decoder = new TextDecoder();
  const events: HandleMessageStreamEvent[] = [];
  let buffer = "";
  let failedProxy = false;

  const failProxy = () => {
    if (failedProxy) {
      return;
    }

    failedProxy = true;
    const logLine = `Failed to proxy <${input.targetUrl.toString()}> Error: socket hang up (ECONNRESET)`;
    const error = Object.assign(new Error("socket hang up"), {
      code: "ECONNRESET",
    });

    input.logs.push(logLine);
    input.onSocketHangUp({
      events: [...events],
      logLine,
      streamUrl: input.targetUrl.toString(),
    });
    input.upstreamResponse.destroy(error);
    input.upstreamRequest.destroy(error);
  };

  const scheduleFailure = () => {
    const timer = setTimeout(() => {
      input.timers.delete(timer);
      failProxy();
    }, input.idleAfterActionsRequestedMs);
    input.timers.add(timer);
  };

  input.upstreamResponse.on("data", (chunk: Buffer) => {
    if (failedProxy) {
      return;
    }

    try {
      buffer += decoder.decode(chunk, { stream: true });
      let newlineIndex = buffer.indexOf("\n");

      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);

        if (line.length > 0) {
          const event = JSON.parse(line) as HandleMessageStreamEvent;
          events.push(event);
          input.clientResponse.write(`${line}\n`);

          if (event.type === "actions.requested") {
            input.upstreamResponse.pause();
            scheduleFailure();
            return;
          }
        }

        newlineIndex = buffer.indexOf("\n");
      }
    } catch (error) {
      input.onProxyError(error);
      input.clientResponse.destroy(error instanceof Error ? error : undefined);
      input.upstreamRequest.destroy();
    }
  });

  input.upstreamResponse.once("end", () => {
    if (!failedProxy) {
      input.onProxyError(new Error("Upstream stream ended before actions.requested."));
      input.clientResponse.end();
    }
  });

  input.upstreamResponse.once("error", (error) => {
    if (!failedProxy) {
      input.onProxyError(error);
      input.clientResponse.destroy(error);
    }
  });
}

async function readDurableTailEvents(input: {
  readonly fetch: typeof fetch;
  readonly serverUrl: string;
  readonly sessionId: string;
  readonly startIndex: number;
}): Promise<HandleMessageStreamEvent[]> {
  const tailUrl = new URL(createEveMessageStreamRoutePath(input.sessionId), input.serverUrl);
  tailUrl.searchParams.set("startIndex", String(input.startIndex));
  const response = await input.fetch(tailUrl);

  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `Durable stream returned ${response.status}.`);
  }

  return await readMessageStreamEvents({ response });
}

async function hasSettledWithin<T>(promise: Promise<T>, ms: number): Promise<boolean> {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );

  await wait(ms);
  return settled;
}

async function startEveDev(appRoot: string): Promise<RunningEveDev> {
  const eveBinPath = join(appRoot, "node_modules", "eve", "bin", "eve.js");
  const child = spawn(
    process.execPath,
    [eveBinPath, "dev", "--no-ui", "--host", "127.0.0.1", "--port", "0"],
    {
      cwd: appRoot,
      env: {
        ...process.env,
        // Activate the deterministic mock-model adapter in the spawned dev
        // server so the streamed turn completes without model credentials.
        NODE_ENV: "test",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  let stdout = "";

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const url = await waitForServerUrl({
    child,
    getOutput: () => ({
      stderr,
      stdout,
    }),
  });

  return {
    stderr: () => stderr,
    stdout: () => stdout,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }

      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 10_000);

        child.once("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
        child.kill("SIGTERM");
      });
    },
    url,
  };
}

describe("eve dev server", () => {
  it(
    "boots the packaged development server and completes a streamed turn",
    async () => {
      const app = await scenarioApp(DEV_SERVER_AGENT_DESCRIPTOR);
      const server = await startEveDev(app.appRoot);

      try {
        const response = await fetch(new URL(EVE_HEALTH_ROUTE_PATH, server.url));
        const responseText = await response.text();

        expect(
          response.status,
          [
            `Expected ${EVE_HEALTH_ROUTE_PATH} to return 200.`,
            `response body:\n${responseText}`,
            `stdout:\n${server.stdout()}`,
            `stderr:\n${server.stderr()}`,
          ].join("\n\n"),
        ).toBe(200);
        expect(JSON.parse(responseText)).toMatchObject({
          ok: true,
          status: "ready",
        });

        let messageResult: Awaited<ReturnType<typeof sendDevelopmentMessage>>;
        try {
          messageResult = await sendDevelopmentMessage({
            message: "hello world",
            session: createDevelopmentSessionState(),
            serverUrl: server.url,
          });
        } catch (error) {
          throw new Error(
            [
              `Expected dev message route to complete without throwing: ${String(error)}`,
              `stdout:\n${server.stdout()}`,
              `stderr:\n${server.stderr()}`,
            ].join("\n\n"),
            { cause: error },
          );
        }

        expect(
          messageResult.events.some((event) => event.type === "message.completed"),
          [
            "Expected dev message route to complete a streamed turn.",
            `events:\n${JSON.stringify(messageResult.events, null, 2)}`,
            `stdout:\n${server.stdout()}`,
            `stderr:\n${server.stderr()}`,
          ].join("\n\n"),
        ).toBe(true);
        await wait(1_000);

        const output = `${server.stdout()}\n${server.stderr()}`;
        expect(hasKnownDevBundlingFailure(output)).toBe(false);
      } finally {
        await server.stop();
      }
    },
    DEV_SERVER_SCENARIO_TIMEOUT_MS,
  );

  it(
    "reproduces a proxy socket hang up during a long inline tool while the durable tail completes",
    async () => {
      const app = await scenarioApp(IDLE_STREAM_REPRO_DESCRIPTOR);
      const server = await startEveDev(app.appRoot);
      const abortController = new AbortController();
      const proxyFailure = createDeferred<ProxySocketHangUp>();
      let proxy: RunningSocketHangUpProxy | undefined;
      let resultPromise: Promise<unknown> | undefined;

      try {
        const originClient = new Client({
          host: server.url,
          preserveCompletedSessions: true,
        });
        const originSession = originClient.session();
        const firstResponse = await originSession.send("Prime the session before the repro turn.");
        await firstResponse.result();

        const baselineState = originSession.state;
        expect(baselineState.sessionId).toBeDefined();
        expect(baselineState.streamIndex).toBeGreaterThan(0);

        proxy = await startSocketHangUpProxy({
          idleAfterActionsRequestedMs: 750,
          onProxyError: proxyFailure.reject,
          onSocketHangUp: proxyFailure.resolve,
          targetUrl: server.url,
        });

        const proxiedClient = new Client({
          host: proxy.url,
          preserveCompletedSessions: true,
        });
        const proxiedSession = proxiedClient.session(baselineState);
        const response = await proxiedSession.send({
          message: "Use idle_stream_repro with label `tail-marker` and delayMs `8000`.",
          signal: abortController.signal,
        });
        resultPromise = response.result();

        const failure = await proxyFailure.promise;
        const forwardedTypes = failure.events.map((event) => event.type);
        expect(forwardedTypes).toContain("actions.requested");
        expect(failure.streamUrl).toContain("/stream?startIndex=");
        expect(failure.streamUrl).toContain(`startIndex=${baselineState.streamIndex}`);
        expect(failure.logLine).toContain("Failed to proxy <http://127.0.0.1:");
        expect(failure.logLine).toContain("Error: socket hang up (ECONNRESET)");

        const tailEvents = await readDurableTailEvents({
          fetch,
          serverUrl: server.url,
          sessionId: response.sessionId,
          startIndex: baselineState.streamIndex + failure.events.length,
        });
        const tailTypes = tailEvents.map((event) => event.type);

        expect(tailTypes).toEqual(
          expect.arrayContaining([
            "action.result",
            "message.completed",
            "turn.completed",
            "session.waiting",
          ]),
        );
        expect(tailTypes).not.toContain("actions.requested");
        expect(proxy.logs()).toContain(failure.logLine);
        expect(await hasSettledWithin(resultPromise, 250)).toBe(false);

        abortController.abort();
        await resultPromise.catch(() => undefined);
      } finally {
        abortController.abort();
        await proxy?.stop();
        await resultPromise?.catch(() => undefined);
        await server.stop();
      }
    },
    DEV_SERVER_SCENARIO_TIMEOUT_MS,
  );

});
