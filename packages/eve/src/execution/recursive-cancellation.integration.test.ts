import { describe, expect, it } from "vitest";

import type { ChannelAdapter } from "#channel/adapter.js";
import {
  createCompiledAgentNodeManifest,
  createCompiledSubagentNodeId,
  ROOT_COMPILED_AGENT_NODE_ID,
  type CompiledAgentManifest,
  type CompiledAgentNodeManifest,
  type CompiledSubagentEdge,
  type CompiledSubagentNode,
  type CompiledToolDefinition,
} from "#compiler/manifest.js";
import type { CompiledModuleMap } from "#compiler/module-map.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { createTestRuntime, type TestRuntime } from "#internal/testing/app-harness.js";
import { getWorld } from "#internal/workflow/runtime.js";
import type { ToolContext } from "#public/definitions/tool.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";

const TERMINAL_STATUSES = new Set(["cancelled", "completed", "failed"]);

describe("recursive workflow cancellation", () => {
  it("waits for two local children and a grandchild to become terminal", async () => {
    const grandchildAbortSeen = deferred<void>();
    const releaseGrandchild = deferred<void>();
    const siblingBlockStarted = deferred<void>();
    const grandchildStarted = deferred<void>();
    const runtime = createTestRuntime({ agent: { name: "recursive-cancellation" } });
    installCancellationGraph(runtime, {
      grandchildAbortSeen,
      grandchildStarted,
      releaseGrandchild,
      siblingBlockStarted,
    });

    await runtime.run(async () => {
      const bundle = await getCompiledRuntimeAgentBundle({
        compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
      });
      expect([...bundle.graph.root.subagentRegistry.subagentsByName.keys()]).toEqual(["child_a"]);
      expect([
        ...bundle.graph.nodesByNodeId
          .get("memory::subagents/child_a.ts")!
          .subagentRegistry.subagentsByName.keys(),
      ]).toEqual(["grandchild"]);
      const workflowRuntime = createWorkflowRuntime({
        compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
      });
      const rootProgram = `return await Promise.all([
          tools["child\\u005fa"]({ message: "Use grand\\u0063hild and wait" }),
          tools["child\\u005fa"](${JSON.stringify({ message: "Use block_a and wait" })}),
        ]);`;
      const handle = await workflowRuntime.run({
        adapter: { kind: "http" } satisfies ChannelAdapter,
        auth: null,
        input: {
          message: `Use Workflow with js: \`${rootProgram}\``,
        },
        mode: "task",
      });

      try {
        await withTimeout(siblingBlockStarted.promise, "blocking sibling to start");
        await withTimeout(grandchildStarted.promise, "blocking grandchild to start");
      } catch (error) {
        const runs = await listRootRunFamily(handle.sessionId);
        throw new Error(`Descendants did not start: family=${JSON.stringify(runs)}`, {
          cause: error,
        });
      }

      let cancellationSettled = false;
      const cancellation = workflowRuntime.cancel(handle.sessionId).finally(() => {
        cancellationSettled = true;
      });
      await withTimeout(grandchildAbortSeen.promise, "grandchild abort signal");

      expect(cancellationSettled).toBe(false);
      const active = await listRootRunFamily(handle.sessionId);
      expect(active.some((run) => !TERMINAL_STATUSES.has(run.status))).toBe(true);

      releaseGrandchild.resolve();
      await withTimeout(cancellation, "recursive cancellation settlement");

      const settled = await waitForRootRunFamilyToSettle(handle.sessionId);
      expect(settled).toHaveLength(8);
      expect(settled.every((run) => TERMINAL_STATUSES.has(run.status))).toBe(true);
      expect(settled.filter((run) => run.attributes?.["$eve.type"] === "subagent")).toHaveLength(3);
      expect(settled.filter((run) => run.attributes?.["$eve.type"] === "turn")).toHaveLength(4);
    });
  }, 30_000);
});

interface CancellationGraphSignals {
  readonly grandchildAbortSeen: Deferred<void>;
  readonly grandchildStarted: Deferred<void>;
  readonly releaseGrandchild: Deferred<void>;
  readonly siblingBlockStarted: Deferred<void>;
}

