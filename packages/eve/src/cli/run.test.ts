import { describe, expect, it, vi } from "vitest";

import { resolveDevUiMode, resolveTuiDisplayOptions, runCli } from "#cli/run.js";
import type { RunDevelopmentTuiInput } from "#cli/dev/tui/tui.js";
import type { DevelopmentServerOptions } from "#internal/nitro/host/types.js";
import type { LocalDevelopmentUserIdentityResolution } from "#services/dev-client/local-user-credential.js";

async function withInteractiveTerminal<T>(fn: () => Promise<T>): Promise<T> {
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  try {
    return await fn();
  } finally {
    if (stdinDescriptor !== undefined) {
      Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
    } else {
      Reflect.deleteProperty(process.stdin, "isTTY");
    }
    if (stdoutDescriptor !== undefined) {
      Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
    } else {
      Reflect.deleteProperty(process.stdout, "isTTY");
    }
  }
}

describe("CLI command registration", () => {
  it("lists the current project creation and Vercel commands", async () => {
    const output: string[] = [];

    await runCli(["--help"], {
      error: (message) => output.push(message),
      log: (message) => output.push(message),
    });

    const help = output.join("\n");
    expect(help).toContain("init [options] [target]");
    expect(help).toContain("link");
    expect(help).toContain("deploy");
    expect(help).not.toContain("setup");
  });
});

describe("eve init for a coding agent that fumbles the invocation", () => {
  // Detection must precede the commander failure: a bad/unknown arg trips
  // parsing before the init action runs, so runCli itself falls back to the guide.
  it("prints the setup guide but still fails on the malformed invocation", async () => {
    const output: string[] = [];

    // The guide is additive: the parse failure must still propagate (nonzero
    // exit), so runCli rejects even though the agent gets actionable next steps.
    await expect(
      runCli(
        ["init", "--unknown-flag"],
        { error: (message) => output.push(message), log: (message) => output.push(message) },
        { isCodingAgentLaunch: async () => true },
      ),
    ).rejects.toThrow();

    expect(output.join("\n")).toContain("Set up an eve agent");
  });

  it("still surfaces the usage error for a human", async () => {
    await expect(
      runCli(
        ["init", "--unknown-flag"],
        { error: () => {}, log: () => {} },
        { isCodingAgentLaunch: async () => false },
      ),
    ).rejects.toThrow();
  });
});

describe("eve dev --input", () => {
  it("forwards the initial draft to the interactive TUI", async () => {
    const runDevelopmentTui = vi.fn<(input: RunDevelopmentTuiInput) => Promise<void>>(
      async () => {},
    );

    await withInteractiveTerminal(() =>
      runCli(
        ["dev", "--url", "https://example.com", "--input", "/model"],
        { error: () => {}, log: () => {} },
        { runDevelopmentTui },
      ),
    );

    expect(runDevelopmentTui).toHaveBeenCalledWith(
      expect.objectContaining({
        initialInput: "/model",
        target: {
          kind: "remote",
          serverUrl: "https://example.com/",
          workspaceRoot: process.cwd(),
        },
      }),
    );
  });

  it("rejects the option when the terminal cannot run the interactive UI", async () => {
    await expect(
      runCli(
        ["dev", "--url", "https://example.com", "--input", "/model"],
        { error: () => {}, log: () => {} },
        { runDevelopmentTui: vi.fn(async () => {}) },
      ),
    ).rejects.toThrow("--input requires the interactive UI");
  });

  it("rejects the option with explicit --no-ui", async () => {
    await expect(
      runCli(["dev", "--input", "/model", "--no-ui"], {
        error: () => {},
        log: () => {},
      }),
    ).rejects.toThrow("--input requires the interactive UI");
  });
});

describe("eve dev --url protocol", () => {
  it("rejects an http:// remote URL up front instead of crashing during connect", async () => {
    await expect(
      runCli(["dev", "--url", "http://my-app.vercel.app"], { error: () => {}, log: () => {} }),
    ).rejects.toThrow(/https/);
  });
});

describe("eve eval --url protocol", () => {
  it("rejects an http:// remote URL up front", async () => {
    await expect(
      runCli(["eval", "--url", "http://my-app.vercel.app"], { error: () => {}, log: () => {} }),
    ).rejects.toThrow(/https/);
  });
});

describe("eve dev --logs", () => {
  it("accepts sandbox as the initial TUI log mode", async () => {
    const runDevelopmentTui = vi.fn(async () => {});

    await withInteractiveTerminal(() =>
      runCli(
        ["dev", "--url", "https://example.com", "--logs", "sandbox"],
        { error: () => {}, log: () => {} },
        { runDevelopmentTui },
      ),
    );

    expect(runDevelopmentTui).toHaveBeenCalledWith(
      expect.objectContaining({
        logs: "sandbox",
        target: {
          kind: "remote",
          serverUrl: "https://example.com/",
          workspaceRoot: process.cwd(),
        },
      }),
    );
  });
});

