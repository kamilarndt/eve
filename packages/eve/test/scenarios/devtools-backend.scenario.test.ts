import { spawn, type ChildProcessByStdio } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { WEATHER_AGENT_DESCRIPTOR } from "../../src/internal/testing/scenario-apps/weather-agent.js";
import {
  type ScenarioAppDescriptor,
  useScenarioApp,
} from "../../src/internal/testing/scenario-app.js";

const scenarioApp = useScenarioApp();
const SCENARIO_TIMEOUT_MS = 360_000;
const DEVTOOLS_AGENT_DESCRIPTOR: ScenarioAppDescriptor = {
  ...WEATHER_AGENT_DESCRIPTOR,
  files: Object.fromEntries(
    Object.entries(WEATHER_AGENT_DESCRIPTOR.files)
      .filter(([path]) => !path.startsWith("agent/channels/") && !path.startsWith("agent/skills/"))
      .map(([path, content]) => [
        path,
        path === "agent/tools/get_weather.ts"
          ? content.replace(
              "void ctx.session.turn.id;",
              'void ctx.session.turn.id; console.log("devtools-weather-tool", input.city);',
            )
          : content,
      ]),
  ),
  name: "devtools-backend",
};

interface DevToolsDiscovery {
  readonly browserCapability: string;
  readonly devtoolsUrl: string;
  readonly runtimeInstanceId: string;
}

interface RunningDevTools {
  readonly child: ChildProcessByStdio<null, Readable, Readable>;
  readonly discovery: DevToolsDiscovery;
  readonly output: () => string;
  stop(): Promise<void>;
}

