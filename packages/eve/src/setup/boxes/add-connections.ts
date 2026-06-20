import {
  ensureConnection,
  ensureConnectionDependencies,
  listAuthoredConnections,
  type ConnectionInput,
  type ConnectionMutationResult,
} from "#setup/scaffold/index.js";
import { createPromptCommandOutput, type ChannelSetupLog, withPhase } from "#setup/cli/index.js";
import { detectPackageManager } from "#setup/package-manager.js";
import { runPackageManagerInstall } from "#setup/primitives/pm/run.js";

import {
  cleanupCreatedConnectionConnector,
  setupConnectionConnector,
  type ConnectionConnectorPrompts,
} from "../connection-connector.js";
import { canonicalConnectorUidForEntry } from "../scaffold/connections/catalog.js";
import {
  isProjectResolved,
  mergeProjectResolution,
  type ProjectResolution,
} from "../project-resolution.js";
import type { Prompter, SingleSelectOptions } from "../prompter.js";
import { hasVercelProject, requireProjectPath, type SetupState } from "../state.js";
import type { SetupBox } from "../step.js";
import { WizardCancelledError } from "../step.js";
import { projectIdFromResolution } from "../vercel-project.js";
import { CONNECT_REQUIRES_VERCEL } from "./select-connections.js";

/** Injected for tests; defaults to the real scaffold and Connect effects. */
export interface AddConnectionsDeps {
  detectPackageManager: typeof detectPackageManager;
  ensureConnection: typeof ensureConnection;
  ensureConnectionDependencies: typeof ensureConnectionDependencies;
  listAuthoredConnections: typeof listAuthoredConnections;
  runPackageManagerInstall: typeof runPackageManagerInstall;
  setupConnectionConnector: typeof setupConnectionConnector;
  cleanupCreatedConnectionConnector: typeof cleanupCreatedConnectionConnector;
}

function withConnectorUid(entry: ConnectionInput, connectorUid: string): ConnectionInput {
  if (entry.auth?.kind !== "connect") {
    throw new Error(`Connection ${entry.slug} is not configured for Vercel Connect.`);
  }
  return { ...entry, auth: { ...entry.auth, connector: connectorUid } };
}

export interface AddConnectionsOptions {
  /** Carries connector choices, creation-name input, and provisioning output. */
  prompter: Prompter;
  signal?: AbortSignal;
  deps?: AddConnectionsDeps;
}

function logFollowUp(log: ChannelSetupLog, result: ConnectionMutationResult): void {
  if (result.action === "skipped") {
    log.warning(`Skipped ${result.slug} (already exists; pass --force to overwrite).`);
    return;
  }
  log.success(`Added agent/connections/${result.slug}.ts`);
  if (result.envKeysAdded.length > 0) {
    log.info(`Set ${result.envKeysAdded.join(", ")} in .env.local`);
  } else if (result.envKeysRequired.length > 0) {
    log.info(`Set ${result.envKeysRequired.join(", ")} in your environment`);
  }
}

function connectionConnectorPrompts(prompter: Prompter): ConnectionConnectorPrompts {
  return {
    async choosePath(input) {
      const request: SingleSelectOptions<string> = {
        message: `Which connector should ${input.slug} use?`,
        hintLayout: "inline",
        options: [
          {
            value: "find",
            label: "Find a new one",
            hint: `Browse existing ${input.service} connectors`,
          },
          {
            value: "create",
            label: "Create a new one",
            hint: `Register another ${input.service} connector`,
          },
        ],
      };
      if (input.notice !== undefined) {
        request.notices = [{ tone: "warning", text: input.notice }];
      }
      const selected = await prompter.select<string>(request);
      return selected === "find" ? { kind: "find" } : { kind: "create" };
    },

    async chooseExisting(input) {
      const connectors = new Map(input.connectors.map((connector) => [connector.uid, connector]));
      let selected: string;
      try {
        selected = await prompter.select<string>({
          message: `Select a connector for ${input.slug}`,
          search: true,
          placeholder: "type to search connectors",
          options: input.connectors.map((connector) => ({
            value: connector.uid,
            label: connector.uid,
            hint: connector.name == null ? connector.id : `${connector.name} · ${connector.id}`,
          })),
        });
      } catch (error) {
        if (error instanceof WizardCancelledError) return undefined;
        throw error;
      }
      const connector = connectors.get(selected);
      if (connector === undefined) {
        throw new Error(`Connector selection ${selected} is no longer available.`);
      }
      return { id: connector.id, uid: connector.uid };
    },

    async promptName(input) {
      const unavailableNames = new Set(
        input.unavailableNames.map((name) => name.trim().toLowerCase()),
      );
      const request: Parameters<Prompter["text"]>[0] = {
        message: "New connector name",
        defaultValue: input.suggestedName,
        validate: (value) => {
          const name = value.trim();
          if (name.length === 0) return "Connector name cannot be empty.";
          if (unavailableNames.has(name.toLowerCase())) {
            return `Connector name "${name}" already exists.`;
          }
          return undefined;
        },
      };
      if (input.suggestedName !== input.slug) {
        request.notices = [
          {
            tone: "warning",
            text: `Connector named "${input.slug}" already exists.`,
          },
        ];
      }
      return (await prompter.text(request)).trim();
    },
  };
}

/**
 * THE CONNECTIONS BOX: executes the {@link ConnectionPlan}s the
 * select-connections box recorded during the interview. Connector reuse and
 * creation details are resolved here because they depend on live Connect
 * inventory; the remaining work is file scaffolding and provisioning.
 */