describe("eve dev boot progress", () => {
  it("passes one reporter through local startup and clears the row on failure", async () => {
    const writes: string[] = [];
    const close = vi.fn(async () => {});
    let hostReporter: DevelopmentServerOptions["onBootProgress"] = undefined;
    let tuiReporter: RunDevelopmentTuiInput["onBootProgress"] = undefined;
    const startHost = vi.fn(async (_appRoot: string, options?: DevelopmentServerOptions) => {
      hostReporter = options?.onBootProgress;
      hostReporter?.({ phase: "compiling agent", type: "phase-started" });
      hostReporter?.({ elapsedMs: 1, phase: "compiling agent", type: "phase-finished" });
      return {
        close,
        localAuth: { serverInstanceId: "b".repeat(32), version: 1 as const },
        url: "http://127.0.0.1:2000",
      };
    });
    const runDevelopmentTui = vi.fn(async (input: RunDevelopmentTuiInput) => {
      tuiReporter = input.onBootProgress;
      throw new Error("TUI startup failed");
    });
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    try {
      await expect(
        withInteractiveTerminal(() =>
          runCli(
            ["dev"],
            { error: () => {}, log: () => {} },
            {
              createLocalDevelopmentUserCredential: () => ({
                dispose: async () => {},
                refresh: async () => {},
                token: undefined,
              }),
              runDevelopmentTui,
              startHost,
            },
          ),
        ),
      ).rejects.toThrow("TUI startup failed");
    } finally {
      stdoutWrite.mockRestore();
    }

    expect(hostReporter).toBeTypeOf("function");
    expect(tuiReporter).toBe(hostReporter);
    expect(writes.at(-1)).toBe("\r\u001B[K");
    expect(close).toHaveBeenCalledOnce();
  });
});