function installCancellationGraph(runtime: TestRuntime, signals: CancellationGraphSignals): void {
  const childASourceId = "memory::subagents/child_a.ts";
  const grandchildSourceId = "memory::subagents/grandchild.ts";
  const childAId = createCompiledSubagentNodeId(ROOT_COMPILED_AGENT_NODE_ID, childASourceId);
  const grandchildId = createCompiledSubagentNodeId(childAId, grandchildSourceId);
  const blockA = toolDefinition("block_a");
  const blockGrandchild = toolDefinition("block_grandchild");

  const subagents: CompiledSubagentNode[] = [
    subagentNode(runtime.manifest, {
      description: "Runs one local task.",
      name: "child_a",
      nodeId: childAId,
      sourceId: childASourceId,
      tools: [blockA],
    }),
    subagentNode(runtime.manifest, {
      description: "Use block_grandchild and wait until cancellation.",
      name: "grandchild",
      nodeId: grandchildId,
      sourceId: grandchildSourceId,
      tools: [blockGrandchild],
    }),
  ];
  const edges: CompiledSubagentEdge[] = [
    { childNodeId: childAId, parentNodeId: ROOT_COMPILED_AGENT_NODE_ID },
    { childNodeId: grandchildId, parentNodeId: childAId },
  ];

  const manifest = runtime.manifest as CompiledAgentManifest & {
    subagentEdges: CompiledSubagentEdge[];
    subagents: CompiledSubagentNode[];
    workflowEnabled: boolean;
  };
  manifest.workflowEnabled = true;
  manifest.config.limits = {
    ...manifest.config.limits,
    maxSubagentDepth: 2,
  };
  manifest.subagents.push(...subagents);
  manifest.subagentEdges.push(...edges);

  const moduleMap = runtime.moduleMap as CompiledModuleMap & {
    nodes: Record<string, { modules: Record<string, Record<string, unknown>> }>;
  };
  moduleMap.nodes[childAId] = {
    modules: {
      [blockA.sourceId]: {
        default: blockingTool({
          name: "block_a",
          onStart: signals.siblingBlockStarted.resolve,
        }),
      },
    },
  };
  moduleMap.nodes[grandchildId] = {
    modules: {
      [blockGrandchild.sourceId]: {
        default: blockingTool({
          name: "block_grandchild",
          onAbort: signals.grandchildAbortSeen.resolve,
          onStart: signals.grandchildStarted.resolve,
          releaseAfterAbort: signals.releaseGrandchild.promise,
        }),
      },
    },
  };
}

function subagentNode(
  root: CompiledAgentManifest,
  input: {
    readonly description: string;
    readonly name: string;
    readonly nodeId: string;
    readonly sourceId: string;
    readonly tools: readonly CompiledToolDefinition[];
  },
): CompiledSubagentNode {
  const agent: CompiledAgentNodeManifest = createCompiledAgentNodeManifest({
    agentRoot: `/virtual/agent/subagents/${input.name}`,
    appRoot: root.appRoot,
    config: {
      ...root.config,
      description: input.description,
      name: input.name,
    },
    tools: input.tools,
  });
  return {
    agent,
    description: input.description,
    entryPath: `subagents/${input.name}/agent.ts`,
    logicalPath: `subagents/${input.name}`,
    name: input.name,
    nodeId: input.nodeId,
    rootPath: `/virtual/agent/subagents/${input.name}`,
    sourceId: input.sourceId,
    sourceKind: "module",
  };
}

function toolDefinition(name: string): CompiledToolDefinition {
  return {
    description: `${name} blocks until cancellation.`,
    inputSchema: { additionalProperties: false, properties: {}, type: "object" },
    logicalPath: `tools/${name}.ts`,
    name,
    sourceId: `memory::tools/${name}.ts`,
    sourceKind: "module",
  };
}

function blockingTool(input: {
  readonly name: string;
  readonly onAbort?: () => void;
  readonly onStart: () => void;
  readonly releaseAfterAbort?: Promise<void>;
}) {
  return {
    description: `${input.name} blocks until cancellation.`,
    inputSchema: { additionalProperties: false, properties: {}, type: "object" },
    name: input.name,
    async execute(_value: unknown, context: ToolContext): Promise<never> {
      input.onStart();
      return await new Promise<never>((_resolve, reject) => {
        const abort = (): void => {
          input.onAbort?.();
          void (input.releaseAfterAbort ?? Promise.resolve()).then(() => {
            reject(context.abortSignal.reason ?? new Error("turn cancelled"));
          });
        };
        if (context.abortSignal.aborted) {
          abort();
          return;
        }
        context.abortSignal.addEventListener("abort", abort, { once: true });
      });
    },
  };
}

interface WorldRunRecord {
  readonly attributes?: Record<string, string>;
  readonly runId: string;
  readonly status: string;
}

async function listRootRunFamily(rootRunId: string): Promise<WorldRunRecord[]> {
  const world = await getWorld();
  const listed = await world.runs.list({ pagination: { limit: 1000 }, resolveData: "none" });
  return listed.data
    .filter(
      (run) =>
        run.runId === rootRunId ||
        (run.attributes as Record<string, string> | undefined)?.["$eve.root"] === rootRunId,
    )
    .map((run) => ({
      attributes: run.attributes as Record<string, string> | undefined,
      runId: run.runId,
      status: run.status,
    }));
}

async function waitForRootRunFamilyToSettle(rootRunId: string): Promise<WorldRunRecord[]> {
  return await withTimeout(
    (async () => {
      while (true) {
        const runs = await listRootRunFamily(rootRunId);
        if (runs.length === 8 && runs.every((run) => TERMINAL_STATUSES.has(run.status))) {
          return runs;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    })(),
    "all recursive workflow runs to settle",
  );
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), 10_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
