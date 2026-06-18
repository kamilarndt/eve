import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DevInspectorRequest } from "#cli/dev/inspector.js";

const mocks = vi.hoisted(() => ({
  inspectorClose: vi.fn(),
  observationStreamOnce: vi.fn(),
  observationStreamWrite: vi.fn(),
  observationWrites: [] as string[],
  openDevInspector: vi.fn(),
  serverClose: vi.fn(),
  startDevelopmentServer: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    createWriteStream: vi.fn(() => ({
      destroyed: false,
      once: mocks.observationStreamOnce,
      write: mocks.observationStreamWrite,
    })),
  };
});

vi.mock("#cli/dev/inspector.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#cli/dev/inspector.js")>();
  return {
    ...actual,
    openDevInspector: mocks.openDevInspector,
  };
});

vi.mock("#internal/nitro/host.js", () => ({
  startDevelopmentServer: mocks.startDevelopmentServer,
}));

const originalEnv = process.env.EVE_DEVTOOLS_RUNTIME_CHILD_CONFIG;
const originalSend = process.send;

describe("runDevToolsRuntimeChildFromEnvironment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.observationWrites.length = 0;
    mocks.observationStreamOnce.mockReturnThis();
    mocks.observationStreamWrite.mockImplementation(
      (line: string, _encoding: string, callback?: (error?: Error | null) => void) => {
        mocks.observationWrites.push(line);
        callback?.(null);
        return true;
      },
    );
    mocks.serverClose.mockResolvedValue(undefined);
    mocks.openDevInspector.mockResolvedValue({
      close: mocks.inspectorClose,
      mode: "inspect",
      url: "ws://127.0.0.1:49111/session",
      waitForDebugger: vi.fn(),
    });
    mocks.startDevelopmentServer.mockResolvedValue({
      close: mocks.serverClose,
      url: "http://127.0.0.1:42001/",
    });
    Object.defineProperty(process, "send", {
      configurable: true,
      value: vi.fn(),
    });
    process.env.EVE_DEVTOOLS_RUNTIME_CHILD_CONFIG = JSON.stringify({
      appRoot: "/tmp/app",
      host: "127.0.0.1",
      port: 0,
      runtimeInstanceId: "runtime-1",
    });
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.EVE_DEVTOOLS_RUNTIME_CHILD_CONFIG;
    } else {
      process.env.EVE_DEVTOOLS_RUNTIME_CHILD_CONFIG = originalEnv;
    }
    Object.defineProperty(process, "send", {
      configurable: true,
      value: originalSend,
    });
  });

  it("opens the inspector, starts the self-runner dev server, and stops on shutdown", async () => {
    const { runDevToolsRuntimeChildFromEnvironment } = await import("./runtime-child.js");

    const running = runDevToolsRuntimeChildFromEnvironment();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.openDevInspector).toHaveBeenCalledWith({
      host: "127.0.0.1",
      mode: "inspect",
      port: 0,
    } satisfies DevInspectorRequest);
    expect(mocks.startDevelopmentServer).toHaveBeenCalledWith(
      "/tmp/app",
      expect.objectContaining({
        developmentLease: "external",
        host: "127.0.0.1",
        port: 0,
        runtimeDebugging: true,
        writeDevelopmentServerMetadata: false,
      }),
    );
    expect(process.send).toHaveBeenCalledWith({
      data: {
        url: "ws://127.0.0.1:49111/session",
      },
      runtimeInstanceId: "runtime-1",
      type: "inspector.opened",
      version: 1,
    });
    expect(process.send).toHaveBeenCalledWith({
      data: {
        pid: process.pid,
        revision: "/tmp/app",
        url: "http://127.0.0.1:42001/",
      },
      runtimeInstanceId: "runtime-1",
      type: "runtime.ready",
      version: 1,
    });

    await vi.waitFor(() => {
      expect(mocks.observationWrites.length).toBeGreaterThanOrEqual(3);
    });
    const observationTypes = mocks.observationWrites.map((line) => JSON.parse(line).type);
    expect(observationTypes).toContain("runtime.child.started");
    expect(observationTypes).toContain("runtime.inspector.opened");
    expect(observationTypes).toContain("runtime.server.ready");

    process.emit("message", {
      data: {},
      runtimeInstanceId: "runtime-1",
      type: "runtime.shutdown",
      version: 1,
    });

    await running;

    expect(mocks.serverClose).toHaveBeenCalledTimes(1);
    expect(mocks.inspectorClose).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(mocks.observationWrites.map((line) => JSON.parse(line).type)).toContain(
        "runtime.child.stopped",
      );
    });
  });

  it("reports startup failures through the versioned control protocol", async () => {
    mocks.startDevelopmentServer.mockRejectedValueOnce(new Error("dev server failed"));
    const { runDevToolsRuntimeChildFromEnvironment } = await import("./runtime-child.js");

    await expect(runDevToolsRuntimeChildFromEnvironment()).rejects.toThrow("dev server failed");

    expect(process.send).toHaveBeenCalledWith({
      data: {
        message: "dev server failed",
      },
      runtimeInstanceId: "runtime-1",
      type: "runtime.startup-failed",
      version: 1,
    });
    expect(mocks.inspectorClose).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(mocks.observationWrites.map((line) => JSON.parse(line).type)).toContain(
        "runtime.startup_failed",
      );
    });
  });

  it("stops the runtime when its supervisor disconnects", async () => {
    const { runDevToolsRuntimeChildFromEnvironment } = await import("./runtime-child.js");

    const running = runDevToolsRuntimeChildFromEnvironment();
    await vi.waitFor(() => {
      expect(process.send).toHaveBeenCalledWith(expect.objectContaining({ type: "runtime.ready" }));
    });

    process.emit("disconnect");
    await running;

    expect(mocks.serverClose).toHaveBeenCalledTimes(1);
    expect(mocks.inspectorClose).toHaveBeenCalledTimes(1);
  });
});
