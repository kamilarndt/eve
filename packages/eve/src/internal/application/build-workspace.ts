import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { resolveOutputDirectory } from "#internal/application/paths.js";
import { VERCEL_EVE_AGENT_SUMMARY_OUTPUT_PATH } from "#internal/vercel-agent-summary.js";

/** Invocation-owned writable paths for one production build. */
export interface ApplicationBuildWorkspace {
  readonly appRoot: string;
  readonly artifactsRoot: string;
  readonly finalOutputDir: string;
  readonly finalSummaryPath: string;
  readonly hostArtifactsDir: string;
  readonly nitroBuildDir: string;
  readonly nitroOutputDir: string;
  readonly outputDir: string;
  readonly rootDir: string;
  readonly summaryPath: string;
  readonly workflowBuildDir: string;
}

/** Creates a unique production-build workspace under the target app's `.eve` directory. */
export async function createApplicationBuildWorkspace(
  appRoot: string,
): Promise<ApplicationBuildWorkspace> {
  const resolvedAppRoot = resolve(appRoot);
  const buildId = `${Date.now().toString(36)}-${randomUUID()}`;
  const rootDir = join(resolvedAppRoot, ".eve", "builds", buildId);
  const workspace: ApplicationBuildWorkspace = {
    appRoot: resolvedAppRoot,
    artifactsRoot: join(rootDir, "artifacts"),
    finalOutputDir: resolveOutputDirectory(resolvedAppRoot),
    finalSummaryPath: join(resolvedAppRoot, VERCEL_EVE_AGENT_SUMMARY_OUTPUT_PATH),
    hostArtifactsDir: join(rootDir, "host"),
    nitroBuildDir: join(rootDir, "nitro"),
    nitroOutputDir: join(rootDir, "nitro-output"),
    outputDir: join(rootDir, "output"),
    rootDir,
    summaryPath: join(rootDir, "agent-summary.json"),
    workflowBuildDir: join(rootDir, "workflow"),
  };

  await mkdir(rootDir, { recursive: true });
  return workspace;
}

/** Removes one build's invocation-owned workspace. */
export async function removeApplicationBuildWorkspace(
  workspace: ApplicationBuildWorkspace,
): Promise<void> {
  await rm(workspace.rootDir, { force: true, recursive: true });
}
