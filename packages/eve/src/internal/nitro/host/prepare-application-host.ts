import { join } from "node:path";

import { compileAgent } from "#compiler/compile-agent.js";
import { createScheduleRegistrations } from "#runtime/schedules/register.js";
import { loadResolvedCompiledSchedules } from "#runtime/schedules/resolve-schedule.js";
import { writeCompiledArtifactsFiles } from "#internal/application/compiled-artifacts.js";
import {
  resolveApplicationHostArtifactsDirectory,
  resolveNitroBuildDirectory,
  resolveWorkflowBuildDirectory,
} from "#internal/application/paths.js";
import { createAuthoredSourceRuntimeCompiledArtifactsSource } from "#internal/application/runtime-compiled-artifacts-source.js";
import {
  activateDevelopmentRuntimeArtifactsSnapshot,
  stageDevelopmentRuntimeArtifactsSnapshot,
} from "#internal/nitro/dev-runtime-artifacts.js";
import type { PreparedApplicationHost } from "#internal/nitro/host/types.js";

/**
 * Compiles one authored app and stages the package-owned artifacts needed by
 * the Nitro host.
 */
export async function prepareApplicationHost(
  startPath: string,
  options: {
    readonly dev?: boolean;
    readonly workspace?: {
      readonly artifactsRoot: string;
      readonly hostArtifactsDir: string;
      readonly nitroBuildDir: string;
      readonly nitroOutputDir: string;
      readonly workflowBuildDir: string;
    };
  } = {},
): Promise<PreparedApplicationHost> {
  const compileResult = await compileAgent({
    artifactsRoot: options.workspace?.artifactsRoot,
    startPath,
  });
  const artifactsRoot =
    options.workspace?.artifactsRoot ?? join(compileResult.project.appRoot, ".eve");
  const hostArtifactsDir =
    options.workspace?.hostArtifactsDir ??
    resolveApplicationHostArtifactsDirectory(compileResult.project.appRoot);
  const nitroBuildDir =
    options.workspace?.nitroBuildDir ?? resolveNitroBuildDirectory(compileResult.project.appRoot);
  const nitroOutputDir =
    options.workspace?.nitroOutputDir ??
    join(compileResult.project.appRoot, ".eve", "nitro-output");
  const schedules = await loadResolvedCompiledSchedules({
    compiledArtifactsSource: createAuthoredSourceRuntimeCompiledArtifactsSource(
      compileResult.project.appRoot,
      { artifactsRoot },
    ),
  });
  const scheduleRegistrations = createScheduleRegistrations(schedules);
  const workflowBuildDir =
    options.workspace?.workflowBuildDir ??
    resolveWorkflowBuildDirectory(compileResult.project.appRoot);
  const runtimeArtifactsSnapshot =
    options.dev === true
      ? await stageDevelopmentRuntimeArtifactsSnapshot(compileResult)
      : undefined;
  const compiledArtifacts = await writeCompiledArtifactsFiles({
    compileResult,
    dev: options.dev,
    outDir: hostArtifactsDir,
  });
  if (runtimeArtifactsSnapshot !== undefined) {
    await activateDevelopmentRuntimeArtifactsSnapshot({
      appRoot: compileResult.project.appRoot,
      snapshot: runtimeArtifactsSnapshot,
    });
  }

  return {
    appRoot: compileResult.project.appRoot,
    artifactsRoot,
    compileResult,
    compiledArtifacts,
    hostArtifactsDir,
    nitroBuildDir,
    nitroOutputDir,
    scheduleRegistrations,
    schedules,
    workflowBuildDir,
  };
}
