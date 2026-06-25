import {
  CONNECTION_CATALOG,
  ensureConnectionDependencies,
  listAuthoredConnections,
} from "#setup/scaffold/index.js";
import { createPromptCommandOutput, withPhase } from "#setup/cli/index.js";
import { detectPackageManager } from "#setup/package-manager.js";
import { runPackageManagerInstall } from "#setup/primitives/pm/run.js";
import { toErrorMessage } from "#shared/errors.js";

import { interactiveAsker } from "../ask.js";
import { addConnections, type AddConnectionsDeps } from "../boxes/add-connections.js";
import { selectConnections } from "../boxes/select-connections.js";
import {
  detectDeployment,
  isProjectResolved,
  projectResolutionFromDeployment,
} from "../project-resolution.js";
import type { Prompter, SelectOption, SingleSelectOptions } from "../prompter.js";
import { runInteractive, type AnySetupBox } from "../runner.js";
import { snapshotSetupState, type SetupState } from "../state.js";
import { WizardCancelledError } from "../step.js";
import {
  getVercelAuthStatus,
  vercelAuthBlockerReason,
  type VercelAuthStatus,
} from "../vercel-project.js";
import { withSpinner } from "../with-spinner.js";

import { inProjectSetupState, prompterSink } from "./in-project.js";
import { runLinkFlow } from "./link.js";

export const CONNECTIONS_PROMPT_MESSAGE =
  "Select an MCP server to add to your agent through Vercel Connect";

const USER_AUTH_CONNECTIONS = CONNECTION_CATALOG.filter(
  (entry) => entry.slug === "linear" || entry.slug === "notion",
);

export interface ConnectionsFlowDeps {
  detectDeployment: typeof detectDeployment;
  detectPackageManager: typeof detectPackageManager;
  getVercelAuthStatus: typeof getVercelAuthStatus;
  runLinkFlow: typeof runLinkFlow;
  ensureConnectionDependencies: typeof ensureConnectionDependencies;
  listAuthoredConnections: typeof listAuthoredConnections;
  runPackageManagerInstall: typeof runPackageManagerInstall;
  addConnections?: AddConnectionsDeps;
}

export type ConnectionsFlowResult =
  | { kind: "done"; addedConnections: readonly string[] }
  | { kind: "cancelled" }
  | { kind: "failed"; addedConnections: readonly string[]; message: string };

function connectionRows(
  authored: ReadonlySet<string>,
  authStatus: VercelAuthStatus,
): SelectOption<string>[] {
  const blocker = vercelAuthBlockerReason(authStatus);
  const rows: SelectOption<string>[] = USER_AUTH_CONNECTIONS.map((entry) => {
    const row = { value: entry.slug, label: entry.label };
    if (authored.has(entry.slug)) {
      return { ...row, completed: true, focusHint: "Already added" };
    }
    if (blocker !== undefined) {
      return {
        ...row,
        disabled: true,
        disabledReason: blocker,
        disabledReasonTone: "warning",
      };
    }
    return { ...row, hint: entry.hint };
  });
  rows.push({ value: "done", label: "Done", trailingAction: true });
  return rows;
}

async function pickConnection(
  prompter: Prompter,
  authored: ReadonlySet<string>,
  authStatus: VercelAuthStatus,
): Promise<string | undefined> {
  const options = connectionRows(authored, authStatus);
  const request: SingleSelectOptions<string> = {
    message: CONNECTIONS_PROMPT_MESSAGE,
    options,
    hintLayout: "inline",
    search: true,
    placeholder: "type to search MCP servers",
  };
  if (
    !options.some(
      (option) => option.value !== "done" && option.disabled !== true && option.completed !== true,
    )
  ) {
    request.initialValue = "done";
  }
  try {
    return await prompter.select(request);
  } catch (error) {
    if (error instanceof WizardCancelledError) return undefined;
    throw error;
  }
}

