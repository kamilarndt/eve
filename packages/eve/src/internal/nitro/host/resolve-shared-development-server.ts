import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { resolveDiscoveryProject } from "#discover/project.js";
import { resolvePackageRoot } from "#internal/application/package.js";
import { DevelopmentServerState } from "#internal/nitro/host/dev-server-state.js";
import { isEveServerHealthy } from "#shared/eve-server-health.js";
import { isLoopbackServerUrl } from "#shared/network-address.js";

export const EVE_BASE_URL_ENV = "EVE_BASE_URL";

const DEVELOPMENT_SERVER_POLL_MS = 100;
const DEVELOPMENT_SERVER_SHUTDOWN_GRACE_MS = 1_000;
const MAX_CHILD_OUTPUT_TAIL_LENGTH = 16_384;

export interface SharedDevelopmentServerHandle {
  readonly close?: () => Promise<void>;
  readonly origin: string;
  readonly process?: ChildProcess;
}

type ChildProcessOutcome =
  | { readonly kind: "error"; readonly error: Error }
  | {
      readonly kind: "exit";
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    };

interface DevelopmentServerCandidate {
  readonly process: ChildProcess;
  settled: Promise<void>;
  outcome: ChildProcessOutcome | undefined;
  stderrTail: string;
  stdoutTail: string;
}

/**
 * Resolves a development server for a framework adapter.
 *
 * A healthy loopback URL in the app root's state file is reused. Otherwise the
 * adapter starts the normal `eve dev` child and waits for that child to publish
 * its ready URL.
 */
export async function resolveSharedDevelopmentServer(input: {
  readonly appRoot: string;
  readonly timeoutMs: number;
}): Promise<SharedDevelopmentServerHandle> {
  const deadline = Date.now() + input.timeoutMs;
  const project = await withDeadline(resolveDiscoveryProject(input.appRoot), deadline, () =>
    createResolutionTimeout({
      appRoot: input.appRoot,
      candidate: undefined,
      serverUrl: undefined,
      timeoutMs: input.timeoutMs,
    }),
  );
  const state = new DevelopmentServerState(project);
  let candidate: DevelopmentServerCandidate | undefined;
  let serverUrl: string | undefined;

  try {
    for (;;) {
      throwIfDeadlineReached({
        appRoot: project.appRoot,
        candidate,
        deadline,
        serverUrl,
        timeoutMs: input.timeoutMs,
      });
      serverUrl = await withDeadline(state.read(), deadline, () =>
        createResolutionTimeout({
          appRoot: project.appRoot,
          candidate,
          serverUrl,
          timeoutMs: input.timeoutMs,
        }),
      );

      if (serverUrl !== undefined) {
        if (!isLoopbackServerUrl(serverUrl)) {
          throw new Error(
            `Development server for "${project.appRoot}" published a non-loopback URL (${serverUrl}); refusing to attach.`,
          );
        }

        const healthy = await withDeadline(
          isEveServerHealthy(serverUrl, {
            timeoutMs: Math.min(remainingTime(deadline), 1_000),
          }),
          deadline,
          () =>
            createResolutionTimeout({
              appRoot: project.appRoot,
              candidate,
              serverUrl,
              timeoutMs: input.timeoutMs,
            }),
        );
        if (healthy) {
          return candidate === undefined || candidate.outcome !== undefined
            ? { origin: serverUrl }
            : createOwnedDevelopmentServerHandle(serverUrl, candidate);
        }
      }

      if (candidate?.outcome !== undefined) {
        throw createCandidateFailure(candidate, project.appRoot);
      }
      candidate ??= spawnDevelopmentServerCandidate(project.appRoot);
      await waitForStateChange(candidate, deadline);
    }
  } catch (error) {
    if (candidate !== undefined) {
      try {
        await terminateCandidate(candidate);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `Failed to resolve and clean up the development-server candidate for "${project.appRoot}".`,
        );
      }
    }
    throw error;
  }
}