describe("eve dev DevTools backend", () => {
  it(
    "supports discovery, authenticated API use, CDP pause, and a canonical run",
    async () => {
      const app = await scenarioApp(DEVTOOLS_AGENT_DESCRIPTOR);
      const running = await startDevTools(app.appRoot);
      const devtoolsUrl = new URL(running.discovery.devtoolsUrl);
      devtoolsUrl.hash = "";
      const headers = {
        authorization: `Bearer ${running.discovery.browserCapability}`,
      };

      try {
        const appResponse = await fetch(devtoolsUrl);
        expect(appResponse.status).toBe(200);
        expect(await appResponse.text()).toContain("Eve DevTools");

        const unauthorized = await fetch(new URL("/api/v1/bootstrap", devtoolsUrl));
        expect(unauthorized.status).toBe(401);

        await waitFor(async () => {
          const initialBootstrap = await fetch(new URL("/api/v1/bootstrap", devtoolsUrl), {
            headers,
          });
          expect(initialBootstrap.status).toBe(200);
          await expect(initialBootstrap.json()).resolves.toMatchObject({
            agent: expect.any(Object),
            runtime: {
              runtimeInstanceId: running.discovery.runtimeInstanceId,
              status: "ready",
            },
          });
        }, running.output);
        const stableMetadata = JSON.parse(
          await readFile(join(app.appRoot, ".eve", "dev-server.json"), "utf8"),
        ) as Record<string, unknown>;
        expect(stableMetadata).toMatchObject({
          devtoolsUrl: baseUrl(devtoolsUrl),
          runtimeInstanceId: running.discovery.runtimeInstanceId,
          runtimePid: expect.any(Number),
          url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/$/u),
        });

        const ticketResponse = await fetch(new URL("/api/v1/debugger/tickets", devtoolsUrl), {
          headers,
          method: "POST",
        });
        expect(ticketResponse.status).toBe(200);
        const { ticket } = (await ticketResponse.json()) as { ticket: string };
        const debuggerUrl = new URL(`/api/v1/debugger?ticket=${ticket}`, devtoolsUrl);
        debuggerUrl.protocol = "ws:";
        const cdp = await CdpClient.connect(debuggerUrl);
        let createdBody: { run: { sessionId: string } } | undefined;
        try {
          await cdp.command("Runtime.enable");
          await cdp.command("Debugger.enable");
          const authoredLocations = await resolveGeneratedLocations(
            cdp,
            pathToFileURL(join(app.appRoot, "agent", "tools", "get_weather.ts")).href,
            20,
          );
          const locationsResponse = await waitForValue(async () => {
            const response = await fetch(
              new URL(
                `/api/v1/sources/${encodeURIComponent("agent/tools/get_weather.ts")}/locations?line=21`,
                devtoolsUrl,
              ),
              { headers },
            );
            if (!response.ok) return undefined;
            const body = (await response.json()) as {
              readonly locations: readonly {
                readonly columnNumber: number;
                readonly lineNumber: number;
                readonly scriptId: string;
              }[];
            };
            return body.locations.length > 0 ? body.locations : undefined;
          }, running.output);
          const expectedLocations: (typeof locationsResponse)[number][] = [];
          const expectedScriptIds = new Set<string>();
          for (const location of authoredLocations) {
            if (expectedScriptIds.has(location.scriptId)) continue;
            expectedScriptIds.add(location.scriptId);
            expectedLocations.push(location);
          }
          expect(locationsResponse).toEqual(expect.arrayContaining(expectedLocations));
          const breakpoints = await Promise.all(
            locationsResponse.map(
              async (location) => await cdp.command("Debugger.setBreakpoint", { location }),
            ),
          );
          expect(breakpoints).not.toHaveLength(0);
          expect(breakpoints).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ actualLocation: expect.any(Object) }),
            ]),
          );

          const pausedEvent = cdp.waitForEvent("Debugger.paused");
          const created = await fetch(new URL("/api/v1/runs", devtoolsUrl), {
            body: JSON.stringify({ message: "What is the weather in Berlin?" }),
            headers: { ...headers, "content-type": "application/json" },
            method: "POST",
          });
          expect(created.status, running.output()).toBe(202);
          createdBody = (await created.json()) as { run: { sessionId: string } };

          const paused = await pausedEvent;
          const callFrameId = firstCallFrameId(paused);
          const evaluated = await cdp.command("Debugger.evaluateOnCallFrame", {
            callFrameId,
            expression: "input.city",
            returnByValue: true,
          });
          expect(evaluated).toMatchObject({ result: { value: "Berlin" } });

          await waitFor(async () => {
            const health = await fetch(new URL("/api/v1/health", devtoolsUrl));
            await expect(health.json()).resolves.toMatchObject({
              ok: true,
              runtime: { status: "paused" },
            });
          }, running.output);
          const pausedBootstrap = await fetch(new URL("/api/v1/bootstrap", devtoolsUrl), {
            headers,
          });
          expect(pausedBootstrap.status).toBe(200);
          await expect(pausedBootstrap.json()).resolves.toMatchObject({
            debugger: { pause: expect.any(Object) },
            runtime: { status: "paused" },
          });
          await cdp.command("Debugger.resume");
        } finally {
          cdp.close();
        }

        if (createdBody === undefined) throw new Error("DevTools run was not created.");
        await waitFor(async () => {
          const events = await fetch(
            new URL(`/api/v1/runs/${createdBody.run.sessionId}/events?cursor=0`, devtoolsUrl),
            { headers },
          );
          expect(events.status).toBe(200);
          const body = (await events.json()) as {
            events: readonly { event: { type: string } }[];
            run: { status: string };
          };
          expect(body.events.map(({ event }) => event.type)).toEqual(
            expect.arrayContaining(["session.started", "actions.requested", "action.result"]),
          );
          expect(["completed", "waiting"]).toContain(body.run.status);
        }, running.output);

        let latestLogs: unknown;
        await waitFor(
          async () => {
            const response = await fetch(new URL("/api/v1/logs?cursor=0", devtoolsUrl), {
              headers,
            });
            expect(response.status).toBe(200);
            const body = (await response.json()) as {
              entries: readonly {
                fields?: { coordinates?: { session?: string } };
                message: string;
                source?: { path?: string };
              }[];
            };
            latestLogs = body;
            expect(body.entries).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  fields: expect.objectContaining({
                    coordinates: expect.objectContaining({ session: createdBody.run.sessionId }),
                  }),
                  message: "devtools-weather-tool Berlin",
                  source: expect.objectContaining({ path: "agent/tools/get_weather.ts" }),
                }),
              ]),
            );
          },
          () => `${running.output()}\n\nlogs:\n${JSON.stringify(latestLogs, null, 2)}`,
        );

        const sources = await fetch(new URL("/api/v1/sources", devtoolsUrl), { headers });
        await expect(sources.json()).resolves.toMatchObject({
          sources: expect.arrayContaining([
            expect.objectContaining({ kind: "authored", path: "agent/tools/get_weather.ts" }),
          ]),
        });
      } finally {
        await running.stop();
      }

      await expect(
        readFile(join(app.appRoot, ".eve", "devtools", "current.json"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
    SCENARIO_TIMEOUT_MS,
  );
});

