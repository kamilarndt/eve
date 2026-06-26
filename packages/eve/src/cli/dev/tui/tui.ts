import { Client } from "#client/index.js";
import type { TokenValue } from "#client/types.js";
import type { DevBootProgressReporter } from "#internal/dev-boot-progress.js";
import {
  resolveDevelopmentClientOptions,
  resolveRemoteDevelopmentClientOptions,
} from "#services/dev-client/client-options.js";
import { createDevelopmentCredentialGate } from "#services/dev-client/credential-gate.js";
import { resolveDevelopmentOidcToken } from "#services/dev-client/request-headers.js";
import { isVercelAuthChallenge } from "#services/dev-client/vercel-auth-error.js";
import { resolveVercelDeployment } from "#setup/vercel-deployment.js";
import { toErrorMessage } from "#shared/errors.js";

import { createPromptCommandHandler } from "./prompt-command-handler.js";
import { promptCommandsFor } from "./prompt-commands.js";
import { formatRemoteAuthChallengeMessage } from "./remote-auth-result.js";
import { EveTUIRunner, type EveTUIRunnerOptions } from "./runner.js";
import { remoteHost, type DevelopmentTuiTarget, type RemoteDevelopmentTarget } from "./target.js";
import type { TuiDisplayOptions } from "./types.js";

export type { DevelopmentTuiTarget } from "./target.js";

export const EVE_DEV_OIDC_TOKEN_ENV = "EVE_DEV_OIDC_TOKEN";

export interface RunDevelopmentTuiInput extends TuiDisplayOptions {
  /** The local server or remote URL used by this TUI session. */
  readonly target: DevelopmentTuiTarget;
  /**
   * Text to seed the prompt input with after the UI launches. The buffer is
   * editable and is not auto-submitted. The user presses Enter to send it.
   * Applies to the first prompt only.
   */
  readonly initialInput?: string;
  /** Static request headers sent by the development client. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Reports local CLI boot phases. Omitted for remote and programmatic TUI runs. */
  readonly onBootProgress?: DevBootProgressReporter;
}

function resolveExplicitRemoteOidcToken(): TokenValue | undefined {
  if (process.env[EVE_DEV_OIDC_TOKEN_ENV]?.trim()) {
    return () => process.env[EVE_DEV_OIDC_TOKEN_ENV] ?? "";
  }
  return undefined;
}

function prepareRemoteTarget(target: RemoteDevelopmentTarget) {
  const explicitOidcToken = resolveExplicitRemoteOidcToken();
  const credentials = createDevelopmentCredentialGate(target.serverUrl, {
    oidcToken: explicitOidcToken,
  });
  const remote = { target, credentials };
  const resolveDeployment = (signal: AbortSignal) =>
    resolveVercelDeployment({
      workspaceRoot: target.workspaceRoot,
      host: remoteHost(target),
      signal,
    });

  if (explicitOidcToken !== undefined) {
    return {
      ...remote,
      resolveOidcToken: resolveDevelopmentOidcToken,
      resolveDeployment,
      skipStartupDeploymentResolution: true,
    } satisfies NonNullable<EveTUIRunnerOptions["remote"]>;
  }

  return {
    ...remote,
    resolveOidcToken: resolveDevelopmentOidcToken,
    resolveDeployment,
  } satisfies NonNullable<EveTUIRunnerOptions["remote"]>;
}

type PreparedDevelopmentTuiTarget =
  | {
      readonly kind: "local";
      readonly target: Extract<DevelopmentTuiTarget, { kind: "local" }>;
    }
  | {
      readonly kind: "remote";
      readonly target: RemoteDevelopmentTarget;
      readonly remote: NonNullable<EveTUIRunnerOptions["remote"]>;
    };

function prepareDevelopmentTarget(target: DevelopmentTuiTarget): PreparedDevelopmentTuiTarget {
  return target.kind === "local"
    ? { kind: "local", target }
    : { kind: "remote", target, remote: prepareRemoteTarget(target) };
}

/**
 * Runs the `eve dev` terminal UI against the given server URL until the
 * user exits.
 *
 * The configured client is handed to the runner so its subagent
 * child-session streams inherit the same auth. Turn-dispatch failures —
 * including the Vercel Deployment Protection challenge — are formatted into
 * the inline error region rather than crashing the command.
 */
export async function runDevelopmentTui(input: RunDevelopmentTuiInput): Promise<void> {
  const { target, headers, initialInput, onBootProgress, ...display } = input;
  const prepared = prepareDevelopmentTarget(target);
  const { serverUrl } = target;

  const client = new Client(
    prepared.kind === "local"
      ? resolveDevelopmentClientOptions(serverUrl, { headers })
      : resolveRemoteDevelopmentClientOptions({
          serverUrl,
          credentials: prepared.remote.credentials,
          headers,
        }),
  );

  const options: EveTUIRunnerOptions = {
    ...display,
    session: client.session(),
    client,
    serverUrl,
    promptCommandHandler: createPromptCommandHandler({ target }),
    availablePromptCommands: promptCommandsFor(target.kind),
    formatTransportError: (error) =>
      isVercelAuthChallenge(error)
        ? formatRemoteAuthChallengeMessage(serverUrl)
        : toErrorMessage(error),
  };
  if (prepared.kind === "local") {
    options.appRoot = prepared.target.workspaceRoot;
  } else {
    options.remote = prepared.remote;
  }
  if (initialInput !== undefined) options.initialInput = initialInput;
  if (onBootProgress !== undefined) options.onBootProgress = onBootProgress;

  await new EveTUIRunner(options).run();
}
