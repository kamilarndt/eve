import { afterEach, describe, expect, it, vi } from "vitest";

import type { EveTUIRunnerOptions } from "./runner.js";

const mocks = vi.hoisted(() => ({
  resolveDevelopmentOidcToken: vi.fn(),
  resolveVercelDeployment: vi.fn(),
  run: vi.fn(async () => {}),
  runnerOptions: [] as EveTUIRunnerOptions[],
}));

vi.mock("#services/dev-client/request-headers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#services/dev-client/request-headers.js")>()),
  resolveDevelopmentOidcToken: mocks.resolveDevelopmentOidcToken,
}));

vi.mock("#setup/vercel-deployment.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#setup/vercel-deployment.js")>()),
  resolveVercelDeployment: mocks.resolveVercelDeployment,
}));

vi.mock("./runner.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runner.js")>()),
  EveTUIRunner: vi.fn().mockImplementation(function (options: EveTUIRunnerOptions) {
    mocks.runnerOptions.push(options);
    return { run: mocks.run };
  }),
}));

import { EVE_DEV_OIDC_TOKEN_ENV, runDevelopmentTui, type DevelopmentTuiTarget } from "./tui.js";

const REMOTE_TARGET = {
  kind: "remote",
  serverUrl: "https://self-hosted.example.com/",
  workspaceRoot: "/tmp/weather-agent",
} satisfies DevelopmentTuiTarget;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  mocks.resolveDevelopmentOidcToken.mockReset();
  mocks.resolveVercelDeployment.mockReset();
  mocks.run.mockClear();
  mocks.runnerOptions.length = 0;
});

describe("runDevelopmentTui", () => {
  it("uses EVE_DEV_OIDC_TOKEN as generic OIDC auth for remote targets", async () => {
    vi.stubEnv(EVE_DEV_OIDC_TOKEN_ENV, " generic-token ");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        ok: true,
        status: "ready",
        workflowId: "wf_test",
      }),
    );

    await runDevelopmentTui({ target: REMOTE_TARGET });

    const options = mocks.runnerOptions[0];
    if (options?.remote === undefined || options.client === undefined) {
      throw new Error("Expected a remote TUI client.");
    }
    expect(options.remote.skipStartupDeploymentResolution).toBe(true);
    mocks.resolveVercelDeployment.mockResolvedValue({ kind: "not-found" });
    const signal = new AbortController().signal;
    await options.remote.resolveDeployment(signal);
    expect(mocks.resolveVercelDeployment).toHaveBeenCalledWith({
      workspaceRoot: REMOTE_TARGET.workspaceRoot,
      host: "self-hosted.example.com",
      signal,
    });

    await options.client.health();
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("authorization")).toBe("Bearer generic-token");
    expect(headers.get("x-vercel-trusted-oidc-idp-token")).toBe("generic-token");
  });

  it("sends explicit headers with remote target requests", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        ok: true,
        status: "ready",
        workflowId: "wf_test",
      }),
    );

    await runDevelopmentTui({
      target: REMOTE_TARGET,
      headers: { authorization: "Basic route-token", "x-route-key": "abc123" },
    });

    const options = mocks.runnerOptions[0];
    if (options?.client === undefined) {
      throw new Error("Expected a remote TUI client.");
    }

    await options.client.health();
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("authorization")).toBe("Basic route-token");
    expect(headers.get("x-route-key")).toBe("abc123");
  });

  it("keeps Vercel origin resolution when no explicit dev OIDC token is set", async () => {
    const signal = new AbortController().signal;
    mocks.resolveVercelDeployment.mockResolvedValue({ kind: "not-found" });

    await runDevelopmentTui({ target: REMOTE_TARGET });
    const remote = mocks.runnerOptions[0]?.remote;
    if (remote === undefined) throw new Error("Expected remote options.");
    await remote.resolveDeployment(signal);

    expect(mocks.resolveVercelDeployment).toHaveBeenCalledWith({
      workspaceRoot: REMOTE_TARGET.workspaceRoot,
      host: "self-hosted.example.com",
      signal,
    });
  });

  it("creates a fresh client session for every TUI attached to the same server", async () => {
    const target = {
      kind: "local",
      serverUrl: "http://127.0.0.1:4321/",
      workspaceRoot: "/tmp/app",
    } satisfies DevelopmentTuiTarget;
    await runDevelopmentTui({ target });
    await runDevelopmentTui({ target });

    expect(mocks.runnerOptions).toHaveLength(2);
    const [first, second] = mocks.runnerOptions;
    if (first === undefined || second === undefined) {
      throw new Error("Expected two TUI runner invocations.");
    }
    expect(first.client).not.toBe(second.client);
    expect(first.session).not.toBe(second.session);
  });
});
