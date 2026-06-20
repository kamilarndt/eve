import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";

import { z } from "#compiled/zod/index.js";

import type { ProcessOutputHandler } from "#setup/primitives/process-output.js";
import { captureVercel, runVercelCaptureStdout } from "#setup/primitives/run-vercel.js";

const CONNECT_LOOKUP_TIMEOUT_MS = 60_000;
const CONNECT_MUTATION_TIMEOUT_MS = 2 * 60_000;
const CONNECT_CREATE_TIMEOUT_MS = 30 * 60_000;
const CREATED_CONNECTOR_PROGRESS = /\bConnector created:\s*(scl_[A-Za-z0-9_-]+)\b/u;

const NonEmptyStringSchema = z.string().min(1);

const ConnectorRefSchema = z.object({
  id: NonEmptyStringSchema,
  uid: NonEmptyStringSchema,
});

const ConnectorListItemSchema = ConnectorRefSchema.extend({
  name: NonEmptyStringSchema.nullish(),
});

const ConnectorListPageSchema = z.object({
  connectors: z.array(ConnectorListItemSchema),
  cursor: NonEmptyStringSchema.nullish(),
});

const ConnectorAuthorizationSchema = ConnectorRefSchema.extend({
  service: NonEmptyStringSchema.optional(),
  supportedSubjectTypes: z.array(NonEmptyStringSchema),
});

const VercelProjectLinkSchema = z.object({
  projectId: NonEmptyStringSchema,
  orgId: NonEmptyStringSchema,
});

/** Exact connector identity returned by Vercel Connect. */
export type ConnectConnectorRef = z.infer<typeof ConnectorRefSchema>;

/** Connector row returned by `vercel connect list -F json`. */
export type ConnectConnectorListItem = z.infer<typeof ConnectorListItemSchema>;

/** Project and team identifiers stored by `vercel link`. */
export type VercelProjectLink = z.infer<typeof VercelProjectLinkSchema>;

/** Vercel subprocess operations used by the connection connector boundary. */
export interface ConnectionConnectDeps {
  captureVercel: typeof captureVercel;
  runVercelCaptureStdout: typeof runVercelCaptureStdout;
}

const defaultDeps: ConnectionConnectDeps = { captureVercel, runVercelCaptureStdout };

export type AttachConnectionConnectorResult =
  | { kind: "attached" }
  | { kind: "failed"; message: string };

/** Whether a connector can mint a credential for the requested subject type. */
export type VerifyConnectionConnectorResult =
  | { kind: "supported-subject"; connector: ConnectConnectorRef }
  | {
      kind: "unsupported-subject";
      connector: ConnectConnectorRef;
      supportedSubjectTypes: string[];
    };

export type CreateConnectionConnectorResult =
  | { kind: "created"; connector: ConnectConnectorRef }
  | { kind: "failed"; message: string }
  | { kind: "failed-owned"; connectorId: string; message: string };

export type RemoveConnectionConnectorResult =
  | { kind: "removed" }
  | { kind: "failed"; message: string };

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function parseTerminalJsonObject(value: string): unknown {
  const source = stripVTControlCharacters(value).trim();
  let objectStart = source.lastIndexOf("{");
  while (objectStart >= 0) {
    const parsed = parseJson(source.slice(objectStart));
    if (parsed !== undefined) return parsed;
    objectStart = source.lastIndexOf("{", objectStart - 1);
  }
  return undefined;
}

function createdConnectorIdFromProgress(value: string): string | undefined {
  return CREATED_CONNECTOR_PROGRESS.exec(stripVTControlCharacters(value))?.[1];
}

function vercelErrorDiagnostic(stderr: string): string | undefined {
  const lines = stripVTControlCharacters(stderr)
    .split(/\r\n|\r|\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    if (line.startsWith("Error: ")) return line.slice("Error: ".length);
    if (line.startsWith("Setup failed: ")) return line;
  }
  return undefined;
}

