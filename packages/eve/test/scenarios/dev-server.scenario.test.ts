import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { EVE_HEALTH_ROUTE_PATH } from "../../src/protocol/routes.js";
import {
  pruneDevelopmentRuntimeArtifactsSnapshots,
  readDevelopmentRuntimeArtifactsSnapshotRoot,
  resolveDevelopmentRuntimeArtifactsPointerPath,
} from "../../src/internal/nitro/dev-runtime-artifacts.js";
import {
  AUTHORED_ARTIFACTS_UPDATED_LOG_LINE,
  STRUCTURAL_RELOAD_LOG_LINE,
} from "../../src/internal/nitro/host/dev-watcher-log.js";
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
const DEV_SERVER_AGENT_DESCRIPTOR: ScenarioAppDescriptor = {
  ...WEATHER_AGENT_DESCRIPTOR,
  files: Object.fromEntries(
    Object.entries(WEATHER_AGENT_DESCRIPTOR.files).filter(
      ([path]) => !path.startsWith("agent/channels/"),
    ),
  ),
};

const STABLE_DEV_NITRO_INPUT_PATHS = [
  [".eve", "host", "compiled-artifacts-bootstrap.mjs"],
  [".eve", "host", "compiled-artifacts-workflow-bootstrap.mjs"],
  [".eve", "host", "compiled-artifacts-workflow-world.mjs"],
  [".eve", "nitro", "workflow", "steps.mjs"],
  [".eve", "nitro", "workflow", "workflows.mjs"],
  [".eve", "nitro", "workflow", "workflows-handler.mjs"],
] as const;

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
    text.includes("UNRESOLVED_IMPORT") ||
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

async function waitForCondition(
  condition: () => boolean,
  failureMessage: string,
  timeoutMs: number = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error(failureMessage);
    }
    await wait(100);
  }
}

async function readStableDevNitroInputs(appRoot: string): Promise<Record<string, string>> {
  return Object.fromEntries(
    await Promise.all(
      STABLE_DEV_NITRO_INPUT_PATHS.map(async (segments) => {
        const relativePath = segments.join("/");
        return [relativePath, await readFile(join(appRoot, ...segments), "utf8")] as const;
      }),
    ),
  );
}

function assertNitroImportEdgesDoNotReferenceRuntimeSnapshots(
  sources: Readonly<Record<string, string>>,
): void {
  for (const [relativePath, source] of Object.entries(sources)) {
    const importLines = source.split("\n").filter((line) => line.startsWith("import "));
    const snapshotImport = importLines.find(
      (line) =>
        line.includes("/.eve/dev-runtime/snapshots/") ||
        line.includes("\\.eve\\dev-runtime\\snapshots\\"),
    );
    expect(snapshotImport, `${relativePath} imports a prunable runtime snapshot`).toBeUndefined();
  }

  expect(sources[".eve/nitro/workflow/workflows-handler.mjs"]).toContain(
    "../../host/compiled-artifacts-workflow-world.mjs",
  );
}

function hashDevNitroInputs(sources: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(sources).map(([relativePath, source]) => [
      relativePath,
      createHash("sha256").update(source).digest("hex"),
    ]),
  );
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

async function runEveBuild(appRoot: string): Promise<{ stderr: string; stdout: string }> {
  const eveBinPath = join(appRoot, "node_modules", "eve", "bin", "eve.js");
  const child = spawn(process.execPath, [eveBinPath, "build"], {
    cwd: appRoot,
    env: {
      ...process.env,
      NODE_ENV: "test",
      VERCEL: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
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

  await new Promise<void>((resolvePromise, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(`Timed out waiting for eve build.\n\nstdout:\n${stdout}\n\nstderr:\n${stderr}`),
      );
    }, 240_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(
        new Error(
          `eve build failed (code ${String(code)}, signal ${String(signal)}).\n\nstdout:\n${stdout}\n\nstderr:\n${stderr}`,
        ),
      );
    });
  });

  return { stderr, stdout };
}

