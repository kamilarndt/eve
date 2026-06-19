import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseEnv } from "node:util";

import pc from "picocolors";

import {
  resolveDevelopmentOidcToken,
  vercelOidcTokenMatchesProject,
} from "#services/dev-client/request-headers.js";
import { createPromptCommandOutput } from "#setup/cli/index.js";
import {
  detectProjectIdentity,
  readProjectLink,
  type ProjectIdentity,
} from "#setup/project-resolution.js";
import { runVercelEnvPull } from "#setup/run-vercel-link.js";
import {
  resolveVercelDeployment,
  type VercelDeploymentResolutionFailure,
  type VerifiedVercelTarget,
} from "#setup/vercel-deployment.js";
import {
  applyVercelTrustedSourceAccess,
  prepareVercelTrustedSourceAccess,
  type VercelTrustedSourceGrant,
} from "#setup/vercel-trusted-sources.js";
import { StepBackError, WizardCancelledError } from "#setup/step.js";
import {
  linkResolvedVercelProject,
  pickProject,
  pickTeam,
  resolveProjectByNameOrId,
  type PickTeamOptions,
  type VercelProjectReference,
} from "#setup/vercel-project.js";
import { toErrorMessage } from "#shared/errors.js";

import type { Prompter, SelectOption, SingleSelectOptions } from "../prompter.js";
import type { ResolvedVercelProjectSpec } from "../state.js";
import { runLoginFlow, type LoginFlowResult } from "./login.js";

const PROJECT_CHANGE_WARNING_LINES = ["Updates .env.local and .vercel/project.json"] as const;

export type RemoteAuthCompletedMutation =
  | { readonly kind: "vercel-login" }
  | {
      readonly kind: "project-linked";
      readonly project: string;
      readonly team: string;
    }
  | {
      readonly kind: "trusted-sources-updated";
      readonly targetProjectName: string;
    }
  | { readonly kind: "environment-pulled" };

export type RemoteAuthPreparation =
  | {
      readonly kind: "prepared";
      readonly target: VerifiedVercelTarget;
      readonly resolveToken: () => Promise<string>;
      readonly completedMutations: readonly RemoteAuthCompletedMutation[];
    }
  | {
      readonly kind: "cancelled";
      readonly completedMutations: readonly RemoteAuthCompletedMutation[];
    }
  | {
      readonly kind: "failed";
      readonly message: string;
      readonly completedMutations: readonly RemoteAuthCompletedMutation[];
    };

/** Injectable entry point for the remote authentication flow. */
export type RemoteAuthFlow = typeof runRemoteAuthFlow;
export interface RemoteAuthFlowDeps {
  readonly runLoginFlow: typeof runLoginFlow;
  readonly detectProjectIdentity: typeof detectProjectIdentity;
  readonly readProjectLink: typeof readProjectLink;
  readonly pickTeam: typeof pickTeam;
  readonly pickProject: typeof pickProject;
  readonly resolveProjectByNameOrId: typeof resolveProjectByNameOrId;
  readonly linkResolvedVercelProject: typeof linkResolvedVercelProject;
  readonly resolveVercelDeployment: typeof resolveVercelDeployment;
  readonly runVercelEnvPull: typeof runVercelEnvPull;
  readonly readPulledOidcToken: (workspaceRoot: string) => Promise<string | undefined>;
  readonly resolveOidcToken: typeof resolveDevelopmentOidcToken;
  readonly prepareVercelTrustedSourceAccess: typeof prepareVercelTrustedSourceAccess;
  readonly applyVercelTrustedSourceAccess: typeof applyVercelTrustedSourceAccess;
}

const defaultDeps: RemoteAuthFlowDeps = {
  runLoginFlow,
  detectProjectIdentity,
  readProjectLink,
  pickTeam,
  pickProject,
  resolveProjectByNameOrId,
  linkResolvedVercelProject,
  resolveVercelDeployment,
  runVercelEnvPull,
  readPulledOidcToken,
  resolveOidcToken: resolveDevelopmentOidcToken,
  prepareVercelTrustedSourceAccess,
  applyVercelTrustedSourceAccess,
};