async function startDevTools(appRoot: string): Promise<RunningDevTools> {
  const eveBinPath = join(appRoot, "node_modules", "eve", "bin", "eve.js");
  const child = spawn(
    process.execPath,
    [eveBinPath, "dev", "--no-ui", "--host", "127.0.0.1", "--port", "0"],
    {
      cwd: appRoot,
      env: { ...process.env, NODE_ENV: "test" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  let stdout = "";
  child.stderr.setEncoding("utf8");
  child.stdout.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  const output = () => `stdout:\n${stdout}\n\nstderr:\n${stderr}`;

  const discovery = await waitForValue(async () => {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`eve dev exited before discovery.\n${output()}`);
    }
    try {
      return JSON.parse(
        await readFile(join(appRoot, ".eve", "devtools", "current.json"), "utf8"),
      ) as DevToolsDiscovery;
    } catch {
      return undefined;
    }
  }, output);

  return {
    child,
    discovery,
    output,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
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
  };
}

class CdpClient {
  readonly #events = new Map<string, unknown[]>();
  readonly #pending = new Map<
    number,
    { reject(error: Error): void; resolve(value: unknown): void }
  >();
  readonly #waiters = new Map<string, ((value: unknown) => void)[]>();
  readonly #socket: WebSocket;
  #nextId = 1;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as {
        error?: { message?: string };
        id?: number;
        method?: string;
        params?: unknown;
        result?: unknown;
      };
      if (message.id !== undefined) {
        const pending = this.#pending.get(message.id);
        this.#pending.delete(message.id);
        if (message.error !== undefined) {
          pending?.reject(new Error(message.error.message ?? "CDP command failed."));
        } else {
          pending?.resolve(message.result);
        }
        return;
      }
      if (message.method === undefined) return;
      const waiter = this.#waiters.get(message.method)?.shift();
      if (waiter !== undefined) waiter(message.params);
      else
        this.#events.set(message.method, [
          ...(this.#events.get(message.method) ?? []),
          message.params,
        ]);
    });
  }

  static async connect(url: URL): Promise<CdpClient> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("CDP WebSocket failed.")), {
        once: true,
      });
    });
    return new CdpClient(socket);
  }

  close(): void {
    this.#socket.close();
  }

  events(method: string): readonly unknown[] {
    return [...(this.#events.get(method) ?? [])];
  }

  async command(method: string, params?: unknown): Promise<unknown> {
    const id = this.#nextId++;
    const result = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { reject, resolve });
    });
    this.#socket.send(JSON.stringify({ id, method, params }));
    return await result;
  }

  async waitForEvent(method: string, timeoutMs = 60_000): Promise<unknown> {
    const queued = this.#events.get(method)?.shift();
    if (queued !== undefined) return queued;
    return await Promise.race([
      new Promise((resolve) => {
        this.#waiters.set(method, [...(this.#waiters.get(method) ?? []), resolve]);
      }),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error(`Timed out waiting for ${method}.`)), timeoutMs).unref();
      }),
    ]);
  }
}

async function resolveGeneratedLocations(
  cdp: CdpClient,
  authoredUrl: string,
  originalLine: number,
): Promise<readonly { columnNumber: number; lineNumber: number; scriptId: string }[]> {
  const locations: { columnNumber: number; lineNumber: number; scriptId: string }[] = [];
  for (const event of cdp.events("Debugger.scriptParsed")) {
    if (event === null || typeof event !== "object") continue;
    const script = event as {
      scriptId?: unknown;
      sourceMapURL?: unknown;
      url?: unknown;
    };
    if (
      typeof script.scriptId !== "string" ||
      typeof script.sourceMapURL !== "string" ||
      script.sourceMapURL === "" ||
      typeof script.url !== "string"
    ) {
      continue;
    }
    const sourceMap = await readSourceMap(script.url, script.sourceMapURL);
    if (sourceMap === undefined) continue;
    const sourceIndex = await findSourceIndex(sourceMap.sources, authoredUrl);
    if (sourceIndex === -1) continue;
    for (const location of findGeneratedLocations(sourceMap.mappings, sourceIndex, originalLine)) {
      locations.push({ ...location, scriptId: script.scriptId });
    }
  }
  if (locations.length === 0) {
    throw new Error(`No generated CDP location mapped to ${authoredUrl}:${originalLine + 1}.`);
  }
  return locations;
}

async function findSourceIndex(sources: readonly string[], authoredUrl: string): Promise<number> {
  const canonicalAuthoredUrl = await canonicalFileUrl(authoredUrl);
  for (const [index, source] of sources.entries()) {
    if (source === authoredUrl || (await canonicalFileUrl(source)) === canonicalAuthoredUrl) {
      return index;
    }
  }
  return -1;
}

async function canonicalFileUrl(url: string): Promise<string> {
  if (!url.startsWith("file:")) return url;
  try {
    return pathToFileURL(await realpath(fileURLToPath(url))).href;
  } catch {
    return url;
  }
}

