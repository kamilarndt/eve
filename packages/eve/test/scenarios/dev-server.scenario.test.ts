import { spawn, type ChildProcessByStdio } from "node:child_process";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import type { HandleMessageStreamEvent } from "../../src/protocol/message.js";
import { runCli } from "../../src/cli/run.js";
import { EVE_LOCAL_DEV_USER_CREDENTIAL_HEADER } from "../../src/protocol/local-dev-auth.js";
import { EVE_HEALTH_ROUTE_PATH } from "../../src/protocol/routes.js";
import { WEATHER_AGENT_DESCRIPTOR } from "../../src/internal/testing/scenario-apps/weather-agent.js";
import {
  type ScenarioAppDescriptor,
  useScenarioApp,
} from "../../src/internal/testing/scenario-app.js";
import { sendDevelopmentMessage } from "../dev-client-harness/send-message.js";
import { createDevelopmentSessionState } from "../dev-client-harness/session.js";

// Keep the dev TUI's glyph set deterministic across CI hosts so the
// screen assertions below remain stable.
process.env.EVE_TUI_UNICODE = "1";

const scenarioApp = useScenarioApp();
const DEV_SERVER_SCENARIO_TIMEOUT_MS = 360_000;
const CALLBACK_ORIGIN_CONNECTION_SOURCE = `import {
  ConnectionAuthorizationRequiredError,
  defineInteractiveAuthorization,
  defineMcpClientConnection,
} from "eve/connections";

const auth = defineInteractiveAuthorization({
  async getToken() {
    throw new ConnectionAuthorizationRequiredError("callback-origin");
  },
  async startAuthorization({ callbackUrl, principal }) {
    const url = new URL("https://idp.example/authorize");
    url.searchParams.set("principal_id", principal.id);
    url.searchParams.set("redirect_uri", callbackUrl);
    return { challenge: { url: url.toString() } };
  },
  async completeAuthorization() {
    return { token: "authorized" };
  },
});

export default defineMcpClientConnection({
  auth,
  description: "Connection used to verify the local authorization callback origin.",
  url: "https://mcp.invalid/example",
});
`;
const DEV_SERVER_AGENT_DESCRIPTOR: ScenarioAppDescriptor = {
  ...WEATHER_AGENT_DESCRIPTOR,
  files: Object.fromEntries([
    ...Object.entries(WEATHER_AGENT_DESCRIPTOR.files).filter(
      ([path]) => !path.startsWith("agent/channels/"),
    ),
    ["agent/connections/callback-origin.ts", CALLBACK_ORIGIN_CONNECTION_SOURCE],
  ]),
};

interface RunningEveDev {
  readonly stderr: () => string;
  readonly stdout: () => string;
  readonly url: string;
  stop(): Promise<void>;
}

function stripAnsi(text: string): string {
  return text
    .split("\u001b[")
    .map((segment, index) => {
      if (index === 0) {
        return segment;
      }

      return segment.replace(/^[0-9;]*m/, "");
    })
    .join("");
}

function hasUnsupportedWindowsEsmImport(text: string): boolean {
  return (
    text.includes("ERR_UNSUPPORTED_ESM_URL_SCHEME") ||
    text.includes("Received protocol 'g:'") ||
    text.includes('Received protocol "g:"')
  );
}

function hasKnownDevBundlingFailure(text: string): boolean {
  return (
    hasUnsupportedWindowsEsmImport(text) ||
    (text.includes("ERR_MODULE_NOT_FOUND") && text.includes("authored-module-map-loader"))
  );
}