/** Human-readable actions that completed and cannot be rolled back automatically. */
export function describeRemoteAuthCompletedMutations(
  completedMutations: readonly RemoteAuthCompletedMutation[],
): string[] {
  return completedMutations.map((mutation) => {
    switch (mutation.kind) {
      case "vercel-login":
        return "logged in to Vercel";
      case "project-linked":
        return `linked ${mutation.project} in ${mutation.team}`;
      case "trusted-sources-updated":
        return `updated Trusted Sources for ${mutation.targetProjectName}`;
      case "environment-pulled":
        return "refreshed .env.local";
    }
  });
}

/** Adds the mutations that cannot be rolled back to an authentication failure. */
export function appendRemoteAuthMutationSummary(
  message: string,
  completedMutations: readonly RemoteAuthCompletedMutation[],
): string {
  const completed = describeRemoteAuthCompletedMutations(completedMutations);
  return completed.length === 0
    ? message
    : `${message} Completed before the failure: ${completed.join(", ")}.`;
}

function failed(
  message: string,
  completedMutations: readonly RemoteAuthCompletedMutation[] = [],
): Extract<RemoteAuthPreparation, { kind: "failed" }> {
  return {
    kind: "failed",
    message: appendRemoteAuthMutationSummary(message, completedMutations),
    completedMutations: [...completedMutations],
  };
}

function cancelled(
  completedMutations: readonly RemoteAuthCompletedMutation[] = [],
): Extract<RemoteAuthPreparation, { kind: "cancelled" }> {
  return { kind: "cancelled", completedMutations: [...completedMutations] };
}

function loginFailure(result: LoginFlowResult): RemoteAuthPreparation | undefined {
  switch (result.kind) {
    case "already":
    case "logged-in":
      return undefined;
    case "cancelled":
      return cancelled();
    case "cli-missing":
      return failed("The Vercel CLI is not installed. Run /vc:install, then retry /vc:auth.");
    case "failed":
      return failed("Vercel login did not complete. Run /vc:login or retry /vc:auth.");
    case "unavailable":
      return failed(
        "Vercel could not verify your account. Check your connection, then retry /vc:auth.",
      );
  }
}

function currentProjectHint(identity: ProjectIdentity): string {
  const project = pc.bold(identity.projectName);
  return identity.teamName === undefined ? project : `${project} in ${identity.teamName}`;
}

function linkedDirectoryMessage(identity: ProjectIdentity): string {
  const project = identity.projectName;
  const location =
    identity.teamName === undefined
      ? pc.bold(project)
      : `${project} in ${pc.bold(identity.teamName)}`;
  return `This directory is currently linked to ${location}.`;
}

function deploymentFailureMessage(failure: VercelDeploymentResolutionFailure): string {
  return failure.cause === "vercel" ? failure.failure.message : failure.message;
}

async function chooseProjectAction(
  prompter: Prompter,
  host: string,
  identity: ProjectIdentity,
): Promise<"current" | "change" | "cancel"> {
  return prompter.select({
    message: `Authenticate ${host}`,
    hintLayout: "stacked",
    options: [
      {
        value: "current",
        label: "Use current project",
        hint: currentProjectHint(identity),
      },
      {
        value: "change",
        label: "Select another Vercel project",
        notice: { tone: "warning", lines: PROJECT_CHANGE_WARNING_LINES },
      },
      { value: "cancel", label: "Cancel" },
    ],
  });
}

async function confirmProjectChange(
  prompter: Prompter,
  current: ProjectIdentity | undefined,
  project: ResolvedVercelProjectSpec,
): Promise<boolean> {
  const linkAction: SelectOption<"continue"> = {
    value: "continue",
    label: `Link to project '${pc.bold(project.project)}'`,
    hint: "Links this directory and pulls an OIDC token for remote authentication.",
  };
  const options: SelectOption<"continue" | "cancel">[] = [
    linkAction,
    { value: "cancel", label: "Cancel" },
  ];
  const question: SingleSelectOptions<"continue" | "cancel"> =
    current === undefined
      ? {
          message: "This directory is not currently linked.",
          hintLayout: "stacked",
          options,
        }
      : {
          message: linkedDirectoryMessage(current),
          messageTone: "warning",
          hintLayout: "stacked",
          options,
        };
  const choice = await prompter.select(question);
  return choice === "continue";
}