export function addConnections(
  options: AddConnectionsOptions,
): SetupBox<SetupState, null, ProjectResolution> {
  const deps = options.deps ?? {
    detectPackageManager,
    ensureConnection,
    ensureConnectionDependencies,
    listAuthoredConnections,
    runPackageManagerInstall,
    setupConnectionConnector,
    cleanupCreatedConnectionConnector,
  };

  return {
    id: "add-connections",

    shouldRun(state) {
      return state.connectionSelection.length > 0;
    },

    async gather(): Promise<null> {
      return null;
    },

    async perform({ state }): Promise<ProjectResolution> {
      const log = options.prompter.log;
      const projectRoot = requireProjectPath(state);
      const noVercel = !hasVercelProject(state);
      const project = state.project;
      const authoredConnections = new Set(await deps.listAuthoredConnections(projectRoot));
      let connectDependenciesReady: Promise<void> | undefined;

      const prepareConnectDependencies = (): Promise<void> => {
        connectDependenciesReady ??= (async () => {
          await deps.ensureConnectionDependencies({ projectRoot });
          const packageManager = await deps.detectPackageManager(projectRoot);
          const installed = await withPhase(
            log,
            `Installing connection dependencies (${packageManager.kind} install)...`,
            () =>
              deps.runPackageManagerInstall(packageManager.kind, projectRoot, {
                onOutput: createPromptCommandOutput(log),
                signal: options.signal,
              }),
          );
          if (!installed) {
            throw new Error(
              `Dependency installation failed. Run \`${packageManager.kind} install\`, then retry /connect.`,
            );
          }
        })();
        return connectDependenciesReady;
      };

      for (const plan of state.connectionSelection) {
        if (authoredConnections.has(plan.slug)) {
          const result = await deps.ensureConnection({
            projectRoot,
            slug: plan.slug,
            protocol: plan.protocol,
            entry: plan.entry,
          });
          logFollowUp(log, result);
          continue;
        }

        let entry = plan.entry;
        let createdConnectorId: string | undefined;
        const canonicalConnectorUid =
          plan.entry.auth?.kind === "connect"
            ? canonicalConnectorUidForEntry(plan.entry)
            : undefined;
        if (plan.entry.auth?.kind === "connect") {
          await prepareConnectDependencies();
        }
        if (plan.provision.kind === "connect") {
          if (plan.entry.auth?.kind !== "connect") {
            throw new Error(`Connection ${plan.slug} has no Connect authorization definition.`);
          }
          if (canonicalConnectorUid === undefined) {
            throw new Error(`Connection ${plan.slug} has no canonical Connect connector UID.`);
          }
          const connector = await deps.setupConnectionConnector({
            log,
            principalType: plan.entry.auth.principalType,
            projectRoot,
            slug: plan.slug,
            service: plan.provision.service,
            canonicalConnectorUid,
            signal: options.signal,
            prompts: connectionConnectorPrompts(options.prompter),
            // The project was linked up front by the link box; Connect
            // provisioning reuses it. The link box is a hard invariant once
            // Vercel is in play: an unresolved project here means it did not
            // run or did not record a resolution.
            linkProject: async () => {
              if (noVercel) {
                throw new Error(CONNECT_REQUIRES_VERCEL);
              }
              if (!isProjectResolved(project)) {
                throw new Error(
                  "Expected a linked Vercel project for Connect, but none was resolved.",
                );
              }
              return projectIdFromResolution(project);
            },
          });
          entry = withConnectorUid(plan.entry, connector.connectorUid);
          if (connector.kind === "attached-created") {
            createdConnectorId = connector.connectorId;
          }
        } else if (plan.provision.kind === "command-hint") {
          if (canonicalConnectorUid === undefined) {
            throw new Error(`Connection ${plan.slug} has no canonical Connect connector UID.`);
          }
          entry = withConnectorUid(plan.entry, canonicalConnectorUid);
        }

        let result: ConnectionMutationResult;
        try {
          result = await deps.ensureConnection({
            projectRoot,
            slug: plan.slug,
            protocol: plan.protocol,
            entry,
          });
        } catch (error) {
          if (createdConnectorId !== undefined) {
            try {
              await deps.cleanupCreatedConnectionConnector({
                log,
                projectRoot,
                connectorId: createdConnectorId,
              });
            } catch (cleanupError) {
              const original = error instanceof Error ? error.message : String(error);
              const cleanup =
                cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
              throw new Error(`${original} ${cleanup}`);
            }
          }
          throw error;
        }
        if (result.action === "skipped" && createdConnectorId !== undefined) {
          await deps.cleanupCreatedConnectionConnector({
            log,
            projectRoot,
            connectorId: createdConnectorId,
          });
        }
        logFollowUp(log, result);
        if (result.action === "skipped") continue;
        authoredConnections.add(result.slug);

        switch (plan.provision.kind) {
          case "connect":
            break;
          case "command-hint":
            if (canonicalConnectorUid === undefined) {
              throw new Error(`Connection ${result.slug} has no canonical Connect connector UID.`);
            }
            log.info(
              `Run \`vercel connect attach ${canonicalConnectorUid} --yes\`. If the canonical connector is unavailable, run \`/connect\` interactively.`,
            );
            break;
          case "connect-manual":
            log.warning(
              `Could not determine a Connect service for ${result.slug}. Create the connector manually and set its UID in agent/connections/${result.slug}.ts.`,
            );
            break;
          case "none":
            break;
        }
      }
      return project;
    },

    apply(state, payload) {
      return { ...state, project: mergeProjectResolution(state.project, payload) };
    },
  };
}