async function readSourceMap(
  scriptUrl: string,
  sourceMapUrl: string,
): Promise<{ mappings: string; sources: string[] } | undefined> {
  try {
    let raw: string;
    let baseUrl = scriptUrl;
    if (sourceMapUrl.startsWith("data:")) {
      const comma = sourceMapUrl.indexOf(",");
      if (comma === -1) return undefined;
      const metadata = sourceMapUrl.slice(0, comma);
      const data = sourceMapUrl.slice(comma + 1);
      raw = metadata.includes(";base64")
        ? Buffer.from(data, "base64").toString("utf8")
        : decodeURIComponent(data);
    } else {
      baseUrl = new URL(sourceMapUrl, scriptUrl).href;
      if (!baseUrl.startsWith("file:")) return undefined;
      raw = await readFile(fileURLToPath(baseUrl), "utf8");
    }
    const parsed = JSON.parse(raw) as {
      mappings?: unknown;
      sourceRoot?: unknown;
      sources?: unknown;
    };
    if (typeof parsed.mappings !== "string" || !Array.isArray(parsed.sources)) return undefined;
    const sourceRoot = typeof parsed.sourceRoot === "string" ? parsed.sourceRoot : "";
    return {
      mappings: parsed.mappings,
      sources: parsed.sources.map((source) =>
        normalizeSourceMapUrl(baseUrl, sourceRoot, String(source)),
      ),
    };
  } catch {
    return undefined;
  }
}

function normalizeSourceMapUrl(baseUrl: string, sourceRoot: string, source: string): string {
  if (/^[a-z][a-z+.-]*:/iu.test(source)) return source;
  const rootedSource = sourceRoot === "" ? source : `${sourceRoot.replace(/\/$/u, "")}/${source}`;
  return new URL(rootedSource, baseUrl).href;
}

function findGeneratedLocations(
  mappings: string,
  targetSourceIndex: number,
  targetOriginalLine: number,
): readonly { columnNumber: number; lineNumber: number }[] {
  const locations: { columnNumber: number; lineNumber: number }[] = [];
  let sourceIndex = 0;
  let originalLine = 0;
  let originalColumn = 0;
  let nameIndex = 0;
  for (const [generatedLine, encodedLine] of mappings.split(";").entries()) {
    let generatedColumn = 0;
    for (const encodedSegment of encodedLine.split(",")) {
      if (encodedSegment === "") continue;
      const values = decodeVlq(encodedSegment);
      generatedColumn += values[0] ?? 0;
      if (values.length < 4) continue;
      sourceIndex += values[1]!;
      originalLine += values[2]!;
      originalColumn += values[3]!;
      if (values[4] !== undefined) nameIndex += values[4];
      if (sourceIndex === targetSourceIndex && originalLine === targetOriginalLine) {
        locations.push({ columnNumber: generatedColumn, lineNumber: generatedLine });
      }
    }
  }
  void originalColumn;
  void nameIndex;
  return locations;
}

function decodeVlq(value: string): number[] {
  const result: number[] = [];
  let current = 0;
  let shift = 0;
  for (const character of value) {
    const digit = BASE64_DIGITS.indexOf(character);
    if (digit === -1) throw new Error("Invalid source-map VLQ segment.");
    current += (digit & 31) << shift;
    if ((digit & 32) !== 0) {
      shift += 5;
      continue;
    }
    const negative = (current & 1) === 1;
    result.push((negative ? -1 : 1) * (current >> 1));
    current = 0;
    shift = 0;
  }
  return result;
}

const BASE64_DIGITS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function firstCallFrameId(paused: unknown): string {
  const callFrames =
    paused !== null &&
    typeof paused === "object" &&
    Array.isArray((paused as { callFrames?: unknown }).callFrames)
      ? (paused as { callFrames: unknown[] }).callFrames
      : [];
  const frame = callFrames[0];
  if (frame === null || typeof frame !== "object") throw new Error("Pause had no call frame.");
  const callFrameId = (frame as { callFrameId?: unknown }).callFrameId;
  if (typeof callFrameId !== "string") throw new Error("Pause call frame had no id.");
  return callFrameId;
}

function baseUrl(url: URL): string {
  return new URL("/", url).toString();
}

async function waitFor(assertion: () => Promise<void>, diagnostics: () => string): Promise<void> {
  await waitForValue(async () => {
    try {
      await assertion();
      return true;
    } catch {
      return undefined;
    }
  }, diagnostics);
}

async function waitForValue<T>(
  read: () => Promise<T | undefined>,
  diagnostics: () => string,
): Promise<T> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for DevTools scenario state.\n${diagnostics()}`);
}
