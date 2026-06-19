import { Client, ClientError, type AgentInfoResult } from "#client/index.js";
import type { DevelopmentCredentialGate } from "#services/dev-client/credential-gate.js";
import {
  formatVercelTrustedSourcesFailure,
  isVercelAuthChallenge,
  vercelTrustedSourcesErrorCode,
} from "#services/dev-client/vercel-auth-error.js";
import {
  appendRemoteAuthMutationSummary,
  type RemoteAuthCompletedMutation,
  type RemoteAuthPreparation,
} from "#setup/flows/remote-auth.js";
import type {
  ResolvedVercelDeployment,
  VercelDeploymentResolution,
  VerifiedVercelTarget,
} from "#setup/vercel-deployment.js";
import { toErrorMessage } from "#shared/errors.js";
import { isObject } from "#shared/guards.js";

import { remoteHost, type RemoteDevelopmentTarget } from "./target.js";

export type RemoteAuthChallenge =
  | { readonly kind: "eve-oidc" }
  | { readonly kind: "vercel-deployment-protection" };

interface RemoteRequestFailure {
  readonly code?: string;
  readonly message: string;
}

export type RemoteConnectionState =
  | { readonly state: "checking" }
  | { readonly state: "ready"; readonly info: AgentInfoResult }
  | {
      readonly state: "auth-required";
      readonly challenge: RemoteAuthChallenge;
    }
  | {
      readonly state: "authenticating";
      readonly challenge: RemoteAuthChallenge;
    }
  | {
      readonly state: "auth-failed";
      readonly challenge: RemoteAuthChallenge;
    }
  | {
      readonly state: "unavailable";
      readonly failure: RemoteRequestFailure;
    };

export interface RemoteConnectionSnapshot {
  readonly target: RemoteDevelopmentTarget;
  readonly connection: RemoteConnectionState;
  /** Last deployment identity resolved from Vercel for this target. */
  readonly deployment?: ResolvedVercelDeployment;
}

export type RemoteAuthCompletion =
  | { readonly kind: "authenticated" }
  | {
      readonly kind: "cancelled";
      readonly completedMutations: readonly RemoteAuthCompletedMutation[];
    }
  | {
      readonly kind: "failed";
      readonly message: string;
    }
  | {
      readonly kind: "unavailable";
      readonly failure: RemoteRequestFailure;
    };

export interface RemoteConnectionController {
  current(): RemoteConnectionSnapshot;
  check(): Promise<RemoteConnectionState>;
  authenticate(
    prepare: (signal: AbortSignal) => Promise<RemoteAuthPreparation>,
    signal?: AbortSignal,
  ): Promise<RemoteAuthCompletion>;
  reportFailure(error: unknown): RemoteConnectionState;
  dispose(): void;
}

export interface RemoteConnectionControllerOptions {
  readonly client: Client;
  readonly credentials: DevelopmentCredentialGate;
  readonly target: RemoteDevelopmentTarget;
  /** Resolves an ambient token only after Vercel proves the exact target origin. */
  readonly resolveOidcToken?: (
    deployment: Pick<ResolvedVercelDeployment, "ownerId" | "projectId">,
  ) => Promise<string>;
  readonly resolveDeployment?: (signal: AbortSignal) => Promise<VercelDeploymentResolution>;
  readonly probeTimeoutMs?: number;
  readonly onChange: (snapshot: RemoteConnectionSnapshot) => void;
}

type RemoteProbeResult = Extract<
  RemoteConnectionState,
  { state: "ready" | "auth-required" | "unavailable" }
>;

function isEveOidcChallenge(error: unknown): boolean {
  if (!(error instanceof ClientError) || error.status !== 401) {
    return false;
  }

  try {
    const body: unknown = JSON.parse(error.body);
    return (
      isObject(body) &&
      body.ok === false &&
      body.code === "unauthorized" &&
      body.error === "Authorization is required for this route."
    );
  } catch {
    return false;
  }
}