describe("eve dev local user projection", () => {
  const localAuth = { serverInstanceId: "a".repeat(32), version: 1 } as const;

  it("registers the integrated TUI after the local server starts", async () => {
    const runDevelopmentTui = vi.fn<(input: RunDevelopmentTuiInput) => Promise<void>>(
      async () => {},
    );
    let hostStarted = false;
    const startHost = vi.fn(async () => {
      hostStarted = true;
      return {
        localAuth,
        url: "http://localhost:2000",
        close: async () => {},
      };
    });
    const dispose = vi.fn(async () => {});
    const createLocalDevelopmentUserCredential = vi.fn(
      (input: {
        resolveIdentity(): Promise<LocalDevelopmentUserIdentityResolution>;
        resolveServer(): Promise<typeof localAuth | undefined>;
      }) => ({
        token: "local-user-token",
        refresh: async () => {
          expect(hostStarted).toBe(true);
          expect(await input.resolveServer()).toBe(localAuth);
          expect(await input.resolveIdentity()).toEqual({
            identity: { id: "vercel-user-123" },
            status: "authenticated",
          });
        },
        dispose,
      }),
    );

    await withInteractiveTerminal(() =>
      runCli(
        ["dev"],
        { error: () => {}, log: () => {} },
        {
          createLocalDevelopmentUserCredential,
          getVercelUserIdentity: async () => ({
            identity: { id: "vercel-user-123" },
            status: "authenticated",
          }),
          runDevelopmentTui,
          startHost,
        },
      ),
    );

    const input = runDevelopmentTui.mock.calls[0]?.[0];
    expect(input).toEqual(
      expect.objectContaining({
        localUserCredential: expect.objectContaining({
          dispose: expect.any(Function),
          refresh: expect.any(Function),
          token: "local-user-token",
        }),
        target: {
          kind: "local",
          serverUrl: "http://localhost:2000",
          workspaceRoot: process.cwd(),
        },
      }),
    );
    expect(createLocalDevelopmentUserCredential).toHaveBeenCalledWith(
      expect.objectContaining({ resolveServer: expect.any(Function) }),
    );
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("keeps the credential refreshable when the Vercel CLI user is unavailable", async () => {
    const runDevelopmentTui = vi.fn(async () => {});
    const createLocalDevelopmentUserCredential = vi.fn(
      (input: { resolveIdentity(): Promise<LocalDevelopmentUserIdentityResolution> }) => ({
        token: undefined,
        refresh: async () => {
          expect(await input.resolveIdentity()).toEqual({ status: "unavailable" });
        },
        dispose: async () => {},
      }),
    );

    await withInteractiveTerminal(() =>
      runCli(
        ["dev"],
        { error: () => {}, log: () => {} },
        {
          createLocalDevelopmentUserCredential,
          getVercelUserIdentity: async () => ({ status: "unavailable" }),
          runDevelopmentTui,
          startHost: async () => ({
            localAuth,
            url: "http://localhost:2000",
            close: async () => {},
          }),
        },
      ),
    );

    expect(runDevelopmentTui).toHaveBeenCalledWith(
      expect.objectContaining({
        localUserCredential: expect.objectContaining({ token: undefined }),
      }),
    );
  });

  it("registers an attached TUI only when localhost metadata matches this app", async () => {
    const runDevelopmentTui = vi.fn(async () => {});
    const resolveLocalDevelopmentServerAuth = vi.fn(async () => localAuth);
    const createLocalDevelopmentUserCredential = vi.fn(
      (input: { resolveServer: () => Promise<typeof localAuth | undefined> }) => ({
        token: "attached-user-token",
        refresh: async () => {
          await input.resolveServer();
        },
        dispose: async () => {},
      }),
    );

    await withInteractiveTerminal(() =>
      runCli(
        ["dev", "--url", "http://127.0.0.1:4321"],
        { error: () => {}, log: () => {} },
        {
          createLocalDevelopmentUserCredential,
          resolveLocalDevelopmentServerAuth,
          runDevelopmentTui,
        },
      ),
    );

    expect(resolveLocalDevelopmentServerAuth).toHaveBeenCalledWith(
      expect.objectContaining({ serverUrl: "http://127.0.0.1:4321/" }),
    );
    expect(runDevelopmentTui).toHaveBeenCalledWith(
      expect.objectContaining({
        localUserCredential: expect.objectContaining({ token: "attached-user-token" }),
        target: expect.objectContaining({
          kind: "local",
          workspaceRoot: expect.any(String),
        }),
      }),
    );
    expect(createLocalDevelopmentUserCredential).toHaveBeenCalledWith(
      expect.objectContaining({ resolveServer: expect.any(Function) }),
    );
    const credentialInput = createLocalDevelopmentUserCredential.mock.calls[0]?.[0];
    expect(await credentialInput?.resolveServer()).toBe(localAuth);
    expect(resolveLocalDevelopmentServerAuth).toHaveBeenCalledTimes(3);
  });

  it("does not project this app's user into an unrelated localhost server", async () => {
    const runDevelopmentTui = vi.fn(async () => {});
    const createLocalDevelopmentUserCredential = vi.fn(() => ({
      token: undefined,
      refresh: async () => {},
      dispose: async () => {},
    }));

    await withInteractiveTerminal(() =>
      runCli(
        ["dev", "--url", "http://127.0.0.1:4321"],
        { error: () => {}, log: () => {} },
        {
          createLocalDevelopmentUserCredential,
          resolveLocalDevelopmentServerAuth: async () => undefined,
          runDevelopmentTui,
        },
      ),
    );

    expect(createLocalDevelopmentUserCredential).toHaveBeenCalledOnce();
    expect(runDevelopmentTui).toHaveBeenCalledWith(
      expect.objectContaining({
        localUserCredential: expect.objectContaining({ token: undefined }),
        target: expect.objectContaining({
          kind: "local",
          workspaceRoot: expect.any(String),
        }),
      }),
    );
  });

  it("recovers local source access when matching server metadata appears after startup", async () => {
    let resolveCount = 0;
    const runDevelopmentTui = vi.fn(async (input: RunDevelopmentTuiInput) => {
      expect(input.target).toMatchObject({
        kind: "local",
        workspaceRoot: expect.any(String),
      });
      await expect(input.resolveAppRoot?.()).resolves.toEqual(expect.any(String));
    });

    await withInteractiveTerminal(() =>
      runCli(
        ["dev", "--url", "http://127.0.0.1:4321"],
        { error: () => {}, log: () => {} },
        {
          createLocalDevelopmentUserCredential: () => ({
            token: undefined,
            refresh: async () => {},
            dispose: async () => {},
          }),
          resolveLocalDevelopmentServerAuth: async () => {
            resolveCount += 1;
            return resolveCount === 1 ? undefined : localAuth;
          },
          runDevelopmentTui,
        },
      ),
    );

    expect(resolveCount).toBeGreaterThanOrEqual(2);
  });
});

describe("resolveDevUiMode", () => {
  it("defaults to the terminal UI in an interactive terminal", () => {
    expect(resolveDevUiMode({ options: {}, interactive: true })).toBe("tui");
  });

  it("forces headless when --no-ui is set", () => {
    expect(resolveDevUiMode({ options: { ui: false }, interactive: true })).toBe("headless");
  });

  it("forces headless in a non-interactive terminal regardless of flags", () => {
    expect(resolveDevUiMode({ options: {}, interactive: false })).toBe("headless");
  });
});

describe("resolveTuiDisplayOptions", () => {
  it("defaults tools to auto-collapsed, reasoning to full, and stderr logs visible", () => {
    expect(resolveTuiDisplayOptions({})).toEqual({
      logs: "stderr",
      reasoning: "full",
      tools: "auto-collapsed",
    });
  });

  it("passes through every provided display dimension", () => {
    expect(
      resolveTuiDisplayOptions({
        tools: "hidden",
        reasoning: "collapsed",
        subagents: "auto-collapsed",
        connectionAuth: "full",
        assistantResponseStats: "tokens",
        contextSize: 200_000,
        logs: "stderr",
      }),
    ).toEqual({
      tools: "hidden",
      reasoning: "collapsed",
      subagents: "auto-collapsed",
      connectionAuth: "full",
      assistantResponseStats: "tokens",
      contextSize: 200_000,
      logs: "stderr",
    });
  });

  it("omits optional display dimensions that were not provided", () => {
    const resolved = resolveTuiDisplayOptions({ tools: "full" });
    expect(resolved).not.toHaveProperty("subagents");
    expect(resolved).not.toHaveProperty("contextSize");
    expect(resolved.logs).toBe("stderr");
  });
});
