import { describe, expect, it } from "vitest";
import { getWorld, resumeHook, start } from "#compiled/@workflow/core/runtime.js";

import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { captureTurnEvents, filterEventsByType } from "#internal/testing/events.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { mockTool } from "#internal/testing/mocks/mock-tool.js";
import { waitForHook } from "#internal/testing/workflow-test-helpers.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { workflowEntry } from "#execution/workflow-entry.js";

function buildSerializedContext(overrides: {
  channelKind: string;
  continuationToken: string;
  mode: string;
  parent?: {
    readonly callId: string;
    readonly rootSessionId: string;
    readonly sessionId: string;
    readonly turn: {
      readonly id: string;
      readonly sequence: number;
    };
  };
}): Record<string, unknown> {
  const context: Record<string, unknown> = {
    "eve.auth": null,
    "eve.bundle": { source: createBundledRuntimeCompiledArtifactsSource() },
    "eve.channel": { kind: overrides.channelKind, state: {} },
    "eve.continuationToken": overrides.continuationToken,
    "eve.mode": overrides.mode,
  };
  if (overrides.parent !== undefined) {
    context["eve.parentSession"] = overrides.parent;
  }
  return context;
}

describe("workflowEntry integration", () => {
  it("cancels one active turn and resumes the same entry session", async () => {
    const blocking = createBlockingCancellationTool();
    const app = createTestRuntime({
      agent: { name: "workflow-entry-turn-cancellation" },
      tools: [blocking.tool],
    });
    const continuationToken = "http:workflow-entry-turn-cancellation";

    await app.run(async () => {
      const compiledArtifactsSource = createBundledRuntimeCompiledArtifactsSource();
      const runtime = createWorkflowRuntime({
        compiledArtifactsSource,
      });
      const run = await start(workflowEntry, [
        {
          input: { message: "call wait_for_cancellation" },
          serializedContext: buildSerializedContext({
            channelKind: "http",
            continuationToken,
            mode: "conversation",
          }),
        },
      ]);
      await blocking.started;
      const stream = captureTurnEvents(run);

      try {
        await runtime.cancelTurn({ sessionId: run.runId });
        await blocking.aborted;

        const cancelledTurn = await stream.nextTurn();
        expect(cancelledTurn.map((event) => event.type)).toContain("turn.cancelled");
        expect(cancelledTurn.at(-1)?.type).toBe("session.waiting");

        await expect(runtime.cancelTurn({ sessionId: run.runId })).resolves.toBeUndefined();

        const followUp = await runtime.deliver({
          auth: null,
          continuationToken,
          payload: { message: "continue after cancellation" },
        });
        expect(followUp.sessionId).toBe(run.runId);

        let resumedTurn = await stream.nextTurn();
        while (isCancellationBoundary(resumedTurn)) {
          resumedTurn = await stream.nextTurn();
        }
        expect(resumedTurn.at(-1)?.type).toBe("session.waiting");
        expect(
          resumedTurn.some(
            (event) =>
              event.type === "message.completed" &&
              event.data.message?.includes("continue after cancellation") === true,
          ),
        ).toBe(true);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });

  it("cancels an entry session and eventually releases its continuation", async () => {
    const blocking = createBlockingCancellationTool();
    const app = createTestRuntime({
      agent: { name: "workflow-entry-session-cancellation" },
      tools: [blocking.tool],
    });
    const continuationToken = "http:workflow-entry-session-cancellation";

    await app.run(async () => {
      const compiledArtifactsSource = createBundledRuntimeCompiledArtifactsSource();
      const runtime = createWorkflowRuntime({
        compiledArtifactsSource,
      });
      const run = await start(workflowEntry, [
        {
          input: { message: "call wait_for_cancellation" },
          serializedContext: buildSerializedContext({
            channelKind: "http",
            continuationToken,
            mode: "conversation",
          }),
        },
      ]);
      await blocking.started;
      const stream = captureTurnEvents(run);

      try {
        await runtime.cancelSession({ sessionId: run.runId });
        await blocking.aborted;

        const cancelledSession = await stream.nextTurn();
        expect(cancelledSession.map((event) => event.type)).toContain("turn.cancelled");
        expect(cancelledSession.at(-1)?.type).toBe("session.cancelled");
        await expect(run.returnValue).resolves.toEqual({ output: "" });

        const replacementRun = await start(workflowEntry, [
          {
            input: { message: "fresh session" },
            serializedContext: buildSerializedContext({
              channelKind: "http",
              continuationToken,
              mode: "conversation",
            }),
          },
        ]);
        const replacementStream = captureTurnEvents(replacementRun);

        try {
          expect(replacementRun.runId).not.toBe(run.runId);

          const freshTurn = await replacementStream.nextTurn();
          expect(freshTurn.at(-1)?.type).toBe("session.waiting");
          expect(
            freshTurn.some(
              (event) =>
                event.type === "message.completed" &&
                event.data.message?.includes("fresh session") === true,
            ),
          ).toBe(true);
        } finally {
          replacementStream.dispose();
          await replacementRun.cancel();
        }
      } finally {
        stream.dispose();
        if ((await run.status) === "running") await run.cancel();
      }
    });
  });

  it("treats authored session cancellation as non-retryable control flow", async () => {
    let executions = 0;
    const tool = mockTool({
      name: "cancel_session",
      execute(_input, ctx): never {
        executions += 1;
        return ctx.cancel({ scope: "session" });
      },
    });
    const app = createTestRuntime({
      agent: { name: "workflow-entry-authored-session-cancellation" },
      tools: [tool],
    });

    await app.run(async () => {
      const run = await start(workflowEntry, [
        {
          input: { message: "call cancel_session" },
          serializedContext: buildSerializedContext({
            channelKind: "http",
            continuationToken: "http:workflow-entry-authored-session-cancellation",
            mode: "conversation",
          }),
        },
      ]);
      const stream = captureTurnEvents(run);

      try {
        const events = await stream.nextTurn();
        expect(events.map((event) => event.type)).toContain("turn.cancelled");
        expect(events.at(-1)?.type).toBe("session.cancelled");
        expect(executions).toBe(1);
        await expect(run.returnValue).resolves.toEqual({ output: "" });
      } finally {
        stream.dispose();
        if ((await run.status) === "running") await run.cancel();
      }
    });
  });

  it("parks in conversation mode and resumes via the workflow hook", async () => {
    const runtime = createTestRuntime({ agent: { name: "workflow-entry-conversation" } });
    const continuationToken = "http:workflow-entry-conversation";

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
      const hook = await waitForHook(
        { runId: run.runId },
        {
          token: continuationToken,
        },
      );

      try {
        const firstTurn = await stream.nextTurn();

        expect(hook.token).toBe(continuationToken);
        expect(firstTurn.at(-1)?.type).toBe("session.waiting");
        expect(firstTurn.every((event) => typeof event.meta?.at === "string")).toBe(true);
        expect(
          firstTurn.some(
            (event) =>
              event.type === "message.completed" &&
              event.data.message?.includes("hello there") === true,
          ),
        ).toBe(true);

        await resumeHook(continuationToken, {
          kind: "deliver",
          payloads: [{ message: "follow up" }],
        });

        const secondTurn = await stream.nextTurn();

        expect(secondTurn.at(-1)?.type).toBe("session.waiting");
        expect(secondTurn.every((event) => typeof event.meta?.at === "string")).toBe(true);
        expect(
          secondTurn.some(
            (event) =>
              event.type === "message.completed" &&
              event.data.message?.includes("follow up") === true,
          ),
        ).toBe(true);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });

  it("emits completed structured results for a conversation turn outputSchema", async () => {
    const runtime = createTestRuntime({ agent: { name: "workflow-entry-output-schema" } });
    const continuationToken = "http:workflow-entry-output-schema";
    const outputSchema = {
      properties: {
        count: { type: "integer" },
        title: { type: "string" },
      },
      required: ["title", "count"],
      type: "object",
    } as const;

    await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          input: { message: "summarize this", outputSchema },
          serializedContext: buildSerializedContext({
            channelKind: "http",
            continuationToken,
            mode: "conversation",
          }),
        },
      ]);

      const stream = captureTurnEvents(run);
      await waitForHook(
        { runId: run.runId },
        {
          token: continuationToken,
        },
      );

      try {
        const firstTurn = await stream.nextTurn();
        const results = filterEventsByType(firstTurn, "result.completed");

        expect(results).toHaveLength(1);
        expect(results[0]?.data.result).toEqual({
          count: 1,
          title: "structured-output",
        });
        expect(firstTurn.at(-1)?.type).toBe("session.waiting");

        await resumeHook(continuationToken, {
          kind: "deliver",
          payloads: [{ message: "follow up without structured output" }],
        });

        const secondTurn = await stream.nextTurn();

        expect(filterEventsByType(secondTurn, "result.completed")).toHaveLength(0);
        expect(secondTurn.at(-1)?.type).toBe("session.waiting");
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });

  it("completes immediately in task mode", async () => {
    const runtime = createTestRuntime({ agent: { name: "workflow-entry-task" } });

    await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          input: { message: "hello there" },
          serializedContext: buildSerializedContext({
            channelKind: "http",
            continuationToken: "http:workflow-entry-task",
            mode: "task",
          }),
        },
      ]);

      await expect(run.returnValue).resolves.toEqual({
        output: expect.stringContaining("hello there"),
      });
      await expect(run.status).resolves.toBe("completed");
    });
  });

  it("returns agent-declared structured output in task mode", async () => {
    const outputSchema = {
      properties: {
        summary: { type: "string" },
      },
      required: ["summary"],
      type: "object",
    } as const;
    const runtime = createTestRuntime({
      agent: { name: "workflow-entry-task-output-schema", outputSchema },
    });

    await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          input: { message: "hello there" },
          serializedContext: buildSerializedContext({
            channelKind: "http",
            continuationToken: "http:workflow-entry-task-output-schema",
            mode: "task",
          }),
        },
      ]);

      await expect(run.returnValue).resolves.toEqual({
        output: { summary: "structured-output" },
      });
      await expect(run.status).resolves.toBe("completed");
    });
  });

  it("emits `$eve.*` session attributes onto the parent workflow run", async () => {
    const runtime = createTestRuntime({ agent: { name: "workflow-entry-tags" } });
    const continuationToken = "http:workflow-entry-tags";

    await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          input: { message: "session tag round-trip" },
          serializedContext: buildSerializedContext({
            channelKind: "http",
            continuationToken,
            mode: "conversation",
          }),
        },
      ]);

      const stream = captureTurnEvents(run);
      try {
        // Drain the first turn — by the time it completes `createSessionStep`
        // has run and emitted the session-level `$eve.*` keys from inside
        // its own step body.
        await stream.nextTurn();

        const world = await getWorld();
        const persisted = await world.runs.get(run.runId);
        const attrs = (persisted as { attributes?: Record<string, string> }).attributes ?? {};

        expect(attrs["$eve.type"]).toBe("session");
        expect(attrs["$eve.trigger"]).toBe("http");
        expect(attrs["$eve.title"]).toContain("session tag round-trip");
        // Top-level sessions have no parent or subagent name on the root run.
        expect(attrs["$eve.parent"]).toBeUndefined();
        expect(attrs["$eve.subagent"]).toBeUndefined();
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });

  it("emits parent lineage onto a subagent workflow run", async () => {
    const runtime = createTestRuntime({ agent: { name: "workflow-entry-subagent-tags" } });

    await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          input: { message: "subagent tag round-trip" },
          serializedContext: buildSerializedContext({
            channelKind: "subagent",
            continuationToken: "subagent:parent-session:call-subagent-1",
            mode: "task",
            parent: {
              callId: "call-subagent-1",
              rootSessionId: "root-session",
              sessionId: "parent-session",
              turn: { id: "turn-parent", sequence: 2 },
            },
          }),
        },
      ]);

      await expect(run.returnValue).resolves.toEqual({
        output: expect.stringContaining("subagent tag round-trip"),
      });
      await expect(run.status).resolves.toBe("completed");

      const world = await getWorld();
      const persisted = await world.runs.get(run.runId);
      const attrs = (persisted as { attributes?: Record<string, string> }).attributes ?? {};

      expect(attrs["$eve.type"]).toBe("subagent");
      expect(attrs["$eve.parent"]).toBe("parent-session");
      expect(attrs["$eve.parent_call"]).toBe("call-subagent-1");
      expect(attrs["$eve.parent_turn"]).toBe("turn-parent");
      expect(attrs["$eve.root"]).toBe("root-session");
      expect(attrs["$eve.trigger"]).toBe("subagent");
    });
  });
});

function createBlockingCancellationTool() {
  let markStarted: () => void = () => undefined;
  let markAborted: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const aborted = new Promise<void>((resolve) => {
    markAborted = resolve;
  });

  const tool = mockTool({
    name: "wait_for_cancellation",
    execute(_input, ctx) {
      markStarted();
      return new Promise<never>((_resolve, reject) => {
        const onAbort = () => {
          markAborted();
          reject(ctx.abortSignal.reason);
        };
        if (ctx.abortSignal.aborted) {
          onAbort();
          return;
        }
        ctx.abortSignal.addEventListener("abort", onAbort, { once: true });
      });
    },
  });

  return { aborted, started, tool };
}

function isCancellationBoundary(
  events: readonly import("#protocol/message.js").HandleMessageStreamEvent[],
): boolean {
  return events.some((event) => event.type === "turn.cancelled");
}