function classifyRemoteError(
  error: unknown,
  phase: "connection-check" | "authentication-verification",
): RemoteProbeResult {
  if (isVercelAuthChallenge(error)) {
    return {
      state: "auth-required",
      challenge: { kind: "vercel-deployment-protection" },
    };
  }
  if (isEveOidcChallenge(error)) {
    return {
      state: "auth-required",
      challenge: { kind: "eve-oidc" },
    };
  }
  if (error instanceof ClientError) {
    const code = vercelTrustedSourcesErrorCode(error.message);
    if (
      phase === "connection-check" &&
      error.status === 403 &&
      code === "TRUSTED_SOURCES_ENVIRONMENT_MISMATCH"
    ) {
      return {
        state: "auth-required",
        challenge: { kind: "vercel-deployment-protection" },
      };
    }
    const failure = { message: formatVercelTrustedSourcesFailure(error.message) };
    return {
      state: "unavailable",
      failure: code === undefined ? failure : { ...failure, code },
    };
  }
  return {
    state: "unavailable",
    failure: { message: toErrorMessage(error) },
  };
}

async function probeRemoteInfo(
  client: Client,
  phase: "connection-check" | "authentication-verification",
  signal: AbortSignal,
): Promise<RemoteProbeResult> {
  try {
    return { state: "ready", info: await client.info({ signal }) };
  } catch (error) {
    return classifyRemoteError(error, phase);
  }
}

const REMOTE_PROBE_TIMEOUT_MS = 10_000;

function challengeFor(state: RemoteConnectionState): RemoteAuthChallenge {
  switch (state.state) {
    case "auth-required":
    case "authenticating":
    case "auth-failed":
      return state.challenge;
    case "checking":
    case "ready":
      return { kind: "eve-oidc" };
    case "unavailable":
      return state.failure.code === "TRUSTED_SOURCES_ENVIRONMENT_MISMATCH"
        ? { kind: "vercel-deployment-protection" }
        : { kind: "eve-oidc" };
  }
}