describe("eve dev server", () => {
  it(
    "stays healthy while an isolated production build runs and a tool is deleted",
    async () => {
      const app = await scenarioApp(DEV_SERVER_AGENT_DESCRIPTOR);
      const server = await startEveDev(app.appRoot);
      const workflowHandlerPath = join(
        app.appRoot,
        ".eve",
        "nitro",
        "workflow",
        "workflows-handler.mjs",
      );

      try {
        const workflowHandlerBeforeBuild = await readFile(workflowHandlerPath, "utf8");
        const pointerPath = resolveDevelopmentRuntimeArtifactsPointerPath(app.appRoot);
        const pointerBeforeDelete = readDevelopmentRuntimeArtifactsSnapshotRoot(pointerPath);

        let buildSettled = false;
        const buildPromise = runEveBuild(app.appRoot).then(
          (output) => {
            buildSettled = true;
            return output;
          },
          (error: unknown) => {
            buildSettled = true;
            throw error;
          },
        );

        let healthChecksDuringOverlap = 0;
        const assertHealthyDuringOverlap = async () => {
          const response = await fetch(new URL(EVE_HEALTH_ROUTE_PATH, server.url), {
            signal: AbortSignal.timeout(5_000),
          });
          const responseText = await response.text();
          expect(
            response.status,
            [
              "Expected eve dev to remain healthy while build and authored rebuild overlap.",
              `response:\n${responseText}`,
              `stdout:\n${server.stdout()}`,
              `stderr:\n${server.stderr()}`,
            ].join("\n\n"),
          ).toBe(200);
          healthChecksDuringOverlap += 1;
        };

        await assertHealthyDuringOverlap();
        await rm(join(app.appRoot, "agent", "tools", "get_weather.ts"));
        while (!buildSettled) {
          await wait(100);
          await assertHealthyDuringOverlap();
        }
        const buildOutput = await buildPromise;
        expect(healthChecksDuringOverlap).toBeGreaterThan(0);

        await expect(readFile(workflowHandlerPath, "utf8")).resolves.toBe(
          workflowHandlerBeforeBuild,
        );
        expect(existsSync(join(app.appRoot, ".output", "server", "index.mjs"))).toBe(true);
        const healthAfterBuild = await fetch(new URL(EVE_HEALTH_ROUTE_PATH, server.url));
        expect(healthAfterBuild.status).toBe(200);

        await waitForCondition(
          () => server.stdout().includes(AUTHORED_ARTIFACTS_UPDATED_LOG_LINE),
          `Timed out waiting for tool deletion rebuild.\n\nstdout:\n${server.stdout()}\n\nstderr:\n${server.stderr()}`,
        );
        await waitForCondition(() => {
          const currentPointer = readDevelopmentRuntimeArtifactsSnapshotRoot(pointerPath);
          return currentPointer !== undefined && currentPointer !== pointerBeforeDelete;
        }, `Timed out waiting for the deletion runtime snapshot.\n\nstdout:\n${server.stdout()}\n\nstderr:\n${server.stderr()}`);
        await wait(1_000);

        const healthAfterDelete = await fetch(new URL(EVE_HEALTH_ROUTE_PATH, server.url));
        const healthAfterDeleteText = await healthAfterDelete.text();
        expect(
          healthAfterDelete.status,
          [
            `Expected health after tool deletion to return 200, received ${healthAfterDelete.status}.`,
            `response:\n${healthAfterDeleteText}`,
            `stdout:\n${server.stdout()}`,
            `stderr:\n${server.stderr()}`,
          ].join("\n\n"),
        ).toBe(200);
        const combinedOutput = [
          server.stdout(),
          server.stderr(),
          buildOutput.stdout,
          buildOutput.stderr,
        ].join("\n");
        expect(hasKnownDevBundlingFailure(combinedOutput)).toBe(false);
        expect(combinedOutput).not.toContain("Dev worker failed after 3 retries");
        expect(combinedOutput).not.toContain("UNRESOLVED_IMPORT");
        expect(combinedOutput).not.toContain("ERR_MODULE_NOT_FOUND");
        expect(server.stdout()).not.toContain(STRUCTURAL_RELOAD_LOG_LINE);
      } finally {
        await server.stop();
      }
    },
    DEV_SERVER_SCENARIO_TIMEOUT_MS,
  );

  it(
    "rebuilds after pruning its startup runtime snapshot and completes a streamed turn",
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

        const pointerPath = resolveDevelopmentRuntimeArtifactsPointerPath(app.appRoot);
        const startupRuntimeRoot = readDevelopmentRuntimeArtifactsSnapshotRoot(pointerPath);
        if (startupRuntimeRoot === undefined) {
          throw new Error("Expected eve dev to publish an initial runtime snapshot.");
        }
        const startupNitroInputs = await readStableDevNitroInputs(app.appRoot);
        assertNitroImportEdgesDoNotReferenceRuntimeSnapshots(startupNitroInputs);

        await writeFile(
          join(app.appRoot, "agent", "instructions.md"),
          "Use the weather tool and answer with the current conditions.\n",
        );
        await waitForCondition(() => {
          const currentRuntimeRoot = readDevelopmentRuntimeArtifactsSnapshotRoot(pointerPath);
          return currentRuntimeRoot !== undefined && currentRuntimeRoot !== startupRuntimeRoot;
        }, `Timed out waiting for authored HMR.\n\nstdout:\n${server.stdout()}\n\nstderr:\n${server.stderr()}`);

        const authoredRuntimeRoot = readDevelopmentRuntimeArtifactsSnapshotRoot(pointerPath);
        if (authoredRuntimeRoot === undefined) {
          throw new Error("Expected authored HMR to publish a runtime snapshot.");
        }
        const stableNitroInputsBeforePrune = await readStableDevNitroInputs(app.appRoot);
        assertNitroImportEdgesDoNotReferenceRuntimeSnapshots(stableNitroInputsBeforePrune);
        const stableNitroInputHashesBeforePrune = hashDevNitroInputs(stableNitroInputsBeforePrune);

        await pruneDevelopmentRuntimeArtifactsSnapshots({
          appRoot: app.appRoot,
          now: Date.now() + 1_000,
          recentWindowMs: 0,
          retainCount: 0,
        });
        expect(existsSync(startupRuntimeRoot)).toBe(false);
        expect(existsSync(authoredRuntimeRoot)).toBe(true);
        expect(readDevelopmentRuntimeArtifactsSnapshotRoot(pointerPath)).toBe(authoredRuntimeRoot);
        expect(hashDevNitroInputs(await readStableDevNitroInputs(app.appRoot))).toEqual(
          stableNitroInputHashesBeforePrune,
        );

        const healthAfterPrune = await fetch(new URL(EVE_HEALTH_ROUTE_PATH, server.url));
        expect(
          healthAfterPrune.status,
          [
            "Expected pruning an obsolete runtime snapshot not to break the live Nitro worker.",
            `stdout:\n${server.stdout()}`,
            `stderr:\n${server.stderr()}`,
          ].join("\n\n"),
        ).toBe(200);

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
              "Expected a streamed turn to complete immediately after pruning.",
              `startup snapshot: ${startupRuntimeRoot}`,
              `authored snapshot: ${authoredRuntimeRoot}`,
              `current snapshot: ${String(readDevelopmentRuntimeArtifactsSnapshotRoot(pointerPath))}`,
              `stdout:\n${server.stdout()}`,
              `stderr:\n${server.stderr()}`,
            ].join("\n\n"),
            { cause: error },
          );
        }

        expect(
          messageResult.events.some((event) => event.type === "message.completed"),
          [
            "Expected dev message route to complete a streamed turn after pruning.",
            `events:\n${JSON.stringify(messageResult.events, null, 2)}`,
            `stdout:\n${server.stdout()}`,
            `stderr:\n${server.stderr()}`,
          ].join("\n\n"),
        ).toBe(true);

        await writeFile(join(app.appRoot, ".env.local"), "EVE_SCENARIO_RELOAD=1\n");
        await waitForCondition(
          () => server.stdout().includes(STRUCTURAL_RELOAD_LOG_LINE),
          `Timed out waiting for a structural Nitro reload.\n\nstdout:\n${server.stdout()}\n\nstderr:\n${server.stderr()}`,
        );
        await waitForCondition(() => {
          const currentRuntimeRoot = readDevelopmentRuntimeArtifactsSnapshotRoot(pointerPath);
          return currentRuntimeRoot !== undefined && currentRuntimeRoot !== authoredRuntimeRoot;
        }, `Timed out waiting for the structural reload snapshot.\n\nstdout:\n${server.stdout()}\n\nstderr:\n${server.stderr()}`);
        await wait(2_000);

        const healthAfterStructuralReload = await fetch(new URL(EVE_HEALTH_ROUTE_PATH, server.url));
        expect(
          healthAfterStructuralReload.status,
          [
            "Expected Nitro's structural reload to remain healthy after pruning.",
            `stdout:\n${server.stdout()}`,
            `stderr:\n${server.stderr()}`,
          ].join("\n\n"),
        ).toBe(200);

        const output = `${server.stdout()}\n${server.stderr()}`;
        expect(hasKnownDevBundlingFailure(output)).toBe(false);
      } finally {
        await server.stop();
      }
    },
    DEV_SERVER_SCENARIO_TIMEOUT_MS,
  );
});