/** Runs `/connect`, linking a project on first selection when needed. */
export async function runConnectionsFlow(input: {
  appRoot: string;
  prompter: Prompter;
  signal?: AbortSignal;
  deps?: Partial<ConnectionsFlowDeps>;
}): Promise<ConnectionsFlowResult> {
  const { appRoot, prompter, signal } = input;
  const deps: ConnectionsFlowDeps = {
    detectDeployment,
    detectPackageManager,
    ensureConnectionDependencies,
    getVercelAuthStatus,
    listAuthoredConnections,
    runLinkFlow,
    runPackageManagerInstall,
    ...input.deps,
  };
  const [deployment, initialAuthored, authStatus] = await withSpinner(
    prompter,
    "Checking the project…",
    () =>
      Promise.all([
        deps.detectDeployment(appRoot, { signal }),
        deps.listAuthoredConnections(appRoot),
        deps.getVercelAuthStatus(appRoot, { signal }),
      ]),
  );
  signal?.throwIfAborted();

  let state = inProjectSetupState(appRoot, projectResolutionFromDeployment(deployment));
  let authored = new Set(initialAuthored);
  const added: string[] = [];
  let dependenciesReady = false;

  while (true) {
    const selected = await pickConnection(prompter, authored, authStatus);
    if (selected === undefined || selected === "done") {
      return added.length === 0 && selected === undefined
        ? { kind: "cancelled" }
        : { kind: "done", addedConnections: added };
    }
    if (authored.has(selected)) continue;

    if (!isProjectResolved(state.project)) {
      const link = await deps.runLinkFlow({
        appRoot,
        prompter,
        signal,
        projectSelection: "create-or-link",
        teamSelectMessage: () =>
          "You need to link to a project to use Vercel Connect.\n\nSelect your team",
      });
      if (link.kind === "cancelled") {
        if (signal?.aborted) return { kind: "cancelled" };
        continue;
      }

      const deploymentAfterLink = await withSpinner(prompter, "Checking the project…", () =>
        deps.detectDeployment(appRoot, { signal }),
      );
      const project = projectResolutionFromDeployment(deploymentAfterLink);
      if (!isProjectResolved(project)) throw new Error("Project link was not found after linking.");
      state = { ...state, project };
    }

    const boxes: AnySetupBox<SetupState>[] = [
      selectConnections({ asker: interactiveAsker(prompter), presetConnections: [selected] }),
      addConnections({
        prompter,
        signal,
        deps: deps.addConnections,
        beforeScaffold: async () => {
          if (dependenciesReady) return;
          const packageManager = await deps.detectPackageManager(appRoot);
          await deps.ensureConnectionDependencies({ projectRoot: appRoot });
          const installed = await withPhase(
            prompter.log,
            `Installing connection dependencies (${packageManager.kind} install)...`,
            () =>
              deps.runPackageManagerInstall(packageManager.kind, appRoot, {
                onOutput: createPromptCommandOutput(prompter.log),
                signal,
              }),
          );
          if (!installed) {
            throw new Error(
              `Dependency installation failed. Run \`${packageManager.kind} install\`.`,
            );
          }
          dependenciesReady = true;
        },
      }),
    ];
    try {
      const result = await runInteractive(boxes, state, prompterSink(prompter), {
        snapshot: snapshotSetupState,
        signal,
      });
      if (result.kind !== "done") {
        return added.length === 0
          ? { kind: "cancelled" }
          : { kind: "done", addedConnections: added };
      }
      state = result.state;
      authored = new Set(await deps.listAuthoredConnections(appRoot));
      if (!authored.has(selected)) continue;
      added.push(selected);
    } catch (error) {
      authored = new Set(await deps.listAuthoredConnections(appRoot));
      if (!authored.has(selected)) throw error;
      if (!added.includes(selected)) added.push(selected);
      return { kind: "failed", addedConnections: added, message: toErrorMessage(error) };
    }
  }
}
