import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createDevToolsEventHub } from "#internal/devtools/event-hub.js";
import { createDevToolsLogsDomain } from "#internal/devtools/domains/logs/logs-domain.js";
import { createDevToolsRuntimeDomain } from "#internal/devtools/domains/runtime/runtime-domain.js";
import type { DevToolsRuntimeState } from "#internal/devtools/host/types.js";
import { createDevToolsDebuggerDomain } from "./debugger-domain.js";

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  connect: vi.fn(),
  handleUpgrade: vi.fn(),
  hooks: undefined as
    | undefined
    | {
        onClose(): void;
        onMessage(message: string): void;
        onOpen(): void;
      },
  send: vi.fn(),
}));

vi.mock("#internal/devtools/debugger-relay.js", () => ({
  DEBUGGER_TICKET_TTL_MS: 30_000,
  connectInspectorWebSocket: mocks.connect,
  handleDebuggerUpgrade: mocks.handleUpgrade,
}));

describe("createDevToolsDebuggerDomain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hooks = undefined;
    mocks.connect.mockImplementation((_url, hooks) => {
      mocks.hooks = hooks;
      return { close: mocks.close, send: mocks.send };
    });
    mocks.handleUpgrade.mockImplementation((input) => {
      input.setDebuggerOwned(true);
      return true;
    });
  });

  it("observes scripts, console records, exceptions, and pause state", () => {
    let state: DevToolsRuntimeState = {
      inspectorUrl: "ws://127.0.0.1:9229/session",
      runtimeInstanceId: "runtime-1",
      status: "ready",
    };
    const eventHub = createDevToolsEventHub({ replayLimit: 30 });
    const logs = createDevToolsLogsDomain({ eventHub });
    const runtime = createDevToolsRuntimeDomain({
      eventHub,
      getState: () => state,
      updateState: (patch) => {
        state = { ...state, ...patch };
      },
    });
    const recordScript = vi.fn();
    const originalLocation = vi.fn((location) =>
      location.scriptId === "generated-tool"
        ? { column: 7, line: 12, sourceId: "agent/tools/dynamic-echo.ts" }
        : undefined,
    );
    const domain = createDevToolsDebuggerDomain({
      eventHub,
      logs,
      runtime,
      sources: {
        get: vi.fn(),
        list: vi.fn(),
        locations: vi.fn(),
        originalLocation,
        recordScript,
      },
    });

    domain.syncInspector();
    expect(mocks.connect).toHaveBeenCalledWith(state.inspectorUrl, expect.any(Object));
    mocks.hooks?.onOpen();
    expect(mocks.send).toHaveBeenCalledWith(
      JSON.stringify({ id: 1_000_000_001, method: "Runtime.enable" }),
    );
    expect(mocks.send).toHaveBeenCalledWith(
      JSON.stringify({ id: 1_000_000_002, method: "Debugger.enable" }),
    );
    expect(domain.snapshot()).toMatchObject({ connected: true });

    mocks.hooks?.onMessage(
      JSON.stringify({
        method: "Debugger.scriptParsed",
        params: { scriptId: "script-1", sourceMapURL: "tool.ts.map", url: "file:///app/tool.ts" },
      }),
    );
    expect(recordScript).toHaveBeenCalledWith({
      revision: undefined,
      scriptId: "script-1",
      sourceMapUrl: "tool.ts.map",
      url: "file:///app/tool.ts",
    });

    mocks.hooks?.onMessage(
      JSON.stringify({
        method: "Runtime.consoleAPICalled",
        params: {
          args: [
            { type: "string", value: "hello" },
            { type: "number", value: 42 },
          ],
          stackTrace: {
            callFrames: [
              {
                columnNumber: 1,
                lineNumber: 20,
                scriptId: "runtime-wrapper",
                url: "file:///app/runtime-child.js",
              },
              {
                columnNumber: 2,
                lineNumber: 4,
                scriptId: "generated-tool",
                url: "file:///app/.eve/compile/random.js",
              },
            ],
          },
          type: "warning",
        },
      }),
    );
    domain.correlateConsole({
      coordinates: { session: "session-1", turn: "turn-2" },
      fingerprint: '[["string","hello"],["number","42"]]',
      type: "warning",
    });
    mocks.hooks?.onMessage(
      JSON.stringify({
        method: "Runtime.exceptionThrown",
        params: { exceptionDetails: { text: "Uncaught failure" } },
      }),
    );
    expect(logs.list(0).entries).toMatchObject([
      {
        fields: { coordinates: { session: "session-1", turn: "turn-2" } },
        level: "warn",
        message: "hello 42",
        source: { column: 7, line: 12, path: "agent/tools/dynamic-echo.ts" },
        stream: "console",
      },
      { level: "error", message: "Uncaught failure", stream: "console" },
    ]);

    mocks.hooks?.onMessage(
      JSON.stringify({ method: "Debugger.paused", params: { reason: "breakpoint" } }),
    );
    expect(state.status).toBe("paused");
    expect(domain.snapshot()).toMatchObject({ pause: { reason: "breakpoint" } });
    mocks.hooks?.onMessage(JSON.stringify({ method: "Debugger.resumed", params: {} }));
    expect(state.status).toBe("ready");
    expect(domain.snapshot().pause).toBeUndefined();
  });

  it("reconnects its observer and tracks the single controller lease", () => {
    let state: DevToolsRuntimeState = {
      inspectorUrl: "ws://127.0.0.1:9229/session",
      runtimeInstanceId: "runtime-1",
      status: "ready",
    };
    const eventHub = createDevToolsEventHub({ replayLimit: 10 });
    const runtime = createDevToolsRuntimeDomain({
      eventHub,
      getState: () => state,
      updateState: (patch) => {
        state = { ...state, ...patch };
      },
    });
    const domain = createDevToolsDebuggerDomain({
      eventHub,
      logs: createDevToolsLogsDomain({ eventHub }),
      runtime,
      sources: {
        get: vi.fn(),
        list: vi.fn(),
        locations: vi.fn(),
        originalLocation: vi.fn(),
        recordScript: vi.fn(),
      },
    });

    domain.syncInspector();
    const firstHooks = mocks.hooks;
    firstHooks?.onClose();
    domain.syncInspector();
    expect(mocks.connect).toHaveBeenCalledTimes(2);

    const socket = new EventEmitter() as Duplex;
    socket.destroy = vi.fn(() => socket);
    expect(domain.handleUpgrade({} as IncomingMessage, socket, 43_123)).toBe(true);
    expect(domain.snapshot().controllerAttached).toBe(true);

    state = { ...state, inspectorUrl: undefined };
    domain.syncInspector();
    domain.close();
    expect(mocks.close).toHaveBeenCalled();
    expect(socket.destroy).toHaveBeenCalled();
  });
});
