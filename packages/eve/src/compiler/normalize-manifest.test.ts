import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentSourceManifest } from "#discover/manifest.js";
import {
  createAgentSourceManifest,
  createLocalSubagentSourceRef,
  createModuleSourceRef,
} from "#discover/manifest.js";
import { classifyModelRouting } from "#internal/classify-model-routing.js";
import type { CompiledAgentDefinition } from "#compiler/manifest.js";
import { compileAgentManifest } from "#compiler/normalize-manifest.js";
import { ExperimentalWorkflow } from "#public/definitions/tool.js";
import { z } from "#compiled/zod/index.js";

const mocks = vi.hoisted(() => ({
  compileAgentConfig: vi.fn(),
  loadModuleBackedDefinition: vi.fn(),
}));

vi.mock("#compiler/normalize-agent-config.js", () => ({
  compileAgentConfig: mocks.compileAgentConfig,
}));

vi.mock("#compiler/normalize-helpers.js", () => ({
  loadModuleBackedDefinition: mocks.loadModuleBackedDefinition,
}));

describe("compileAgentManifest", () => {
  beforeEach(() => {
    mocks.compileAgentConfig.mockReset();
    mocks.loadModuleBackedDefinition.mockReset();
  });

  it("rejects Workflow runtime configuration on subagents", async () => {
    const subagentManifest = createAgentSourceManifest({
      agentId: "research",
      agentRoot: "/app/agent/subagents/research",
      appRoot: "/app",
      configModule: createModuleSourceRef({
        logicalPath: "agent.ts",
      }),
    });
    const manifest = createAgentSourceManifest({
      agentId: "root",
      agentRoot: "/app/agent",
      appRoot: "/app",
      subagents: [
        createLocalSubagentSourceRef({
          entryPath: "subagents/research/agent.ts",
          logicalPath: "subagents/research",
          manifest: subagentManifest,
          rootPath: "/app/agent/subagents/research",
          subagentId: "research",
        }),
      ],
    });

    mocks.compileAgentConfig.mockImplementation(async (input: AgentSourceManifest) => {
      if (input.agentId === "research") {
        return createConfig({
          description: "Research subagent",
          name: "research",
          experimental: {
            workflow: {
              world: "@workflow/world-postgres",
            },
          },
        });
      }

      return createConfig({ name: "root" });
    });
    mocks.loadModuleBackedDefinition.mockResolvedValue({
      description: "Research subagent",
      model: "openai/gpt-5.5",
    });

    await expect(compileAgentManifest(manifest)).rejects.toThrow(
      'Remove "experimental.workflow" from "research"',
    );
  });

  it("rejects configured ExperimentalWorkflow tool definitions on subagents", async () => {
    const workflowSource = createModuleSourceRef({ logicalPath: "tools/workflow.ts" });
    const subagentManifest = createAgentSourceManifest({
      agentId: "research",
      agentRoot: "/app/agent/subagents/research",
      appRoot: "/app",
      configModule: createModuleSourceRef({ logicalPath: "agent.ts" }),
      tools: [workflowSource],
    });
    const manifest = createAgentSourceManifest({
      agentId: "root",
      agentRoot: "/app/agent",
      appRoot: "/app",
      subagents: [
        createLocalSubagentSourceRef({
          entryPath: "subagents/research/agent.ts",
          logicalPath: "subagents/research",
          manifest: subagentManifest,
          rootPath: "/app/agent/subagents/research",
          subagentId: "research",
        }),
      ],
    });
    mocks.compileAgentConfig.mockImplementation(async (input: AgentSourceManifest) =>
      input.agentId === "research"
        ? createConfig({ description: "Research subagent", name: input.agentId })
        : createConfig({ name: input.agentId }),
    );
    mocks.loadModuleBackedDefinition.mockResolvedValue(
      ExperimentalWorkflow({
        referenceSchema: z.object({ loopId: z.string() }),
        async load() {
          return null;
        },
        async advance() {
          return null;
        },
      }),
    );

    await expect(compileAgentManifest(manifest)).rejects.toThrow(
      'Configured ExperimentalWorkflow is only supported on the root agent. Remove "tools/workflow.ts" from "research".',
    );
  });

  it("preserves the authored source for a configured ExperimentalWorkflow", async () => {
    const workflowSource = createModuleSourceRef({ logicalPath: "tools/workflow.ts" });
    const manifest = createAgentSourceManifest({
      agentId: "root",
      agentRoot: "/app/agent",
      appRoot: "/app",
      tools: [workflowSource],
    });
    mocks.compileAgentConfig.mockResolvedValue(createConfig({ name: "root" }));
    mocks.loadModuleBackedDefinition.mockResolvedValue(
      ExperimentalWorkflow({
        referenceSchema: z.object({ loopId: z.string() }),
        async load() {
          return null;
        },
        async advance() {
          return null;
        },
      }),
    );

    const compiled = await compileAgentManifest(manifest);

    expect(compiled.workflowEnabled).toBe(true);
    expect(compiled.experimentalWorkflow).toEqual({
      logicalPath: workflowSource.logicalPath,
      sourceId: workflowSource.sourceId,
      sourceKind: "module",
    });
  });
});

function createConfig(
  input: Pick<CompiledAgentDefinition, "name"> &
    Partial<Pick<CompiledAgentDefinition, "description" | "experimental">>,
): CompiledAgentDefinition {
  const config: CompiledAgentDefinition = {
    model: {
      id: "openai/gpt-5.5",
      routing: classifyModelRouting("openai/gpt-5.5"),
    },
    name: input.name,
  };

  if (input.description !== undefined) {
    config.description = input.description;
  }
  if (input.experimental !== undefined) {
    config.experimental = input.experimental;
  }

  return config;
}
