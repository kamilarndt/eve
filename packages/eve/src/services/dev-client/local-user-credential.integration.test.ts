import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadDevelopmentEnvironmentFiles } from "#cli/dev/environment.js";
import { LocalDevelopmentAuthServer } from "#internal/local-development-auth.js";
import {
  EVE_LOCAL_DEV_AUTH_DIRECTORY_ENV,
  EVE_LOCAL_DEV_AUTH_INSTANCE_ID_ENV,
  EVE_LOCAL_DEV_USER_CREDENTIAL_HEADER,
} from "#protocol/local-dev-auth.js";
import type { Result } from "#shared/result.js";

import { resolveDevelopmentClientOptions } from "./client-options.js";
import { createLocalDevelopmentUserCredential } from "./local-user-credential.js";

describe("createLocalDevelopmentUserCredential", () => {
  it("keeps app env reloads from replacing server-owned registry coordinates", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "eve-local-user-credential-"));
    await writeFile(
      join(appRoot, ".env.local"),
      `${EVE_LOCAL_DEV_AUTH_DIRECTORY_ENV}=/tmp/authored\n${EVE_LOCAL_DEV_AUTH_INSTANCE_ID_ENV}=${"f".repeat(32)}\n`,
      "utf8",
    );
    loadDevelopmentEnvironmentFiles(appRoot);
    const server = resultValue(await LocalDevelopmentAuthServer.start(appRoot));
    const credential = createLocalDevelopmentUserCredential({
      appRoot,
      resolveServer: async () => server.metadata,
      resolveIdentity: async () => authenticated("vercel-user-123"),
    });

    try {
      await credential.refresh();
      loadDevelopmentEnvironmentFiles(appRoot);

      const token = credential.token;
      expect(token).toBeDefined();
      if (token === undefined) throw new Error("Expected a local user credential.");
      const authServer = LocalDevelopmentAuthServer.readerFromEnvironment();
      if (authServer === undefined)
        throw new Error("Expected active local auth registry metadata.");
      await expect(authServer.read(token)).resolves.toMatchObject({
        ok: true,
        value: { id: "vercel-user-123", type: "user" },
      });
    } finally {
      await credential.dispose();
      await server.dispose();
      await rm(appRoot, { force: true, recursive: true });
    }
  });

  it("rotates the next request to a new grant after the CLI user changes", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "eve-local-user-rotation-"));
    const server = resultValue(await LocalDevelopmentAuthServer.start(appRoot));
    const authServer = LocalDevelopmentAuthServer.reader({
      appRoot,
      metadata: server.metadata,
    });
    let userId = "vercel-user-a";
    const credential = createLocalDevelopmentUserCredential({
      appRoot,
      resolveServer: async () => server.metadata,
      resolveIdentity: async () => authenticated(userId),
    });
    const clientOptions = resolveDevelopmentClientOptions("http://127.0.0.1:3000", {
      resolveLocalUserCredential: () => credential.token,
    });

    try {
      await credential.refresh({ forceIdentity: true });
      if (typeof clientOptions.headers !== "function") {
        throw new Error("Expected lazy development client headers.");
      }
      const firstHeaders = await clientOptions.headers();
      const firstToken = firstHeaders[EVE_LOCAL_DEV_USER_CREDENTIAL_HEADER];
      expect(firstToken).toBeDefined();

      userId = "vercel-user-b";
      await credential.refresh({ forceIdentity: true });
      const secondHeaders = await clientOptions.headers();
      const secondToken = secondHeaders[EVE_LOCAL_DEV_USER_CREDENTIAL_HEADER];
      expect(secondToken).toBeDefined();
      expect(secondToken).not.toBe(firstToken);
      if (firstToken === undefined || secondToken === undefined) {
        throw new Error("Expected both local user grant tokens.");
      }

      await expect(authServer.read(firstToken)).resolves.toEqual({ ok: true, value: undefined });
      await expect(authServer.read(secondToken)).resolves.toMatchObject({
        ok: true,
        value: { id: "vercel-user-b", type: "user" },
      });
    } finally {
      await credential.dispose();
      await server.dispose();
      await rm(appRoot, { force: true, recursive: true });
    }
  });

  it("rebinds the credential when an attached dev server is replaced", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "eve-local-user-restart-"));
    const firstServer = resultValue(await LocalDevelopmentAuthServer.start(appRoot));
    let activeServer = firstServer.metadata;
    const credential = createLocalDevelopmentUserCredential({
      appRoot,
      resolveServer: async () => activeServer,
      resolveIdentity: async () => authenticated("vercel-user-123"),
    });

    try {
      await credential.refresh();
      const firstToken = credential.token;
      expect(firstToken).toBeDefined();

      await firstServer.dispose();
      const secondServer = resultValue(await LocalDevelopmentAuthServer.start(appRoot));
      activeServer = secondServer.metadata;
      try {
        await credential.refresh();
        const secondToken = credential.token;
        expect(secondToken).toBeDefined();
        expect(secondToken).not.toBe(firstToken);
        if (secondToken === undefined) throw new Error("Expected a replacement credential.");

        const secondAuthServer = LocalDevelopmentAuthServer.reader({
          appRoot,
          metadata: secondServer.metadata,
        });
        await expect(secondAuthServer.read(secondToken)).resolves.toMatchObject({
          ok: true,
          value: { id: "vercel-user-123", type: "user" },
        });
      } finally {
        await secondServer.dispose();
      }
    } finally {
      await credential.dispose();
      await rm(appRoot, { force: true, recursive: true });
    }
  });
});

function resultValue<T>(result: Result<T, unknown>): T {
  if (!result.ok) throw new Error(`Expected success, received ${JSON.stringify(result.error)}.`);
  return result.value;
}

function authenticated(id: string) {
  return { identity: { id }, status: "authenticated" } as const;
}
