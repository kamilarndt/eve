import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  resolveDevelopmentProcessIdPath,
  resolveDevelopmentServerMetadataPath,
  resolveLocalDevelopmentServerAuth,
} from "./development-server-metadata.js";

const temporaryDirectories: string[] = [];
const localAuth = { serverInstanceId: "a".repeat(32), version: 1 } as const;

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("resolveLocalDevelopmentServerAuth", () => {
  it("returns auth coordinates only for this app's live server URL", async () => {
    const appRoot = await createAppRoot();
    await writeActiveServer(appRoot, {
      localAuth,
      pid: process.pid,
      url: "http://127.0.0.1:4321/",
    });

    await expect(
      resolveLocalDevelopmentServerAuth({ appRoot, serverUrl: "http://127.0.0.1:4321" }),
    ).resolves.toEqual(localAuth);
    await expect(
      resolveLocalDevelopmentServerAuth({ appRoot, serverUrl: "http://localhost:4321" }),
    ).resolves.toEqual(localAuth);
    await expect(
      resolveLocalDevelopmentServerAuth({ appRoot, serverUrl: "http://127.0.0.1:4322" }),
    ).resolves.toBeUndefined();
  });

  it("does not attach user credentials to metadata from an older server", async () => {
    const appRoot = await createAppRoot();
    await writeActiveServer(appRoot, {
      pid: process.pid,
      url: "http://127.0.0.1:4321/",
    });

    await expect(
      resolveLocalDevelopmentServerAuth({ appRoot, serverUrl: "http://127.0.0.1:4321" }),
    ).resolves.toBeUndefined();
  });
});

async function createAppRoot(): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "eve-development-server-metadata-"));
  temporaryDirectories.push(appRoot);
  await mkdir(join(appRoot, ".eve"));
  return appRoot;
}

async function writeActiveServer(
  appRoot: string,
  metadata: { readonly localAuth?: typeof localAuth; readonly pid: number; readonly url: string },
): Promise<void> {
  await writeFile(resolveDevelopmentProcessIdPath(appRoot), `${metadata.pid}\n`, "utf8");
  await writeFile(
    resolveDevelopmentServerMetadataPath(appRoot),
    `${JSON.stringify(metadata)}\n`,
    "utf8",
  );
}
