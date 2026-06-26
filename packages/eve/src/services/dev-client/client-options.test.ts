import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveTestVercelTarget } from "#internal/testing/verified-vercel-target.js";

import {
  resolveDevelopmentClientOptions,
  resolveRemoteDevelopmentClientOptions,
} from "./client-options.js";
import { createDevelopmentCredentialGate } from "./credential-gate.js";
import { isLocalDevelopmentServerUrl } from "./local-host.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

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

  it("skips the OIDC bearer for local hosts", () => {
    for (const url of ["http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"]) {
      expect(isLocalDevelopmentServerUrl(url)).toBe(true);
      expect(resolveDevelopmentClientOptions(url).auth).toBeUndefined();
    }
  });

  it("passes explicit headers through local development clients", async () => {
    const options = resolveDevelopmentClientOptions("http://localhost:3000", {
      headers: { authorization: "Basic route-token" },
    });

    expect(options.headers).toEqual({ authorization: "Basic route-token" });
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
    // The token flows through generic OIDC auth, never headers.
    expect(options.auth).toEqual({ oidc: expect.any(Function) });
  });

  it("merges explicit headers with Vercel bypass headers for remote clients", async () => {
    vi.stubEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "bypass-secret");
    const credentials = createDevelopmentCredentialGate("https://verified.example.com");
    credentials.authorize({
      target: await resolveTestVercelTarget({
        host: "verified.example.com",
        projectId: "prj_test",
      }),
      resolveToken: async () => "vercel-token",
    });

    const options = resolveRemoteDevelopmentClientOptions({
      credentials,
      headers: { authorization: "Bearer custom-token", "x-route-key": "abc123" },
      serverUrl: "https://verified.example.com",
    });

    if (typeof options.headers !== "function") {
      throw new Error("Expected dynamic headers.");
    }
    await expect(options.headers()).resolves.toEqual({
      authorization: "Bearer custom-token",
      "x-route-key": "abc123",
      "x-vercel-protection-bypass": "bypass-secret",
    });
  });
});
