import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

import { DevelopmentServerState } from "#internal/nitro/host/dev-server-state.js";

import {
  EVE_BASE_URL_ENV,
  resolveSharedDevelopmentServer,
} from "./resolve-shared-development-server.js";

const temporaryRoots: string[] = [];

interface MockChildProcess extends EventEmitter {
  stderr: EventEmitter;
  stdout: EventEmitter;
  killed: boolean;
  pid: number;
  kill(signal?: NodeJS.Signals | number): boolean;
}

function createMockChildProcess(pid: number): MockChildProcess {
  const child = new EventEmitter() as MockChildProcess;
  child.stderr = new EventEmitter();
  child.stdout = new EventEmitter();
  child.killed = false;
  child.pid = pid;
  child.kill = () => {
    if (child.killed) return true;
    child.killed = true;
    child.emit("exit", null, "SIGTERM");
    return true;
  };
  return child;
}

async function createTempAppRoot(): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "eve-shared-dev-server-"));
  temporaryRoots.push(appRoot);
  await writeFile(join(appRoot, "instructions.md"), "You are a test agent.\n");
  return appRoot;
}

async function writeServerUrl(appRoot: string, origin: string): Promise<void> {
  await new DevelopmentServerState({ appRoot }).write(origin);
}

afterEach(async () => {
  spawnMock.mockReset();
  vi.unstubAllGlobals();
  delete process.env[EVE_BASE_URL_ENV];
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("resolveSharedDevelopmentServer", () => {
  it("returns a healthy URL already recorded for the app root", async () => {
    const appRoot = await createTempAppRoot();
    await writeServerUrl(appRoot, "http://127.0.0.1:49152");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200 })),
    );

    await expect(resolveSharedDevelopmentServer({ appRoot, timeoutMs: 2_000 })).resolves.toEqual({
      origin: "http://127.0.0.1:49152",
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("does not probe a non-loopback URL from the state record", async () => {
    const appRoot = await createTempAppRoot();
    await writeServerUrl(appRoot, "http://192.168.1.20:49152");
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(resolveSharedDevelopmentServer({ appRoot, timeoutMs: 2_000 })).rejects.toThrow(
      /published a non-loopback URL/u,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("starts a child after a stale record and returns its published URL", async () => {
    const appRoot = await createTempAppRoot();
    await writeServerUrl(appRoot, "http://127.0.0.1:49152");
    const child = createMockChildProcess(2_147_483_646);
    spawnMock.mockReturnValue(child);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (url: string) => new Response(null, { status: url.includes("49153") ? 200 : 503 }),
      ),
    );

    const resolution = resolveSharedDevelopmentServer({ appRoot, timeoutMs: 2_000 });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce());
    await writeServerUrl(appRoot, "http://127.0.0.1:49153");

    const handle = await resolution;
    expect(handle).toEqual({
      close: expect.any(Function),
      origin: "http://127.0.0.1:49153",
      process: child,
    });
    await handle.close?.();
  });

  it("reports a child that exits before a usable URL is recorded", async () => {
    const appRoot = await createTempAppRoot();
    const child = createMockChildProcess(2_147_483_646);
    spawnMock.mockReturnValue(child);

    const resolution = resolveSharedDevelopmentServer({ appRoot, timeoutMs: 2_000 });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce());
    child.emit("exit", 1, null);

    await expect(resolution).rejects.toThrow(
      /failed before publishing a healthy URL \(exit code 1/u,
    );
  });

  it("keeps independent app roots on their own recorded URLs", async () => {
    const firstAppRoot = await createTempAppRoot();
    const secondAppRoot = await createTempAppRoot();
    await writeServerUrl(firstAppRoot, "http://127.0.0.1:49152");
    await writeServerUrl(secondAppRoot, "http://127.0.0.1:49153");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200 })),
    );

    await expect(
      resolveSharedDevelopmentServer({ appRoot: firstAppRoot, timeoutMs: 2_000 }),
    ).resolves.toEqual({ origin: "http://127.0.0.1:49152" });
    await expect(
      resolveSharedDevelopmentServer({ appRoot: secondAppRoot, timeoutMs: 2_000 }),
    ).resolves.toEqual({ origin: "http://127.0.0.1:49153" });
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
