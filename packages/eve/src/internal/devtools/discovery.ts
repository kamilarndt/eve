import { randomUUID } from "node:crypto";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const DEVTOOLS_DISCOVERY_SCHEMA_VERSION = 1;

interface DiscoveryRuntimeState {
  readonly inspectorUrl?: string;
  readonly runtimeInstanceId: string;
  readonly runtimePid?: number;
  readonly runtimeUrl?: string;
}

export function resolveDevToolsDiscoveryPath(appRoot: string): string {
  return join(appRoot, ".eve", "devtools", "current.json");
}

export async function writeDevToolsDiscovery(input: {
  readonly appRoot: string;
  readonly browserCapability: string;
  readonly devtoolsUrl: string;
  readonly runtimeState: DiscoveryRuntimeState;
}): Promise<void> {
  const discoveryPath = resolveDevToolsDiscoveryPath(input.appRoot);
  const discoveryDirectory = join(input.appRoot, ".eve", "devtools");
  const temporaryPath = `${discoveryPath}.${randomUUID()}.tmp`;
  const runtime = input.runtimeState;
  await mkdir(discoveryDirectory, { mode: 0o700, recursive: true });
  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify(
        {
          appRoot: input.appRoot,
          browserCapability: input.browserCapability,
          devtoolsUrl: input.devtoolsUrl,
          inspectorUrl: runtime.inspectorUrl,
          runtimeInstanceId: runtime.runtimeInstanceId,
          runtimePid: runtime.runtimePid,
          runtimeUrl: runtime.runtimeUrl,
          schemaVersion: DEVTOOLS_DISCOVERY_SCHEMA_VERSION,
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, discoveryPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}