async function selectProject(
  deps: RemoteAuthFlowDeps,
  workspaceRoot: string,
  serverUrl: string,
  prompter: Prompter,
  signal: AbortSignal | undefined,
): Promise<ResolvedVercelProjectSpec> {
  const remoteUrl = pc.blue(serverUrl);
  let initialTeam: string | undefined;
  while (true) {
    const teamOptions: PickTeamOptions = {
      message: `Which team does ${remoteUrl} belong to?`,
      promptWhenSingle: true,
      signal,
    };
    if (initialTeam !== undefined) teamOptions.initialValue = initialTeam;
    const team = await deps.pickTeam(prompter, workspaceRoot, undefined, teamOptions);
    try {
      const picked = await deps.pickProject(prompter, workspaceRoot, team, {
        allowCreateWhenEmpty: false,
        message: `Which project is ${remoteUrl} part of?`,
        signal,
      });
      return { kind: "existing", project: picked.project, team };
    } catch (error) {
      if (!(error instanceof StepBackError)) throw error;
      initialTeam = team;
    }
  }
}

/**
 * Reads the fresh Vercel OIDC credential written by `vercel env pull`.
 * The token is returned to the request-header source and is never logged.
 */
async function readPulledOidcToken(workspaceRoot: string): Promise<string | undefined> {
  try {
    const values = parseEnv(await readFile(join(workspaceRoot, ".env.local"), "utf8"));
    const token = values.VERCEL_OIDC_TOKEN?.trim();
    return token && token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Authenticates a remote through a new or existing Vercel project. Updates
 * Trusted Sources when needed, refreshes `.env.local`, and prepares a live
 * token resolver for the verified target.
 */
export async function runRemoteAuthFlow(input: {
  readonly workspaceRoot: string;
  readonly serverUrl: string;
  readonly configureTrustedSources?: boolean;
  readonly prompter: Prompter;
  readonly signal?: AbortSignal;
  readonly deps?: Partial<RemoteAuthFlowDeps>;
}): Promise<RemoteAuthPreparation> {
  const { workspaceRoot, serverUrl, prompter, signal } = input;
  const host = new URL(serverUrl).host;
  const deps: RemoteAuthFlowDeps = { ...defaultDeps, ...input.deps };
  const completedMutations: RemoteAuthCompletedMutation[] = [];
  let applying = false;

  try {
    const login = await deps.runLoginFlow({
      appRoot: workspaceRoot,
      prompter,
      signal,
    });
    const loginOutcome = loginFailure(login);
    if (loginOutcome !== undefined) return loginOutcome;
    if (login.kind === "logged-in") completedMutations.push({ kind: "vercel-login" });

    const identity = await deps.detectProjectIdentity(workspaceRoot, { signal });
    signal?.throwIfAborted();

    let shouldLink = identity === undefined;
    if (identity !== undefined) {
      const action = await chooseProjectAction(prompter, host, identity);
      if (action === "cancel") return cancelled(completedMutations);
      shouldLink = action === "change";
    }

    let projectToLink:
      | {
          readonly spec: ResolvedVercelProjectSpec;
          readonly project: VercelProjectReference;
        }
      | undefined;
    let projectAuthority: { readonly orgId: string; readonly projectId: string } | undefined;
    if (shouldLink) {
      try {
        const project = await selectProject(deps, workspaceRoot, serverUrl, prompter, signal);
        const resolved = await deps.resolveProjectByNameOrId(
          workspaceRoot,
          project.team,
          project.project,
          { signal },
        );
        if (resolved === null) {
          return failed(
            `Vercel project ${project.project} was not found in ${project.team}.`,
            completedMutations,
          );
        }
        if (!(await confirmProjectChange(prompter, identity, project))) {
          return cancelled(completedMutations);
        }
        projectToLink = { spec: project, project: resolved };
        projectAuthority = { orgId: resolved.accountId, projectId: resolved.id };
      } catch (error) {
        if (error instanceof WizardCancelledError) return cancelled(completedMutations);
        signal?.throwIfAborted();
        return failed(
          `Could not select a Vercel project: ${toErrorMessage(error)}`,
          completedMutations,
        );
      }
    }
    if (!shouldLink) {
      const link = await deps.readProjectLink(workspaceRoot);
      if (link !== undefined) {
        projectAuthority = { orgId: link.orgId, projectId: link.projectId };
      }
    }
    if (projectAuthority === undefined) {
      return failed("The directory is not linked to a valid Vercel project.", completedMutations);
    }
    const deploymentResolution = await deps.resolveVercelDeployment({
      workspaceRoot,
      host,
      signal,
      source: projectAuthority,
    });
    let target: VerifiedVercelTarget;
    switch (deploymentResolution.kind) {
      case "resolved":
        target = deploymentResolution.target;
        break;
      case "cancelled":
        return cancelled(completedMutations);
      case "not-found":
        return failed(
          `Vercel did not resolve ${host} as a deployment in the selected account.`,
          completedMutations,
        );
      case "unscoped":
        return failed(
          `Could not verify ${host}: the directory is not linked to a Vercel account.`,
          completedMutations,
        );
      case "project-mismatch":
        return failed(
          `Could not verify ${host}: Vercel resolved project ${deploymentResolution.actualProjectId}, not ${deploymentResolution.expectedProjectId}.`,
          completedMutations,
        );
      case "failed":
        return failed(
          `Could not verify ${host} through Vercel: ${deploymentFailureMessage(deploymentResolution.failure)}`,
          completedMutations,
        );
    }

    let trustedSourcesGrant: VercelTrustedSourceGrant | undefined;
    if (input.configureTrustedSources === true) {
      const trustedSources = await deps.prepareVercelTrustedSourceAccess({
        workspaceRoot,
        target,
        prompter,
        signal,
      });
      signal?.throwIfAborted();
      if (trustedSources.kind === "cancelled") return cancelled(completedMutations);
      if (trustedSources.kind === "failed") {
        return failed(trustedSources.message, completedMutations);
      }
      if (trustedSources.kind === "approved") trustedSourcesGrant = trustedSources.grant;
    }

    signal?.throwIfAborted();
    applying = true;
    if (projectToLink !== undefined) {
      try {
        await deps.linkResolvedVercelProject({
          prompter,
          projectRoot: workspaceRoot,
          project: projectToLink.project,
          signal,
        });
      } catch (error) {
        return failed(
          `Could not link the Vercel project: ${toErrorMessage(error)}`,
          completedMutations,
        );
      }
      completedMutations.push({
        kind: "project-linked",
        project: projectToLink.spec.project,
        team: projectToLink.spec.team,
      });
    }

    if (trustedSourcesGrant !== undefined) {
      const trustedSources = await deps.applyVercelTrustedSourceAccess({
        workspaceRoot,
        grant: trustedSourcesGrant,
        signal,
      });
      if (trustedSources.kind === "failed") {
        return failed(trustedSources.message, completedMutations);
      }
      if (trustedSources.kind === "updated") {
        completedMutations.push({
          kind: "trusted-sources-updated",
          targetProjectName: trustedSources.targetProjectName,
        });
      }
    }
    let pulled: boolean;
    try {
      pulled = await deps.runVercelEnvPull(
        workspaceRoot,
        createPromptCommandOutput(prompter.log),
        signal,
      );
    } catch (error) {
      return failed(
        `Could not refresh .env.local from Vercel: ${toErrorMessage(error)}`,
        completedMutations,
      );
    }
    if (!pulled) {
      return failed("Vercel did not refresh .env.local. Retry /vc:auth.", completedMutations);
    }
    completedMutations.push({ kind: "environment-pulled" });

    const resolveToken = async (): Promise<string> => {
      const refreshed = (await deps.resolveOidcToken(target.deployment)).trim();
      if (refreshed.length > 0) return refreshed;

      const pulled = ((await deps.readPulledOidcToken(workspaceRoot)) ?? "").trim();
      return vercelOidcTokenMatchesProject(pulled, target.deployment) ? pulled : "";
    };
    const token = await resolveToken();
    signal?.throwIfAborted();
    if (token.length === 0) {
      return failed(
        "The selected project did not provide a matching VERCEL_OIDC_TOKEN in .env.local.",
        completedMutations,
      );
    }
    return { kind: "prepared", target, resolveToken, completedMutations: [...completedMutations] };
  } catch (error) {
    if (!applying && (error instanceof WizardCancelledError || signal?.aborted === true)) {
      return cancelled(completedMutations);
    }
    return failed(`Could not authenticate ${host}: ${toErrorMessage(error)}`, completedMutations);
  }
}