export function createRemoteConnectionController(
  options: RemoteConnectionControllerOptions,
): RemoteConnectionController {
  let connection: RemoteConnectionState = { state: "checking" };
  let deployment: ResolvedVercelDeployment | undefined;
  let operationAbort: AbortController | undefined;
  let restoreActiveCredentials: (() => void) | undefined;
  let operationGeneration = 0;
  let disposed = false;

  const snapshot = (): RemoteConnectionSnapshot =>
    deployment === undefined
      ? { target: options.target, connection }
      : { target: options.target, connection, deployment };
  const update = (next: RemoteConnectionState): RemoteConnectionState => {
    connection = next;
    if (!disposed) options.onChange(snapshot());
    return next;
  };
  const beginOperation = (
    parentSignal?: AbortSignal,
  ): { readonly generation: number; readonly signal: AbortSignal } => {
    operationAbort?.abort();
    const abort = new AbortController();
    operationAbort = abort;
    const signal =
      parentSignal === undefined ? abort.signal : AbortSignal.any([abort.signal, parentSignal]);
    return { generation: ++operationGeneration, signal };
  };
  const isCurrent = (generation: number): boolean =>
    !disposed && generation === operationGeneration;
  const publishTarget = (target: VerifiedVercelTarget): void => {
    deployment = target.deployment;
    if (!disposed) options.onChange(snapshot());
  };
  const authorizeResolvedTarget = async (
    signal: AbortSignal,
    generation: number,
  ): Promise<(() => void) | undefined> => {
    const resolveDeployment = options.resolveDeployment;
    if (resolveDeployment === undefined) return;
    try {
      const resolved = await resolveDeployment(signal);
      if (!isCurrent(generation) || signal.aborted || resolved.kind !== "resolved") return;
      publishTarget(resolved.target);
      const resolveToken = async (): Promise<string> => {
        const token = await options.resolveOidcToken?.(resolved.target.deployment);
        return token ?? "";
      };
      return options.credentials.authorize({
        target: resolved.target,
        resolveToken,
      });
    } catch {
      // Deployment metadata and ambient credentials are optional. The anonymous
      // probe below remains the authoritative connection result.
    }
    return undefined;
  };
  const runProbe = async (
    phase: "connection-check" | "authentication-verification",
    parentSignal: AbortSignal,
  ): Promise<RemoteProbeResult> => {
    const signal = AbortSignal.any([
      parentSignal,
      AbortSignal.timeout(options.probeTimeoutMs ?? REMOTE_PROBE_TIMEOUT_MS),
    ]);
    return await probeRemoteInfo(options.client, phase, signal);
  };

  options.onChange(snapshot());

  return {
    current: snapshot,

    async check(): Promise<RemoteConnectionState> {
      const operation = beginOperation();
      restoreActiveCredentials?.();
      restoreActiveCredentials = undefined;
      deployment = undefined;
      update({ state: "checking" });
      const restoreCredentials = await authorizeResolvedTarget(
        operation.signal,
        operation.generation,
      );
      if (!isCurrent(operation.generation)) {
        restoreCredentials?.();
        return connection;
      }
      restoreActiveCredentials = restoreCredentials;
      const probe = await runProbe("connection-check", operation.signal);
      if (!isCurrent(operation.generation)) return connection;
      const state = update(probe);
      return state;
    },

    async authenticate(
      prepare: (signal: AbortSignal) => Promise<RemoteAuthPreparation>,
      signal?: AbortSignal,
    ): Promise<RemoteAuthCompletion> {
      const operation = beginOperation(signal);
      const previous = connection;
      const challenge = challengeFor(connection);
      update({ state: "authenticating", challenge });

      let preparation: RemoteAuthPreparation;
      try {
        preparation = await prepare(operation.signal);
      } catch (error) {
        preparation = {
          kind: "failed",
          message: toErrorMessage(error),
          completedMutations: [],
        };
      }

      if (!isCurrent(operation.generation)) {
        return {
          kind: "cancelled",
          completedMutations: preparation.completedMutations,
        };
      }

      if (preparation.kind === "cancelled") {
        update(previous);
        return {
          kind: "cancelled",
          completedMutations: preparation.completedMutations,
        };
      }
      if (preparation.kind === "failed") {
        update({ state: "auth-failed", challenge });
        return { kind: "failed", message: preparation.message };
      }
      if (operation.signal.aborted) {
        update(previous);
        return {
          kind: "cancelled",
          completedMutations: preparation.completedMutations,
        };
      }

      const restorePreviousCredentials = restoreActiveCredentials;
      let restoreCandidateCredentials: () => void;
      try {
        restoreCandidateCredentials = options.credentials.authorize({
          target: preparation.target,
          resolveToken: preparation.resolveToken,
        });
      } catch (error) {
        const message = appendRemoteAuthMutationSummary(
          toErrorMessage(error),
          preparation.completedMutations,
        );
        update({ state: "auth-failed", challenge });
        return { kind: "failed", message };
      }
      const verified = await runProbe("authentication-verification", operation.signal);
      if (!isCurrent(operation.generation)) {
        restoreCandidateCredentials();
        return { kind: "cancelled", completedMutations: preparation.completedMutations };
      }
      if (operation.signal.aborted) {
        restoreCandidateCredentials();
        update(previous);
        return { kind: "cancelled", completedMutations: preparation.completedMutations };
      }
      if (verified.state === "ready") {
        publishTarget(preparation.target);
        restoreActiveCredentials = () => {
          restoreCandidateCredentials();
          restorePreviousCredentials?.();
        };
        update(verified);
        return { kind: "authenticated" };
      }
      restoreCandidateCredentials();
      if (verified.state === "auth-required") {
        const message = appendRemoteAuthMutationSummary(
          `The selected Vercel project did not authorize ${remoteHost(options.target)}.`,
          preparation.completedMutations,
        );
        update({ state: "auth-failed", challenge: verified.challenge });
        return { kind: "failed", message };
      }
      if (verified.state === "unavailable") {
        const failure = {
          ...verified.failure,
          message: appendRemoteAuthMutationSummary(
            verified.failure.message,
            preparation.completedMutations,
          ),
        };
        update({ state: "unavailable", failure });
        return { kind: "unavailable", failure };
      }

      const exhaustive: never = verified;
      return exhaustive;
    },

    reportFailure(error: unknown): RemoteConnectionState {
      operationAbort?.abort();
      operationGeneration += 1;
      return update(classifyRemoteError(error, "connection-check"));
    },

    dispose(): void {
      disposed = true;
      operationGeneration += 1;
      operationAbort?.abort();
      operationAbort = undefined;
      restoreActiveCredentials?.();
      restoreActiveCredentials = undefined;
    },
  };
}