function createFailureMessage(service: string, failure: string, stderr: string): string {
  const diagnostic = vercelErrorDiagnostic(stderr);
  return diagnostic === undefined
    ? `Could not create the ${service} connector: ${failure}`
    : `Could not create the ${service} connector: ${diagnostic}`;
}

function failureDiagnostic(fallback: string, stderr: string): string {
  return vercelErrorDiagnostic(stderr) ?? fallback;
}

/** Reads a linked Vercel project without trusting unvalidated JSON. */
export async function readConnectionProjectLink(
  projectRoot: string,
): Promise<VercelProjectLink | undefined> {
  try {
    const source = await readFile(join(projectRoot, ".vercel", "project.json"), "utf8");
    const parsed = VercelProjectLinkSchema.safeParse(JSON.parse(source));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Parses a completed `vercel connect create -F json` response. */
export function parseCreatedConnectionConnector(
  stdout: string,
  principalType: "user",
): ConnectConnectorRef | undefined {
  const parsed = ConnectorAuthorizationSchema.safeParse(parseTerminalJsonObject(stdout));
  if (!parsed.success || !parsed.data.supportedSubjectTypes.includes(principalType)) {
    return undefined;
  }
  return { id: parsed.data.id, uid: parsed.data.uid };
}

/** Attaches one exact connector UID to the linked project. */
export async function attachConnectionConnector(
  input: {
    projectRoot: string;
    connectorUid: string;
    signal?: AbortSignal;
    onOutput?: ProcessOutputHandler;
  },
  deps: ConnectionConnectDeps = defaultDeps,
): Promise<AttachConnectionConnectorResult> {
  const result = await deps.captureVercel(
    ["connect", "attach", input.connectorUid, "--yes", "-F", "json"],
    {
      cwd: input.projectRoot,
      nonInteractive: true,
      onOutput: input.onOutput,
      signal: input.signal,
      timeoutMs: CONNECT_MUTATION_TIMEOUT_MS,
    },
  );
  return result.ok
    ? { kind: "attached" }
    : { kind: "failed", message: failureDiagnostic(result.failure.message, result.failure.stderr) };
}

/** Lists every connector for a service through the stable Vercel CLI JSON contract. */
export async function listConnectionConnectors(
  input: {
    projectRoot: string;
    service: string;
    signal?: AbortSignal;
    onOutput?: ProcessOutputHandler;
  },
  deps: ConnectionConnectDeps = defaultDeps,
): Promise<ConnectConnectorListItem[]> {
  const connectors: ConnectConnectorListItem[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const args = ["connect", "list", "--all-projects", "--service", input.service, "-F", "json"];
    if (cursor !== undefined) args.push("--next", cursor);
    const result = await deps.captureVercel(args, {
      cwd: input.projectRoot,
      nonInteractive: true,
      onOutput: input.onOutput,
      signal: input.signal,
      timeoutMs: CONNECT_LOOKUP_TIMEOUT_MS,
    });
    if (!result.ok) {
      throw new Error(
        `Could not list existing ${input.service} connectors: ${result.failure.message}`,
      );
    }
    const page = ConnectorListPageSchema.safeParse(parseTerminalJsonObject(result.stdout));
    if (!page.success) {
      throw new Error(`Vercel returned an invalid connector list for ${input.service}.`);
    }
    connectors.push(...page.data.connectors);
    const nextCursor = page.data.cursor ?? undefined;
    if (nextCursor !== undefined && seenCursors.has(nextCursor)) {
      throw new Error(`The connector list repeated cursor ${nextCursor} for ${input.service}.`);
    }
    if (nextCursor !== undefined) seenCursors.add(nextCursor);
    cursor = nextCursor;
  } while (cursor !== undefined);
  return connectors;
}

/** Verifies that an explicitly selected connector can authorize the requested principal. */
export async function verifyConnectionConnector(
  input: {
    projectRoot: string;
    orgId: string;
    service: string;
    principalType: "user";
    connector: ConnectConnectorRef;
    signal?: AbortSignal;
    onOutput?: ProcessOutputHandler;
  },
  deps: ConnectionConnectDeps = defaultDeps,
): Promise<VerifyConnectionConnectorResult> {
  const endpoint = `/v1/connect/connectors/${encodeURIComponent(input.connector.id)}`;
  const result = await deps.captureVercel(["api", endpoint, "--scope", input.orgId, "--raw"], {
    cwd: input.projectRoot,
    nonInteractive: true,
    onOutput: input.onOutput,
    signal: input.signal,
    timeoutMs: CONNECT_LOOKUP_TIMEOUT_MS,
  });
  if (!result.ok) {
    throw new Error(`Could not verify connector ${input.connector.uid}: ${result.failure.message}`);
  }
  const parsed = ConnectorAuthorizationSchema.safeParse(parseJson(result.stdout));
  if (
    !parsed.success ||
    parsed.data.id !== input.connector.id ||
    parsed.data.uid !== input.connector.uid ||
    (parsed.data.service !== undefined && parsed.data.service !== input.service)
  ) {
    throw new Error(`Vercel returned invalid details for connector ${input.connector.uid}.`);
  }
  if (!parsed.data.supportedSubjectTypes.includes(input.principalType)) {
    return {
      kind: "unsupported-subject",
      connector: input.connector,
      supportedSubjectTypes: parsed.data.supportedSubjectTypes,
    };
  }
  return { kind: "supported-subject", connector: input.connector };
}

/** Creates one named connector, treating every nonzero CLI exit as failure. */
export async function createConnectionConnector(
  input: {
    projectRoot: string;
    service: string;
    name: string;
    principalType: "user";
    signal?: AbortSignal;
    onOutput?: ProcessOutputHandler;
  },
  deps: ConnectionConnectDeps = defaultDeps,
): Promise<CreateConnectionConnectorResult> {
  const result = await deps.runVercelCaptureStdout(
    ["connect", "create", input.service, "--name", input.name, "-F", "json"],
    {
      cwd: input.projectRoot,
      onOutput: input.onOutput,
      signal: input.signal,
      timeoutMs: CONNECT_CREATE_TIMEOUT_MS,
    },
  );
  const rawIdentity = ConnectorRefSchema.safeParse(parseTerminalJsonObject(result.stdout));
  const progressConnectorId = createdConnectorIdFromProgress(
    result.ok ? result.stdout : `${result.stdout}\n${result.stderr}`,
  );
  const ownedConnectorId = rawIdentity.success ? rawIdentity.data.id : progressConnectorId;
  if (!result.ok) {
    const message = createFailureMessage(input.service, result.failure, result.stderr);
    return ownedConnectorId === undefined
      ? { kind: "failed", message }
      : { kind: "failed-owned", connectorId: ownedConnectorId, message };
  }
  const connector = parseCreatedConnectionConnector(result.stdout, input.principalType);
  if (connector !== undefined) return { kind: "created", connector };
  const message = `The ${input.service} connector did not return a usable connector identifier with ${input.principalType} authorization.`;
  return ownedConnectorId === undefined
    ? { kind: "failed", message }
    : { kind: "failed-owned", connectorId: ownedConnectorId, message };
}

/** Removes a connector created by the current attempt. */
export async function removeConnectionConnector(
  input: {
    projectRoot: string;
    connectorIdOrUid: string;
    onOutput?: ProcessOutputHandler;
  },
  deps: ConnectionConnectDeps = defaultDeps,
): Promise<RemoveConnectionConnectorResult> {
  const result = await deps.captureVercel(
    ["connect", "remove", input.connectorIdOrUid, "--disconnect-all", "--yes", "-F", "json"],
    {
      cwd: input.projectRoot,
      nonInteractive: true,
      onOutput: input.onOutput,
      timeoutMs: CONNECT_MUTATION_TIMEOUT_MS,
    },
  );
  return result.ok ? { kind: "removed" } : { kind: "failed", message: result.failure.message };
}
