import { describe, expect, it } from "vitest";

import { EVE_LOCAL_DEV_USER_CREDENTIAL_HEADER } from "#protocol/local-dev-auth.js";

import {
  resolveDevelopmentClientOptions,
  resolveRemoteDevelopmentClientOptions,
} from "./client-options.js";
import { createDevelopmentCredentialGate } from "./credential-gate.js";
import { isLocalDevelopmentServerUrl } from "./local-host.js";

describe("resolveDevelopmentClientOptions", () => {
  it("targets the given host without inferring credentials from locality", () => {
    const options = resolveDevelopmentClientOptions("http://localhost:3000");
    expect(options.host).toBe("http://localhost:3000");
    expect(options.auth).toBeUndefined();
    expect(options.headers).toBeUndefined();

    const remote = resolveDevelopmentClientOptions("https://arbitrary.example.com");
    expect(remote.auth).toBeUndefined();
    expect(remote.headers).toBeUndefined();
  });

  it("does not preserve completed sessions across dev prompts", () => {
    expect(resolveDevelopmentClientOptions("http://localhost:3000").preserveCompletedSessions).toBe(
      undefined,
    );
  });

  it("recognizes only the local hosts accepted by the development server", () => {
    for (const url of ["http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"]) {
      expect(isLocalDevelopmentServerUrl(url)).toBe(true);
      expect(resolveDevelopmentClientOptions(url).auth).toBeUndefined();
    }
  });

  it("binds an authorized credential gate to a non-redirecting client", () => {
    const credentials = createDevelopmentCredentialGate("https://verified.example.com");

    const options = resolveRemoteDevelopmentClientOptions({
      credentials,
      serverUrl: "https://verified.example.com",
    });

    expect(options.host).toBe("https://verified.example.com");
    expect(options.redirect).toBe("manual");
    expect(options.headers).toBe(credentials.resolveBypassHeaders);
    expect(options.auth).toEqual({ vercelOidc: { token: expect.any(Function) } });
  });

  it("sends a server-associated local credential to any matching bind address", async () => {
    let credential = "local-secret";
    const local = resolveDevelopmentClientOptions("http://localhost:3000", {
      resolveLocalUserCredential: () => credential,
    });
    const privateNetwork = resolveDevelopmentClientOptions("http://10.0.0.5:3000", {
      resolveLocalUserCredential: () => credential,
    });

    expect(typeof local.headers).toBe("function");
    expect(typeof privateNetwork.headers).toBe("function");
    if (typeof local.headers !== "function" || typeof privateNetwork.headers !== "function") {
      throw new Error("Expected lazy development headers.");
    }

    expect(await local.headers()).toEqual({
      [EVE_LOCAL_DEV_USER_CREDENTIAL_HEADER]: "local-secret",
    });
    credential = "rotated-secret";
    expect(await local.headers()).toEqual({
      [EVE_LOCAL_DEV_USER_CREDENTIAL_HEADER]: "rotated-secret",
    });
    expect(await privateNetwork.headers()).toMatchObject({
      [EVE_LOCAL_DEV_USER_CREDENTIAL_HEADER]: "rotated-secret",
    });
  });
});
