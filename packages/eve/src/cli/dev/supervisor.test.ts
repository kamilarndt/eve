import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  acquireDevelopmentServerLease: vi.fn(),
  child: undefined as ChildProcess | undefined,
  hostAppendLog: vi.fn(),
  hostAppendObservation: vi.fn(),
  hostClose: vi.fn(),
  hostSyncRuntimeState: vi.fn(),
  hostWriteDiscovery: vi.fn(),
  releaseDevelopmentLease: vi.fn(),
  spawn: vi.fn(),
  startDevToolsHost: vi.fn(),
  writeDevelopmentServerMetadata: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: mocks.spawn,
  };
});

vi.mock("#internal/application/package.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#internal/application/package.js")>();
  return {
    ...actual,
    resolvePackageRoot: () => "/tmp/eve-package",
  };
});

vi.mock("#internal/devtools/host.js", () => ({
  startDevToolsHost: mocks.startDevToolsHost,
}));

vi.mock("#internal/nitro/host/start-development-server.js", () => ({
  acquireDevelopmentServerLease: mocks.acquireDevelopmentServerLease,
  writeDevelopmentServerMetadata: mocks.writeDevelopmentServerMetadata,
}));

describe("startDevToolsSupervisor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    mocks.acquireDevelopmentServerLease.mockResolvedValue(mocks.releaseDevelopmentLease);
    mocks.hostClose.mockResolvedValue(undefined);
    mocks.hostSyncRuntimeState.mockResolvedValue(undefined);
    mocks.hostWriteDiscovery.mockResolvedValue(undefined);
    mocks.releaseDevelopmentLease.mockResolvedValue(undefined);
    mocks.writeDevelopmentServerMetadata.mockResolvedValue(undefined);
    mocks.startDevToolsHost.mockResolvedValue({
      appendLog: mocks.hostAppendLog,
      appendObservation: mocks.hostAppendObservation,
      browserCapability: "browser-token",
      browserUrl: "http://127.0.0.1:43123/#token=browser-token",
      close: mocks.hostClose,
      syncRuntimeState: mocks.hostSyncRuntimeState,
      url: "http://127.0.0.1:43123/",
      writeDiscovery: mocks.hostWriteDiscovery,
    });
    mocks.child = new EventEmitter() as ChildProcess;
    Object.assign(mocks.child, {
      exitCode: null,
      kill: vi.fn(),
      pid: 12345,
      signalCode: null,
      send: vi.fn((_message: unknown, callback?: (error: Error | null) => void) => {
        callback?.(null);
        return true;
      }),
      stderr: new EventEmitter(),
      stdout: new EventEmitter(),
    });
    Object.assign(mocks.child, {
      stdio: [null, mocks.child.stdout, mocks.child.stderr, new EventEmitter(), null],
    });
    mocks.spawn.mockReturnValue(mocks.child);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("spawns a runtime child and resolves when the child reports ready", async () => {
    const { startDevToolsSupervisor } = await import("./supervisor.js");

    const pending = startDevToolsSupervisor("/tmp/app", {
      host: "127.0.0.1",
      inspector: { host: "127.0.0.1", mode: "inspect", port: 0 },
      port: 0,
    });
    await waitForSupervisorSpawn();

    expect(mocks.acquireDevelopmentServerLease).toHaveBeenCalledWith("/tmp/app");
    expect(mocks.startDevToolsHost).toHaveBeenCalledWith(
      expect.objectContaining({
        appRoot: "/tmp/app",
        getRuntimeState: expect.any(Function),
        updateRuntimeState: expect.any(Function),
      }),
    );
    expect(mocks.spawn).toHaveBeenCalledWith(
      process.execPath,
      ["/tmp/eve-package/bin/eve.js", "__devtools-runtime-child"],
      expect.objectContaining({
        cwd: "/tmp/app",
        stdio: ["ignore", "pipe", "pipe", "pipe", "ipc"],
      }),
    );
    const spawnOptions = mocks.spawn.mock.calls[0]?.[2] as { env?: NodeJS.ProcessEnv } | undefined;
    const childConfig = JSON.parse(
      spawnOptions?.env?.EVE_DEVTOOLS_RUNTIME_CHILD_CONFIG ?? "{}",
    ) as { runtimeInstanceId: string };

    mocks.child!.emit("message", {
      data: {
        url: "ws://127.0.0.1:49111/session",
      },
      runtimeInstanceId: childConfig.runtimeInstanceId,
      type: "inspector.opened",
      version: 1,
    });
    mocks.child!.emit("message", {
      data: {
        pid: 12345,
        revision: "rev-1",
        url: "http://127.0.0.1:42001/",
      },
      runtimeInstanceId: childConfig.runtimeInstanceId,
      type: "runtime.ready",
      version: 1,
    });

    const handle = await pending;

    expect(handle.url).toBe("http://127.0.0.1:42001/");
    expect(handle.devtoolsUrl).toBe("http://127.0.0.1:43123/#token=browser-token");
    expect(handle.runtimePid).toBe(12345);
    expect(handle.inspectorUrl).toBe("ws://127.0.0.1:49111/session");
    expect(mocks.hostSyncRuntimeState).toHaveBeenCalledTimes(2);
    expect(mocks.writeDevelopmentServerMetadata).toHaveBeenCalledWith(
      "/tmp/app",
      "http://127.0.0.1:42001/",
      expect.objectContaining({ devtoolsUrl: "http://127.0.0.1:43123/" }),
    );

    const closed = handle.close();
    expect(mocks.child!.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: "runtime.shutdown", version: 1 }),
      expect.any(Function),
    );
    await Promise.resolve();
    mocks.child!.emit("exit", 0, null);
    await closed;
    expect(mocks.hostClose).toHaveBeenCalledTimes(1);
    expect(mocks.releaseDevelopmentLease).toHaveBeenCalledTimes(1);
  });

  it("spawns only the runtime child with the network inspection Node flag", async () => {
    const { startDevToolsSupervisor } = await import("./supervisor.js");

    const pending = startDevToolsSupervisor("/tmp/app", { inspectNetwork: true });
    await waitForSupervisorSpawn();

    expect(mocks.spawn).toHaveBeenCalledWith(
      process.execPath,
      [
        "--experimental-network-inspection",
        "/tmp/eve-package/bin/eve.js",
        "__devtools-runtime-child",
      ],
      expect.any(Object),
    );

    const spawnOptions = mocks.spawn.mock.calls[0]?.[2] as { env?: NodeJS.ProcessEnv } | undefined;
    const childConfig = JSON.parse(
      spawnOptions?.env?.EVE_DEVTOOLS_RUNTIME_CHILD_CONFIG ?? "{}",
    ) as { runtimeInstanceId: string };
    mocks.child!.emit("message", {
      data: {
        pid: 12345,
        url: "http://127.0.0.1:42001/",
      },
      runtimeInstanceId: childConfig.runtimeInstanceId,
      type: "runtime.ready",
      version: 1,
    });
    await pending;
  });

  it("updates discovery while a pausing inspector waits before runtime readiness", async () => {
    const { startDevToolsSupervisor } = await import("./supervisor.js");

    const pending = startDevToolsSupervisor("/tmp/app", {
      inspector: { host: "127.0.0.1", mode: "inspect-brk", port: 0 },
    });
    await waitForSupervisorSpawn();
    const spawnOptions = mocks.spawn.mock.calls[0]?.[2] as { env?: NodeJS.ProcessEnv } | undefined;
    const childConfig = JSON.parse(
      spawnOptions?.env?.EVE_DEVTOOLS_RUNTIME_CHILD_CONFIG ?? "{}",
    ) as { runtimeInstanceId: string };
    const hostInput = mocks.startDevToolsHost.mock.calls[0]?.[0] as
      | { getRuntimeState?: () => { inspectorUrl?: string; status: string } }
      | undefined;

    mocks.child!.emit("message", {
      data: {
        url: "ws://127.0.0.1:49111/session",
      },
      runtimeInstanceId: childConfig.runtimeInstanceId,
      type: "inspector.opened",
      version: 1,
    });
    await Promise.resolve();

    expect(hostInput?.getRuntimeState?.()).toMatchObject({
      inspectorUrl: "ws://127.0.0.1:49111/session",
      status: "paused",
    });
    expect(mocks.hostSyncRuntimeState).toHaveBeenCalledTimes(1);

    mocks.child!.emit("message", {
      data: {
        pid: 12345,
        url: "http://127.0.0.1:42001/",
      },
      runtimeInstanceId: childConfig.runtimeInstanceId,
      type: "runtime.ready",
      version: 1,
    });
    await pending;
  });

  it("captures runtime child logs and keeps host state after a ready child crashes", async () => {
    const { startDevToolsSupervisor } = await import("./supervisor.js");

    const pending = startDevToolsSupervisor("/tmp/app");
    await waitForSupervisorSpawn();
    const spawnOptions = mocks.spawn.mock.calls[0]?.[2] as { env?: NodeJS.ProcessEnv } | undefined;
    const childConfig = JSON.parse(
      spawnOptions?.env?.EVE_DEVTOOLS_RUNTIME_CHILD_CONFIG ?? "{}",
    ) as { runtimeInstanceId: string };
    const hostInput = mocks.startDevToolsHost.mock.calls[0]?.[0] as
      | { getRuntimeState?: () => { inspectorUrl?: string; status: string } }
      | undefined;

    mocks.child!.stdout!.emit("data", Buffer.from("booting\nready"));
    mocks.child!.stderr!.emit("data", Buffer.from("Debugger listen"));
    mocks.child!.stderr!.emit(
      "data",
      Buffer.from(
        [
          "ing on ws://127.0.0.1:49111/session",
          "For help, see: https://nodejs.org/en/docs/inspector",
          "Debugger attached.",
          "warning",
          "",
        ].join("\n"),
      ),
    );
    mocks.child!.emit("message", {
      data: { url: "ws://127.0.0.1:49111/session" },
      runtimeInstanceId: childConfig.runtimeInstanceId,
      type: "inspector.opened",
      version: 1,
    });
    mocks.child!.emit("message", {
      data: {
        pid: 12345,
        url: "http://127.0.0.1:42001/",
      },
      runtimeInstanceId: childConfig.runtimeInstanceId,
      type: "runtime.ready",
      version: 1,
    });

    await pending;
    expect(hostInput?.getRuntimeState?.().status).toBe("ready");
    expect(mocks.hostAppendLog).toHaveBeenCalledWith({
      message: "booting",
      stream: "stdout",
    });
    expect(mocks.hostAppendLog).toHaveBeenCalledWith({
      message: "warning",
      stream: "stderr",
    });
    expect(mocks.hostAppendLog).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("Debugger") }),
    );
    expect(process.stderr.write).toHaveBeenCalledTimes(1);
    expect(process.stderr.write).toHaveBeenCalledWith("warning\n");

    mocks.child!.stderr!.emit("data", Buffer.from("Waiting for the debugger to disconnect..."));
    mocks.child!.emit("exit", 1, null);
    await Promise.resolve();

    expect(mocks.hostAppendLog).toHaveBeenCalledWith({
      message: "ready",
      stream: "stdout",
    });
    expect(mocks.hostAppendLog).toHaveBeenCalledWith({
      message: "Runtime child exited (code 1, signal null).",
      stream: "system",
    });
    expect(process.stderr.write).toHaveBeenCalledTimes(1);
    expect(hostInput?.getRuntimeState?.().status).toBe("crashed");
    expect(hostInput?.getRuntimeState?.().inspectorUrl).toBeUndefined();
    expect(mocks.hostSyncRuntimeState).toHaveBeenCalledTimes(3);
  });

  it("forwards valid runtime observations and drops malformed records", async () => {
    const { startDevToolsSupervisor } = await import("./supervisor.js");

    const pending = startDevToolsSupervisor("/tmp/app");
    await waitForSupervisorSpawn();
    const spawnOptions = mocks.spawn.mock.calls[0]?.[2] as { env?: NodeJS.ProcessEnv } | undefined;
    const childConfig = JSON.parse(
      spawnOptions?.env?.EVE_DEVTOOLS_RUNTIME_CHILD_CONFIG ?? "{}",
    ) as { runtimeInstanceId: string };
    const observationStream = mocks.child!.stdio[3] as EventEmitter;

    observationStream.emit(
      "data",
      `${JSON.stringify({
        at: "2026-06-20T00:00:00.000Z",
        data: { ok: true },
        recordId: "record-1",
        runtimeInstanceId: childConfig.runtimeInstanceId,
        schemaVersion: 1,
        sequence: 0,
        type: "runtime.child.started",
      })}\n`,
    );
    observationStream.emit("data", "not-json\n");
    observationStream.emit(
      "data",
      `${JSON.stringify({
        at: "2026-06-20T00:00:00.000Z",
        data: { ok: false },
        recordId: "record-2",
        runtimeInstanceId: "other-runtime",
        schemaVersion: 1,
        sequence: 1,
        type: "runtime.child.started",
      })}\n`,
    );

    expect(mocks.hostAppendObservation).toHaveBeenCalledTimes(1);
    expect(mocks.hostAppendObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { ok: true },
        runtimeInstanceId: childConfig.runtimeInstanceId,
        type: "runtime.child.started",
      }),
    );
    expect(mocks.hostAppendLog).toHaveBeenCalledWith({
      message: "Dropped malformed DevTools observation record.",
      stream: "system",
    });

    mocks.child!.emit("message", {
      data: {
        pid: 12345,
        url: "http://127.0.0.1:42001/",
      },
      runtimeInstanceId: childConfig.runtimeInstanceId,
      type: "runtime.ready",
      version: 1,
    });
    await pending;
  });

  it("rejects if the runtime child exits before readiness", async () => {
    const { startDevToolsSupervisor } = await import("./supervisor.js");

    const pending = startDevToolsSupervisor("/tmp/app");
    await waitForSupervisorSpawn();
    mocks.child!.emit("exit", 1, null);

    await expect(pending).rejects.toThrow("runtime child exited before it was ready");
  });

  it("ignores malformed protocol versions and rejects explicit startup failure", async () => {
    const { startDevToolsSupervisor } = await import("./supervisor.js");

    const pending = startDevToolsSupervisor("/tmp/app");
    await waitForSupervisorSpawn();
    const spawnOptions = mocks.spawn.mock.calls[0]?.[2] as { env?: NodeJS.ProcessEnv } | undefined;
    const childConfig = JSON.parse(
      spawnOptions?.env?.EVE_DEVTOOLS_RUNTIME_CHILD_CONFIG ?? "{}",
    ) as { runtimeInstanceId: string };

    mocks.child!.emit("message", {
      data: {
        pid: 12345,
        url: "http://127.0.0.1:42001/",
      },
      runtimeInstanceId: childConfig.runtimeInstanceId,
      type: "runtime.ready",
      version: 999,
    });
    mocks.child!.emit("message", {
      data: {
        message: "compile failed",
      },
      runtimeInstanceId: childConfig.runtimeInstanceId,
      type: "runtime.startup-failed",
      version: 1,
    });

    await expect(pending).rejects.toThrow("compile failed");
    expect(mocks.hostClose).toHaveBeenCalledTimes(1);
  });
});

async function waitForSupervisorSpawn(): Promise<void> {
  await vi.waitFor(() => {
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });
}
