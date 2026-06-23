import { describe, expect, it } from "vitest";

import type { SandboxBackend } from "#public/definitions/sandbox-backend.js";
import { createRuntimeSandboxTemplatePlan } from "#runtime/sandbox/template-plan.js";
import type { ResolvedSandboxDefinition } from "#runtime/types.js";

function createDefinition(backend: SandboxBackend): ResolvedSandboxDefinition {
  return {
    backend,
    logicalPath: "agent/sandbox.ts",
    sourceHash: "source-hash",
    sourceId: "agent/sandbox",
    sourceKind: "module",
  };
}

function createBackend(requiresTemplate: boolean): SandboxBackend {
  return {
    async create() {
      throw new Error("Unexpected create call.");
    },
    name: "test",
    async prewarm() {
      return { reused: true };
    },
    provisioning: {
      prewarmAtBuild: true,
      requiresTemplate,
    },
  };
}

describe("createRuntimeSandboxTemplatePlan", () => {
  it("requires a source-graph template for an otherwise-empty remote backend", () => {
    expect(
      createRuntimeSandboxTemplatePlan({
        definition: createDefinition(createBackend(true)),
        workspaceResourceRoot: { logicalPath: "", rootEntries: [] },
      }),
    ).toEqual({ kind: "source-graph" });
  });

  it("keeps an otherwise-empty ordinary backend template-less", () => {
    expect(
      createRuntimeSandboxTemplatePlan({
        definition: createDefinition(createBackend(false)),
        workspaceResourceRoot: { logicalPath: "", rootEntries: [] },
      }),
    ).toEqual({ kind: "none" });
  });
});
