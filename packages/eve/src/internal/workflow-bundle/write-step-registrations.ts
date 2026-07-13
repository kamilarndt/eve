import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { atomicWriteFile } from "#internal/application/atomic-write.js";
import {
  bundleWorkflowStepRegistrations,
  type WorkflowBundleDiscoveredEntries,
} from "#internal/workflow-bundle/builder-support.js";
import { writeNitroStepEntrypoint } from "#internal/workflow-bundle/nitro-step-entry.js";
import type { WorkflowManifest } from "#internal/workflow-bundle/workflow-builders.js";

/** Writes self-contained dev registrations or production source registrations. */
export async function writeWorkflowStepRegistrations(input: {
  readonly builtinsPath: string;
  readonly discoveredEntries: WorkflowBundleDiscoveredEntries;
  readonly outfile: string;
  readonly projectRoot: string;
  readonly watch: boolean;
  readonly workingDir: string;
}): Promise<WorkflowManifest> {
  if (input.watch) {
    return await bundleWorkflowStepRegistrations(input);
  }

  return await writeNitroStepEntrypoint({
    builtinsPath: input.builtinsPath,
    discoveredEntries: input.discoveredEntries,
    outfile: input.outfile,
    preferAbsoluteFileImports: true,
    projectRoot: input.projectRoot,
    workingDir: input.workingDir,
  });
}

/** Mirrors bundled dev registrations or writes Nitro's production source entry. */
export async function writeNitroWorkflowStepRegistrations(input: {
  readonly builtinsPath: string;
  readonly discoveredEntries: WorkflowBundleDiscoveredEntries;
  readonly outfile: string;
  readonly projectRoot: string;
  readonly sourceOutfile: string;
  readonly watch: boolean;
  readonly workingDir: string;
}): Promise<void> {
  if (input.watch) {
    await mkdir(dirname(input.outfile), { recursive: true });
    await atomicWriteFile(input.outfile, await readFile(input.sourceOutfile));
    return;
  }

  await writeNitroStepEntrypoint({
    builtinsPath: input.builtinsPath,
    discoveredEntries: input.discoveredEntries,
    outfile: input.outfile,
    preferAbsoluteFileImports: true,
    projectRoot: input.projectRoot,
    workingDir: input.workingDir,
  });
}
