import { Client } from "#client/index.js";
import { resolveDevelopmentClientOptions } from "#services/dev-client/client-options.js";
import {
  resolveVerifiedRemoteDevelopmentClient,
  type VerifiedRemoteDevelopmentClient,
} from "#setup/verified-remote-client.js";
import {
  formatVercelAuthChallengeMessage,
  isVercelAuthChallenge,
} from "#services/dev-client/vercel-auth-error.js";
import { toErrorMessage } from "#shared/errors.js";
import type { DevBootProgressReporter } from "#internal/dev-boot-progress.js";

import { createPromptCommandHandler } from "./prompt-command-handler.js";
import { EveTUIRunner, type EveTUIRunnerOptions } from "./runner.js";
import type { DevelopmentTuiTarget } from "./target.js";
import type { TuiDisplayOptions } from "./types.js";

export type { DevelopmentTuiTarget } from "./target.js";

export interface RunDevelopmentTuiInput extends TuiDisplayOptions {
  /** The local server or remote URL used by this TUI session. */
  readonly target: DevelopmentTuiTarget;
  /**
   * Text to seed the prompt input with after the UI launches. The buffer is
   * editable and is not auto-submitted — the user presses Enter to send it.
   * Applies to the first prompt only.
   */
  readonly initialInput?: string;
  /** Reports local CLI boot phases. Omitted for remote and programmatic TUI runs. */
  readonly onBootProgress?: DevBootProgressReporter;
}

async function resolveClientOptions(
  target: DevelopmentTuiTarget,
): Promise<VerifiedRemoteDevelopmentClient> {
  if (target.kind === "local") {
    return {
      options: resolveDevelopmentClientOptions(target.serverUrl),
      lastOidcTokenFailure: () => undefined,
    };
  }

  return await resolveVerifiedRemoteDevelopmentClient({
    serverUrl: target.serverUrl,
    workspaceRoot: target.workspaceRoot,
  });
}

/**
 * Translate a renderer dynamic-import failure into an actionable error.
 *
 * react, react-reconciler, and yoga-layout are optional peer dependencies, so a
 * published install may lack them. The lazy `import("#tui/react-renderer.js")`
 * statically pulls them in, so a missing one rejects the import() with
 * ERR_MODULE_NOT_FOUND; surface install guidance rather than a raw
 * module-resolution stack trace. Unrelated errors pass through unchanged.
 */
export function translateRendererImportError(error: unknown): Error {
  if ((error as NodeJS.ErrnoException | undefined)?.code === "ERR_MODULE_NOT_FOUND") {
    return new Error(
      "`eve dev` requires the optional peer dependencies react, react-reconciler, and " +
        "yoga-layout, which are not installed. Add them with your package manager, e.g. " +
        "`npm install react react-reconciler yoga-layout`.",
      { cause: error },
    );
  }
  return error instanceof Error ? error : new Error(String(error));
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
  const { target, initialInput, onBootProgress, ...display } = input;
  const { serverUrl } = target;

  const { options: clientOptions, lastOidcTokenFailure } = await resolveClientOptions(target);
  const client = new Client(clientOptions);

  const options: EveTUIRunnerOptions = {
    ...display,
    session: client.session(),
    client,
    serverUrl,
    promptCommandHandler: createPromptCommandHandler(
      target.kind === "local" ? { appRoot: target.workspaceRoot } : {},
    ),
    formatTransportError: (error) =>
      isVercelAuthChallenge(error)
        ? formatVercelAuthChallengeMessage({ serverUrl, oidcTokenFailure: lastOidcTokenFailure() })
        : toErrorMessage(error),
  };
  if (target.kind === "local") options.appRoot = target.workspaceRoot;
  if (initialInput !== undefined) options.initialInput = initialInput;
  if (onBootProgress !== undefined) options.onBootProgress = onBootProgress;

  // The React/cell renderer is the only renderer. Loaded lazily so importing
  // `eve` (or any non-`eve dev` command) never pulls in React/Yoga (yoga-layout
  // compiles WASM at import). Setting `options.renderer` is what `createRenderer`
  // returns verbatim — the runner itself is renderer-agnostic.
  let ReactRenderer: typeof import("#tui/react-renderer.js").ReactRenderer;
  try {
    ({ ReactRenderer } = await import("#tui/react-renderer.js"));
  } catch (error) {
    throw translateRendererImportError(error);
  }
  options.renderer = new ReactRenderer({
    tools: display.tools,
    reasoning: display.reasoning,
    subagents: display.subagents,
    connectionAuth: display.connectionAuth,
    logs: display.logs,
    captureForeignOutput: true,
  });

  await new EveTUIRunner(options).run();
}