function parseServerUrl(stdout: string): string | undefined {
  const match = /server listening at (https?:\/\/\S+)/.exec(stripAnsi(stdout));

  return match?.[1];
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function withInteractiveTerminal<T>(fn: () => Promise<T>): Promise<T> {
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  try {
    return await fn();
  } finally {
    if (stdinDescriptor === undefined) Reflect.deleteProperty(process.stdin, "isTTY");
    else Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
    if (stdoutDescriptor === undefined) Reflect.deleteProperty(process.stdout, "isTTY");
    else Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(message));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForServerUrl(input: {
  readonly child: ChildProcessByStdio<null, Readable, Readable>;
  readonly getOutput: () => {
    readonly stderr: string;
    readonly stdout: string;
  };
}): Promise<string> {
  return await new Promise((resolve, reject) => {
    let settled = false;

    const timeout = setTimeout(() => {
      settleReject(
        new Error(
          [
            "Timed out waiting for eve dev to print its server URL.",
            `stdout:\n${input.getOutput().stdout}`,
            `stderr:\n${input.getOutput().stderr}`,
          ].join("\n\n"),
        ),
      );
    }, 120_000);

    const cleanup = () => {
      clearTimeout(timeout);
      input.child.stdout.off("data", handleOutput);
      input.child.stderr.off("data", handleOutput);
      input.child.off("error", settleReject);
      input.child.off("exit", handleExit);
    };

    const settleResolve = (url: string) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      resolve(url);
    };

    function settleReject(error: unknown) {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(error);
    }

    function handleOutput() {
      const output = input.getOutput();
      const combinedOutput = `${output.stdout}\n${output.stderr}`;

      if (hasKnownDevBundlingFailure(combinedOutput)) {
        settleReject(
          new Error(
            [
              "eve dev emitted a known generated dev bundle import failure.",
              `stdout:\n${output.stdout}`,
              `stderr:\n${output.stderr}`,
            ].join("\n\n"),
          ),
        );
        return;
      }

      const url = parseServerUrl(output.stdout);

      if (url !== undefined) {
        settleResolve(url);
      }
    }

    function handleExit(code: number | null, signal: NodeJS.Signals | null) {
      const output = input.getOutput();

      settleReject(
        new Error(
          [
            `eve dev exited before printing its server URL (code ${String(code)}, signal ${String(signal)}).`,
            `stdout:\n${output.stdout}`,
            `stderr:\n${output.stderr}`,
          ].join("\n\n"),
        ),
      );
    }

    input.child.stdout.on("data", handleOutput);
    input.child.stderr.on("data", handleOutput);
    input.child.once("error", settleReject);
    input.child.once("exit", handleExit);
    handleOutput();
  });
}

async function startEveDev(appRoot: string): Promise<RunningEveDev> {
  const eveBinPath = join(appRoot, "node_modules", "eve", "bin", "eve.js");
  const child = spawn(
    process.execPath,
    [eveBinPath, "dev", "--no-ui", "--host", "127.0.0.1", "--port", "0"],
    {
      cwd: appRoot,
      env: {
        ...process.env,
        // Activate the deterministic mock-model adapter in the spawned dev
        // server so the streamed turn completes without model credentials.
        NODE_ENV: "test",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  let stdout = "";

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const url = await waitForServerUrl({
    child,
    getOutput: () => ({
      stderr,
      stdout,
    }),
  });

  return {
    stderr: () => stderr,
    stdout: () => stdout,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }

      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 10_000);

        child.once("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
        child.kill("SIGTERM");
      });
    },
    url,
  };
}

