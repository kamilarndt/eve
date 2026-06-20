import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EVE_LOCAL_DEV_AUTH_DIRECTORY_ENV,
  EVE_LOCAL_DEV_AUTH_INSTANCE_ID_ENV,
} from "#protocol/local-dev-auth.js";
import type { Result } from "#shared/result.js";

import {
  LocalDevelopmentAuthServer,
  type LocalDevelopmentAuthServerHandle,
} from "./local-development-auth.js";

const temporaryDirectories: string[] = [];
const serverHandles: LocalDevelopmentAuthServerHandle[] = [];
const originalDirectory = process.env[EVE_LOCAL_DEV_AUTH_DIRECTORY_ENV];
const originalInstanceId = process.env[EVE_LOCAL_DEV_AUTH_INSTANCE_ID_ENV];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(serverHandles.splice(0).map((server) => server.dispose().catch(() => {})));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
  restoreEnvironmentValue(EVE_LOCAL_DEV_AUTH_DIRECTORY_ENV, originalDirectory);
  restoreEnvironmentValue(EVE_LOCAL_DEV_AUTH_INSTANCE_ID_ENV, originalInstanceId);
});

describe("LocalDevelopmentAuthServer", () => {
  it("resolves an immutable TUI grant through worker-facing server coordinates", async () => {
    const appRoot = await createTemporaryDirectory();
    const handle = await startServer(appRoot);
    const writer = LocalDevelopmentAuthServer.writer({
      appRoot,
      metadata: handle.metadata,
    });
    const reader = LocalDevelopmentAuthServer.readerFromEnvironment();
    if (reader === undefined) throw new Error("Expected active local auth registry metadata.");
    const grant = resultValue(await writer.create({ userId: "vercel-user-123" }));

    await expect(reader.read(grant.token)).resolves.toEqual({
      ok: true,
      value: {
        authenticator: "vercel-cli",
        id: "vercel-user-123",
        type: "user",
      },
    });

    await grant.dispose();
    await expect(reader.read(grant.token)).resolves.toEqual({ ok: true, value: undefined });
  });

  it("rejects forged credentials and grants from another server instance", async () => {
    const appRoot = await createTemporaryDirectory();
    const firstHandle = await startServer(appRoot);
    const firstWriter = LocalDevelopmentAuthServer.writer({
      appRoot,
      metadata: firstHandle.metadata,
    });
    const firstReader = LocalDevelopmentAuthServer.reader({
      appRoot,
      metadata: firstHandle.metadata,
    });
    const firstGrant = resultValue(await firstWriter.create({ userId: "vercel-user-123" }));

    await expect(firstReader.read("forged-credential")).resolves.toEqual({
      ok: true,
      value: undefined,
    });

    await firstHandle.dispose();
    const secondHandle = await startServer(appRoot);
    const secondReader = LocalDevelopmentAuthServer.reader({
      appRoot,
      metadata: secondHandle.metadata,
    });
    await expect(secondReader.read(firstGrant.token)).resolves.toEqual({
      ok: true,
      value: undefined,
    });
  });

  it("revokes one TUI without changing another TUI's principal", async () => {
    const appRoot = await createTemporaryDirectory();
    const handle = await startServer(appRoot);
    const writer = LocalDevelopmentAuthServer.writer({
      appRoot,
      metadata: handle.metadata,
    });
    const reader = LocalDevelopmentAuthServer.reader({
      appRoot,
      metadata: handle.metadata,
    });
    const firstGrant = resultValue(await writer.create({ userId: "vercel-user-a" }));
    const secondGrant = resultValue(await writer.create({ userId: "vercel-user-b" }));

    await firstGrant.dispose();

    await expect(reader.read(firstGrant.token)).resolves.toEqual({ ok: true, value: undefined });
    await expect(reader.read(secondGrant.token)).resolves.toMatchObject({
      ok: true,
      value: { id: "vercel-user-b" },
    });
    await secondGrant.dispose();
  });

  it("keeps independently started registries isolated in one process", async () => {
    const firstAppRoot = await createTemporaryDirectory();
    const secondAppRoot = await createTemporaryDirectory();
    const firstHandle = await startServer(firstAppRoot);
    const secondHandle = await startServer(secondAppRoot);
    const firstWriter = LocalDevelopmentAuthServer.writer({
      appRoot: firstAppRoot,
      metadata: firstHandle.metadata,
    });
    const firstReader = LocalDevelopmentAuthServer.reader({
      appRoot: firstAppRoot,
      metadata: firstHandle.metadata,
    });
    const secondWriter = LocalDevelopmentAuthServer.writer({
      appRoot: secondAppRoot,
      metadata: secondHandle.metadata,
    });
    const secondReader = LocalDevelopmentAuthServer.reader({
      appRoot: secondAppRoot,
      metadata: secondHandle.metadata,
    });
    const firstGrant = resultValue(await firstWriter.create({ userId: "vercel-user-a" }));
    const secondGrant = resultValue(await secondWriter.create({ userId: "vercel-user-b" }));

    await expect(firstReader.read(firstGrant.token)).resolves.toMatchObject({
      ok: true,
      value: { id: "vercel-user-a" },
    });
    await expect(firstReader.read(secondGrant.token)).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    await expect(secondReader.read(secondGrant.token)).resolves.toMatchObject({
      ok: true,
      value: { id: "vercel-user-b" },
    });

    expect(process.env[EVE_LOCAL_DEV_AUTH_INSTANCE_ID_ENV]).toBe(
      secondHandle.metadata.serverInstanceId,
    );
    await firstHandle.dispose();
    expect(process.env[EVE_LOCAL_DEV_AUTH_INSTANCE_ID_ENV]).toBe(
      secondHandle.metadata.serverInstanceId,
    );
    await secondHandle.dispose();
    expect(process.env[EVE_LOCAL_DEV_AUTH_INSTANCE_ID_ENV]).toBe(originalInstanceId);
    expect(process.env[EVE_LOCAL_DEV_AUTH_DIRECTORY_ENV]).toBe(originalDirectory);
  });

  it("rejects and removes a grant after its issuing TUI process exits", async () => {
    const appRoot = await createTemporaryDirectory();
    const handle = await startServer(appRoot);
    const writer = LocalDevelopmentAuthServer.writer({
      appRoot,
      metadata: handle.metadata,
    });
    const reader = LocalDevelopmentAuthServer.reader({
      appRoot,
      metadata: handle.metadata,
    });
    const grant = resultValue(await writer.create({ userId: "vercel-user-123" }));
    const kill = vi.spyOn(process, "kill").mockImplementation((processId) => {
      if (processId === process.pid) {
        throw Object.assign(new Error("process not found"), { code: "ESRCH" });
      }
      return true;
    });

    await expect(reader.read(grant.token)).resolves.toEqual({ ok: true, value: undefined });

    kill.mockRestore();
    await expect(reader.read(grant.token)).resolves.toEqual({ ok: true, value: undefined });
  });

  it("returns an error for an invalid user id", async () => {
    const appRoot = await createTemporaryDirectory();
    const handle = await startServer(appRoot);
    const writer = LocalDevelopmentAuthServer.writer({
      appRoot,
      metadata: handle.metadata,
    });

    await expect(writer.create({ userId: " " })).resolves.toEqual({
      ok: false,
      error: { kind: "invalid-user-id" },
    });
  });

  it("removes grants only after their owner process exits", async () => {
    const appRoot = await createTemporaryDirectory();
    const registryRoot = join(appRoot, ".eve", "dev-auth");
    const abandonedInstanceId = "e".repeat(32);
    const abandonedDirectory = join(registryRoot, abandonedInstanceId);
    const abandonedGrantsDirectory = join(abandonedDirectory, "grants");
    const activeInstanceId = "f".repeat(32);
    const activeDirectory = join(registryRoot, activeInstanceId);
    const activeGrantsDirectory = join(activeDirectory, "grants");
    const abandonedProcessId = 987_654_321;
    vi.spyOn(process, "kill").mockImplementation((processId) => {
      if (processId === abandonedProcessId) {
        throw Object.assign(new Error("process not found"), { code: "ESRCH" });
      }
      return true;
    });

    await mkdir(abandonedGrantsDirectory, { recursive: true });
    await writeServerOwner(abandonedDirectory, abandonedInstanceId, abandonedProcessId);
    const abandonedGrant = join(abandonedGrantsDirectory, "stale.json");
    await writeFile(abandonedGrant, "{}\n", "utf8");
    await mkdir(activeGrantsDirectory, { recursive: true });
    await writeServerOwner(activeDirectory, activeInstanceId, process.pid);
    const activeGrant = join(activeGrantsDirectory, "active.json");
    await writeFile(activeGrant, "{}\n", "utf8");
    const unrelatedFile = join(registryRoot, "README");
    await writeFile(unrelatedFile, "reserved\n", "utf8");

    await startServer(appRoot);

    await expect(access(abandonedGrant)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(activeGrant, "utf8")).resolves.toBe("{}\n");
    await expect(readFile(unrelatedFile, "utf8")).resolves.toBe("reserved\n");
  });

  it.skipIf(process.platform === "win32")(
    "rejects a symlinked local auth registry root",
    async () => {
      const appRoot = await createTemporaryDirectory();
      const symlinkTarget = await createTemporaryDirectory();
      await mkdir(join(appRoot, ".eve"));
      await symlink(symlinkTarget, join(appRoot, ".eve", "dev-auth"), "dir");

      const result = await LocalDevelopmentAuthServer.start(appRoot);

      expect(result.ok).toBe(false);
      if (result.ok) {
        serverHandles.push(result.value);
        expect.unreachable("Expected the symlinked registry root to be rejected.");
      }
      expect(result.error).toEqual({
        kind: "io",
        cause: new Error(
          `Local development auth registry is unavailable at ${join(appRoot, ".eve", "dev-auth")}.`,
        ),
      });
    },
  );
});

async function startServer(appRoot: string): Promise<LocalDevelopmentAuthServerHandle> {
  const server = resultValue(await LocalDevelopmentAuthServer.start(appRoot));
  serverHandles.push(server);
  return server;
}

function resultValue<T>(result: Result<T, unknown>): T {
  if (!result.ok) throw new Error(`Expected success, received ${JSON.stringify(result.error)}.`);
  return result.value;
}

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "eve-local-development-auth-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeServerOwner(
  directory: string,
  serverInstanceId: string,
  processId: number,
): Promise<void> {
  await writeFile(
    join(directory, "owner.json"),
    `${JSON.stringify({
      kind: "eve-local-dev-auth-server",
      processId,
      serverInstanceId,
      version: 1,
    })}\n`,
    "utf8",
  );
}

function restoreEnvironmentValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
