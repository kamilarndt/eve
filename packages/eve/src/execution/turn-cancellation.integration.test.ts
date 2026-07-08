import { describe, expect, it } from "vitest";
import { getWorld, resumeHook, start } from "#internal/workflow/runtime.js";

import { createTestRuntime, type TestRuntime } from "#internal/testing/app-harness.js";
import {
  captureTurnEvents,
  containsEventSequence,
  filterEventsByType,
} from "#internal/testing/events.js";
import { waitForHook } from "#internal/testing/workflow-test-helpers.js";
import { ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/manifest.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { turnCancelHookToken } from "#execution/turn-cancellation-control.js";
import { workflowEntry } from "#execution/workflow-entry.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";
import type { ToolContext } from "#public/definitions/tool.js";
import type { ResolvedToolDefinition } from "#runtime/types.js";

/**
 * Layer-1 turn cancellation: resuming a turn's `{completionToken}:cancel`
 * hook mid-turn settles the turn as `turn.cancelled` → `session.waiting`
 * with zero failure events, no step retries, and a session that accepts
 * the next message normally. (The HTTP trigger arrives in layer 2; these
 * tests resume the hook directly.)
 */

const FAILURE_EVENT_TYPES = ["step.failed", "turn.failed", "session.failed"] as const;
const WAIT_TOOL_NAME = "wait_for_cancel";

function buildSerializedContext(overrides: {
  channelKind: string;
  continuationToken: string;
  mode: string;
}): Record<string, unknown> {
  return {
    "eve.auth": null,
    "eve.bundle": { source: createBundledRuntimeCompiledArtifactsSource() },
    "eve.channel": { kind: overrides.channelKind, state: {} },
    "eve.continuationToken": overrides.continuationToken,
    "eve.mode": overrides.mode,
  };
}

/**
 * Builds an authored tool that hangs until the layer-0 turn signal
 * aborts, then rejects with the signal's reason — the deterministic
 * mid-turn anchor for cancellation tests.
 */
function buildWaitForCancelTool(onStart: () => void): ResolvedToolDefinition {
  return {
    description: "Waits until the turn is cancelled.",
    execute: (_input: unknown, rawCtx: unknown) => {
      const ctx = rawCtx as ToolContext;
      onStart();
      return new Promise((_resolve, reject) => {
        if (ctx.abortSignal.aborted) {
          reject(ctx.abortSignal.reason);
          return;
        }
        ctx.abortSignal.addEventListener("abort", () => reject(ctx.abortSignal.reason), {
          once: true,
        });
      });
    },
    inputSchema: { additionalProperties: false, properties: {}, type: "object" },
    logicalPath: `tools/${WAIT_TOOL_NAME}.ts`,
    name: WAIT_TOOL_NAME,
    sourceId: `tools/${WAIT_TOOL_NAME}.ts`,
    sourceKind: "module",
  };
}

interface WaitToolFixture {
  readonly runtime: TestRuntime;
  readonly toolStarted: Promise<void>;
  toolStarts(): number;
}

function createWaitToolRuntime(agentName: string): WaitToolFixture {
  let starts = 0;
  let resolveStarted: (() => void) | undefined;
  const toolStarted = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const waitTool = buildWaitForCancelTool(() => {
    starts += 1;
    resolveStarted?.();
  });
  const runtime = createTestRuntime({ agent: { name: agentName }, tools: [waitTool] });
  const manifestTool = runtime.manifest.tools.find((tool) => tool.name === WAIT_TOOL_NAME);
  if (manifestTool === undefined) {
    throw new Error(`Expected ${WAIT_TOOL_NAME} to be present in the test manifest.`);
  }
  runtime.moduleMap.nodes[ROOT_COMPILED_AGENT_NODE_ID]!.modules[manifestTool.sourceId] = {
    default: { execute: waitTool.execute },
  };
  return { runtime, toolStarted, toolStarts: () => starts };
}

/** First-turn cancel token for a session driven by `workflowEntry`. */
function firstTurnCancelToken(sessionId: string): string {
  return turnCancelHookToken(`${sessionId}:turn-control:0`);
}

/** Polls the world for a hook row by token (hooks are per-run; the token is global). */
async function waitForHookByToken(token: string, timeout = 15_000): Promise<{ runId: string }> {
  const world = await getWorld();
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const hook = await world.hooks.getByToken(token);
      if (hook !== null && hook !== undefined) {
        return hook;
      }
    } catch {
      // Not registered yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for hook token "${token}".`);
}

/**
 * The retry canary: an aborted `turnStep` settles by *returning*, so the
 * turn workflow run must record no `step_failed`/`step_retrying` events
 * (nothing thrown ever crosses the step boundary) and at most one
 * `step_completed` per correlation id. Duplicate `step_started` entries
 * are allowed: the runtime may supersede an aborted attempt and
 * re-dispatch the step under the same correlation id — the entry abort
 * check makes the superseding attempt side-effect free.
 */
async function expectNoStepRetries(runId: string): Promise<void> {
  const world = await getWorld();
  const completions = new Map<string, number>();
  const failureEvents: string[] = [];
  let cursor: string | undefined;

  do {
    const pagination: { cursor?: string; limit: number } = { limit: 1000 };
    if (cursor !== undefined) {
      pagination.cursor = cursor;
    }
    const page = await world.events.list({ pagination, resolveData: "none", runId });
    const events: readonly { correlationId?: string | null; eventType?: string }[] = page.data;
    for (const event of events) {
      if (event.eventType === "step_failed" || event.eventType === "step_retrying") {
        failureEvents.push(`${event.eventType}:${String(event.correlationId ?? "?")}`);
      }
      if (event.eventType === "step_completed") {
        const correlationId = String(event.correlationId ?? "?");
        completions.set(correlationId, (completions.get(correlationId) ?? 0) + 1);
      }
    }
    cursor = page.hasMore === true && page.cursor !== null ? page.cursor : undefined;
  } while (cursor !== undefined);

  expect(failureEvents).toEqual([]);
  expect([...completions.entries()].filter(([, count]) => count > 1)).toEqual([]);
}

function expectNoFailureEvents(events: readonly HandleMessageStreamEvent[]): void {
  const types = events.map((event) => event.type);
  for (const failureType of FAILURE_EVENT_TYPES) {
    expect(types).not.toContain(failureType);
  }
}

describe("turn cancellation integration", () => {
  it("cancels a turn mid-tool and accepts the next message normally", async () => {
    const fixture = createWaitToolRuntime("turn-cancel-tool");
    const continuationToken = "http:turn-cancel-tool";

    await fixture.runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          input: { message: `Use the ${WAIT_TOOL_NAME} tool.` },
          serializedContext: buildSerializedContext({
            channelKind: "http",
            continuationToken,
            mode: "conversation",
          }),
        },
      ]);
      const stream = captureTurnEvents(run);

      try {
        const cancelToken = firstTurnCancelToken(run.runId);
        const cancelHook = await waitForHookByToken(cancelToken);
        await fixture.toolStarted;
        await resumeHook(cancelToken, {});

        const cancelledTurn = await stream.nextTurn();

        // A duplicate cancel after the turn settled is a benign no-op:
        // it lands on a consumed/disposed hook and must not disturb the
        // session. (Same-instant duplicates are serialized by the
        // trigger in layer 2: an extra payload racing the settle can
        // re-dispatch in-flight steps under the runtime's at-least-once
        // execution and double-emit the epilogue.)
        await resumeHook(cancelToken, {}).catch(() => undefined);

        expect(cancelledTurn.at(-1)?.type).toBe("session.waiting");
        expect(
          containsEventSequence(cancelledTurn, [
            "turn.started",
            "turn.cancelled",
            "session.waiting",
          ]),
        ).toBe(true);
        expect(filterEventsByType(cancelledTurn, "turn.started")).toHaveLength(1);
        expect(filterEventsByType(cancelledTurn, "turn.cancelled")).toHaveLength(1);
        // The superseding step attempt settles before any model work, so
        // the cancelled turn streams exactly one step.
        expect(filterEventsByType(cancelledTurn, "step.started")).toHaveLength(1);
        expectNoFailureEvents(cancelledTurn);
        expect(fixture.toolStarts()).toBe(1);

        await expectNoStepRetries(cancelHook.runId);

        await waitForHook({ runId: run.runId }, { token: continuationToken });
        await resumeHook(continuationToken, {
          kind: "deliver",
          payloads: [{ message: "follow up after cancel" }],
        });

        const followUpTurn = await stream.nextTurn();

        expect(followUpTurn.at(-1)?.type).toBe("session.waiting");
        expect(filterEventsByType(followUpTurn, "turn.cancelled")).toHaveLength(0);
        expectNoFailureEvents(followUpTurn);
        expect(
          followUpTurn.some(
            (event) =>
              event.type === "message.completed" &&
              event.data.message?.includes("follow up after cancel") === true,
          ),
        ).toBe(true);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });

  it("cancels a turn waiting on an in-flight subagent and does not re-dispatch it", async () => {
    const fixture = createWaitToolRuntime("turn-cancel-subagent");
    const continuationToken = "http:turn-cancel-subagent";

    await fixture.runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          input: { message: `Delegate to a subagent: use the ${WAIT_TOOL_NAME} tool.` },
          serializedContext: buildSerializedContext({
            channelKind: "http",
            continuationToken,
            mode: "conversation",
          }),
        },
      ]);
      const stream = captureTurnEvents(run);

      try {
        // The child (a fresh copy of the same agent) hangs on the wait
        // tool, holding the parent in `waitForRuntimeActionResults`.
        await fixture.toolStarted;

        const cancelToken = firstTurnCancelToken(run.runId);
        await waitForHookByToken(cancelToken);
        await resumeHook(cancelToken, {});

        const cancelledTurn = await stream.nextTurn();

        expect(cancelledTurn.at(-1)?.type).toBe("session.waiting");
        expect(filterEventsByType(cancelledTurn, "turn.cancelled")).toHaveLength(1);
        expect(filterEventsByType(cancelledTurn, "subagent.called")).toHaveLength(1);
        expectNoFailureEvents(cancelledTurn);

        // Unblock the orphaned child (no cascade in layer 1 — its late
        // result lands on the parent's disposed inbox and is dropped).
        const childSessionId = filterEventsByType(cancelledTurn, "subagent.called")[0]?.data
          .childSessionId;
        expect(childSessionId).toBeDefined();
        const childCancelToken = firstTurnCancelToken(childSessionId ?? "");
        await waitForHookByToken(childCancelToken);
        await resumeHook(childCancelToken, {}).catch(() => undefined);

        // The cleared pending batch must not re-dispatch on the next turn.
        await waitForHook({ runId: run.runId }, { token: continuationToken });
        await resumeHook(continuationToken, {
          kind: "deliver",
          payloads: [{ message: "follow up after subagent cancel" }],
        });

        const followUpTurn = await stream.nextTurn();

        expect(followUpTurn.at(-1)?.type).toBe("session.waiting");
        expect(filterEventsByType(followUpTurn, "subagent.called")).toHaveLength(0);
        expect(filterEventsByType(followUpTurn, "turn.cancelled")).toHaveLength(0);
        expectNoFailureEvents(followUpTurn);
        expect(
          followUpTurn.some(
            (event) =>
              event.type === "message.completed" &&
              event.data.message?.includes("follow up after subagent cancel") === true,
          ),
        ).toBe(true);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  }, 60_000);

  it("treats a cancel after the turn settled as a benign no-op", async () => {
    const runtime = createTestRuntime({ agent: { name: "turn-cancel-late" } });
    const continuationToken = "http:turn-cancel-late";

    await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          input: { message: "hello there" },
          serializedContext: buildSerializedContext({
            channelKind: "http",
            continuationToken,
            mode: "conversation",
          }),
        },
      ]);
      const stream = captureTurnEvents(run);

      try {
        const firstTurn = await stream.nextTurn();
        expect(firstTurn.at(-1)?.type).toBe("session.waiting");
        expect(filterEventsByType(firstTurn, "turn.completed")).toHaveLength(1);

        // The turn workflow has settled and disposed its cancel hook; a
        // late cancel either rejects (hook gone) or lands unconsumed.
        await resumeHook(firstTurnCancelToken(run.runId), {}).catch(() => undefined);

        await waitForHook({ runId: run.runId }, { token: continuationToken });
        await resumeHook(continuationToken, {
          kind: "deliver",
          payloads: [{ message: "follow up after late cancel" }],
        });

        const secondTurn = await stream.nextTurn();

        expect(secondTurn.at(-1)?.type).toBe("session.waiting");
        expect(filterEventsByType(secondTurn, "turn.cancelled")).toHaveLength(0);
        expectNoFailureEvents(secondTurn);
        expect(
          secondTurn.some(
            (event) =>
              event.type === "message.completed" &&
              event.data.message?.includes("follow up after late cancel") === true,
          ),
        ).toBe(true);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });

  it("completes settled turn runs so the world sweeps their hooks", async () => {
    const runtime = createTestRuntime({ agent: { name: "turn-cancel-sweep" } });
    const continuationToken = "http:turn-cancel-sweep";

    await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          input: { message: "first turn" },
          serializedContext: buildSerializedContext({
            channelKind: "http",
            continuationToken,
            mode: "conversation",
          }),
        },
      ]);
      const stream = captureTurnEvents(run);

      try {
        expect((await stream.nextTurn()).at(-1)?.type).toBe("session.waiting");

        await waitForHook({ runId: run.runId }, { token: continuationToken });
        await resumeHook(continuationToken, {
          kind: "deliver",
          payloads: [{ message: "second turn" }],
        });
        expect((await stream.nextTurn()).at(-1)?.type).toBe("session.waiting");

        // The turn run's teardown must not await the cancel hook's
        // outstanding read: a turn run that never returns stays
        // `running` forever and its hooks (inbox, cancel, durable-abort)
        // are never swept — one leaked run and three leaked hooks per
        // turn, and O(live hooks) token scans slow every resume.
        const world = await getWorld();
        const deadline = Date.now() + 15_000;
        let completedTurnRuns = 0;
        let cancelHooks = 0;
        while (Date.now() < deadline) {
          const cancelToken0 = firstTurnCancelToken(run.runId);
          const cancelHook0 = await world.hooks.getByToken(cancelToken0).catch(() => null);
          cancelHooks = cancelHook0 === null ? 0 : 1;

          const runsPage = await world.runs.list({ pagination: { limit: 100 } });
          completedTurnRuns = runsPage.data.filter(
            (row: { status?: string; workflowName?: string }) =>
              row.workflowName?.includes("turnWorkflow") === true && row.status === "completed",
          ).length;

          if (completedTurnRuns >= 1 && cancelHooks === 0) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }

        // The first turn settled a full turn ago: its run must have
        // completed and its cancel hook must be gone from the world.
        expect(completedTurnRuns).toBeGreaterThanOrEqual(1);
        expect(cancelHooks).toBe(0);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  }, 60_000);
});