describe("eve dev server", () => {
  it(
    "boots the packaged development server and completes a streamed turn",
    async () => {
      const app = await scenarioApp(DEV_SERVER_AGENT_DESCRIPTOR);
      const server = await startEveDev(app.appRoot);

      try {
        const response = await fetch(new URL(EVE_HEALTH_ROUTE_PATH, server.url));
        const responseText = await response.text();

        expect(
          response.status,
          [
            `Expected ${EVE_HEALTH_ROUTE_PATH} to return 200.`,
            `response body:\n${responseText}`,
            `stdout:\n${server.stdout()}`,
            `stderr:\n${server.stderr()}`,
          ].join("\n\n"),
        ).toBe(200);
        expect(JSON.parse(responseText)).toMatchObject({
          ok: true,
          status: "ready",
        });

        let messageResult: Awaited<ReturnType<typeof sendDevelopmentMessage>>;
        try {
          messageResult = await sendDevelopmentMessage({
            message: "hello world",
            session: createDevelopmentSessionState(),
            serverUrl: server.url,
          });
        } catch (error) {
          throw new Error(
            [
              `Expected dev message route to complete without throwing: ${String(error)}`,
              `stdout:\n${server.stdout()}`,
              `stderr:\n${server.stderr()}`,
            ].join("\n\n"),
            { cause: error },
          );
        }

        expect(
          messageResult.events.some((event) => event.type === "message.completed"),
          [
            "Expected dev message route to complete a streamed turn.",
            `events:\n${JSON.stringify(messageResult.events, null, 2)}`,
            `stdout:\n${server.stdout()}`,
            `stderr:\n${server.stderr()}`,
          ].join("\n\n"),
        ).toBe(true);

        type AuthorizationRequiredEvent = Extract<
          HandleMessageStreamEvent,
          { readonly type: "authorization.required" }
        >;
        let authorizationRequired: AuthorizationRequiredEvent | undefined;
        const previousCwd = process.cwd();
        try {
          process.chdir(app.appRoot);
          await withInteractiveTerminal(() =>
            runCli(
              ["dev", "--url", server.url],
              { error: () => {}, log: () => {} },
              {
                getVercelUserIdentity: async () => ({
                  identity: { id: "dev-server-scenario-user-id" },
                  status: "authenticated",
                }),
                runDevelopmentTui: async (input) => {
                  expect(input.target).toEqual({
                    kind: "local",
                    serverUrl: server.url,
                    workspaceRoot: await realpath(app.appRoot),
                  });
                  const credential = input.localUserCredential?.token;
                  expect(credential).toBeDefined();
                  if (credential === undefined) {
                    throw new Error("Attached local TUI did not receive a user credential.");
                  }

                  let resolveAuthorizationRequired: (
                    event: AuthorizationRequiredEvent,
                  ) => void = () => {};
                  const authorizationRequiredEvent = new Promise<AuthorizationRequiredEvent>(
                    (resolve) => {
                      resolveAuthorizationRequired = resolve;
                    },
                  );
                  const authAbortController = new AbortController();
                  const authRequest = sendDevelopmentMessage({
                    headers: {
                      [EVE_LOCAL_DEV_USER_CREDENTIAL_HEADER]: credential,
                    },
                    message: 'Call connection__search once with keywords "callback".',
                    onEvent(event) {
                      if (
                        event.type === "authorization.required" &&
                        event.data.name === "callback-origin"
                      ) {
                        resolveAuthorizationRequired(event);
                      }
                    },
                    session: createDevelopmentSessionState(),
                    signal: authAbortController.signal,
                    serverUrl: server.url,
                  });
                  try {
                    authorizationRequired = await withTimeout(
                      Promise.race([
                        authorizationRequiredEvent,
                        authRequest.then((result) => {
                          throw new Error(
                            `Connection search reached a turn boundary before requesting authorization. Events: ${JSON.stringify(result.events)}`,
                          );
                        }),
                      ]),
                      30_000,
                      "Timed out waiting for callback-origin to request authorization.",
                    );
                  } finally {
                    authAbortController.abort();
                  }
                  await authRequest.catch((error: unknown) => {
                    if (!authAbortController.signal.aborted) throw error;
                  });
                },
              },
            ),
          );
        } finally {
          process.chdir(previousCwd);
        }

        expect(authorizationRequired).toBeDefined();
        if (authorizationRequired === undefined) {
          throw new Error("Attached local TUI did not receive an authorization challenge.");
        }
        const webhookUrl = authorizationRequired.data.webhookUrl;
        const challengeUrl = authorizationRequired.data.authorization?.url;
        expect(webhookUrl).toBeDefined();
        expect(challengeUrl).toBeDefined();
        if (webhookUrl === undefined || challengeUrl === undefined) {
          throw new Error("Authorization challenge omitted its callback URL.");
        }

        const serverPort = new URL(server.url).port;
        expect(serverPort).not.toBe("3000");
        expect(new URL(webhookUrl).port).toBe(serverPort);
        expect(new URL(challengeUrl).searchParams.get("redirect_uri")).toBe(webhookUrl);
        expect(new URL(challengeUrl).searchParams.get("principal_id")).toBe(
          "dev-server-scenario-user-id",
        );
        await wait(1_000);

        const output = `${server.stdout()}\n${server.stderr()}`;
        expect(hasKnownDevBundlingFailure(output)).toBe(false);
      } finally {
        await server.stop();
      }
    },
    DEV_SERVER_SCENARIO_TIMEOUT_MS,
  );
});
