import { createPromptCommandOutput, type ChannelSetupLog, withPhase } from "#setup/cli/index.js";
import { runVercel } from "#setup/primitives/run-vercel.js";

import {
  attachConnectionConnector,
  createConnectionConnector,
  listConnectionConnectors,
  readConnectionProjectLink,
  removeConnectionConnector,
  verifyConnectionConnector,
  type ConnectConnectorListItem,
  type ConnectConnectorRef,
  type VercelProjectLink,
} from "./connection-connect.js";

const CONNECT_MUTATION_TIMEOUT_MS = 2 * 60_000;

/** Choice shown only after the canonical provider connector could not attach. */
export type ConnectConnectorPathChoice = { kind: "find" } | { kind: "create" };

/** Interaction boundary for the connector-resolution prompts owned by setup UI. */
export interface ConnectionConnectorPrompts {
  choosePath(input: {
    slug: string;
    service: string;
    canonicalConnectorUid: string;
    notice?: string;
  }): Promise<ConnectConnectorPathChoice>;
  chooseExisting(input: {
    slug: string;
    service: string;
    connectors: readonly ConnectConnectorListItem[];
  }): Promise<ConnectConnectorRef | undefined>;
  promptName(input: {
    slug: string;
    service: string;
    suggestedName: string;
    unavailableNames: readonly string[];
  }): Promise<string>;
}

/** Controls connector provisioning while adding a Connect-backed connection. */
export interface SetupConnectionConnectorOptions {
  log: ChannelSetupLog;
  projectRoot: string;
  slug: string;
  /** Bare Vercel Connect service identifier used for list/create requests. */
  service: string;
  /** Concrete Vercel Connect UID to attach before offering a fallback. */
  canonicalConnectorUid: string;
  principalType: "user";
  prompts: ConnectionConnectorPrompts;
  signal?: AbortSignal;
  linkProject?: () => Promise<string | undefined>;
}

/** A connector attached by this run, with ownership explicit for rollback. */
export type SetupConnectionConnectorResult =
  | { kind: "attached-existing"; connectorUid: string }
  | { kind: "attached-created"; connectorUid: string; connectorId: string };

function connectorNames(connectors: readonly ConnectConnectorListItem[]): string[] {
  const names = new Map<string, string>();
  for (const connector of connectors) {
    if (connector.name != null) names.set(connector.name.toLowerCase(), connector.name);
    const separator = connector.uid.lastIndexOf("/");
    const uidName = connector.uid.slice(separator + 1).trim();
    if (uidName.length > 0 && !names.has(uidName.toLowerCase())) {
      names.set(uidName.toLowerCase(), uidName);
    }
  }
  return [...names.values()];
}

function suggestedConnectorName(slug: string, unavailableNames: readonly string[]): string {
  const normalized = new Set(unavailableNames.map((name) => name.toLowerCase()));
  if (!normalized.has(slug.toLowerCase())) return slug;
  let suffix = 2;
  while (normalized.has(`${slug}-${suffix}`.toLowerCase())) suffix += 1;
  return `${slug}-${suffix}`;
}

async function ensureLinkedProject(
  options: SetupConnectionConnectorOptions,
  onOutput: ReturnType<typeof createPromptCommandOutput>,
): Promise<VercelProjectLink> {
  const linkedProjectId = options.linkProject
    ? await options.linkProject()
    : (await readConnectionProjectLink(options.projectRoot))?.projectId;
  if (linkedProjectId === undefined && options.linkProject === undefined) {
    options.log.message("Linking a Vercel project for Connect...");
    await runVercel(["link"], {
      cwd: options.projectRoot,
      onOutput,
      signal: options.signal,
      timeoutMs: CONNECT_MUTATION_TIMEOUT_MS,
    });
  }
  const project = await readConnectionProjectLink(options.projectRoot);
  const expectedProjectId = linkedProjectId ?? project?.projectId;
  if (
    project === undefined ||
    expectedProjectId === undefined ||
    project.projectId !== expectedProjectId
  ) {
    throw new Error(
      `A linked Vercel project is required before configuring ${options.slug}. Run \`vercel link\` and retry.`,
    );
  }
  return project;
}

/** Removes a connector owned by this run or throws an exact recovery instruction. */
export async function cleanupCreatedConnectionConnector(input: {
  log: ChannelSetupLog;
  projectRoot: string;
  connectorId: string;
}): Promise<void> {
  const cleanup = await removeConnectionConnector({
    projectRoot: input.projectRoot,
    connectorIdOrUid: input.connectorId,
    onOutput: createPromptCommandOutput(input.log),
  });
  if (cleanup.kind === "failed") {
    throw new Error(
      `Could not remove connector ${input.connectorId} created by this attempt. Run \`vercel connect remove ${input.connectorId} --disconnect-all --yes\` before retrying. ${cleanup.message}`,
    );
  }
}