function spawnDevelopmentServerCandidate(appRoot: string): DevelopmentServerCandidate {
  const child = spawn(
    process.execPath,
    [join(resolvePackageRoot(), "bin", "eve.js"), "dev", "--no-ui", "--port", "0"],
    {
      cwd: appRoot,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const candidate: DevelopmentServerCandidate = {
    outcome: undefined,
    process: child,
    settled: Promise.resolve(),
    stderrTail: "",
    stdoutTail: "",
  };
  candidate.settled = new Promise((resolvePromise) => {
    const settle = (outcome: ChildProcessOutcome) => {
      if (candidate.outcome !== undefined) {
        return;
      }
      candidate.outcome = outcome;
      resolvePromise();
    };

    child.once("error", (error) => settle({ error, kind: "error" }));
    child.once("exit", (code, signal) => settle({ code, kind: "exit", signal }));
  });
  child.stdout?.on("data", (chunk: Buffer) => {
    process.stdout.write(chunk);
    candidate.stdoutTail = appendOutputTail(candidate.stdoutTail, chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(chunk);
    candidate.stderrTail = appendOutputTail(candidate.stderrTail, chunk);
  });
  return candidate;
}

function appendOutputTail(current: string, chunk: Buffer): string {
  return `${current}${chunk.toString("utf8")}`.slice(-MAX_CHILD_OUTPUT_TAIL_LENGTH);
}

async function waitForStateChange(
  candidate: DevelopmentServerCandidate,
  deadline: number,
): Promise<void> {
  const waitMs = Math.min(DEVELOPMENT_SERVER_POLL_MS, remainingTime(deadline));
  await Promise.race([delay(waitMs), candidate.settled]);
}

function remainingTime(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

function throwIfDeadlineReached(input: {
  readonly appRoot: string;
  readonly candidate: DevelopmentServerCandidate | undefined;
  readonly deadline: number;
  readonly serverUrl: string | undefined;
  readonly timeoutMs: number;
}): void {
  if (Date.now() < input.deadline) {
    return;
  }

  throw createResolutionTimeout(input);
}

function createResolutionTimeout(input: {
  readonly appRoot: string;
  readonly candidate: DevelopmentServerCandidate | undefined;
  readonly serverUrl: string | undefined;
  readonly timeoutMs: number;
}): Error {
  const stateStatus =
    input.serverUrl === undefined
      ? "no server URL was recorded"
      : `recorded URL ${input.serverUrl} was not healthy`;
  const candidateStatus =
    input.candidate === undefined
      ? "no child was spawned"
      : input.candidate.outcome === undefined
        ? `child ${String(input.candidate.process.pid)} is still running`
        : "the spawned child exited before a reusable server became ready";
  return new Error(
    `Timed out after ${input.timeoutMs}ms resolving the development server for "${input.appRoot}" (${stateStatus}; ${candidateStatus}).`,
  );
}

async function withDeadline<T>(
  operation: Promise<T>,
  deadline: number,
  createTimeoutError: () => Error,
): Promise<T> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    throw createTimeoutError();
  }

  const timeoutController = new AbortController();
  try {
    return await Promise.race([
      operation,
      delay(remainingMs, undefined, { signal: timeoutController.signal }).then(() => {
        throw createTimeoutError();
      }),
    ]);
  } finally {
    timeoutController.abort();
  }
}

function createCandidateFailure(candidate: DevelopmentServerCandidate, appRoot: string): Error {
  const outcome = candidate.outcome;
  if (outcome === undefined) {
    return new Error(`Development-server child for "${appRoot}" did not publish a healthy URL.`);
  }

  const summary =
    outcome.kind === "error"
      ? outcome.error.message
      : `exit code ${String(outcome.code)}, signal ${String(outcome.signal)}`;
  const output = [
    candidate.stdoutTail.length > 0 ? `stdout:\n${candidate.stdoutTail}` : undefined,
    candidate.stderrTail.length > 0 ? `stderr:\n${candidate.stderrTail}` : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join("\n\n");
  return new Error(
    `Development-server child for "${appRoot}" failed before publishing a healthy URL (${summary}).${output.length > 0 ? `\n\n${output}` : ""}`,
    outcome.kind === "error" ? { cause: outcome.error } : undefined,
  );
}

async function terminateCandidate(candidate: DevelopmentServerCandidate): Promise<void> {
  if (candidate.outcome !== undefined) {
    return;
  }

  candidate.process.kill("SIGTERM");
  await waitForCandidateExit(candidate, DEVELOPMENT_SERVER_SHUTDOWN_GRACE_MS);
  if (candidate.outcome !== undefined) {
    return;
  }

  candidate.process.kill("SIGKILL");
  await waitForCandidateExit(candidate, DEVELOPMENT_SERVER_SHUTDOWN_GRACE_MS);
  if (candidate.outcome === undefined) {
    throw new Error(
      `Development-server child ${String(candidate.process.pid)} did not exit after SIGTERM and SIGKILL.`,
    );
  }
}

async function waitForCandidateExit(
  candidate: DevelopmentServerCandidate,
  timeoutMs: number,
): Promise<void> {
  await Promise.race([candidate.settled, delay(timeoutMs)]);
}

function createOwnedDevelopmentServerHandle(
  origin: string,
  candidate: DevelopmentServerCandidate,
): SharedDevelopmentServerHandle {
  const child = candidate.process;
  const close = () => {
    if (!child.killed) {
      child.kill();
    }
  };
  const removeHooks = () => {
    process.off("exit", close);
  };

  process.once("exit", close);
  child.once("error", removeHooks);
  child.once("exit", removeHooks);
  return {
    close: () => terminateCandidate(candidate),
    origin,
    process: child,
  };
}
