import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { LocalDevelopmentAuthServer } from "#internal/local-development-auth.js";
import type { LocalDevelopmentAuthMetadata } from "#protocol/local-dev-auth.js";
import { isSameDevelopmentServerEndpoint } from "#shared/local-development-url.js";

const DEVELOPMENT_PROCESS_ID_FILE = "dev-process.pid";
const DEVELOPMENT_SERVER_METADATA_FILE = "dev-server.json";

export interface DevelopmentServerMetadata {
  readonly localAuth?: LocalDevelopmentAuthMetadata;
  readonly processId: number;
  readonly url: string;
}

export interface ActiveDevelopmentProcess {
  readonly localAuth?: LocalDevelopmentAuthMetadata;
  readonly processId: number;
  readonly url?: string;
}

export function resolveDevelopmentProcessIdPath(appRoot: string): string {
  return join(appRoot, ".eve", DEVELOPMENT_PROCESS_ID_FILE);
}

export function resolveDevelopmentServerMetadataPath(appRoot: string): string {
  return join(appRoot, ".eve", DEVELOPMENT_SERVER_METADATA_FILE);
}

export function parseDevelopmentProcessId(value: string): number | undefined {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;

  const processId = Number(trimmed);
  return Number.isSafeInteger(processId) && processId > 0 ? processId : undefined;
}

export function isDevelopmentProcessRunning(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

export function parseDevelopmentServerMetadata(
  value: string,
): DevelopmentServerMetadata | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("pid" in parsed) ||
    typeof parsed.pid !== "number" ||
    !Number.isSafeInteger(parsed.pid) ||
    parsed.pid <= 0 ||
    !("url" in parsed) ||
    typeof parsed.url !== "string"
  ) {
    return undefined;
  }

  const url = normalizeHttpUrl(parsed.url);
  if (url === undefined) return undefined;
  let localAuth: LocalDevelopmentAuthMetadata | undefined;
  if ("localAuth" in parsed) {
    localAuth = LocalDevelopmentAuthServer.parseMetadata(parsed.localAuth);
    if (localAuth === undefined) return undefined;
  }

  const metadata: DevelopmentServerMetadata = {
    processId: parsed.pid,
    url,
  };
  if (localAuth === undefined) return metadata;
  return { ...metadata, localAuth };
}

export async function readDevelopmentServerMetadata(
  appRoot: string,
): Promise<DevelopmentServerMetadata | undefined> {
  try {
    return parseDevelopmentServerMetadata(
      await readFile(resolveDevelopmentServerMetadataPath(appRoot), "utf8"),
    );
  } catch {
    return undefined;
  }
}

export async function readActiveDevelopmentProcess(
  appRoot: string,
): Promise<ActiveDevelopmentProcess | undefined> {
  let processId: number | undefined;
  try {
    processId = parseDevelopmentProcessId(
      await readFile(resolveDevelopmentProcessIdPath(appRoot), "utf8"),
    );
  } catch {
    return undefined;
  }
  if (processId === undefined || !isDevelopmentProcessRunning(processId)) return undefined;

  const metadata = await readDevelopmentServerMetadata(appRoot);
  if (metadata?.processId !== processId) return { processId };
  if (metadata.localAuth === undefined) return { processId, url: metadata.url };
  return { localAuth: metadata.localAuth, processId, url: metadata.url };
}

export async function resolveLocalDevelopmentServerAuth(input: {
  readonly appRoot: string;
  readonly serverUrl: string;
}): Promise<LocalDevelopmentAuthMetadata | undefined> {
  const activeServer = await readActiveDevelopmentProcess(input.appRoot);
  if (
    activeServer?.url === undefined ||
    !isSameDevelopmentServerEndpoint(activeServer.url, input.serverUrl)
  ) {
    return undefined;
  }
  return activeServer.localAuth;
}

export async function writeDevelopmentServerMetadata(input: {
  readonly appRoot: string;
  readonly localAuth: LocalDevelopmentAuthMetadata;
  readonly serverUrl: string;
}): Promise<void> {
  await writeFile(
    resolveDevelopmentServerMetadataPath(input.appRoot),
    `${JSON.stringify(
      {
        localAuth: input.localAuth,
        pid: process.pid,
        updatedAt: new Date().toISOString(),
        url: input.serverUrl,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function normalizeHttpUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}