async function cleanupThenThrow(
  options: SetupConnectionConnectorOptions,
  connectorId: string,
  message: string,
): Promise<never> {
  try {
    await cleanupCreatedConnectionConnector({
      log: options.log,
      projectRoot: options.projectRoot,
      connectorId,
    });
  } catch (cleanupError) {
    const cleanupMessage =
      cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
    throw new Error(`${message} ${cleanupMessage}`);
  }
  options.signal?.throwIfAborted();
  throw new Error(message);
}

function logAttached(log: ChannelSetupLog, connectorUid: string): void {
  log.success(`Attached ${connectorUid} connector`);
  log.info("Authorization is per user and starts on first use.");
}

/**
 * Attaches the provider's canonical connector first. Only an explicit fallback
 * choice can select another existing connector or create a new one.
 */
export async function setupConnectionConnector(
  options: SetupConnectionConnectorOptions,
): Promise<SetupConnectionConnectorResult> {
  const { canonicalConnectorUid, log, principalType, projectRoot, prompts, service, signal, slug } =
    options;
  const onOutput = createPromptCommandOutput(log);
  const project = await ensureLinkedProject(options, onOutput);

  const canonical = await attachConnectionConnector({
    projectRoot,
    connectorUid: canonicalConnectorUid,
    signal,
  });
  if (canonical.kind === "attached") {
    logAttached(log, canonicalConnectorUid);
    return { kind: "attached-existing", connectorUid: canonicalConnectorUid };
  }
  signal?.throwIfAborted();

  let notice = `Could not attach ${canonicalConnectorUid}: ${canonical.message}`;
  while (true) {
    const choice = await prompts.choosePath({
      slug,
      service,
      canonicalConnectorUid,
      notice,
    });
    signal?.throwIfAborted();
    const connectors = await listConnectionConnectors({ projectRoot, service, signal });

    if (choice.kind === "find") {
      if (connectors.length === 0) {
        notice = `No ${service} connectors were found.`;
        continue;
      }
      const userAuthorizable: ConnectConnectorListItem[] = [];
      for (const connector of connectors) {
        const verification = await verifyConnectionConnector({
          projectRoot,
          orgId: project.orgId,
          service,
          principalType,
          connector,
          signal,
        });
        if (verification.kind === "supported-subject") userAuthorizable.push(connector);
      }
      if (userAuthorizable.length === 0) {
        notice = `No existing ${service} connectors support user authorization.`;
        continue;
      }
      const selected = await prompts.chooseExisting({
        slug,
        service,
        connectors: userAuthorizable,
      });
      if (selected === undefined) continue;
      const attached = await attachConnectionConnector({
        projectRoot,
        connectorUid: selected.uid,
        signal,
      });
      if (attached.kind === "failed") {
        signal?.throwIfAborted();
        throw new Error(
          `Could not attach ${selected.uid} to the linked Vercel project. ${attached.message}`,
        );
      }
      logAttached(log, selected.uid);
      return { kind: "attached-existing", connectorUid: selected.uid };
    }

    const unavailableNames = connectorNames(connectors);
    const name = (
      await prompts.promptName({
        slug,
        service,
        unavailableNames,
        suggestedName: suggestedConnectorName(slug, unavailableNames),
      })
    ).trim();
    if (name.length === 0) throw new Error("Connector name cannot be empty.");
    const created = await withPhase(
      log,
      "Waiting for you to complete setup in the browser…",
      () =>
        createConnectionConnector({
          projectRoot,
          service,
          name,
          principalType,
          signal,
          onOutput,
        }),
      { kind: "external-action", emphasis: "browser" },
    );
    if (created.kind === "failed") {
      signal?.throwIfAborted();
      throw new Error(created.message);
    }
    if (created.kind === "failed-owned") {
      return cleanupThenThrow(options, created.connectorId, created.message);
    }
    const attached = await attachConnectionConnector({
      projectRoot,
      connectorUid: created.connector.uid,
      signal,
    });
    if (attached.kind === "failed") {
      return cleanupThenThrow(
        options,
        created.connector.id,
        `Could not attach ${created.connector.uid} to the linked Vercel project. ${attached.message}`,
      );
    }
    logAttached(log, created.connector.uid);
    return {
      kind: "attached-created",
      connectorUid: created.connector.uid,
      connectorId: created.connector.id,
    };
  }
}
