import { describe, expect, it } from "vitest";
import { z } from "#compiled/zod/index.js";

import { ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/manifest.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { AuthKey, InitiatorAuthKey } from "#context/keys.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { getWorld } from "#internal/workflow/runtime.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { ExperimentalWorkflow } from "#public/definitions/tool.js";
import type {
  ExperimentalWorkflowAdvance,
  ExperimentalWorkflowSnapshot,
} from "#shared/experimental-workflow-definition.js";

const SOURCE_ID = "memory::tools/workflow.ts";
const REFERENCE = { loopId: "loop-1" };

describe("configured ExperimentalWorkflow controller integration", () => {
  it("runs the next iteration against the receiving definition, advances, and stops", async () => {
    const runtime = createTestRuntime({ agent: { name: "configured-workflow-controller" } });
    const cursor = {
      dueAt: new Date(Date.now() + 3_000).toISOString(),
      iteration: 0,
    };
    const events: string[] = [];
    const advanced = Promise.withResolvers<ExperimentalWorkflowAdvance<typeof REFERENCE>>();

    const originalDefinition = ExperimentalWorkflow({
      referenceSchema: z.object({ loopId: z.string() }),
      async load() {
        events.push("original:load");
        return snapshot(cursor, "original-definition");
      },
      async advance() {
        events.push("original:advance");
        throw new Error("The pinned definition must not advance the latest iteration.");
      },
    });
    const receivingDefinition = ExperimentalWorkflow({
      referenceSchema: z.object({ loopId: z.string() }),
      async load() {
        events.push("receiving:load");
        return snapshot(cursor, "receiving-definition");
      },
      async advance(input) {
        events.push("receiving:advance");
        cursor.iteration = input.expectedIteration + 1;
        cursor.dueAt = input.nextDueAt;
        advanced.resolve(input);
        return snapshot(cursor, "receiving-definition");
      },
    });

    installDefinition(runtime, originalDefinition);
    await runtime.run(async () => {
      const bundle = await getCompiledRuntimeAgentBundle({
        compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
      });
      const caller = new ContextContainer();
      caller.set(BundleKey, bundle);
      caller.set(ChannelKey, { kind: "http" });
      caller.set(AuthKey, null);
      caller.set(InitiatorAuthKey, null);

      await contextStorage.run(caller, async () => {
        const signal = new AbortController().signal;
        const started = await withTimeout(
          originalDefinition.start(REFERENCE, { abortSignal: signal }),
          "configured workflow controller start",
        );

        installDefinition(runtime, receivingDefinition);
        runtime.reset();
        await runtime.run(async () => {
          const advance = await withTimeout(advanced.promise, "configured workflow advance");
          expect(advance.reference).toEqual(REFERENCE);
          expect(advance.expectedIteration).toBe(0);
          expect(advance.outcome).toEqual({ kind: "completed", output: "receiving-definition" });
          const runs = await (
            await getWorld()
          ).runs.list({
            pagination: { limit: 100 },
            resolveData: "none",
          });
          expect(runs.data.map((run) => run.runId)).toContain(started.runId);
          await waitForIterationToSettle();

          await expect(
            withTimeout(
              originalDefinition.stop(
                { reason: "integration complete", reference: REFERENCE, runId: started.runId },
                { abortSignal: signal },
              ),
              "configured workflow controller stop",
            ),
          ).resolves.toEqual({ runId: started.runId, stopped: true });
        });
      });
    });

    expect(events.filter((event) => event === "original:load")).toHaveLength(2);
    expect(events).toContain("receiving:load");
    expect(events).toContain("receiving:advance");
    expect(events).not.toContain("original:advance");
  }, 20_000);
});

function installDefinition(
  runtime: ReturnType<typeof createTestRuntime>,
  definition: ReturnType<typeof ExperimentalWorkflow>,
): void {
  Object.assign(runtime.manifest, {
    experimentalWorkflow: {
      logicalPath: "tools/workflow.ts",
      sourceId: SOURCE_ID,
      sourceKind: "module",
    },
    workflowEnabled: true,
  });
  const root = runtime.moduleMap.nodes[ROOT_COMPILED_AGENT_NODE_ID];
  if (root === undefined) throw new Error("Test runtime has no root module scope.");
  root.modules[SOURCE_ID] = { default: definition };
}

function snapshot(
  cursor: { readonly dueAt: string; readonly iteration: number },
  value: string,
): ExperimentalWorkflowSnapshot<{ readonly value: string }> {
  return {
    cadence: { delaySeconds: 10, kind: "after-completion" },
    dueAt: cursor.dueAt,
    input: { value },
    iteration: cursor.iteration,
    program: { js: "return input.value" },
  };
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), 8_000);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function waitForIterationToSettle(): Promise<void> {
  const terminal = new Set(["cancelled", "completed", "failed"]);
  let observed: readonly { readonly runId: string; readonly status: string }[] = [];
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const runs = await (
      await getWorld()
    ).runs.list({
      pagination: { limit: 100 },
      resolveData: "none",
    });
    observed = runs.data;
    if (
      runs.data.some(
        (run) =>
          run.workflowName.endsWith("//experimentalWorkflowIteration") && terminal.has(run.status),
      )
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `Timed out waiting for configured workflow iteration to settle: ${JSON.stringify(observed)}.`,
  );
}
