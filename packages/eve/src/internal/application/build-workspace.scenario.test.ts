import { stat } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createApplicationBuildWorkspace,
  removeApplicationBuildWorkspace,
} from "#internal/application/build-workspace.js";
import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";

const createScratchDirectory = useTemporaryDirectories();

describe("application build workspace", () => {
  it("gives concurrent builds unique paths outside every dev-owned directory", async () => {
    const appRoot = await createScratchDirectory("eve-build-workspace-");
    const [first, second] = await Promise.all([
      createApplicationBuildWorkspace(appRoot),
      createApplicationBuildWorkspace(appRoot),
    ]);

    expect(first.rootDir).not.toBe(second.rootDir);
    for (const workspace of [first, second]) {
      expect(workspace.rootDir).toContain(join(appRoot, ".eve", "builds"));
      expect(workspace.artifactsRoot).not.toBe(join(appRoot, ".eve"));
      expect(workspace.hostArtifactsDir).not.toBe(join(appRoot, ".eve", "host"));
      expect(workspace.nitroBuildDir).not.toBe(join(appRoot, ".eve", "nitro"));
      expect(workspace.workflowBuildDir).not.toContain("workflow-cache");
      await expect(stat(workspace.rootDir)).resolves.toBeDefined();
    }

    await Promise.all([
      removeApplicationBuildWorkspace(first),
      removeApplicationBuildWorkspace(second),
    ]);
    await expect(stat(first.rootDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
